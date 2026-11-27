//! OCR at the OS edge: the component on disk, the `ocr-worker` process, and filling in `import.ocr`.
//! Recognition runs in a child process (`health ocr-worker`) with no key and no database: if it crashes or
//! runs out of memory, the writer is untouched (plan §2.1). Callers run it outside serve's profile lock.

use health_core::ocr::Recognized;
use health_core::{Error, Kind, Result};
use health_ocr::components;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub fn component_dir(data_dir: &Path) -> PathBuf {
    components::dir(data_dir)
}

fn missing() -> Error {
    Error::not_found("no_ocr_component", "the OCR component isn't installed: run `health component install ocr`")
}

/// `health ocr-worker`: one request on stdin ({path, dir, this_year}), one reply on stdout
/// ({sha, recognized} or {error: {code, message}}). Progress goes to stderr as codes only, never text read.
pub fn worker_main() -> i32 {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    // tests only (debug builds): the worker dies mid-job, as a crash in the models would
    if cfg!(debug_assertions) && std::env::var_os("HEALTH_OCR_WORKER_CRASH").is_some() {
        std::process::abort();
    }
    let reply = (|| -> std::result::Result<Value, (String, String)> {
        let req: Value = serde_json::from_str(&input).map_err(|e| ("bad_request".into(), e.to_string()))?;
        let path = req["path"].as_str().ok_or(("bad_request".to_string(), "path".to_string()))?;
        let dir = PathBuf::from(req["dir"].as_str().unwrap_or_default());
        let this_year = req["this_year"].as_i64().unwrap_or(2026) as i32;
        let bytes = std::fs::read(path).map_err(|_| ("no_file".to_string(), path.to_string()))?;
        let input = health_ocr::input::read_input(&bytes).map_err(|e| (e.code().to_string(), String::new()))?;
        if !components::ready(&dir) {
            return Err(("no_ocr_component".into(), String::new()));
        }
        let models = components::load(&dir).map_err(|e| ("ocr_component".to_string(), e.to_string()))?;
        let rec = health_ocr::recognize(&models, &input, this_year, &mut |page, pages| eprintln!("page {} of {pages}", page + 1))
            .map_err(|e| ("ocr_engine".to_string(), e.to_string()))?;
        Ok(json!({ "sha": input.sha, "recognized": rec }))
    })();
    let (out, code) = match reply {
        Ok(v) => (v, 0),
        Err((code, message)) => (json!({ "error": { "code": code, "message": message } }), 2),
    };
    println!("{out}");
    code
}

pub use health_runtime::ocr::file_sha;

/// Runs the worker on `path`; the file's SHA-256 and what was read.
pub fn recognize(data_dir: &Path, path: &Path, this_year: i32) -> Result<(String, Recognized)> {
    let dir = component_dir(data_dir);
    if !components::ready(&dir) {
        return Err(missing());
    }
    file_sha(&path.to_string_lossy())?;
    let exe = std::env::current_exe()?;
    let mut child = std::process::Command::new(exe)
        .arg("ocr-worker")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    let req = json!({ "path": path, "dir": dir, "this_year": this_year });
    child.stdin.take().expect("stdin").write_all(req.to_string().as_bytes())?;
    // a stuck worker is stopped: 12 pages take well under a minute
    let id = child.id();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        if rx.recv_timeout(std::time::Duration::from_secs(600)).is_err() {
            kill(id);
        }
    });
    let out = child.wait_with_output();
    let _ = tx.send(());
    let out = out?;
    let v: Value = serde_json::from_slice(&out.stdout)
        .map_err(|_| Error::other("ocr_crashed", "the recognizer stopped unexpectedly; your data is untouched"))?;
    if let Some(e) = v.get("error") {
        let code = e["code"].as_str().unwrap_or("ocr_failed");
        let (kind, code): (Kind, &'static str) = match code {
            "no_ocr_component" => return Err(missing()),
            "no_file" => (Kind::NotFound, "no_file"),
            "too_big" => (Kind::Invalid, "too_big"),
            "unsupported" => (Kind::Invalid, "unsupported"),
            "unreadable" => (Kind::Invalid, "unreadable"),
            "password" => (Kind::Invalid, "password"),
            "ocr_component" => (Kind::Other, "ocr_component"),
            _ => (Kind::Other, "ocr_failed"),
        };
        return Err(Error::new(kind, code, e["message"].as_str().unwrap_or("").to_string()));
    }
    let rec: Recognized = serde_json::from_value(v["recognized"].clone())?;
    if rec.items.is_empty() {
        return Err(Error::invalid("empty", "no lab results were found in this file"));
    }
    Ok((v["sha"].as_str().unwrap_or_default().to_string(), rec))
}

/// Completes an `import.ocr` request that has no `recognized` yet: runs the worker on its file.
pub fn fill(data_dir: &Path, req: &mut Value, this_year: i32) -> Result<()> {
    if req.get("recognized").is_some_and(|r| !r.is_null()) {
        return Ok(());
    }
    let path = req["path"].as_str().ok_or_else(|| Error::invalid("bad_request", "path"))?.to_string();
    let (_, rec) = recognize(data_dir, Path::new(&path), this_year)?;
    req["recognized"] = serde_json::to_value(rec)?;
    Ok(())
}

// Installing the component and its status live in health-runtime: the mobile apps install it too.
pub use health_runtime::ocr::{install, status};

fn kill(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output();
    }
}
