//! The health backend at the OS edge: the one allowed base (health-connect) or `offline`.

use health_api::account::{Backend, Config, Reply};
use health_proto::result::LabKey;
use serde_json::Value;

/// health-connect to the configured base.
pub struct Connect(health_connect::Backend);

impl Backend for Connect {
    fn get(&self, path: &str) -> Reply {
        self.0.get(path)
    }
    fn post(&self, path: &str, json: &str) -> Reply {
        self.0.post(path, json)
    }
    fn raw(&self, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> std::result::Result<(u16, Value), String> {
        self.0.raw(method, path, headers, body)
    }
}

/// Offline: every request refused before it leaves the device.
pub struct Offline;

impl Backend for Offline {
    fn get(&self, _: &str) -> Reply {
        Err("offline".into())
    }
    fn post(&self, _: &str, _: &str) -> Reply {
        Err("offline".into())
    }
    fn raw(&self, _: &str, _: &str, _: &[(&str, &str)], _: &str) -> std::result::Result<(u16, Value), String> {
        Err("offline".into())
    }
}

/// The built-in development backend. Debug builds also take HEALTH_BACKEND (a loopback mock in tests),
/// HEALTH_LAB_KEYS (`did:key:…:lab` or `:room`, separated by `;`) and HEALTH_ATT_KEY (base64url).
pub fn config() -> Config {
    let mut c = Config::builtin();
    if cfg!(debug_assertions)
        && let Ok(base) = std::env::var("HEALTH_BACKEND")
    {
        let keys = std::env::var("HEALTH_LAB_KEYS").unwrap_or_default();
        let lab_keys = keys
            .split(';')
            .filter(|k| !k.trim().is_empty())
            .filter_map(|k| {
                let (key, may) = k.trim().rsplit_once(':')?;
                Some(LabKey { key: key.to_string(), may: may.split('+').map(String::from).collect() })
            })
            .collect();
        let att = std::env::var("HEALTH_ATT_KEY").ok().and_then(|k| health_proto::b64::unb64u(&k)).and_then(|k| k.try_into().ok());
        c = Config::new(&base, lab_keys, att);
    }
    c
}

pub fn backend(offline: bool, c: &Config) -> Box<dyn Backend> {
    if offline { Box::new(Offline) } else { Box::new(Connect(health_connect::Backend::new(&c.base))) }
}
