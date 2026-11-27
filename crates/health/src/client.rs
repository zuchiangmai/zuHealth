//! Loopback client for a running `health serve`: plain HTTP/1.1 over std::net to 127.0.0.1 only.

use health_core::{Error, Kind, Result};
use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

pub struct Serve {
    pub port: u16,
    /// Owner token (keychain mode only; passphrase mode proves the passphrase instead)
    pub token: Option<String>,
}

fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // signal 0 only checks that the process exists
        unsafe { libc::kill(pid as i32, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

/// The serve for this profile, if one is really running: its pid is alive and it answers with the id from serve.json.
/// A stale file is removed, so no credential is ever sent to whatever took over the port.
pub fn probe(profile_dir: &Path) -> Option<Serve> {
    let file = profile_dir.join("serve.json");
    let info: Value = serde_json::from_slice(&std::fs::read(&file).ok()?).ok()?;
    let port = info["port"].as_u64()? as u16;
    let id = info["id"].as_str()?.to_string();
    let pid = info["pid"].as_u64()? as u32;
    let s = Serve { port, token: info["token"].as_str().map(String::from) };
    let ok = alive(pid)
        && s.call("GET", "/v1/meta", &[], b"")
            .ok()
            .and_then(|(_, b)| serde_json::from_slice::<Value>(&b).ok())
            .is_some_and(|m| m["id"] == id.as_str());
    if !ok {
        if !alive(pid) {
            let _ = std::fs::remove_file(&file);
        }
        return None;
    }
    Some(s)
}

pub fn kind_of(status: u16) -> Kind {
    match status {
        400 => Kind::Usage,
        401 | 403 => Kind::Denied,
        404 => Kind::NotFound,
        409 => Kind::Conflict,
        422 => Kind::Invalid,
        423 => Kind::Locked,
        _ => Kind::Other,
    }
}

impl Serve {
    /// One request; returns (status, body).
    pub fn call(&self, method: &str, path: &str, headers: &[(&str, String)], body: &[u8]) -> Result<(u16, Vec<u8>)> {
        let mut s = TcpStream::connect_timeout(&([127, 0, 0, 1], self.port).into(), Duration::from_secs(2))?;
        s.set_read_timeout(Some(Duration::from_secs(600)))?;
        let mut head =
            format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nContent-Length: {}\r\n", self.port, body.len());
        for (k, v) in headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        s.write_all(head.as_bytes())?;
        s.write_all(body)?;
        let mut raw = Vec::new();
        s.read_to_end(&mut raw)?;
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| Error::other("serve", "bad response"))?;
        let head = String::from_utf8_lossy(&raw[..split]);
        let status: u16 = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| Error::other("serve", "bad status"))?;
        let mut body = raw[split + 4..].to_vec();
        if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
            body = dechunk(&body);
        }
        Ok((status, body))
    }

    /// Runs an op on the serve; returns (value, withheld).
    pub fn op(&self, auth: (&str, String), name: &str, req: &Value, dry_run: bool) -> Result<(Value, Option<Value>)> {
        let mut h = vec![(auth.0, auth.1), ("Content-Type", "application/json".into())];
        if dry_run {
            h.push(("X-Health-Dry-Run", "1".into()));
        }
        let (status, body) = self.call("POST", &format!("/v1/op/{name}"), &h, req.to_string().as_bytes())?;
        let v: Value = serde_json::from_slice(&body).map_err(|_| Error::other("serve", "bad JSON from serve"))?;
        if status == 200 {
            return Ok((v["value"].clone(), v.get("withheld").cloned().filter(|w| !w.is_null())));
        }
        let code = v["error"]["code"].as_str().unwrap_or("serve").to_string();
        Err(Error::new(kind_of(status), Box::leak(code.into_boxed_str()), v["error"]["message"].as_str().unwrap_or("").to_string()))
    }
}

fn dechunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(i) = b.windows(2).position(|w| w == b"\r\n") {
        let n = usize::from_str_radix(String::from_utf8_lossy(&b[..i]).trim(), 16).unwrap_or(0);
        if n == 0 || b.len() < i + 2 + n {
            break;
        }
        out.extend_from_slice(&b[i + 2..i + 2 + n]);
        b = &b[(i + 4 + n).min(b.len())..];
    }
    out
}
