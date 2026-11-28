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

    /// The phone's health store (HealthKit; Health Connect on Android): whether it is there.
    pub fn health_available(&self) -> bool {
        #[derive(Deserialize)]
        struct A {
            available: bool,
        }
        self.0.run_mobile_plugin::<A>("healthAvailable", ()).is_ok_and(|a| a.available)
    }

    /// The system's own sheet asking for access.
    pub fn health_authorize(&self) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde::de::IgnoredAny>("healthAuthorize", ()).map(|_| ()).map_err(|e| e.to_string())
    }

    /// The oldest sample the store gives (UTC ms).
    pub fn health_earliest(&self) -> Result<i64, String> {
        #[derive(Deserialize)]
        struct E {
            ms: f64,
        }
        self.0.run_mobile_plugin::<E>("healthEarliest", ()).map(|e| e.ms as i64).map_err(|e| e.to_string())
    }

    /// Samples starting in [from, to) (JSON as `health_runtime::syshealth::Sample` reads it).
    pub fn health_read(&self, from_ms: i64, to_ms: i64) -> Result<Vec<serde_json::Value>, String> {
        #[derive(Serialize)]
        struct R {
            from_ms: i64,
            to_ms: i64,
        }
        #[derive(Deserialize)]
        struct S {
            samples: Vec<serde_json::Value>,
        }
        self.0.run_mobile_plugin::<S>("healthRead", R { from_ms, to_ms }).map(|s| s.samples).map_err(|e| e.to_string())
    }

    /// UTC days holding samples added since `anchors` (replaced with the new ones).
    pub fn health_changed(&self, anchors: &mut serde_json::Value, floor_ms: i64, now_ms: i64) -> Result<Vec<i64>, String> {
        #[derive(Serialize)]
        struct C<'a> {
            anchors: &'a serde_json::Value,
            floor_ms: i64,
            now_ms: i64,
        }
        #[derive(Deserialize)]
        struct D {
            days: Vec<i64>,
            anchors: serde_json::Value,
        }
        let anchors_in = if anchors.is_object() { anchors.clone() } else { serde_json::json!({}) };
        let d: D = self.0.run_mobile_plugin("healthChanged", C { anchors: &anchors_in, floor_ms, now_ms }).map_err(|e| e.to_string())?;
        *anchors = d.anchors;
        Ok(d.days)
    }

    /// This app's own written samples in the store: [{id, version, value}].
    pub fn health_own(&self) -> Result<Vec<serde_json::Value>, String> {
        #[derive(Deserialize)]
        struct S {
            samples: Vec<serde_json::Value>,
        }
        self.0.run_mobile_plugin::<S>("healthOwn", ()).map(|s| s.samples).map_err(|e| e.to_string())
    }

    /// Writes samples (each `{id, kind, value, unit, start_ms, tz_min, version}`).
    pub fn health_write(&self, samples: &serde_json::Value) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde::de::IgnoredAny>("healthWrite", serde_json::json!({ "samples": samples }))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Deletes this app's samples with these ids.
    pub fn health_delete(&self, ids: &[String]) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde::de::IgnoredAny>("healthDelete", serde_json::json!({ "ids": ids }))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn run(&self, command: &str, args: KeyArgs) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde::de::IgnoredAny>(command, args).map(|_| ()).map_err(|e| e.to_string())
    }
}
