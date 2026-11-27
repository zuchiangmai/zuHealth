//! The shell contract the UI (`gui/src/api.ts`) relies on, identical on every platform:
//! - commands: `op`, `unlock`, `init_profile`, `clear_data`, `core_path`, `agent_clients`, `connect_agent`,
//!   `ocr_status`, `ocr_install`, `set_language`, `open_link`, `shell_info`; for files the system hands over or
//!   takes (mobile): `stage_file`, `export_path`, `share_file`
//! - events: `health:status` (`{ up, locked?, need_init?, error? }`), `health:changed`, `health:locked`,
//!   `health:unlocked`, `health:sync`, `menu`
//!
//! Behind it, one host per platform: the `health serve` sidecar on desktop, the in-process runtime on mobile.
//! Native gates (biometrics before unlock, confirmation before handing data over) belong in these Rust commands,
//! never in web code.

#[cfg(desktop)]
mod clients;
#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg(desktop)]
use desktop as host;
#[cfg(mobile)]
use mobile as host;

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

/// Web pages the UI links to; nothing else is opened (both hosts check it, in Rust).
pub(crate) const LINKS: &[&str] = &["https://zuchiangmai.com/health", "https://developer-dashboard.whoop.com/"];

#[tauri::command]
fn shell_info() -> Value {
    json!({
        "os": std::env::consts::OS,
        "kind": if cfg!(mobile) { "mobile" } else { "desktop" },
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/// A file the system handed the UI (a photo, a picked file): its bytes arrive raw, with its name in `x-file-name`.
/// Written under the app's cache directory; returns the path the import ops take.
#[tauri::command]
fn stage_file(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, Value> {
    let fail = |m: String| json!({ "code": "stage_failed", "message": m });
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err(fail("expected raw bytes".into())) };
    let name = request.headers().get("x-file-name").and_then(|v| v.to_str().ok()).unwrap_or("file");
    let name = percent_decode(name);
    // only the base name, in a safe alphabet: the name comes from the web view
    let safe: String = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("file")
        .chars()
        .map(|c| if c.is_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect();
    let dir = app.path().app_cache_dir().map_err(|e| fail(e.to_string()))?.join("import");
    std::fs::create_dir_all(&dir).map_err(|e| fail(e.to_string()))?;
    clear_old(&dir);
    let path = dir.join(format!("{}-{}", std::process::id(), if safe.is_empty() { "file".into() } else { safe }));
    std::fs::write(&path, bytes).map_err(|e| fail(e.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Where a mobile export is written before the share sheet takes it (the app's cache, which Android may share).
#[tauri::command]
fn export_path(app: AppHandle, name: String) -> Result<String, Value> {
    let fail = |m: String| json!({ "code": "export_failed", "message": m });
    let dir = app.path().app_cache_dir().map_err(|e| fail(e.to_string()))?.join("export");
    std::fs::create_dir_all(&dir).map_err(|e| fail(e.to_string()))?;
    clear_old(&dir);
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || "._-".contains(c) { c } else { '_' }).collect();
    let path = dir.join(safe);
    // the app's own folder: an earlier export of the same name is replaced (export ops refuse to overwrite)
    let _ = std::fs::remove_file(&path);
    Ok(path.to_string_lossy().into_owned())
}

/// Removes files left over from earlier sessions (older than a day).
fn clear_old(dir: &std::path::Path) {
    let day = std::time::Duration::from_secs(86_400);
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|a| a > day)) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && let Some(v) = b.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg_attr(target_os = "android", tauri::mobile_entry_point)]
pub fn run() {
    host::run(tauri::Builder::default().invoke_handler(tauri::generate_handler![
        host::op,
        host::unlock,
        host::init_profile,
        host::clear_data,
        host::core_path,
        host::agent_clients,
        host::connect_agent,
        host::ocr_status,
        host::ocr_install,
        host::set_language,
        host::open_link,
        host::share_file,
        shell_info,
        stage_file,
        export_path
    ]));
}

/// The iOS entry point (`main.mm` calls it), as `tauri::mobile_entry_point` writes it but without
/// `tauri::log_stdout()`. That pipes stdout and stderr into os_log, and under Xcode's log hook (which writes os_log
/// back to stderr) the pipe fills and deadlocks the app: a `<select>` opening the keyboard logs enough. Output stays
/// on the process's stderr, which Xcode shows.
#[cfg(target_os = "ios")]
#[unsafe(no_mangle)]
pub extern "C" fn start_app() {
    // a panic must not unwind into Objective-C
    if std::panic::catch_unwind(run).is_err() {
        std::process::abort();
    }
}
