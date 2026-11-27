//! Lab report recognition for `import.ocr`. The runtime fills in `recognized` outside the profile lock; how it is
//! recognised is the platform's choice: desktop runs a worker process (a crash can't touch the writer), mobile runs
//! it in this process (iOS allows no child processes), with only the file's bytes and no profile handle.

use health_core::ocr::Recognized;
use health_core::{Error, Result};
use health_ocr::components;
use serde_json::{Value, json};
use std::path::Path;

/// Recognises the report at a path: its SHA-256 and what was read. `this_year` dates rows printed without a year.
pub type Recognize = Box<dyn Fn(&Path, i32) -> Result<(String, Recognized)> + Send + Sync>;

/// SHA-256 of a report file that is a regular file within the size limit (a FIFO or a huge file is refused
/// before anything reads it).
pub fn file_sha(path: &str) -> Result<String> {
    let meta = std::fs::metadata(path).map_err(|_| Error::not_found("no_file", path))?;
    if !meta.is_file() {
        return Err(Error::invalid("unsupported", "not a regular file"));
    }
    if meta.len() > health_ocr::input::MAX_BYTES {
        return Err(Error::invalid("too_big", "larger than 40 MB"));
    }
    Ok(health_ocr::input::sha256_hex(&std::fs::read(path)?))
}

/// Recognition in this process, with the OCR component under `data_dir`.
pub fn in_process(data_dir: &Path) -> Recognize {
    let dir = components::dir(data_dir);
    Box::new(move |path, this_year| {
        if !components::ready(&dir) {
            return Err(Error::not_found("no_ocr_component", "the OCR component isn't installed"));
        }
        file_sha(&path.to_string_lossy())?;
        let bytes = std::fs::read(path).map_err(|_| Error::not_found("no_file", path.to_string_lossy()))?;
        let input = health_ocr::input::read_input(&bytes).map_err(|e| Error::invalid(e.code(), ""))?;
        let models = components::load(&dir).map_err(|e| Error::other("ocr_component", e.to_string()))?;
        let rec =
            health_ocr::recognize(&models, &input, this_year, &mut |_, _| {}).map_err(|e| Error::other("ocr_engine", e.to_string()))?;
        if rec.items.is_empty() {
            return Err(Error::invalid("empty", "no lab results were found in this file"));
        }
        Ok((input.sha, rec))
    })
}

/// Installs the OCR component: from a folder of the pinned files, or downloaded (health-connect).
/// `with_matching` adds the optional embedding model (~135 MB) that ranks measure candidates.
pub fn install(data_dir: &Path, from: Option<&Path>, with_matching: bool) -> Result<Value> {
    let dir = components::dir(data_dir);
    std::fs::create_dir_all(&dir)?;
    if let Some(from) = from {
        let names = components::install_from(from, &dir).map_err(|e| Error::invalid("ocr_component", e.to_string()))?;
        return Ok(json!({ "installed": names, "ready": components::ready(&dir) }));
    }
    let mut done = Vec::new();
    for f in components::FILES.iter().filter(|f| f.required || with_matching) {
        let dest = dir.join(f.name);
        if components::verify(&dest, f) {
            continue;
        }
        let mut last = 0;
        // tests only (debug builds): the same files from a local server, by name
        let mirror = if cfg!(debug_assertions) { std::env::var("HEALTH_COMPONENT_MIRROR").ok() } else { None };
        let url = mirror.map_or_else(|| f.url.to_string(), |m| format!("{}/{}", m.trim_end_matches('/'), f.name));
        health_connect::download(&url, &dest, f.sha256, f.bytes, &mut |n, total| {
            let pct = n * 100 / total.max(1);
            if pct >= last + 10 {
                last = pct;
                eprintln!("{}: {pct}%", f.name);
            }
        })
        .map_err(|e| match e {
            health_connect::Error::Network(m) => Error::other("network", m),
            health_connect::Error::Integrity(m) => Error::other("integrity", m),
            health_connect::Error::Io(e) => Error::from(e),
        })?;
        done.push(f.name);
    }
    Ok(json!({ "installed": done, "ready": components::ready(&dir) }))
}

/// Whether the OCR component is installed, and its files.
pub fn status(data_dir: &Path) -> Value {
    let dir = components::dir(data_dir);
    json!({ "component": "ocr", "dir": dir, "ready": components::ready(&dir), "files": components::status(&dir) })
}
