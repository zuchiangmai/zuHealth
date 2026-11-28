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

/// Starts WHOOP's sign-in on a phone and opens WHOOP's page in the browser (only that page: the address comes from
/// the core, and the web view opens no pages). WHOOP returns to the site's page, which opens the app; the UI then
/// finishes with `whoop.complete`.
#[tauri::command(async)]
pub(crate) fn whoop_sign_in(app: AppHandle, client_id: String, client_secret: String) -> std::result::Result<Value, Value> {
    use tauri_plugin_opener::OpenerExt;
    let r = runtime(&app)?
        .owner("whoop.begin", &json!({ "client_id": client_id, "client_secret": client_secret, "app": true }), Opts::default())
        .map_err(|e| error_json(&e))?;
    let url = r.value["url"].as_str().unwrap_or_default();
    // health-api whoop::AUTH_URL
    if !url.starts_with("https://api.prod.whoop.com/oauth/oauth2/auth?") {
        return Err(json!({ "code": "whoop_url", "message": "not WHOOP's sign-in page" }));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| json!({ "code": "open_failed", "message": e.to_string() }))?;
    Ok(json!({ "redirect": r.value["redirect"] }))
}

/// Whether GitHub has a newer app (Android: the person installs the APK; iOS updates through the App Store, so it
/// isn't asked there). Only when the person asks.
#[tauri::command(async)]
pub(crate) fn check_update(app: AppHandle) -> std::result::Result<Value, Value> {
    if cfg!(target_os = "ios") {
        return Err(json!({ "code": "no_op", "message": "updates come from the App Store" }));
    }
    let current = app.package_info().version.to_string();
    let u = health_runtime::update::check(&current).map_err(|_| json!({ "code": "network", "message": "" }))?;
    Ok(serde_json::to_value(u).unwrap_or(Value::Null))
}

/// Opens an update's package in the browser, which downloads it; Android then offers to install it. Only GitHub's
/// downloads of this app's repository.
#[tauri::command]
pub(crate) fn open_update(app: AppHandle, url: String) -> std::result::Result<(), Value> {
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with(health_runtime::update::DOWNLOADS) || url.contains("..") {
        return Err(json!({ "code": "bad_request", "message": "not this app's download" }));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| json!({ "code": "open_failed", "message": e.to_string() }))
}

/// The system share sheet for a file the app wrote (an export, a backup).
#[tauri::command(async)]
pub(crate) fn share_file(app: AppHandle, path: String, mime: String) -> std::result::Result<(), String> {
    app.health_platform().share(&path, &mime)
}

/// `RootKeys` over the native plugin: Keychain on iOS, Keystore on Android.
struct NativeKeys(AppHandle);

/// The app now: an activity rebuilt in the same process (Android) has a new handle, and the first one's plugin
/// holds the destroyed activity. The runtime outlives it, so the native services look it up each call.
fn current(first: &AppHandle) -> AppHandle {
    APP.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(|| first.clone())
}

impl NativeKeys {
    fn app(&self) -> AppHandle {
        current(&self.0)
    }
}

impl NativeHealth {
    fn app(&self) -> AppHandle {
        current(&self.0)
    }
}

/// The phone's health store through the platform plugin: HealthKit on iOS, Health Connect on Android (the same
/// plugin calls on both). Only glue: the runtime decides what to read and the core what it means.
struct NativeHealth(AppHandle);

impl health_runtime::syshealth::SystemHealth for NativeHealth {
    fn kind(&self) -> &'static str {
        if cfg!(target_os = "ios") { "healthkit" } else { "health_connect" }
    }
    fn available(&self) -> bool {
        self.app().health_platform().health_available()
    }
    fn authorize(&self) -> std::result::Result<(), String> {
        self.app().health_platform().health_authorize()
    }
    fn read(&self, from_ms: i64, to_ms: i64) -> std::result::Result<Vec<health_runtime::syshealth::Sample>, String> {
        let raw = self.app().health_platform().health_read(from_ms, to_ms)?;
        // a sample the core can't take is skipped, not the whole read
        Ok(raw.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect())
    }
    fn changed_days(&self, anchors: &mut Value, floor_ms: i64) -> std::result::Result<Vec<i64>, String> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        self.app().health_platform().health_changed(anchors, floor_ms, now)
    }
    fn earliest_ms(&self) -> i64 {
        self.app().health_platform().health_earliest().unwrap_or(0)
    }
    fn own(&self) -> std::result::Result<Vec<health_runtime::syshealth::Have>, String> {
        let raw = self.app().health_platform().health_own()?;
        Ok(raw.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect())
    }
    fn write(&self, samples: &[health_runtime::syshealth::Want]) -> std::result::Result<(), String> {
        self.app().health_platform().health_write(&serde_json::to_value(samples).map_err(|e| e.to_string())?)
    }
    fn delete(&self, ids: &[String]) -> std::result::Result<(), String> {
        self.app().health_platform().health_delete(ids)
    }
}

impl KeyStore for NativeKeys {
    fn kind(&self) -> &'static str {
        if cfg!(target_os = "ios") { "keychain" } else { "keystore" }
    }

    fn load(&self, id: &str) -> Result<Option<Key>> {
        let Some(hex_key) = self.app().health_platform().key_load(id).map_err(store_err)? else {
            return Ok(None);
        };
        let mut k = Key::default();
        hex::decode_to_slice(hex_key.trim(), &mut k[..]).map_err(|_| store_err("stored key is not 32 bytes".into()))?;
        Ok(Some(k))
    }

    fn store(&self, id: &str, key: &Key) -> Result<()> {
        self.app().health_platform().key_store(id, &hex::encode(&key[..])).map_err(store_err)
    }
}

impl RootKeys for NativeKeys {
    fn delete(&self, id: &str) -> Result<()> {
        self.app().health_platform().key_delete(id).map_err(store_err)
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
                // the data stays on this device: no iCloud backup or migration (its key can't follow it)
                #[cfg(target_os = "ios")]
                if let Err(e) = handle.health_platform().exclude_from_backup(&data_dir.to_string_lossy()) {
                    eprintln!("health: backup exclusion: {e}");
                }
                let recognize = health_runtime::ocr::in_process(&data_dir, |page, pages| {
                    relay("ocr_progress", json!({ "stage": "read", "done": page, "total": pages }));
                });
                let mut platform = Platform::system(data_dir, Box::new(NativeKeys(handle.clone())), Some(LOCK_AFTER_MS));
                platform.recognize = recognize;
                platform.system_health = Some(Box::new(NativeHealth(handle)));
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
