//! File importers: Apple Health export (zip), a WHOOP API bundle, and JSON lines of rows.
//! Each runs inside one transaction: a failure part-way leaves nothing behind, and rows taken over from
//! older imports stay with them.

use crate::db::{Db, tx};
use crate::error::{Error, Result};
use crate::write::{Begin, ObsRow, SourceSpec, begin, finish, write};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::io::BufReader;
use std::path::Path;

const BATCH: usize = 5_000;

#[derive(Debug, Default, Serialize, schemars::JsonSchema)]
pub struct Imported {
    /// Rows written (including overwrites of the same key)
    pub written: u64,
    /// Rows the database did not have before
    pub added: i64,
    pub rejected: BTreeMap<String, u64>,
    /// Sources (devices) that delivered rows, one import each
    pub sources: usize,
    /// Apple only: records seen, skipped (unknown type) and broken (bad time or value)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apple: Option<crate::apple::Stats>,
}

fn count(c: &Db) -> Result<i64> {
    Ok(c.query_row("SELECT count(*) FROM observation", [], |r| r.get(0))?)
}

struct Writer<'a> {
    c: &'a Db,
    connector: &'static str,
    parser: &'static str,
    now: i64,
    imports: HashMap<String, i64>,
    order: Vec<String>,
    buf: HashMap<String, Vec<ObsRow>>,
    pending: usize,
    res: Imported,
}

impl<'a> Writer<'a> {
    fn new(c: &'a Db, connector: &'static str, parser: &'static str, now: i64) -> Self {
        Writer {
            c,
            connector,
            parser,
            now,
            imports: HashMap::new(),
            order: Vec::new(),
            buf: HashMap::new(),
            pending: 0,
            res: Imported::default(),
        }
    }

    fn push(&mut self, source: String, row: ObsRow) -> Result<()> {
        self.buf.entry(source).or_default().push(row);
        self.pending += 1;
        if self.pending >= BATCH { self.flush() } else { Ok(()) }
    }

    fn flush(&mut self) -> Result<()> {
        for (source, rows) in std::mem::take(&mut self.buf) {
            let id = match self.imports.get(&source) {
                Some(id) => *id,
                None => {
                    let s = SourceSpec { name: Some(source.clone()), ..SourceSpec::new(self.connector, &source) };
                    let (id, _) =
                        begin(self.c, Begin { source: &s, parser: self.parser, blob: None, uid: None, candidates: None }, self.now)?;
                    self.imports.insert(source.clone(), id);
                    self.order.push(source);
                    id
                }
            };
            let w = write(self.c, id, &rows)?;
            self.res.written += w.written;
            for (k, n) in w.rejected {
                *self.res.rejected.entry(k).or_default() += n;
            }
        }
        self.pending = 0;
        Ok(())
    }

    fn finish(mut self) -> Result<Imported> {
        self.flush()?;
        for s in &self.order {
            finish(self.c, self.imports[s], self.now)?;
        }
        self.res.sources = self.order.len();
        Ok(self.res)
    }
}

/// The export's main XML: the largest `<dir>/<name>.xml` that is not a clinical (`_cda`) document; its name follows the phone's language.
fn main_entry(z: &mut zip::ZipArchive<std::fs::File>) -> Option<usize> {
    (0..z.len())
        .filter_map(|i| {
            let f = z.by_index_raw(i).ok()?;
            let n = f.name().ok()?.to_string();
            let lower = n.to_lowercase();
            let parts: Vec<&str> = n.split('/').collect();
            (parts.len() == 2 && !parts[0].is_empty() && lower.ends_with(".xml") && !lower.ends_with("_cda.xml") && parts[1].len() > 4)
                .then(|| (i, f.size()))
        })
        .max_by_key(|(_, size)| *size)
        .map(|(i, _)| i)
}

/// Apple Health "Export All Health Data" zip. One import per device; cumulative types summed per 15 minutes.
pub fn apple(c: &Db, path: &Path, now_ms: i64) -> Result<Imported> {
    let f = std::fs::File::open(path).map_err(|_| Error::not_found("no_file", path.display().to_string()))?;
    let mut z = zip::ZipArchive::new(f).map_err(|_| Error::invalid("not_apple", "not a zip file"))?;
    let i = main_entry(&mut z).ok_or_else(|| Error::invalid("not_apple", "no export.xml in the zip"))?;
    let before = count(c)?;
    tx(c, || {
        let entry = z.by_index(i).map_err(|e| Error::invalid("not_apple", e.to_string()))?;
        let mut w = Writer::new(c, "apple_health", "apple-export-1", now_ms);
        let mut failed: Option<Error> = None;
        let stats = crate::apple::parse(BufReader::with_capacity(1 << 16, entry), &mut |(src, row)| {
            if failed.is_none()
                && let Err(e) = w.push(src, row)
            {
                failed = Some(e);
            }
        })
        .map_err(|e| if e.code == "io" { Error::invalid("import_failed", e.detail) } else { e })?;
        if let Some(e) = failed {
            return Err(e);
        }
        if stats.records == 0 {
            return Err(Error::invalid("not_apple", "no records"));
        }
        let mut res = w.finish()?;
        res.added = count(c)? - before;
        res.apple = Some(stats);
        Ok(res)
    })
}

/// A saved WHOOP API v2 bundle (what the sync pulls); one import for the WHOOP user.
pub fn whoop(c: &Db, d: &crate::whoop::WhoopData, now_ms: i64) -> Result<Imported> {
    if d.user_id.is_empty() || d.user_id.len() > 64 || !d.user_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(Error::invalid("bad_request", "user_id"));
    }
    let before = count(c)?;
    tx(c, || {
        let mut w = Writer::new(c, "whoop", "whoop-v2", now_ms);
        for r in crate::whoop::decode(d, Some(now_ms)) {
            w.push(d.user_id.clone(), r)?;
        }
        let mut res = w.finish()?;
        res.added = count(c)? - before;
        Ok(res)
    })
}

/// JSON lines of rows (`{"metric", "start_ms", "tz_min", "value", ...}`) from one named source.
pub fn rows(c: &Db, path: &Path, source: &str, now_ms: i64) -> Result<Imported> {
    if source.trim().is_empty() || source.len() > 120 {
        return Err(Error::invalid("bad_request", "source"));
    }
    let f = std::fs::File::open(path).map_err(|_| Error::not_found("no_file", path.display().to_string()))?;
    let before = count(c)?;
    tx(c, || {
        let mut w = Writer::new(c, "file", "rows@1", now_ms);
        for (n, line) in std::io::BufRead::lines(BufReader::new(&f)).enumerate() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let row: ObsRow = serde_json::from_str(&line).map_err(|e| Error::invalid("bad_row", format!("line {}: {e}", n + 1)))?;
            w.push(source.to_string(), row)?;
        }
        let mut res = w.finish()?;
        res.added = count(c)? - before;
        Ok(res)
    })
}
