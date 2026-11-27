//! One-click "connect" for agents whose MCP config is a plain JSON file with an `mcpServers` map at a known
//! place (formats from each vendor's docs, Nov 2026; see docs/decisions.md). Other agents get a snippet or a CLI
//! command in the UI instead. A write merges our one entry (`health`) into the file: other servers and keys stay,
//! the original is kept once as `<name>.health-bak`, the new one replaces it atomically, and a file we can't parse (e.g. JSON
//! with comments) is left alone.

use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

/// Where per-user config lives: the home directory, and the OS's app-config directory
/// (macOS ~/Library/Application Support, Windows %APPDATA%, Linux $XDG_CONFIG_HOME or ~/.config).
pub struct Roots {
    pub home: PathBuf,
    pub config: PathBuf,
}

impl Roots {
    pub fn os() -> Option<Roots> {
        let home = PathBuf::from(std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?);
        let config = if cfg!(target_os = "macos") {
            home.join("Library/Application Support")
        } else if cfg!(windows) {
            PathBuf::from(std::env::var_os("APPDATA")?)
        } else {
            std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config"))
        };
        Some(Roots { home, config })
    }
}

struct Client {
    id: &'static str,
    /// Relative to `home` (false) or to `config` (true)
    in_config: bool,
    file: &'static str,
    /// Cursor and Copilot want `"type": "stdio"`; the others infer it from `command`
    typed: bool,
}

const CLIENTS: &[Client] = &[
    Client { id: "claude-desktop", in_config: true, file: "Claude/claude_desktop_config.json", typed: false },
    Client { id: "cursor", in_config: false, file: ".cursor/mcp.json", typed: true },
    Client { id: "copilot", in_config: false, file: ".copilot/mcp-config.json", typed: true },
    Client { id: "gemini", in_config: false, file: ".gemini/settings.json", typed: false },
    Client { id: "kiro", in_config: false, file: ".kiro/settings/mcp.json", typed: false },
];

fn path(r: &Roots, c: &Client) -> PathBuf {
    if c.in_config { r.config.join(c.file) } else { r.home.join(c.file) }
}

/// The one-click clients that look installed (their config folder exists), with the file we would write.
pub fn detect(r: &Roots) -> Vec<Value> {
    CLIENTS.iter().filter(|c| path(r, c).parent().is_some_and(Path::is_dir)).map(|c| json!({ "id": c.id, "file": path(r, c) })).collect()
}

/// Adds (or replaces) the `health` server in the client's config; returns the file written.
pub fn connect(r: &Roots, id: &str, bin: &str, token: &str) -> Result<PathBuf, String> {
    let c = CLIENTS.iter().find(|c| c.id == id).ok_or_else(|| format!("unknown agent {id}"))?;
    // a symlinked config (dotfiles) is updated where it really lives, not replaced by a plain file
    let file = path(r, c);
    let file = std::fs::canonicalize(&file).unwrap_or(file);
    let old = match std::fs::read_to_string(&file) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("can't read {}: {e}", file.display())),
    };
    let mut doc: Value = match old.as_deref().map(str::trim) {
        None | Some("") => json!({}),
        Some(s) => serde_json::from_str(s)
            .map_err(|_| format!("{} isn't plain JSON (it may have comments); add the snippet by hand", file.display()))?,
    };
    let root = doc.as_object_mut().ok_or_else(|| format!("{} isn't a JSON object", file.display()))?;
    let servers = root.entry("mcpServers").or_insert_with(|| Value::Object(Map::new()));
    let servers = servers.as_object_mut().ok_or_else(|| format!("mcpServers in {} isn't an object", file.display()))?;
    let mut entry = Map::new();
    if c.typed {
        entry.insert("type".into(), json!("stdio"));
    }
    entry.insert("command".into(), json!(bin));
    entry.insert("args".into(), json!(["mcp"]));
    entry.insert("env".into(), json!({ "HEALTH_TOKEN": token }));
    servers.insert("health".into(), Value::Object(entry));

    let dir = file.parent().ok_or("no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = file.file_name().ok_or("no file name")?.to_string_lossy().into_owned();
    // the copy of the original is made once and never overwritten, with the original's permissions
    // our own name, so a .bak the person or another tool made is never mistaken for ours
    let bak = dir.join(format!("{name}.health-bak"));
    if old.is_some() && !bak.exists() {
        std::fs::copy(&file, &bak).map_err(|e| format!("can't keep a copy: {e}"))?;
    }
    let tmp = dir.join(format!(".{name}.health-tmp"));
    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())? + "\n";
    write_private(&tmp, &text, old.is_some().then_some(file.as_path())).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(file)
}

/// Writes `text` to a file created owner-only (the token is in it); when replacing a file, then takes on its
/// permissions.
fn write_private(p: &Path, text: &str, like: Option<&Path>) -> std::io::Result<()> {
    use std::io::Write;
    let _ = std::fs::remove_file(p);
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let mut f = o.open(p)?;
    f.write_all(text.as_bytes())?;
    f.sync_all()?;
    if let Some(l) = like {
        std::fs::set_permissions(p, std::fs::metadata(l)?.permissions())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(name: &str) -> Roots {
        let base = std::env::temp_dir().join(format!("health-clients-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        Roots { home: base.join("home"), config: base.join("config") }
    }

    #[test]
    fn connect_keeps_other_servers_and_a_backup() {
        let r = roots("merge");
        let f = r.home.join(".cursor/mcp.json");
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(&f, r#"{"mcpServers":{"other":{"command":"x"}},"keep":1}"#).unwrap();
        assert_eq!(detect(&r).len(), 1);
        connect(&r, "cursor", "/Applications/Health.app/Contents/MacOS/health", "hk_1").unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(v["keep"], 1);
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["mcpServers"]["health"]["type"], "stdio");
        assert_eq!(v["mcpServers"]["health"]["args"], json!(["mcp"]));
        assert_eq!(v["mcpServers"]["health"]["env"]["HEALTH_TOKEN"], "hk_1");
        assert!(std::fs::read_to_string(r.home.join(".cursor/mcp.json.health-bak")).unwrap().contains("other"));
        // connecting again replaces our entry only
        connect(&r, "cursor", "/b", "hk_2").unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["health"]["env"]["HEALTH_TOKEN"], "hk_2");
        assert_eq!(v["mcpServers"].as_object().unwrap().len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn the_backup_keeps_the_original_private_and_a_symlink_stays_a_symlink() {
        use std::os::unix::fs::PermissionsExt;
        let r = roots("bak");
        let real = r.home.join("dotfiles/mcp.json");
        std::fs::create_dir_all(real.parent().unwrap()).unwrap();
        std::fs::create_dir_all(r.home.join(".cursor")).unwrap();
        std::fs::write(&real, r#"{"mcpServers":{}}"#).unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = r.home.join(".cursor/mcp.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        connect(&r, "cursor", "/b", "hk_1").unwrap();
        connect(&r, "cursor", "/b", "hk_2").unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert!(std::fs::read_to_string(&real).unwrap().contains("hk_2"));
        let bak = real.with_file_name("mcp.json.health-bak");
        assert_eq!(std::fs::read_to_string(&bak).unwrap(), r#"{"mcpServers":{}}"#, "the first original is kept");
        assert_eq!(std::fs::metadata(&bak).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn a_new_file_is_created_private() {
        let r = roots("new");
        let f = connect(&r, "claude-desktop", "/b", "hk").unwrap();
        assert_eq!(f, r.config.join("Claude/claude_desktop_config.json"));
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert!(v["mcpServers"]["health"].get("type").is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn a_file_with_comments_is_left_alone() {
        let r = roots("jsonc");
        let f = r.home.join(".gemini/settings.json");
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        let text = "{\n  // mine\n  \"theme\": \"x\"\n}";
        std::fs::write(&f, text).unwrap();
        assert!(connect(&r, "gemini", "/b", "hk").unwrap_err().contains("comments"));
        assert_eq!(std::fs::read_to_string(&f).unwrap(), text);
        assert!(!r.home.join(".gemini/settings.json.health-bak").exists());
    }
}
