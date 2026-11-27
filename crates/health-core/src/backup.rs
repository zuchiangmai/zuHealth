//! Backup export / import (plan §3.4): a `zu-health-export` v1 pack holding a plain copy of the database,
//! a manifest, and the referenced blobs. Import merges (never overwrites). Both run outside a transaction.

use crate::error::{Error, Kind, Result};
use crate::merge::{MergeReport, export_plain};
use crate::pack;
use crate::profile::{Profile, create_private};
use serde::Serialize;
use std::collections::BTreeSet;
use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

pub const MIN_PASSWORD: usize = 8;

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Exported {
    pub path: String,
    pub bytes: u64,
    pub blobs: usize,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Imported {
    #[serde(flatten)]
    pub merge: MergeReport,
    pub restored_blobs: usize,
    /// Blobs the merged imports reference but neither this device nor the backup has
    pub missing_blobs: Vec<String>,
}

/// Removes the temp files on every path.
struct TmpFiles(Vec<PathBuf>);
impl Drop for TmpFiles {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

fn tmp_name(p: &Profile, what: &str) -> PathBuf {
    p.tmp().join(format!("{what}-{}", hex::encode(crate::aead::random::<8>())))
}

/// Every sha referenced by an import or a pointer value, present or not.
fn all_referenced(p: &Profile) -> Result<Vec<String>> {
    let mut st = p.db.prepare(
        "SELECT blob FROM import WHERE blob IS NOT NULL
         UNION SELECT value FROM observation WHERE metric_id IN (SELECT id FROM metric WHERE agg = 'none') AND typeof(value) = 'text'",
    )?;
    let all: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(all.into_iter().filter(|s| crate::blob::is_sha(s)).collect())
}

fn referenced_blobs(p: &Profile) -> Result<Vec<String>> {
    Ok(all_referenced(p)?.into_iter().filter(|s| p.blobs.has(s)).collect())
}

pub fn export(p: &Profile, out: &Path, password: &str, with_blobs: bool, now_ms: i64, opts: pack::Options) -> Result<Exported> {
    export_to(p, out, password, with_blobs, false, now_ms, opts)
}

/// `replace`: the person already agreed to overwrite `out` (a save dialog asked). The old file stays until the
/// new one is complete, then is swapped in at once.
pub fn export_to(
    p: &Profile,
    out: &Path,
    password: &str,
    with_blobs: bool,
    replace: bool,
    now_ms: i64,
    opts: pack::Options,
) -> Result<Exported> {
    if password.chars().count() < MIN_PASSWORD {
        return Err(Error::invalid("weak_password", format!("at least {MIN_PASSWORD} characters")));
    }
    if out.exists() && !(replace && out.is_file()) {
        return Err(Error::conflict("exists", out.display().to_string()));
    }
    let plain = tmp_name(p, "export");
    let part = out.with_file_name(format!(
        "{}.{}.part",
        out.file_name().and_then(|n| n.to_str()).unwrap_or("backup"),
        hex::encode(crate::aead::random::<4>())
    ));
    let mut guard = TmpFiles(vec![plain.clone()]);
    export_plain(&p.db, &plain)?;
    let blobs = if with_blobs { referenced_blobs(p)? } else { vec![] };
    pack_plain(p, &plain, &part, password, &blobs, now_ms, opts)?;
    guard.0.push(part.clone());
    std::fs::rename(&part, out)?;
    guard.0.retain(|x| x != &part);
    Ok(Exported { path: out.display().to_string(), bytes: std::fs::metadata(out)?.len(), blobs: blobs.len() })
}

/// Wraps the plain database `plain` and the files `blobs` (those present) into a pack at `out` (must not exist).
/// Returns how many files went in. On failure `out` is removed (only once this call has created it).
pub fn pack_plain(
    p: &Profile,
    plain: &Path,
    out: &Path,
    password: &str,
    blobs: &[String],
    now_ms: i64,
    opts: pack::Options,
) -> Result<usize> {
    let f = create_private(out)?;
    let r = write_pack(p, f, plain, password, blobs, now_ms, opts);
    if r.is_err() {
        let _ = std::fs::remove_file(out);
    }
    r
}

fn write_pack(p: &Profile, f: File, plain: &Path, password: &str, blobs: &[String], now_ms: i64, opts: pack::Options) -> Result<usize> {
    let mut w = pack::Writer::new(BufWriter::new(f), password, opts)?;
    w.entry("db.sqlite", BufReader::new(File::open(plain)?))?;
    w.entry("manifest.json", serde_json::json!({ "fmt": "zu-health-backup", "v": 1, "at": now_ms }).to_string().as_bytes())?;
    let mut n = 0;
    for sha in blobs {
        if !p.blobs.has(sha) {
            continue;
        }
        w.begin_entry(&format!("blobs/{sha}"))?;
        p.blobs.get(sha, &mut pack::EntryWriter(&mut w))?;
        w.end_entry()?;
        n += 1;
    }
    let f = w.finish()?.into_inner().map_err(|e| e.into_error())?;
    f.sync_all()?;
    Ok(n)
}

pub fn import(p: &Profile, src: &Path, password: &str, now_ms: i64) -> Result<Imported> {
    import_checked(p, src, password, now_ms, &|_| Ok(()))
}

/// `import`, with `check` run inside the merge's transaction once the pack's database has passed the schema checks
/// (`merge::merge_from_checked`; sync: the pack holds only what was asked for).
pub fn import_checked(
    p: &Profile,
    src: &Path,
    password: &str,
    now_ms: i64,
    check: &dyn Fn(&crate::db::Db) -> Result<()>,
) -> Result<Imported> {
    let plain = tmp_name(p, "import");
    let mut guard = TmpFiles(vec![plain.clone()]);
    let mut db_file: Option<BufWriter<File>> = None;
    let mut have_db = false;
    let mut manifest = Vec::new();
    let mut blob_tmp: Vec<(String, PathBuf)> = Vec::new();
    let mut blob_file: Option<BufWriter<File>> = None;
    let mut seen = BTreeSet::new();
    let mut open: BTreeSet<String> = BTreeSet::new(); // entries started and not yet done
    let f = File::open(src).map_err(|_| Error::not_found("no_file", src.display().to_string()))?;
    pack::read(BufReader::new(f), password, |name, bytes, done| {
        let first = !seen.contains(name);
        if first {
            seen.insert(name.to_string());
        } else if !open.contains(name) {
            return Err(Error::invalid("backup_dup", name.to_string()));
        }
        if done {
            open.remove(name);
        } else if first {
            open.insert(name.to_string());
        }
        let blob = name.strip_prefix("blobs/").filter(|s| crate::blob::is_sha(s));
        if name == "db.sqlite" {
            if first {
                db_file = Some(BufWriter::new(create_private(&plain)?));
            }
            let w = db_file.as_mut().expect("open");
            w.write_all(bytes)?;
            if done {
                db_file.take().expect("open").into_inner().map_err(|e| e.into_error())?.sync_all()?;
                have_db = true;
            }
        } else if name == "manifest.json" {
            if manifest.len() + bytes.len() > 64 * 1024 {
                return Err(Error::invalid("backup_manifest", "too large"));
            }
            manifest.extend_from_slice(bytes);
        } else if let Some(sha) = blob {
            if first {
                let t = tmp_name(p, "blob");
                guard.0.push(t.clone());
                blob_tmp.push((sha.to_string(), t.clone()));
                blob_file = Some(BufWriter::new(create_private(&t)?));
            }
            blob_file.as_mut().expect("open").write_all(bytes)?;
            if done {
                blob_file.take().expect("open").flush()?;
            }
        }
        // unknown entries are ignored
        Ok(())
    })?;
    if !have_db {
        return Err(Error::invalid("backup_nodb", ""));
    }
    if !manifest.is_empty() {
        let m: serde_json::Value = serde_json::from_slice(&manifest).map_err(|_| Error::invalid("backup_manifest", ""))?;
        if m["fmt"] != "zu-health-backup" || m["v"] != 1 {
            return Err(Error::new(Kind::Invalid, "backup_manifest", "unknown backup format"));
        }
    }
    let merge = crate::merge::merge_from_checked(&p.db, &plain, now_ms, check)?;
    // committed: now the files
    p.blobs.remove(&merge.orphan_blobs);
    let mut restored = 0;
    for (sha, t) in &blob_tmp {
        if !p.blobs.has(sha) && crate::erase::referenced(&p.db, sha)? {
            // put_file hashes the content, so a mislabelled entry cannot land under another name
            // the merge has committed: a file that cannot be restored is reported missing, not an error
            match p.blobs.put_file(t) {
                Ok(real) if real == *sha => restored += 1,
                Ok(real) => {
                    if !crate::erase::referenced(&p.db, &real).unwrap_or(true) {
                        p.blobs.remove(&[real]);
                    }
                }
                Err(_) => {}
            }
        }
    }
    let missing_blobs = all_referenced(p)?.into_iter().filter(|s| !p.blobs.has(s)).collect();
    Ok(Imported { merge, restored_blobs: restored, missing_blobs })
}
