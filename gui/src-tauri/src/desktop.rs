//! Desktop host: starts the bundled `health serve`, restarts it if it dies, and relays the UI's calls.
//! The UI never sees the owner token and never makes a network request; it only calls the commands here.
//! Ported from the old desktop shell; the commands are registered in `lib.rs`.

use crate::clients;

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

#[derive(Clone)]
struct Conn {
    port: u16,
    token: String,
}

#[derive(Default)]
pub(crate) struct Shell {
    conn: Mutex<Option<Conn>>,
    child: Mutex<Option<Child>>,
    quitting: AtomicBool,
    /// Set while "Clear data" runs: the core stays stopped and the UI isn't told it went down
    paused: AtomicBool,
    /// Why the core is not up (shown by the UI), e.g. "no_profile: …"
    last_error: Mutex<Option<String>>,
}

/// The core binary: next to this executable when bundled (Tauri `externalBin`); HEALTH_BIN in debug builds only.
fn core_bin() -> PathBuf {
    if cfg!(debug_assertions)
        && let Some(p) = std::env::var_os("HEALTH_BIN")
    {
        return p.into();
    }
    let exe = std::env::current_exe().unwrap_or_default();
    exe.with_file_name(if cfg!(windows) { "health.exe" } else { "health" })
}

fn core_command() -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(core_bin());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console window behind the app
    }
    c
}

/// One request to serve on 127.0.0.1. HTTP/1.0, so the reply always comes with a Content-Length (never chunked).
fn http(c: &Conn, method: &str, path: &str, body: &str) -> Result<(u16, Value), String> {
    http_with(c, method, path, "", body)
}

/// `headers`: extra lines, each ending in CRLF
fn http_with(c: &Conn, method: &str, path: &str, headers: &str, body: &str) -> Result<(u16, Value), String> {
    let mut s = TcpStream::connect_timeout(&([127, 0, 0, 1], c.port).into(), Duration::from_secs(5)).map_err(|e| e.to_string())?;
    // a wedged core must not hang the UI or the supervisor: short for the handshake, generous for ops (imports)
    let wait = if path == "/v1/meta" { 10 } else { 900 };
    s.set_read_timeout(Some(Duration::from_secs(wait))).map_err(|e| e.to_string())?;
    let req = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        c.port,
        c.token,
        body.len()
    );
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("bad response from the core")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or("bad status from the core")?;
    let body = &raw[split + 4..];
    let v = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(body).map_err(|e| format!("unreadable reply from the core: {e}"))?
    };
    Ok((status, v))
}

fn unavailable(shell: &Shell) -> Value {
    let why = shell.last_error.lock().unwrap().clone();
    json!({ "code": "unavailable", "message": why.unwrap_or_else(|| "the health core is starting".into()) })
}

#[tauri::command(async)]
pub(crate) fn op(shell: tauri::State<'_, Arc<Shell>>, name: String, req: Value, background: Option<bool>) -> Result<Value, Value> {
    let conn = shell.conn.lock().unwrap().clone().ok_or_else(|| unavailable(&shell))?;
    if !name.chars().all(|c| c.is_ascii_lowercase() || c == '.' || c == '_') {
        return Err(json!({ "code": "no_op", "message": name }));
    }
    // the app's own call (a poll, a reload after an event): serve doesn't count it as the person using the app
    let headers = if background == Some(true) { "X-Health-Background: 1\r\n" } else { "" };
    let (status, body) = http_with(&conn, "POST", &format!("/v1/op/{name}"), headers, &req.to_string())
        .map_err(|e| json!({ "code": "unavailable", "message": e }))?;
    if status == 200 {
        Ok(body["value"].clone())
    } else {
        // always an {code, message} the UI can show, even when the reply has no error body
        Err(body
            .get("error")
            .filter(|e| e.is_object())
            .cloned()
            .unwrap_or_else(|| json!({ "code": "error", "message": format!("HTTP {status}") })))
    }
}

#[tauri::command(async)]
pub(crate) fn unlock(shell: tauri::State<'_, Arc<Shell>>, passphrase: String) -> Result<Value, Value> {
    let conn = shell.conn.lock().unwrap().clone().ok_or_else(|| unavailable(&shell))?;
    let (status, body) = http(&conn, "POST", "/v1/unlock", &json!({ "passphrase": passphrase }).to_string())
        .map_err(|e| json!({ "code": "unavailable", "message": e }))?;
    if status == 200 { Ok(body) } else { Err(body["error"].clone()) }
}

/// First launch: create the profile (new key in the keychain, empty encrypted database). The supervisor then starts serve.
#[tauri::command(async)]
pub(crate) fn init_profile() -> Result<(), Value> {
    let out = core_command().arg("init").output().map_err(|e| json!({ "code": "init_failed", "message": e.to_string() }))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(json!({ "code": "init_failed", "message": String::from_utf8_lossy(&out.stderr).trim() }))
    }
}

/// "Clear data": stops the core (closing its stdin, as on quit), deletes the profile and its key with
/// `health wipe` (the database first; nothing deleted while another process such as `health mcp` writes), then
/// lets the supervisor start the core again: on success it finds no profile and the UI shows the first run.
#[tauri::command(async)]
pub(crate) fn clear_data(shell: tauri::State<'_, Arc<Shell>>, confirm: String) -> Result<(), Value> {
    if !confirm.trim().eq_ignore_ascii_case("DELETE") {
        return Err(json!({ "code": "not_confirmed", "message": "type DELETE" }));
    }
    shell.paused.store(true, Ordering::SeqCst);
    stop_core(&shell);
    let out = wipe();
    shell.paused.store(false, Ordering::SeqCst);
    out
}

fn stop_core(shell: &Shell) {
    if let Some(c) = shell.child.lock().unwrap().as_mut() {
        drop(c.stdin.take()); // --exit-with-parent: the core exits cleanly
    }
    let t = std::time::Instant::now();
    let running = || shell.child.lock().unwrap().is_some();
    while running() && t.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(100));
    }
    if let Some(c) = shell.child.lock().unwrap().as_mut() {
        let _ = c.kill();
    }
    while running() && t.elapsed() < Duration::from_secs(15) {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Runs `health wipe`; its error code (`busy`: another process holds the profile) for the UI.
fn wipe() -> Result<(), Value> {
    let out = core_command()
        .args(["--json", "wipe", "--confirm", "DELETE"])
        .output()
        .map_err(|e| json!({ "code": "clear_failed", "message": e.to_string() }))?;
    if out.status.success() {
        return Ok(());
    }
    let v: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
    Err(json!({
        "code": v["error"]["code"].as_str().unwrap_or("clear_failed"),
        "message": v["error"]["message"].as_str().map_or_else(|| String::from_utf8_lossy(&out.stderr).trim().to_string(), String::from),
    }))
}

/// Where the core binary lives (for the MCP config an agent needs).
/** Agents with a one-click connect that look installed here. */
#[tauri::command]
pub(crate) fn agent_clients() -> Value {
    Value::Array(clients::Roots::os().map(|r| clients::detect(&r)).unwrap_or_default())
}

/** Writes this app's MCP entry (with the grant's token) into an agent's config; returns the file. */
#[tauri::command]
pub(crate) async fn connect_agent(id: String, token: String) -> Result<String, String> {
    let r = clients::Roots::os().ok_or("no home folder")?;
    clients::connect(&r, &id, &core_bin().to_string_lossy(), &token).map(|p| p.display().to_string())
}

/// Runs the core with `args` and `--json`: its reply, or its {code, message} error.
fn core_json(args: &[&str]) -> Result<Value, Value> {
    let out = core_command()
        .arg("--json")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| json!({ "code": "unavailable", "message": e.to_string() }))?;
    let v: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
    if out.status.success() {
        Ok(v)
    } else {
        Err(v.get("error").cloned().unwrap_or_else(|| json!({ "code": "error", "message": "the core failed" })))
    }
}

/** Is the OCR component (models) installed? */
#[tauri::command(async)]
pub(crate) fn ocr_status() -> Result<Value, Value> {
    core_json(&["component", "list"])
}

/** Downloads and checks the OCR component (the core does it; only health-connect opens connections). Its stderr
 *  lines "progress <done> <total>" become `health:ocr_progress` events, as the mobile shell emits them. */
#[tauri::command(async)]
pub(crate) fn ocr_install(app: AppHandle, matching: bool) -> Result<Value, Value> {
    let fail = |e: std::io::Error| json!({ "code": "unavailable", "message": e.to_string() });
    let mut c = core_command();
    c.args(["--json", "component", "install", "ocr"]);
    if !matching {
        c.arg("--no-matching");
    }
    let mut child = c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(fail)?;
    let stderr = child.stderr.take();
    // read stderr to its end (an undrained pipe would stall the core), passing on the progress lines
    let relay = std::thread::spawn(move || {
        let Some(stderr) = stderr else { return };
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let Some(rest) = line.strip_prefix("progress ") else { continue };
            let mut n = rest.split(' ').map(|x| x.parse::<u64>().ok());
            if let (Some(Some(done)), Some(Some(total))) = (n.next(), n.next()) {
                let _ = app.emit("health:ocr_progress", json!({ "stage": "download", "done": done, "total": total }));
            }
        }
    });
    let mut out = Vec::new();
    if let Some(mut so) = child.stdout.take() {
        so.read_to_end(&mut out).map_err(fail)?;
    }
    let ok = child.wait().map_err(fail)?.success();
    let _ = relay.join();
    let v: Value = serde_json::from_slice(&out).unwrap_or(Value::Null);
    if ok { Ok(v) } else { Err(v.get("error").cloned().unwrap_or_else(|| json!({ "code": "error", "message": "the core failed" }))) }
}

#[tauri::command]
pub(crate) fn core_path() -> String {
    core_bin().display().to_string()
}

/// Re-emits serve's SSE events to the UI until the connection drops.
fn relay_events(app: &AppHandle, c: &Conn) {
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", c.port)) else { return };
    let _ = write!(s, "GET /v1/events HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\n\r\n", c.port, c.token);
    for line in BufReader::new(s).lines() {
        let Ok(line) = line else { return };
        if let Some(ev) = line.strip_prefix("event: ") {
            let _ = app.emit(&format!("health:{ev}"), ());
        }
    }
}

fn status(app: &AppHandle, shell: &Shell, up: bool, extra: Value) {
    let mut v = json!({ "up": up });
    if let (Value::Object(o), Value::Object(e)) = (&mut v, extra) {
        o.extend(e);
    }
    if !up {
        v["error"] = json!(shell.last_error.lock().unwrap().clone());
    }
    let _ = app.emit("health:status", v);
}

/// Starts serve and keeps it running; restarts with backoff (1 s doubling to 30 s) if it exits.
fn supervise(app: AppHandle, shell: Arc<Shell>) {
    let mut backoff = 1;
    while !shell.quitting.load(Ordering::SeqCst) {
        if shell.paused.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
        let spawned = core_command()
            .args(["serve", "--exit-with-parent"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let started = std::time::Instant::now();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                *shell.last_error.lock().unwrap() = Some(format!("cannot start the health core: {e}"));
                status(&app, &shell, false, json!({}));
                std::thread::sleep(Duration::from_secs(backoff));
                backoff = (backoff * 2).min(30);
                continue;
            }
        };
        *shell.last_error.lock().unwrap() = None; // only this child's errors count
        let (out, err) = (child.stdout.take(), child.stderr.take());
        // recorded before the handshake: Clear data meanwhile stops this core too, instead of wiping under it
        *shell.child.lock().unwrap() = Some(child);
        let kill = || {
            if let Some(c) = shell.child.lock().unwrap().as_mut() {
                let _ = c.kill();
            }
        };
        // the core's last error line, for the UI ("no_profile: …", "running: …")
        if let Some(err) = err {
            let s = shell.clone();
            std::thread::spawn(move || {
                for l in BufReader::new(err).lines().map_while(Result::ok) {
                    let l = l.trim_start_matches("error: ").to_string();
                    if !l.is_empty() {
                        *s.last_error.lock().unwrap() = Some(l);
                    }
                }
            });
        }
        let mut line = String::new();
        let ready = out.map(|o| BufReader::new(o).read_line(&mut line).is_ok_and(|n| n > 0)).unwrap_or(false);
        let info: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        if let (true, Some(port), Some(token)) = (ready, info["port"].as_u64(), info["token"].as_str()) {
            let conn = Conn { port: port as u16, token: token.into() };
            // handshake: refuse a core that speaks another API major version (plan §7)
            let meta = http(&conn, "GET", "/v1/meta", "");
            let mismatch = matches!(&meta, Ok((_, m)) if m["api"] != 1);
            if let Ok((_, m)) = &meta
                && m["api"] == 1
            {
                *shell.last_error.lock().unwrap() = None;
                *shell.conn.lock().unwrap() = Some(conn.clone());
                status(&app, &shell, true, json!({ "locked": info["locked"] }));
                let (a, c) = (app.clone(), conn);
                std::thread::spawn(move || relay_events(&a, &c));
            } else {
                *shell.last_error.lock().unwrap() = Some(if mismatch {
                    "the bundled core speaks another API version; reinstall PhysiMind".into()
                } else {
                    "cannot reach the health core; retrying".into()
                });
                status(&app, &shell, false, json!({}));
                kill();
            }
        } else {
            // no handshake line: a core that will never answer; restart it rather than wait forever
            kill();
        }
        loop {
            std::thread::sleep(Duration::from_millis(300));
            let mut g = shell.child.lock().unwrap();
            match g.as_mut().map(|c| c.try_wait()) {
                Some(Ok(None)) => continue,
                _ => {
                    g.take();
                    break;
                }
            }
        }
        let ran = started.elapsed(); // how long this core lived, before any waiting below
        *shell.conn.lock().unwrap() = None;
        std::thread::sleep(Duration::from_millis(200)); // let the stderr reader catch the last line
        let err = shell.last_error.lock().unwrap().clone().unwrap_or_default();
        let need_init = err.starts_with("no_profile");
        if shell.paused.load(Ordering::SeqCst) {
            // stopped for "Clear data": start again as soon as it's done, without a "starting" screen meanwhile
            backoff = 1;
            continue;
        }
        status(&app, &shell, false, json!({ "need_init": need_init }));
        // a core that ran a good while gets a fresh start; one that dies at once backs off further each time
        if ran >= Duration::from_secs(30) {
            backoff = 1;
        }
        // a missing profile is fixed by the person, so check back quickly once they create it
        std::thread::sleep(Duration::from_secs(if need_init { 1 } else { backoff }));
        if !need_init && ran < Duration::from_secs(30) {
            backoff = (backoff * 2).min(30);
        }
    }
}

/// An empty unified NSToolbar: the window gets the macOS toolbar-window shape (larger corners, traffic lights
/// centred in a taller title area). The title bar stays transparent over the content (tauri.conf.json).
#[cfg(target_os = "macos")]
fn native_toolbar(w: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSToolbar, NSWindow, NSWindowToolbarStyle};
    let (Ok(ptr), Some(mtm)) = (w.ns_window(), objc2_foundation::MainThreadMarker::new()) else { return };
    // SAFETY: tauri hands out the live NSWindow of this window; setup runs on the main thread (checked above).
    let win: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let toolbar = NSToolbar::new(mtm);
    win.setToolbar(Some(&toolbar));
    win.setToolbarStyle(NSWindowToolbarStyle::Unified);
}

/// The menu bar's words, per interface language (the UI's own text is in gui/src/locales).
fn words(lang: &str) -> impl Fn(&str) -> String + '_ {
    move |en: &str| {
        let (hans, hant) = match en {
            // the app's name isn't translated
            "PhysiMind" => ("PhysiMind", "PhysiMind"),
            "About PhysiMind" => ("关于 PhysiMind", "關於 PhysiMind"),
            "Services" => ("服务", "服務"),
            "Hide PhysiMind" => ("隐藏 PhysiMind", "隱藏 PhysiMind"),
            "Hide Others" => ("隐藏其他", "隱藏其他"),
            "Show All" => ("全部显示", "全部顯示"),
            "Quit PhysiMind" => ("退出 PhysiMind", "結束 PhysiMind"),
            "Edit" => ("编辑", "編輯"),
            "Undo" => ("撤销", "還原"),
            "Redo" => ("重做", "重做"),
            "Cut" => ("剪切", "剪下"),
            "Copy" => ("拷贝", "拷貝"),
            "Paste" => ("粘贴", "貼上"),
            "Select All" => ("全选", "全選"),
            "View" => ("显示", "顯示方式"),
            "Enter Full Screen" => ("进入全屏幕", "進入全螢幕"),
            "Go" => ("前往", "前往"),
            "Dashboard" => ("看板", "看板"),
            "Data sources" => ("数据来源", "數據來源"),
            "Profile" => ("个人资料", "個人資料"),
            "Backup" => ("备份", "備份"),
            "Agent access" => ("Agent 访问", "Agent 訪問"),
            "Identity code" => ("身份码", "身份碼"),
            "About" => ("关于", "關於"),
            "Back" => ("返回", "返回"),
            "Find a measure" => ("查找指标", "查找指標"),
            "Import a file…" => ("导入文件…", "導入文件…"),
            "Window" => ("窗口", "視窗"),
            "Minimize" => ("最小化", "縮到最小"),
            "Zoom" => ("缩放", "縮放"),
            "Close Window" => ("关闭窗口", "關閉視窗"),
            _ => (en, en),
        };
        match lang {
            "zh-Hans" => hans.to_string(),
            "zh-Hant" => hant.to_string(),
            _ => en.to_string(),
        }
    }
}

/// The macOS menu bar in `lang`: the standard menus, plus "Go" with the sections' shortcuts.
#[cfg(target_os = "macos")]
fn menu(app: &AppHandle, lang: &str) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem as P, Submenu};
    let w = words(lang);
    let item = |id: &str, label: &str, key: &str| MenuItem::with_id(app, format!("ui:{id}"), w(label), true, Some(key));
    let health = Submenu::with_items(
        app,
        w("PhysiMind"),
        true,
        &[
            &P::about(app, Some(&w("About PhysiMind")), Some(AboutMetadata { name: Some("PhysiMind".into()), ..Default::default() }))?,
            &P::separator(app)?,
            &P::services(app, Some(&w("Services")))?,
            &P::separator(app)?,
            &P::hide(app, Some(&w("Hide PhysiMind")))?,
            &P::hide_others(app, Some(&w("Hide Others")))?,
            &P::show_all(app, Some(&w("Show All")))?,
            &P::separator(app)?,
            &P::quit(app, Some(&w("Quit PhysiMind")))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        w("Edit"),
        true,
        &[
            &P::undo(app, Some(&w("Undo")))?,
            &P::redo(app, Some(&w("Redo")))?,
            &P::separator(app)?,
            &P::cut(app, Some(&w("Cut")))?,
            &P::copy(app, Some(&w("Copy")))?,
            &P::paste(app, Some(&w("Paste")))?,
            &P::select_all(app, Some(&w("Select All")))?,
        ],
    )?;
    let view = Submenu::with_items(app, w("View"), true, &[&P::fullscreen(app, Some(&w("Enter Full Screen")))?])?;
    let go = Submenu::with_items(
        app,
        w("Go"),
        true,
        &[
            &item("readings", "Dashboard", "CmdOrCtrl+1")?,
            &item("data", "Data sources", "CmdOrCtrl+2")?,
            &item("backup", "Backup", "CmdOrCtrl+3")?,
            &item("profile", "Profile", "CmdOrCtrl+4")?,
            &item("id", "Identity code", "CmdOrCtrl+5")?,
            &item("agents", "Agent access", "CmdOrCtrl+6")?,
            &item("about", "About", "CmdOrCtrl+7")?,
            &P::separator(app)?,
            &item("back", "Back", "CmdOrCtrl+[")?,
            &item("find", "Find a measure", "CmdOrCtrl+F")?,
            &item("import", "Import a file…", "CmdOrCtrl+O")?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        w("Window"),
        true,
        &[
            &P::minimize(app, Some(&w("Minimize")))?,
            &P::maximize(app, Some(&w("Zoom")))?,
            &P::separator(app)?,
            &P::close_window(app, Some(&w("Close Window")))?,
        ],
    )?;
    Menu::with_items(app, &[&health, &edit, &view, &go, &window])
}

/// A phone's update check (mobile.rs): a computer updates as a whole app (Tauri's updater, later).
#[tauri::command]
pub(crate) fn check_update() -> Result<Value, Value> {
    Err(json!({ "code": "no_op", "message": "not on a computer" }))
}

#[tauri::command]
pub(crate) fn open_update(url: String) -> Result<(), Value> {
    let _ = url;
    Err(json!({ "code": "no_op", "message": "not on a computer" }))
}

/// A phone's WHOOP sign-in (mobile.rs): a computer's goes through serve (`whoop.begin` with `open`).
#[tauri::command]
pub(crate) fn whoop_sign_in(client_id: String, client_secret: String) -> Result<Value, Value> {
    let _ = (client_id, client_secret);
    Err(json!({ "code": "no_op", "message": "a computer signs in to WHOOP through whoop.begin" }))
}

/// Opens one of `LINKS` in the default browser.
#[tauri::command]
pub(crate) fn open_link(url: String) -> Result<(), String> {
    if !crate::LINKS.contains(&url.as_str()) {
        return Err("not an allowed link".into());
    }
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&url).status();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&url).status();
    r.map(|_| ()).map_err(|e| e.to_string())
}

/// The UI's language changed (or the page loaded): the menu bar and the window title follow it.
#[tauri::command]
pub(crate) fn set_language(app: AppHandle, lang: String) -> Result<(), String> {
    let lang = match lang.as_str() {
        "zh-Hans" | "zh-Hant" => lang,
        _ => "en".to_string(),
    };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_title(&words(&lang)("PhysiMind"));
    }
    #[cfg(target_os = "macos")]
    app.set_menu(menu(&app, &lang).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn run(builder: tauri::Builder<tauri::Wry>) {
    let shell = Arc::new(Shell::default());
    let app = builder
        // one app at a time: a second one would start its own core, which finds the profile held and is restarted
        // forever; opening it again shows the window already open (first, as the plugin requires)
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // size and place are remembered; visibility is not (a window hidden by ⌘W must come back on launch)
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        .manage(shell.clone())
        // Health is an app you open and close, not a background service: no tray icon, and closing the window
        // quits (Tauri's default). Agents don't need it running: `health mcp` opens the store itself.
        .on_menu_event(|app, e| {
            if let Some(id) = e.id().as_ref().strip_prefix("ui:") {
                let _ = app.emit("menu", id);
            }
        })
        .setup(|app| {
            // macOS: the standard menus plus "Go", whose shortcuts the UI shows (in the UI's language, which
            // set_language sends once the page has loaded). Elsewhere the window has no menu bar and the UI
            // handles the same keys itself.
            #[cfg(target_os = "macos")]
            {
                if let Some(w) = app.get_webview_window("main") {
                    native_toolbar(&w);
                }
                app.set_menu(menu(app.handle(), "en")?)?;
            }
            let (handle, s) = (app.handle().clone(), app.state::<Arc<Shell>>().inner().clone());
            std::thread::spawn(move || supervise(handle, s));
            // agents connected before the app was renamed or moved find its program again (a release build only:
            // a development build must not point real configs at itself)
            if !cfg!(debug_assertions) {
                std::thread::spawn(|| {
                    if let Some(r) = clients::Roots::os() {
                        clients::repoint(&r, &core_bin().to_string_lossy());
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri app");
    app.run(move |_, e| {
        if let RunEvent::Exit = e {
            shell.quitting.store(true, Ordering::SeqCst);
            // as stop_core: the core finishes the step it is in (a network op, a LAN sync merge) and exits; killed
            // only if it hasn't after a moment
            if let Some(mut c) = shell.child.lock().unwrap().take() {
                drop(c.stdin.take());
                let t = std::time::Instant::now();
                while matches!(c.try_wait(), Ok(None)) && t.elapsed() < Duration::from_secs(3) {
                    std::thread::sleep(Duration::from_millis(50));
                }
                let _ = c.kill();
            }
        }
    });
}

/// Mobile only: desktop saves through the native save dialog.
#[tauri::command]
pub(crate) fn share_file(path: String, mime: String) -> Result<(), String> {
    let _ = (path, mime);
    Err("sharing is for the mobile apps".into())
}
