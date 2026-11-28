//! Mobile host: the runtime in this process, behind the same commands and events as the desktop shell.
//! Keys come from the native platform plugin; app lifecycle goes to the runtime, which decides when to lock.

use health_runtime::{Error, Key, KeyStore, Lifecycle, Opts, Platform, Result, RootKeys, Runtime, error_json};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, WindowEvent, Wry};
use tauri_plugin_health_platform::HealthPlatformExt;

/// In the background longer than this, the profile closes and needs unlocking again.
const LOCK_AFTER_MS: i64 = 5 * 60 * 1000;

/// One runtime per process, set once it exists (built off the main thread: opening asks the native key store).
/// It outlives the app's UI: Android may rebuild the activity, and with it the Tauri app, in the same process.
static RUNTIME: OnceLock<Arc<Runtime>> = OnceLock::new();
/// The current app, where events go.
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

fn runtime(_app: &AppHandle) -> std::result::Result<Arc<Runtime>, Value> {
    RUNTIME.get().cloned().ok_or_else(|| json!({ "code": "unavailable", "message": "the health core is starting" }))
}

#[tauri::command(async)]
pub(crate) fn op(app: AppHandle, name: String, req: Value, background: Option<bool>) -> std::result::Result<Value, Value> {
    if !name.chars().all(|c| c.is_ascii_lowercase() || c == '.' || c == '_') || name.starts_with("runtime.") {
        return Err(json!({ "code": "no_op", "message": name }));
    }
    let opts = Opts { background: background == Some(true), ..Opts::default() };
    runtime(&app)?.owner(&name, &req, opts).map(|o| o.value).map_err(|e| error_json(&e))
}

/// The passphrase is unused on mobile: Face ID / fingerprint / device passcode goes here, before the runtime opens.
#[tauri::command(async)]
pub(crate) fn unlock(app: AppHandle, passphrase: String) -> std::result::Result<Value, Value> {
    let _ = passphrase;
    runtime(&app)?.unlock(None).map(|()| Value::Null).map_err(|e| error_json(&e))
}

#[tauri::command(async)]
pub(crate) fn init_profile(app: AppHandle) -> std::result::Result<(), Value> {
    runtime(&app)?.owner("runtime.init", &Value::Null, Opts::default()).map(|_| ()).map_err(|e| error_json(&e))
}

#[tauri::command(async)]
pub(crate) fn clear_data(app: AppHandle, confirm: String) -> std::result::Result<(), Value> {
    let out = runtime(&app)?.owner("runtime.wipe", &json!({ "confirm": confirm }), Opts::default());
    // the data is gone even when only its key couldn't be removed
    if out.as_ref().is_ok() || out.as_ref().is_err_and(|e| e.code == "key_not_deleted") {
        crate::clear_cache(&app);
    }
    out.map(|_| ()).map_err(|e| error_json(&e))
}

/// Desktop-only commands: agents connect to a phone through its own LAN interface, not an MCP config here.
#[tauri::command]
pub(crate) fn core_path() -> String {
    String::new()
}

#[tauri::command]
pub(crate) fn agent_clients() -> Value {
    json!([])
}

#[tauri::command]
pub(crate) fn connect_agent(id: String, token: String) -> std::result::Result<String, String> {
    let _ = (id, token);
    Err("agent connect is desktop only".into())
}

/// Is the OCR component (models) on this device?
#[tauri::command(async)]
pub(crate) fn ocr_status(app: AppHandle) -> std::result::Result<Value, Value> {
    Ok(health_runtime::ocr::status(runtime(&app)?.data_dir()))
}

/// Downloads and checks the OCR component (health-connect, the one crate that opens connections).
#[tauri::command(async)]
pub(crate) fn ocr_install(app: AppHandle, matching: bool) -> std::result::Result<Value, Value> {
    let mut last = u64::MAX;
    health_runtime::ocr::install(runtime(&app)?.data_dir(), None, matching, &mut |done, total| {
        // a percent at a time: the bar needs no more
        let pct = done * 100 / total.max(1);
        if pct != last {
            last = pct;
            relay("ocr_progress", json!({ "stage": "download", "done": done, "total": total }));
        }
    })
    .map_err(|e| error_json(&e))
}

#[tauri::command]
pub(crate) fn set_language(lang: String) -> std::result::Result<(), String> {
    let _ = lang;
    Ok(())
}

/// Opens one of the shell's allowed links in the browser (the web view itself can't open pages).
#[tauri::command]
pub(crate) fn open_link(app: AppHandle, url: String) -> std::result::Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !crate::LINKS.contains(&url.as_str()) {
        return Err("not an allowed link".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// The system share sheet for a file the app wrote (an export, a backup).
#[tauri::command(async)]
pub(crate) fn share_file(app: AppHandle, path: String, mime: String) -> std::result::Result<(), String> {
    app.health_platform().share(&path, &mime)
}

/// `RootKeys` over the native plugin: Keychain on iOS, Keystore on Android.
struct NativeKeys(AppHandle);

impl KeyStore for NativeKeys {
    fn kind(&self) -> &'static str {
        if cfg!(target_os = "ios") { "keychain" } else { "keystore" }
    }

    fn load(&self, id: &str) -> Result<Option<Key>> {
        let Some(hex_key) = self.0.health_platform().key_load(id).map_err(store_err)? else {
            return Ok(None);
        };
        let mut k = Key::default();
        hex::decode_to_slice(hex_key.trim(), &mut k[..]).map_err(|_| store_err("stored key is not 32 bytes".into()))?;
        Ok(Some(k))
    }

    fn store(&self, id: &str, key: &Key) -> Result<()> {
        self.0.health_platform().key_store(id, &hex::encode(&key[..])).map_err(store_err)
    }
}

impl RootKeys for NativeKeys {
    fn delete(&self, id: &str) -> Result<()> {
        self.0.health_platform().key_delete(id).map_err(store_err)
    }
}

fn store_err(e: String) -> Error {
    Error::new(health_runtime::Kind::Locked, "keystore", e)
}

/// Runtime events in the desktop shell's event names, so the UI treats both hosts alike.
fn relay(event: &str, data: Value) {
    let Some(app) = APP.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return };
    if event != "status" {
        let _ = app.emit(&format!("health:{event}"), data);
        return;
    }
    let status = match data["state"].as_str() {
        Some("no_profile") => json!({ "up": true, "need_init": true }),
        Some("locked") => json!({ "up": true, "locked": true }),
        Some("ready") => json!({ "up": true }),
        _ => json!({ "up": false, "error": data["error"]["message"] }),
    };
    let _ = app.emit("health:status", status);
}

/// What other devices show for this one (they translate it, as "Health for Mac").
fn device_name() -> String {
    if cfg!(target_os = "ios") { "Health for iPhone".into() } else { "Health for Android".into() }
}

pub(crate) fn run(builder: tauri::Builder<Wry>) {
    builder
        .plugin(tauri_plugin_health_platform::init())
        .plugin(tauri_plugin_barcode_scanner::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            *APP.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle.clone());
            if RUNTIME.get().is_some() {
                return Ok(()); // a rebuilt activity: the runtime is already up
            }
            crate::clear_cache(&handle); // what the last run staged or exported
            let data_dir = app.path().app_data_dir()?;
            std::thread::spawn(move || {
                let recognize = health_runtime::ocr::in_process(&data_dir, |page, pages| {
                    relay("ocr_progress", json!({ "stage": "read", "done": page, "total": pages }));
                });
                let mut platform = Platform::system(data_dir, Box::new(NativeKeys(handle)), Some(LOCK_AFTER_MS));
                platform.recognize = recognize;
                platform.device_name = device_name();
                let _ = RUNTIME.set(Runtime::new(platform, relay));
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            let Ok(rt) = runtime(window.app_handle()) else { return };
            match event {
                // iOS: willResignActive, Android: onPause. A timestamp only, so it stays on this thread.
                WindowEvent::Suspended => rt.lifecycle(Lifecycle::Background),
                // iOS: didBecomeActive / willEnterForeground, Android: onResume / focus. Returning may close the
                // profile, which waits for a running op: keep that off the UI thread.
                WindowEvent::Resumed | WindowEvent::Focused(true) => {
                    std::thread::spawn(move || rt.lifecycle(Lifecycle::Foreground));
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("tauri app");
}
