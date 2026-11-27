//! The OCR component (plan §4.4): model files that don't ship in the binary. Size and SHA-256 of each are
//! pinned here (same files and hashes as the web version, `B/backend/models.json`); a file is used only if
//! it matches. Installed under `<data dir>/components/ocr/`, shared by every profile.

use crate::{Models, embed::Embedder, engine::Engine};
use std::path::{Path, PathBuf};

pub struct File {
    pub name: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
    /// Upstream address (decision 51)
    pub url: &'static str,
    /// Needed to recognise text; the others only rank measure candidates
    pub required: bool,
}

pub const FILES: &[File] = &[
    File {
        name: "ppocrv5_det.onnx",
        sha256: "1eb7b4f7ab657ebd1c66d5f79bca7497f29768a2e3c15e52daecbba1a8e4a039",
        bytes: 4_826_518,
        url: "https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx/resolve/main/ppocrv5_det.onnx",
        required: true,
    },
    File {
        name: "ppocrv5_rec.onnx",
        sha256: "243a0f06d826761323e9045e9b113ab2c191c3aa50565585e628300b8eda0224",
        bytes: 16_562_373,
        url: "https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx/resolve/main/ppocrv5_rec.onnx",
        required: true,
    },
    File {
        name: "ppocrv5_dict.txt",
        sha256: "d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b",
        bytes: 74_012,
        url: "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/ppocrv5_dict.txt",
        required: true,
    },
    File {
        name: "e5_model_int8.onnx",
        sha256: "4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c",
        bytes: 118_054_593,
        url: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/onnx/model_int8.onnx",
        required: false,
    },
    File {
        name: "e5_tokenizer.json",
        sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
        bytes: 17_082_730,
        url: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/tokenizer.json",
        required: false,
    },
];

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("components").join("ocr")
}

/// The file at `path` is the pinned one (size first, then SHA-256).
pub fn verify(path: &Path, f: &File) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.len() == f.bytes) && std::fs::read(path).is_ok_and(|b| crate::input::sha256_hex(&b) == f.sha256)
}

#[derive(Debug, serde::Serialize)]
pub struct Status {
    pub name: &'static str,
    pub bytes: u64,
    pub required: bool,
    /// Present with the right size (the hash is checked when it is loaded)
    pub installed: bool,
}

pub fn status(dir: &Path) -> Vec<Status> {
    FILES
        .iter()
        .map(|f| Status {
            name: f.name,
            bytes: f.bytes,
            required: f.required,
            installed: std::fs::metadata(dir.join(f.name)).is_ok_and(|m| m.len() == f.bytes),
        })
        .collect()
}

pub fn ready(dir: &Path) -> bool {
    status(dir).iter().all(|s| s.installed || !s.required)
}

/// Copies the pinned files found in `from` (e.g. a folder of manually downloaded files) into `dir`, checked.
/// Returns the names installed; a file that doesn't match is refused.
pub fn install_from(from: &Path, dir: &Path) -> std::io::Result<Vec<&'static str>> {
    std::fs::create_dir_all(dir)?;
    let mut done = Vec::new();
    for f in FILES {
        let src = from.join(f.name);
        if !src.exists() {
            continue;
        }
        if !verify(&src, f) {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, format!("{} is not the expected file", f.name)));
        }
        let tmp = dir.join(format!("{}.part", f.name));
        std::fs::copy(&src, &tmp)?;
        std::fs::rename(&tmp, dir.join(f.name))?;
        done.push(f.name);
    }
    Ok(done)
}

/// Loads the models, each checked against its pinned hash. Matching is left out (None) when its files are
/// missing or don't load: recognition works without it.
pub fn load(dir: &Path) -> anyhow::Result<Models> {
    let read = |name: &str| -> anyhow::Result<Vec<u8>> {
        let f = FILES.iter().find(|f| f.name == name).expect("pinned file");
        let b = std::fs::read(dir.join(name)).map_err(|_| anyhow::anyhow!("missing: {name}"))?;
        if b.len() as u64 != f.bytes || crate::input::sha256_hex(&b) != f.sha256 {
            anyhow::bail!("integrity: {name}");
        }
        Ok(b)
    };
    let engine = Engine::new(&read("ppocrv5_det.onnx")?, &read("ppocrv5_rec.onnx")?, &String::from_utf8(read("ppocrv5_dict.txt")?)?)?;
    let embed = match (read("e5_model_int8.onnx"), read("e5_tokenizer.json")) {
        (Ok(m), Ok(t)) => Embedder::new(&m, &t).ok(),
        _ => None,
    };
    Ok(Models { engine, embed })
}
