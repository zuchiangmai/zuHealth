//! The only crate that opens network connections (plan §2.2, `scripts/check-no-net.sh`). For now it downloads
//! the OCR components the person asked to install. Requests carry no user information; certificates are
//! checked against the operating system's trust store.

pub mod lan;

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;

#[derive(Debug)]
pub enum Error {
    /// Couldn't reach the server, or it refused
    Network(String),
    /// The file arrived but isn't the pinned one (size or SHA-256): discarded
    Integrity(String),
    Io(std::io::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Network(m) => write!(f, "network: {m}"),
            Error::Integrity(m) => write!(f, "integrity: {m}"),
            Error::Io(e) => write!(f, "io: {e}"),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

/// Which certificates are trusted: the OS's verifier, except on Android, where it would need a JVM handle and a
/// Kotlin component wired into the app; there the bundled Mozilla roots (webpki-roots) are used instead.
fn roots() -> ureq::tls::RootCerts {
    if cfg!(target_os = "android") { ureq::tls::RootCerts::WebPki } else { ureq::tls::RootCerts::PlatformVerifier }
}

fn agent() -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder().root_certs(roots()).build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .user_agent("health-desktop")
        // each address gets 15 s to connect, so an unreachable one (often IPv6) gives way to the next
        .timeout_connect(Some(std::time::Duration::from_secs(15)))
        .timeout_global(Some(std::time::Duration::from_secs(1800)))
        .build()
        .into()
}

/// Downloads `url` to `dest` only if it is exactly `bytes` long with SHA-256 `sha256`. Written to a
/// temporary file next to `dest` first, so a broken download never leaves a half file under the real name.
/// `progress(done, total)` as bytes arrive.
pub fn download(url: &str, dest: &Path, sha256: &str, bytes: u64, progress: &mut dyn FnMut(u64, u64)) -> Result<(), Error> {
    let mut res = agent().get(url).call().map_err(|e| Error::Network(e.to_string()))?;
    let mut body = res.body_mut().with_config().limit(bytes + 1).reader();
    let tmp = dest.with_extension("part");
    let mut out = std::fs::File::create(&tmp)?;
    let mut hash = Sha256::new();
    let mut done = 0u64;
    let mut buf = vec![0u8; 1 << 16];
    let result = (|| -> Result<(), Error> {
        loop {
            let n = body.read(&mut buf).map_err(|e| Error::Network(e.to_string()))?;
            if n == 0 {
                break;
            }
            done += n as u64;
            if done > bytes {
                return Err(Error::Integrity(format!("{url}: larger than expected")));
            }
            hash.update(&buf[..n]);
            out.write_all(&buf[..n])?;
            progress(done, bytes);
        }
        out.sync_all()?;
        let got = hex::encode(hash.finalize_reset());
        if done != bytes || got != sha256 {
            return Err(Error::Integrity(format!("{url}: got {done} bytes, sha256 {got}")));
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            std::fs::rename(&tmp, dest)?;
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// The health backend (protocol 0): JSON to one base URL, no redirects (a signed request never goes to another
/// host). Failures are codes only: transport messages carry URLs with the channel or the inbox key, so they are
/// never passed on.
pub struct Backend {
    base: String,
    agent: ureq::Agent,
}

/// The backend's reply: its JSON object, or a code (the protocol's `{err}` codes, or `network` / `server`).
pub type Reply = Result<serde_json::Value, String>;

/// Largest reply read: an inbox page holds up to 16 MB of ciphertext, about 22 MB as base64 in JSON.
const MAX_REPLY: u64 = 32 * 1024 * 1024;
const CODES: [&str; 8] = ["bad", "auth", "unknown", "busy", "gone", "clock", "slow", "upstream"];

impl Backend {
    /// `base` without a trailing slash, e.g. `https://api-dev-health.4seas.xyz`.
    pub fn new(base: &str) -> Backend {
        let tls = ureq::tls::TlsConfig::builder().root_certs(roots()).build();
        let agent = ureq::Agent::config_builder()
            .tls_config(tls)
            .user_agent("health-desktop")
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_connect(Some(std::time::Duration::from_secs(15)))
            .timeout_global(Some(std::time::Duration::from_secs(60)))
            .build()
            .into();
        Backend { base: base.trim_end_matches('/').to_string(), agent }
    }

    pub fn get(&self, path: &str) -> Reply {
        read(self.agent.get(format!("{}{path}", self.base)).call())
    }

    /// Any status back (the WHOOP relay passes WHOOP's replies through): `(status, JSON or null)`.
    pub fn raw(&self, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Result<(u16, serde_json::Value), String> {
        let url = format!("{}{path}", self.base);
        let res = if method == "POST" {
            let mut rq = self.agent.post(&url);
            for (k, v) in headers {
                rq = rq.header(*k, *v);
            }
            rq.send(body)
        } else {
            let mut rq = self.agent.get(&url);
            for (k, v) in headers {
                rq = rq.header(*k, *v);
            }
            rq.call()
        };
        let mut res = res.map_err(|_| "network".to_string())?;
        let status = res.status().as_u16();
        let text = res.body_mut().with_config().limit(MAX_REPLY).read_to_string().map_err(|_| "network".to_string())?;
        Ok((status, serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)))
    }

    pub fn post(&self, path: &str, json: &str) -> Reply {
        read(self.agent.post(format!("{}{path}", self.base)).header("content-type", "application/json").send(json))
    }
}

fn read(res: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Reply {
    let mut res = res.map_err(|_| "network".to_string())?;
    let ok = res.status().is_success();
    let text = res.body_mut().with_config().limit(MAX_REPLY).read_to_string().map_err(|_| "network".to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|_| "server".to_string())?;
    if let Some(e) = v.get("err").and_then(|e| e.as_str()) {
        return Err(if CODES.contains(&e) { e.to_string() } else { "server".into() });
    }
    if ok && v.is_object() { Ok(v) } else { Err("server".into()) }
}
