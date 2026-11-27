use serde::{Deserialize, Serialize};
use tauri::Runtime;
use tauri::plugin::mobile::PluginInvokeError;
use tauri::plugin::{PluginApi, PluginHandle};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_health_platform);

pub(crate) fn register<R: Runtime>(api: PluginApi<R, ()>) -> Result<NativePlatform<R>, PluginInvokeError> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.zuchiangmai.health.platform", "PlatformPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_health_platform)?;
    Ok(NativePlatform(handle))
}

/// The native side. Key values cross the bridge as hex strings (not zeroized on either side).
pub struct NativePlatform<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
struct KeyArgs<'a> {
    id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<&'a str>,
}

#[derive(Deserialize)]
struct Loaded {
    value: Option<String>,
}

impl<R: Runtime> NativePlatform<R> {
    /// The key stored under `id`, or None.
    pub fn key_load(&self, id: &str) -> Result<Option<String>, String> {
        let r: Loaded = self.0.run_mobile_plugin("keyLoad", KeyArgs { id, value: None }).map_err(|e| e.to_string())?;
        Ok(r.value)
    }

    /// Stores `value` under `id`, kept on this device only (never in backups).
    pub fn key_store(&self, id: &str, value: &str) -> Result<(), String> {
        self.run("keyStore", KeyArgs { id, value: Some(value) })
    }

    /// Forgets the key under `id`; a missing key is not an error.
    pub fn key_delete(&self, id: &str) -> Result<(), String> {
        self.run("keyDelete", KeyArgs { id, value: None })
    }

    /// The system share sheet for a file (Android: it must be in the app's cache directory).
    pub fn share(&self, path: &str, mime: &str) -> Result<(), String> {
        #[derive(Serialize)]
        struct ShareArgs<'a> {
            path: &'a str,
            mime: &'a str,
        }
        self.0.run_mobile_plugin::<serde::de::IgnoredAny>("share", ShareArgs { path, mime }).map(|_| ()).map_err(|e| e.to_string())
    }

    fn run(&self, command: &str, args: KeyArgs) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde::de::IgnoredAny>(command, args).map(|_| ()).map_err(|e| e.to_string())
    }
}
