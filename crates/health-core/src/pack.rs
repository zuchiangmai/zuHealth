//! Backup pack `zu-health-export` v1, byte-compatible with the web `export/pack.ts`. Streaming in both directions.
//!   file  = header JSON line + "\n", then per chunk: u32be(len) ‖ AES-GCM(chunk)
//!   key   = PBKDF2-SHA256(password, salt, iter); aad context = SHA-256(header line bytes)
//!   plain = frames: 0x01 u16be(name len) name ‖ 0x02 u32be(len ≤ 1 MiB) data … ‖ 0x03 (file done) … ‖ 0x00 (end)
//! Plain chunks are exactly `chunk` bytes except the last (1..chunk; 0 only for an empty stream).

use crate::aead::{Chunks, TAG, random};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};

pub const FORMAT: &str = "zu-health-export";
const LEGACY_FORMATS: &[&str] = &["sibian-health-export"];
pub const DEFAULT_ITER: u32 = 600_000;
pub const DEFAULT_CHUNK: usize = 4 * 1024 * 1024;
const MAX_ITER: u64 = 10_000_000;
const MAX_CHUNK: u64 = 64 * 1024 * 1024;
const MAX_HEADER: usize = 4096;
const SEG: usize = 1024 * 1024;
const MAX_NAME: usize = 512;
const T_END: u8 = 0;
const T_FILE: u8 = 1;
const T_DATA: u8 = 2;
const T_DONE: u8 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackError {
    Format,
    Auth,
    Truncated,
    Container,
    Io,
}

impl PackError {
    pub fn code(self) -> &'static str {
        match self {
            PackError::Format => "pack_format",
            PackError::Auth => "pack_auth",
            PackError::Truncated => "pack_truncated",
            PackError::Container => "pack_container",
            PackError::Io => "io",
        }
    }
}

impl From<PackError> for crate::Error {
    fn from(e: PackError) -> Self {
        let kind = if e == PackError::Auth { crate::Kind::Denied } else { crate::Kind::Invalid };
        crate::Error::new(kind, e.code(), "")
    }
}

impl From<std::io::Error> for PackError {
    fn from(_: std::io::Error) -> Self {
        PackError::Io
    }
}

fn derive(password: &str, salt: &[u8], iter: u32) -> zeroize::Zeroizing<[u8; 32]> {
    let mut k = zeroize::Zeroizing::new([0u8; 32]);
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iter, &mut *k);
    k
}

pub struct Options {
    pub iter: u32,
    pub chunk: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options { iter: DEFAULT_ITER, chunk: DEFAULT_CHUNK }
    }
}

/// Writes a pack. Add entries, then `finish`.
pub struct Writer<W: Write> {
    out: W,
    chunks: Chunks,
    chunk: usize,
    buf: Vec<u8>,
    seq: u32,
}

impl<W: Write> Writer<W> {
    pub fn new(mut out: W, password: &str, opts: Options) -> std::io::Result<Self> {
        assert!(opts.iter >= 1 && (opts.iter as u64) <= MAX_ITER && opts.chunk >= 1 && (opts.chunk as u64) <= MAX_CHUNK);
        let salt: [u8; 16] = random();
        let prefix: [u8; 8] = random();
        let header = serde_json::json!({
            "fmt": FORMAT, "v": 1, "kdf": "PBKDF2-SHA256", "iter": opts.iter,
            "salt": B64.encode(salt), "prefix": B64.encode(prefix), "chunk": opts.chunk,
        })
        .to_string();
        let key = derive(password, &salt, opts.iter);
        let chunks = Chunks::new(&key, prefix, Sha256::digest(header.as_bytes()).to_vec());
        out.write_all(header.as_bytes())?;
        out.write_all(b"\n")?;
        Ok(Writer { out, chunks, chunk: opts.chunk, buf: Vec::with_capacity(opts.chunk + SEG), seq: 0 })
    }

    fn plain(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.buf.extend_from_slice(data);
        // Keep at least one byte back: the last chunk must not be empty unless the whole stream is.
        while self.buf.len() > self.chunk {
            let rest = self.buf.split_off(self.chunk);
            let full = std::mem::replace(&mut self.buf, rest);
            self.emit(&full, false)?;
        }
        Ok(())
    }

    fn emit(&mut self, plain: &[u8], last: bool) -> std::io::Result<()> {
        let ct = self.chunks.seal(self.seq, last, plain);
        self.out.write_all(&(ct.len() as u32).to_be_bytes())?;
        self.out.write_all(&ct)?;
        self.seq += 1;
        Ok(())
    }

    pub fn entry(&mut self, name: &str, mut data: impl Read) -> std::io::Result<()> {
        self.begin_entry(name)?;
        let mut seg = vec![0u8; SEG];
        loop {
            let k = read_full(&mut data, &mut seg)?;
            if k == 0 {
                break;
            }
            self.data(&seg[..k])?;
        }
        self.end_entry()
    }

    pub fn begin_entry(&mut self, name: &str) -> std::io::Result<()> {
        let n = name.as_bytes();
        assert!(!n.is_empty() && n.len() <= MAX_NAME, "pack entry name");
        self.plain(&[T_FILE, (n.len() >> 8) as u8, n.len() as u8])?;
        self.plain(n)
    }

    /// Data of the current entry, in segments of at most 1 MiB.
    pub fn data(&mut self, mut d: &[u8]) -> std::io::Result<()> {
        while !d.is_empty() {
            let (seg, rest) = d.split_at(d.len().min(SEG));
            self.plain(&[T_DATA])?;
            self.plain(&(seg.len() as u32).to_be_bytes())?;
            self.plain(seg)?;
            d = rest;
        }
        Ok(())
    }

    pub fn end_entry(&mut self) -> std::io::Result<()> {
        self.plain(&[T_DONE])
    }

    pub fn finish(mut self) -> std::io::Result<W> {
        self.plain(&[T_END])?;
        let rest = std::mem::take(&mut self.buf);
        self.emit(&rest, true)?;
        self.out.flush()?;
        Ok(self.out)
    }
}

fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

/// Unpacks a pack, calling `on(name, bytes, done)` for each piece of each entry in order.
/// `done` = the entry is complete (bytes empty). On any error, pieces already delivered must be discarded.
pub fn read<R: Read>(src: R, password: &str, mut on: impl FnMut(&str, &[u8], bool) -> crate::Result<()>) -> crate::Result<()> {
    let mut r = BufReader::new(src);
    let mut header = Vec::new();
    r.by_ref().take(MAX_HEADER as u64 + 1).read_until(b'\n', &mut header).map_err(PackError::from)?;
    if header.pop() != Some(b'\n') {
        return Err(PackError::Format.into());
    }
    let h: serde_json::Value = serde_json::from_slice(&header).map_err(|_| PackError::Format)?;
    let fmt = h["fmt"].as_str().unwrap_or("");
    if (fmt != FORMAT && !LEGACY_FORMATS.contains(&fmt)) || h["v"] != 1 || h["kdf"] != "PBKDF2-SHA256" {
        return Err(PackError::Format.into());
    }
    let iter = h["iter"].as_u64().filter(|i| (1..=MAX_ITER).contains(i)).ok_or(PackError::Format)? as u32;
    let chunk = h["chunk"].as_u64().filter(|c| (1..=MAX_CHUNK).contains(c)).ok_or(PackError::Format)? as usize;
    let salt = h["salt"].as_str().and_then(|s| B64.decode(s).ok()).filter(|s| s.len() == 16).ok_or(PackError::Format)?;
    let prefix: [u8; 8] = h["prefix"].as_str().and_then(|s| B64.decode(s).ok()).and_then(|p| p.try_into().ok()).ok_or(PackError::Format)?;
    let key = derive(password, &salt, iter);
    let chunks = Chunks::new(&key, prefix, Sha256::digest(&header).to_vec());

    let mut frames = Frames::default();
    let mut seq = 0u32;
    loop {
        let mut len = [0u8; 4];
        if read_full(&mut r, &mut len).map_err(PackError::from)? != 4 {
            return Err(PackError::Truncated.into());
        }
        let len = u32::from_be_bytes(len) as usize;
        if len < TAG || len > chunk + TAG {
            return Err(PackError::Format.into());
        }
        let mut ct = vec![0u8; len];
        if read_full(&mut r, &mut ct).map_err(PackError::from)? != len {
            return Err(PackError::Truncated.into());
        }
        let last = r.fill_buf().map_err(PackError::from)?.is_empty();
        let plain = chunks.open(seq, last, &ct).ok_or(PackError::Auth)?;
        seq += 1;
        frames.feed(&plain, &mut on)?;
        if last {
            return if frames.ended { Ok(()) } else { Err(PackError::Container.into()) };
        }
    }
}

#[derive(Default)]
struct Frames {
    buf: Vec<u8>,
    name: Option<String>,
    /// bytes still to read in the current data frame
    data_left: usize,
    ended: bool,
}

impl Frames {
    fn feed(&mut self, plain: &[u8], on: &mut impl FnMut(&str, &[u8], bool) -> crate::Result<()>) -> crate::Result<()> {
        self.buf.extend_from_slice(plain);
        let mut pos = 0;
        let err = || -> crate::Error { PackError::Container.into() };
        loop {
            let avail = &self.buf[pos..];
            if self.ended {
                if !avail.is_empty() {
                    return Err(err());
                }
                break;
            }
            if self.data_left > 0 {
                if avail.is_empty() {
                    break;
                }
                let n = self.data_left.min(avail.len());
                on(self.name.as_deref().expect("in a file"), &avail[..n], false)?;
                self.data_left -= n;
                pos += n;
                continue;
            }
            let Some(&t) = avail.first() else { break };
            match t {
                T_END => {
                    if self.name.is_some() {
                        return Err(err());
                    }
                    self.ended = true;
                    pos += 1;
                }
                T_FILE => {
                    if self.name.is_some() {
                        return Err(err());
                    }
                    if avail.len() < 3 {
                        break;
                    }
                    let n = ((avail[1] as usize) << 8) | avail[2] as usize;
                    if n == 0 || n > MAX_NAME {
                        return Err(err());
                    }
                    if avail.len() < 3 + n {
                        break;
                    }
                    self.name = Some(String::from_utf8(avail[3..3 + n].to_vec()).map_err(|_| err())?);
                    pos += 3 + n;
                }
                T_DATA => {
                    if self.name.is_none() {
                        return Err(err());
                    }
                    if avail.len() < 5 {
                        break;
                    }
                    let n = u32::from_be_bytes(avail[1..5].try_into().unwrap()) as usize;
                    if n > SEG {
                        return Err(err());
                    }
                    self.data_left = n;
                    pos += 5;
                }
                T_DONE => {
                    let name = self.name.take().ok_or_else(err)?;
                    on(&name, &[], true)?;
                    pos += 1;
                }
                _ => return Err(err()),
            }
        }
        self.buf.drain(..pos);
        Ok(())
    }
}

/// `Write` adapter for the current entry of a `Writer`.
pub struct EntryWriter<'a, W: Write>(pub &'a mut Writer<W>);

impl<W: Write> Write for EntryWriter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.data(buf)?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn pack(entries: &[(&str, &[u8])], chunk: usize) -> Vec<u8> {
        let mut w = Writer::new(Vec::new(), "secret-pass", Options { iter: 10, chunk }).unwrap();
        for (n, d) in entries {
            w.entry(n, *d).unwrap();
        }
        w.finish().unwrap()
    }

    fn unpack(bytes: &[u8], pw: &str) -> crate::Result<BTreeMap<String, Vec<u8>>> {
        let mut out: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        read(bytes, pw, |n, b, _| {
            out.entry(n.into()).or_default().extend_from_slice(b);
            Ok(())
        })?;
        Ok(out)
    }

    #[test]
    fn round_trip_across_chunk_sizes() {
        for (chunk, size) in [(1, 3000), (7, 20_000), (4096, 3_000_000), (DEFAULT_CHUNK, 3_000_000)] {
            let big: Vec<u8> = (0..size as u32).map(|i| (i * 7 % 251) as u8).collect();
            let p = pack(&[("db.sqlite", &big), ("manifest.json", b"{}"), ("empty", b"")], chunk);
            let m = unpack(&p, "secret-pass").unwrap();
            assert_eq!(m["db.sqlite"], big);
            assert_eq!(m["manifest.json"], b"{}");
            assert_eq!(m.get("empty").map(Vec::len).unwrap_or(0), 0);
        }
    }

    #[test]
    fn wrong_password_truncation_and_tampering_fail() {
        let p = pack(&[("a", b"hello world")], 4);
        assert_eq!(unpack(&p, "nope").unwrap_err().code, "pack_auth");
        assert!(unpack(&p[..p.len() - 1], "secret-pass").is_err());
        // drop the final chunk entirely: the new last chunk was sealed as not-last
        let hdr = p.iter().position(|&b| b == b'\n').unwrap() + 1;
        let first = 4 + u32::from_be_bytes(p[hdr..hdr + 4].try_into().unwrap()) as usize;
        assert_eq!(unpack(&p[..hdr + first], "secret-pass").unwrap_err().code, "pack_auth");
        let mut bad = p.clone();
        let i = bad.len() - 3;
        bad[i] ^= 1;
        assert_eq!(unpack(&bad, "secret-pass").unwrap_err().code, "pack_auth");
        let mut extra = p.clone();
        extra.push(0);
        assert!(unpack(&extra, "secret-pass").is_err());
    }

    #[test]
    fn reads_the_web_fixture() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/web-backup.zuhealth")).unwrap();
        let m = unpack(&bytes, "fixture-pass").unwrap();
        assert!(m["db.sqlite"].starts_with(b"SQLite format 3\0"));
        let manifest: serde_json::Value = serde_json::from_slice(&m["manifest.json"]).unwrap();
        assert_eq!(manifest["fmt"], "zu-health-backup");
    }
}
