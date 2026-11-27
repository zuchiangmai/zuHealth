//! Encrypted blob files: `blobs/<sha256 of plaintext>`.
//! Format: "HBLOB1" ‖ prefix(8) ‖ chunks u32be(len) ‖ AES-GCM(≤ 4 MiB), using the pack's chunk AEAD with an empty context.
//! The hash is checked after decryption; callers must discard what they read if `get` fails.

use crate::aead::{Chunks, TAG, random};
use crate::error::{Error, Result};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

const MAGIC: &[u8; 6] = b"HBLOB1";
const CHUNK: usize = 4 * 1024 * 1024;

pub struct Store {
    pub dir: PathBuf,
    pub tmp: PathBuf,
    key: zeroize::Zeroizing<[u8; 32]>,
}

pub fn is_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
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

impl Store {
    pub fn new(dir: PathBuf, tmp: PathBuf, key: [u8; 32]) -> Self {
        Store { dir, tmp, key: zeroize::Zeroizing::new(key) }
    }

    pub fn path(&self, sha: &str) -> PathBuf {
        self.dir.join(sha)
    }

    pub fn has(&self, sha: &str) -> bool {
        is_sha(sha) && self.path(sha).exists()
    }

    /// Stores a file; returns its sha256.
    pub fn put_file(&self, src: &Path) -> Result<String> {
        self.put(File::open(src)?)
    }

    /// Encrypts a stream into a temp file while hashing it, then renames it to its sha256 (one pass).
    pub fn put(&self, mut src: impl Read) -> Result<String> {
        let prefix: [u8; 8] = random();
        let chunks = Chunks::new(&self.key, prefix, Vec::new());
        let tmp = self.tmp.join(format!("blob-{}", hex::encode(random::<8>())));
        let r = (|| -> Result<String> {
            let mut out = BufWriter::new(crate::profile::create_private(&tmp)?);
            let mut h = Sha256::new();
            out.write_all(MAGIC)?;
            out.write_all(&prefix)?;
            let mut cur = vec![0u8; CHUNK];
            let mut n = read_full(&mut src, &mut cur)?;
            let mut seq = 0u32;
            loop {
                let mut next = vec![0u8; CHUNK];
                let m = if n == CHUNK { read_full(&mut src, &mut next)? } else { 0 };
                let last = m == 0;
                h.update(&cur[..n]);
                let ct = chunks.seal(seq, last, &cur[..n]);
                out.write_all(&(ct.len() as u32).to_be_bytes())?;
                out.write_all(&ct)?;
                if last {
                    break;
                }
                seq += 1;
                (cur, n) = (next, m);
            }
            out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
            let sha = hex::encode(h.finalize());
            if self.has(&sha) {
                std::fs::remove_file(&tmp)?;
            } else {
                std::fs::rename(&tmp, self.path(&sha))?;
            }
            Ok(sha)
        })();
        if r.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        r
    }

    /// Blob files present (sha-named only).
    pub fn list(&self) -> Vec<String> {
        std::fs::read_dir(&self.dir)
            .map(|rd| rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| is_sha(n)).collect())
            .unwrap_or_default()
    }

    /// Decrypts blob `sha` into `out`, then checks the hash.
    pub fn get(&self, sha: &str, out: &mut impl Write) -> Result<()> {
        if !is_sha(sha) {
            return Err(Error::invalid("bad_blob", sha));
        }
        let mut f = BufReader::new(File::open(self.path(sha)).map_err(|_| Error::not_found("no_blob", sha))?);
        let mut head = [0u8; 14];
        if read_full(&mut f, &mut head)? != 14 || &head[..6] != MAGIC {
            return Err(Error::invalid("blob_corrupt", sha));
        }
        let chunks = Chunks::new(&self.key, head[6..].try_into().unwrap(), Vec::new());
        let mut h = Sha256::new();
        let mut seq = 0u32;
        loop {
            let mut len = [0u8; 4];
            if read_full(&mut f, &mut len)? != 4 {
                return Err(Error::invalid("blob_corrupt", sha));
            }
            let len = u32::from_be_bytes(len) as usize;
            if !(TAG..=CHUNK + TAG).contains(&len) {
                return Err(Error::invalid("blob_corrupt", sha));
            }
            let mut ct = vec![0u8; len];
            if read_full(&mut f, &mut ct)? != len {
                return Err(Error::invalid("blob_corrupt", sha));
            }
            let last = std::io::BufRead::fill_buf(&mut f)?.is_empty();
            let plain = chunks.open(seq, last, &ct).ok_or_else(|| Error::invalid("blob_corrupt", sha))?;
            h.update(&plain);
            out.write_all(&plain)?;
            if last {
                break;
            }
            seq += 1;
        }
        if hex::encode(h.finalize()) != sha {
            return Err(Error::invalid("blob_corrupt", sha));
        }
        Ok(())
    }

    /// Deletes blob files (after the transaction that orphaned them committed).
    pub fn remove(&self, shas: &[String]) {
        for s in shas.iter().filter(|s| is_sha(s)) {
            let _ = std::fs::remove_file(self.path(s));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_tamper() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().to_path_buf(), d.path().to_path_buf(), [7u8; 32]);
        for size in [0usize, 5, CHUNK, CHUNK + 1] {
            let data: Vec<u8> = (0..size).map(|i| (i % 253) as u8).collect();
            let src = d.path().join("src");
            std::fs::write(&src, &data).unwrap();
            let sha = s.put_file(&src).unwrap();
            let mut out = Vec::new();
            s.get(&sha, &mut out).unwrap();
            assert_eq!(out, data);
        }
        let sha = s.put_file(&d.path().join("src")).unwrap();
        let mut bytes = std::fs::read(s.path(&sha)).unwrap();
        let i = bytes.len() - 1;
        bytes[i] ^= 1;
        std::fs::write(s.path(&sha), bytes).unwrap();
        assert_eq!(s.get(&sha, &mut Vec::new()).unwrap_err().code, "blob_corrupt");
    }
}
