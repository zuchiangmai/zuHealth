//! Backup interop (DB design §5.3), ported from the web `db/merge.ts`.
//! A plain (unencrypted) copy of the database travels inside the pack. Merging follows the sync rules, never "last file wins":
//!   metrics by code, sources by (connector, external_id), imports by uid (done / erased / review);
//!   observations: larger import.uid wins; corrections: CORRECTION_WINS; remote tombstones erase local imports;
//!   a locally erased import is never revived. Local integer ids are always translated, never copied.
//! ATTACH / DETACH cannot run in a transaction, so these functions must be called outside one.

use crate::correction::CORRECTION_WINS;
use crate::daily::Scope;
use crate::db::{Db, one, schema_body, tx};
use crate::error::{Error, Result};
use crate::write::{Span, parse_meta, set_span, span_of};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::path::Path;

/// A pack row the writers would accept (R13, R14): times within write::MAX_TIME_MS, an offset an integer within ±14 h,
/// an end not before its start. As the web's merge.ts ROW_SHAPE.
const ROW_SHAPE: &str = "o.start_ms BETWEEN 0 AND 253402041600000 AND (o.end_ms IS NULL OR o.end_ms BETWEEN 0 AND 253402041600000)
     AND typeof(o.tz_min) = 'integer' AND o.tz_min BETWEEN -840 AND 840 AND (o.end_ms IS NULL OR o.end_ms >= o.start_ms)";
/// A number Value::number would store: an integer within ±(2^53 − 1), or a finite real that isn't an integer beyond it
const NUMBER_OK: &str = "((typeof(o.value) = 'integer' AND o.value BETWEEN -9007199254740991 AND 9007199254740991)
     OR (typeof(o.value) = 'real' AND o.value BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308
         AND NOT (o.value = round(o.value) AND abs(o.value) > 9007199254740991)))";

/// The value a row of a measure aggregated as `agg` (an SQL expression) may hold (R14), as the web's valueOk
fn value_ok(agg: &str) -> String {
    format!(
        "CASE {agg} WHEN 'interval' THEN o.end_ms IS NOT NULL AND o.end_ms > o.start_ms AND o.value IS NULL
           WHEN 'none' THEN typeof(o.value) = 'text' AND length(o.value) > 0
           WHEN 'level' THEN o.value IS NULL OR {NUMBER_OK} ELSE {NUMBER_OK} END"
    )
}

/// Both, a NULL counting as false
fn row_ok(agg: &str) -> String {
    format!("(coalesce({ROW_SHAPE}, 0) AND coalesce({}, 0))", value_ok(agg))
}

const TABLES: &[&str] = &["metric", "metric_alias", "source", "import", "observation", "correction", "genotype"];

#[derive(Debug, Default, Serialize, schemars::JsonSchema)]
pub struct MergeReport {
    pub added_metrics: u64,
    pub added_sources: u64,
    pub added_imports: u64,
    /// Local imports erased by the other side's tombstones
    pub erased_imports: u64,
    /// Metrics whose unit or agg differs from the local one: none of their rows were merged
    pub skipped_metrics: Vec<String>,
    /// New imports whose blob another local import already holds (same file imported on two devices)
    pub dropped_blobs: u64,
    /// Blobs the new imports reference; the caller restores those it has
    pub needed_blobs: Vec<String>,
    /// Blobs no longer referenced after erasing; delete after commit
    pub orphan_blobs: Vec<String>,
    /// New imports refused: a uid from the future, or a non-UUIDv7 uid outside lab/staff/room results
    pub refused_imports: u64,
    /// Corrections refused: an HLC from the future
    pub refused_corrections: u64,
    /// Reviews here that the other side had confirmed, now done (R2; the web's confirmedReviews)
    pub confirmed_reviews: u64,
    /// Rows skipped for a time, offset or value the writers would refuse (R13, R14), and corrections skipped for a
    /// time outside 0..=MAX_TIME_MS
    pub refused_rows: u64,
}

/// Schema statements with every object created in schema `plain`.
fn plain_schema() -> String {
    let mut out = String::new();
    for line in schema_body().lines() {
        let mut l = line.to_string();
        for kind in ["CREATE UNIQUE INDEX ", "CREATE INDEX ", "CREATE TABLE ", "CREATE VIEW ", "CREATE VIRTUAL TABLE "] {
            if let Some(rest) = line.strip_prefix(kind) {
                l = format!("{kind}plain.{rest}");
                break;
            }
        }
        out.push_str(&l);
        out.push('\n');
    }
    out
}

fn attach(c: &Db, path: &Path, read_only: bool) -> Result<()> {
    let p = path.to_str().ok_or_else(|| Error::other("bad_path", ""))?;
    let target =
        if read_only { format!("file:{}?mode=ro", p.replace('%', "%25").replace('?', "%3f").replace('#', "%23")) } else { p.to_string() };
    c.execute("ATTACH DATABASE ? AS plain KEY ''", [target])?;
    Ok(())
}

/// Writes a plain copy of this database to `path` (must not exist).
pub fn export_plain(c: &Db, path: &Path) -> Result<()> {
    attach(c, path, false)?;
    let r = tx(c, || {
        c.execute_batch(&plain_schema())?;
        for t in TABLES {
            c.execute(&format!("INSERT INTO plain.\"{t}\" SELECT * FROM main.\"{t}\""), [])?;
        }
        c.execute("INSERT INTO plain.report_text (rowid, text) SELECT rowid, text FROM main.report_text", [])?;
        Ok(())
    });
    c.execute_batch("DETACH DATABASE plain")?;
    r
}

/// Writes a plain database holding only the imports `uids` (any listed status: tombstones travel as such), the rows
/// they own now (found through their spans over the primary key, as erase finds them), their genotypes and report
/// text, plus the whole metric, alias and source tables (small; sources carry the R3 settings) and, when asked, the
/// whole correction table. `merge_from` takes it like any backup (docs/lan-sync.md §6.5). `path` must not exist.
pub fn export_subset(c: &Db, uids: &[String], corrections: bool, path: &Path) -> Result<()> {
    attach(c, path, false)?;
    let r = tx(c, || {
        c.execute_batch(&plain_schema())?;
        c.execute_batch("DROP TABLE IF EXISTS temp.subset_uid; CREATE TEMP TABLE subset_uid (uid TEXT PRIMARY KEY)")?;
        for u in uids {
            c.execute("INSERT OR IGNORE INTO temp.subset_uid VALUES (?)", [u])?;
        }
        for t in ["metric", "metric_alias", "source"] {
            c.execute(&format!("INSERT INTO plain.\"{t}\" SELECT * FROM main.\"{t}\""), [])?;
        }
        c.execute("INSERT INTO plain.import SELECT * FROM main.import WHERE uid IN (SELECT uid FROM temp.subset_uid)", [])?;
        let picked: Vec<(i64, Option<String>)> = c
            .prepare("SELECT id, meta FROM plain.import WHERE status = 'done'")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (id, meta) in picked {
            for (metric, (from, to)) in span_of(&parse_meta(meta)) {
                c.execute(
                    "INSERT INTO plain.observation SELECT * FROM main.observation
                      WHERE metric_id = ? AND start_ms BETWEEN ? AND ? AND import_id = ?",
                    [metric, from, to, id],
                )?;
            }
            c.execute("INSERT INTO plain.genotype SELECT * FROM main.genotype WHERE import_id = ?", [id])?;
            c.execute("INSERT INTO plain.report_text (rowid, text) SELECT rowid, text FROM main.report_text WHERE rowid = ?", [id])?;
        }
        if corrections {
            c.execute("INSERT INTO plain.correction SELECT * FROM main.correction", [])?;
        }
        c.execute_batch("DROP TABLE temp.subset_uid")?;
        Ok(())
    });
    c.execute_batch("DETACH DATABASE plain")?;
    r
}

/// One part of a large done import (docs/lan-sync.md §6.5): a plain database like `export_subset`'s, holding the
/// import and about `max_rows` of its rows in `(metric code, start_ms)` order, starting after `after`. A part never
/// splits one `start_ms` of a metric (several sources may share it), so it can hold a few more. Genotypes and report
/// text travel in the first part only. Each part is a range scan over the primary key. Returns where the next part
/// starts, or None when this one is the last. `path` must not exist.
pub fn export_part(
    c: &Db,
    uid: &str,
    after: Option<&crate::syncstate::Cursor>,
    max_rows: u64,
    path: &Path,
) -> Result<Option<crate::syncstate::Cursor>> {
    let max_rows = max_rows.max(1) as i64;
    attach(c, path, false)?;
    let r = tx(c, || {
        c.execute_batch(&plain_schema())?;
        for t in ["metric", "metric_alias", "source"] {
            c.execute(&format!("INSERT INTO plain.\"{t}\" SELECT * FROM main.\"{t}\""), [])?;
        }
        let (id, meta): (i64, Option<String>) = c
            .query_row("SELECT id, meta FROM import WHERE uid = ? AND status = 'done'", [uid], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|_| Error::not_found("no_import", "not a done import here"))?;
        c.execute("INSERT INTO plain.import SELECT * FROM main.import WHERE id = ?", [id])?;
        if after.is_none() {
            c.execute("INSERT INTO plain.genotype SELECT * FROM main.genotype WHERE import_id = ?", [id])?;
            c.execute("INSERT INTO plain.report_text (rowid, text) SELECT rowid, text FROM main.report_text WHERE rowid = ?", [id])?;
        }
        let mut spans: Vec<(String, i64, i64, i64)> = Vec::new();
        for (metric, (from, to)) in span_of(&parse_meta(meta)) {
            let code: Option<String> = one(c, "SELECT code FROM metric WHERE id = ?", [metric])?;
            if let Some(code) = code {
                spans.push((code, metric, from, to));
            }
        }
        spans.sort();
        let mut budget = max_rows;
        let mut next: Option<crate::syncstate::Cursor> = None;
        for (code, metric, from, to) in spans {
            let lo = match after {
                Some(a) if code < a.code => continue,
                Some(a) if code == a.code => from.max(a.start_ms.saturating_add(1)),
                _ => from,
            };
            if lo > to {
                continue;
            }
            let rows = "FROM main.observation WHERE metric_id = ?1 AND start_ms BETWEEN ?2 AND ?3 AND import_id = ?4";
            if budget <= 0 {
                // the budget is spent: stop before the first metric that still has rows
                let any: Option<i64> = one(c, &format!("SELECT 1 {rows} LIMIT 1"), [metric, lo, to, id])?;
                if any.is_some() {
                    break;
                }
                continue;
            }
            let cut: Option<i64> =
                one(c, &format!("SELECT start_ms {rows} ORDER BY start_ms LIMIT 1 OFFSET ?5"), [metric, lo, to, id, budget - 1])?;
            let hi = cut.unwrap_or(to);
            let n = c.execute(&format!("INSERT INTO plain.observation SELECT * {rows}"), [metric, lo, hi, id])?;
            budget -= n as i64;
            if cut.is_some() {
                next = Some(crate::syncstate::Cursor { code: code.clone(), start_ms: hi });
                if budget <= 0 {
                    break;
                }
            }
        }
        // a part that took the last rows exactly: is anything left after its cursor?
        if let Some(n) = &next {
            let mut more = false;
            for (metric, (from, to)) in span_of(&parse_meta(one(c, "SELECT meta FROM import WHERE id = ?", [id])?)) {
                let code: Option<String> = one(c, "SELECT code FROM metric WHERE id = ?", [metric])?;
                let Some(code) = code else { continue };
                let lo = if code == n.code { from.max(n.start_ms.saturating_add(1)) } else { from };
                if code < n.code || lo > to {
                    continue;
                }
                let any: Option<i64> = one(
                    c,
                    "SELECT 1 FROM main.observation WHERE metric_id = ?1 AND start_ms BETWEEN ?2 AND ?3 AND import_id = ?4 LIMIT 1",
                    [metric, lo, to, id],
                )?;
                if any.is_some() {
                    more = true;
                    break;
                }
            }
            if !more {
                next = None;
            }
        }
        Ok(next)
    });
    c.execute_batch("DETACH DATABASE plain")?;
    r
}

/// (type, name) of every object a database created from the schema has.
fn expected_objects() -> Result<BTreeSet<(String, String, Option<String>)>> {
    let m = rusqlite::Connection::open_in_memory()?;
    m.execute_batch(&schema_body())?;
    objects(&m, "main")
}

/// (type, name, definition) of every object: a differing definition (a view or trigger standing in, other columns) is refused.
/// Comments and whitespace are ignored, so backups made under older comment text still match.
fn objects(c: &Db, schema: &str) -> Result<BTreeSet<(String, String, Option<String>)>> {
    let mut st = c.prepare(&format!("SELECT type, name, sql FROM {schema}.sqlite_schema"))?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?.map(|s| definition(&s)))))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// SQL without `--` comments, with whitespace collapsed (the schema has no `--` inside string literals).
fn definition(sql: &str) -> String {
    sql.lines().map(|l| l.split("--").next().unwrap_or("")).collect::<Vec<_>>().join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Merges the plain database file at `path` (untrusted: checked before anything is read).
pub fn merge_from(c: &Db, path: &Path, now_ms: i64) -> Result<MergeReport> {
    merge_from_checked(c, path, now_ms, &|_| Ok(()))
}

/// `merge_from`, with `check` run inside the merge's transaction once the file has passed the schema checks
/// (`plain` attached): a refusal leaves nothing merged.
pub fn merge_from_checked(c: &Db, path: &Path, now_ms: i64, check: &dyn Fn(&Db) -> Result<()>) -> Result<MergeReport> {
    c.pragma_update(None, "trusted_schema", "OFF")?;
    attach(c, path, true)?;
    let r = (|| {
        let ok: String = c.query_row("PRAGMA plain.quick_check", [], |r| r.get(0))?;
        if ok != "ok" || objects(c, "plain")? != expected_objects()? {
            return Err(Error::invalid("backup_db", "not a health database"));
        }
        // text this side can't read back, and the web would store as U+FFFD: the whole pack is refused (R11)
        if !plain_text_is_utf8(c)? {
            return Err(Error::invalid("backup_db", "text that isn't UTF-8"));
        }
        tx(c, || {
            check(c)?;
            merge_attached(c, now_ms)
        })
    })();
    let _ = c.execute_batch(
        "DROP TABLE IF EXISTS temp.merge_metric; DROP TABLE IF EXISTS temp.merge_source; DROP TABLE IF EXISTS temp.merge_import;",
    );
    c.execute_batch("DETACH DATABASE plain")?;
    r
}

/// `a > b` with NULL smallest, never NULL itself (a row-value comparison yields NULL on a NULL component).
fn gt(a: &str, b: &str) -> String {
    format!("(({b} IS NULL AND {a} IS NOT NULL) OR {a} > {b})")
}

/// For two rows of the same import (equal uid): whether `e` (incoming) beats `o` (local), by typeof, then value,
/// end_ms, tz_min, detail (merge-fixes R1). typeof names order blob < integer < null < real < text.
fn newer_row(e: &str, o: &str) -> String {
    let mut out = gt(&format!("{e}.detail"), &format!("{o}.detail"));
    for col in ["tz_min", "end_ms", "value"] {
        out = format!("({} OR ({e}.{col} IS {o}.{col} AND {out}))", gt(&format!("{e}.{col}"), &format!("{o}.{col}")));
    }
    format!("(typeof({e}.value) > typeof({o}.value) OR (typeof({e}.value) = typeof({o}.value) AND {out}))")
}

/// Every TEXT value in the attached plain database is valid UTF-8 (R11).
fn plain_text_is_utf8(c: &Db) -> Result<bool> {
    for t in ["metric", "metric_alias", "source", "import", "observation", "correction", "genotype"] {
        let cols: Vec<String> =
            c.prepare(&format!("PRAGMA plain.table_info(\"{t}\")"))?.query_map([], |r| r.get(1))?.collect::<rusqlite::Result<_>>()?;
        for col in cols {
            if !column_is_utf8(c, &format!("SELECT \"{col}\" FROM plain.\"{t}\" WHERE typeof(\"{col}\") = 'text'"))? {
                return Ok(false);
            }
        }
    }
    column_is_utf8(c, "SELECT text FROM plain.report_text WHERE typeof(text) = 'text'")
}

fn column_is_utf8(c: &Db, sql: &str) -> Result<bool> {
    let mut st = c.prepare(sql)?;
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        if let rusqlite::types::ValueRef::Text(b) = r.get_ref(0)?
            && std::str::from_utf8(b).is_err()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Clock skew tolerated between devices.
pub const MAX_SKEW_MS: i64 = 86_400_000;

/// "Larger uid wins" makes uids security-relevant: a crafted backup could otherwise take over every local row
/// (uid "zzzz") for good. Accepted: a UUIDv7 not from the future, or a signed-result id (web ingest uses the
/// result id as uid) on a lab/staff/room source only; known local uids always pass.
fn plausible_uid(c: &Db, uid: &str, source_id: i64, now_ms: i64) -> Result<bool> {
    // first, so a bad uid already stored here can't pass either (P5)
    if !crate::write::plain_uid(uid) {
        return Ok(false);
    }
    if one::<i64>(c, "SELECT 1 FROM import WHERE uid = ?", [uid])?.is_some() {
        return Ok(true);
    }
    if let Some(t) = crate::batches::uuid_time(uid) {
        return Ok(t <= now_ms + MAX_SKEW_MS && uid.len() == 36 && uid == uid.to_ascii_lowercase());
    }
    let connector: String = c.query_row("SELECT connector FROM source WHERE id = ?", [source_id], |r| r.get(0))?;
    Ok(matches!(connector.as_str(), "lab" | "staff" | "room"))
}

/// Whether the import `uid` may hold file `sha` (R6): yes when no other import holds it, or when the holder's uid is
/// larger, in which case the holder gives it up (NULL first, so the unique index on `import.blob` holds).
fn take_blob(c: &Db, uid: &str, sha: &str, except: Option<i64>) -> Result<bool> {
    let holder: Option<(i64, String, String)> = c
        .query_row("SELECT id, uid, status FROM import WHERE blob = ?1 AND id IS NOT ?2", rusqlite::params![sha, except], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .ok();
    Ok(match holder {
        None => true,
        // an import being written keeps its file (R6c)
        Some((_, _, status)) if status == "running" => false,
        Some((id, holder_uid, _)) if uid < holder_uid.as_str() => {
            c.execute("UPDATE import SET blob = NULL WHERE id = ?", [id])?;
            true
        }
        Some(_) => false,
    })
}

/// A remote import's meta as it may arrive (R6b v6): a `meta.file` that isn't a sha is dropped, and a sha `blob`
/// records itself as the file when the meta names none (packs from before R6b carry no `meta.file`).
fn with_file(mut m: serde_json::Map<String, serde_json::Value>, blob: &Option<String>) -> serde_json::Map<String, serde_json::Value> {
    if m.get("file").is_some_and(|f| !f.as_str().is_some_and(crate::blob::is_sha)) {
        m.remove("file");
    }
    if let (false, Some(b)) = (m.contains_key("file"), blob) {
        m.insert("file".into(), serde_json::Value::String(b.clone()));
    }
    m
}

/// Sets `meta.file` from the remote meta when the local one has none (R6b); whether it changed.
fn keep_file(local: &mut serde_json::Map<String, serde_json::Value>, remote: &Option<String>) -> bool {
    if local.contains_key("file") {
        return false;
    }
    match parse_meta(remote.clone()).get("file").filter(|f| f.as_str().is_some_and(crate::blob::is_sha)) {
        Some(f) => {
            local.insert("file".into(), f.clone());
            true
        }
        None => false,
    }
}

/// G5: `set_at` is `^(0|[1-9][0-9]*)$` within i64; anything else counts as 0 (None here).
pub fn set_at_value(s: &str) -> Option<i64> {
    let ok = s == "0" || (!s.is_empty() && !s.starts_with('0') && s.bytes().all(|b| b.is_ascii_digit()));
    ok.then(|| s.parse::<i64>().ok()).flatten()
}

/// A source's setting stamp from its meta: (set_at as an integer, set_by); absent: (0, "").
fn setting(meta: &Option<String>) -> (i64, String) {
    let m = parse_meta(meta.clone());
    let at = m.get("set_at").and_then(|v| v.as_str()).and_then(set_at_value).unwrap_or(0);
    let by = m.get("set_by").and_then(|v| v.as_str()).unwrap_or("").to_string();
    (at, by)
}

struct PImport {
    id: i64,
    uid: String,
    source_id: i64,
    parser: String,
    blob: Option<String>,
    status: String,
    meta: Option<String>,
}

fn merge_attached(c: &Db, now_ms: i64) -> Result<MergeReport> {
    let mut rep = MergeReport::default();
    c.execute_batch(
        "CREATE TEMP TABLE merge_metric (p INTEGER PRIMARY KEY, l INTEGER NOT NULL);
         CREATE TEMP TABLE merge_source (p INTEGER PRIMARY KEY, l INTEGER NOT NULL);
         CREATE TEMP TABLE merge_import (p INTEGER PRIMARY KEY, l INTEGER NOT NULL);",
    )?;

    // 1. metrics by code
    let remote: Vec<(i64, String, String, String, String)> = c
        .prepare("SELECT id, code, name, unit, agg FROM plain.metric ORDER BY id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<Result<_, _>>()?;
    let mut map_metric: HashMap<i64, i64> = HashMap::new();
    for (pid, code, name, unit, agg) in remote {
        let local: Option<(i64, String, String)> =
            c.query_row("SELECT id, unit, agg FROM metric WHERE code = ?", [&code], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).ok();
        let lid = match local {
            None => {
                c.execute("INSERT INTO metric (code, name, unit, agg) VALUES (?, ?, ?, ?)", [&code, &name, &unit, &agg])?;
                rep.added_metrics += 1;
                c.last_insert_rowid()
            }
            // user-made x:ocr metrics keep the printed spelling of their unit
            Some((lid, lunit, lagg))
                if lagg == agg && (lunit == unit || (code.starts_with("x:ocr/") && crate::units::same_unit(&lunit, &unit))) =>
            {
                lid
            }
            Some(_) => {
                rep.skipped_metrics.push(code);
                continue;
            }
        };
        c.execute("INSERT INTO merge_metric VALUES (?, ?)", [pid, lid])?;
        map_metric.insert(pid, lid);
    }
    // aliases converge: on a conflict the smaller metric code wins (merge-fixes G3)
    c.execute(
        "INSERT INTO metric_alias (alias, unit, metric_id)
         SELECT a.alias, a.unit, mm.l FROM plain.metric_alias a JOIN merge_metric mm ON mm.p = a.metric_id WHERE true
         ON CONFLICT (alias, unit) DO UPDATE SET metric_id = excluded.metric_id
         WHERE (SELECT code FROM metric WHERE id = excluded.metric_id) < (SELECT code FROM metric WHERE id = metric_alias.metric_id)",
        [],
    )?;

    // 2. sources by identity; name and priority converge by (set_at, set_by, priority, name) (R3)
    let remote: Vec<(i64, String, String, String, i64, Option<String>)> = c
        .prepare("SELECT id, connector, external_id, name, priority, meta FROM plain.source ORDER BY id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<Result<_, _>>()?;
    let mut map_source: HashMap<i64, i64> = HashMap::new();
    for (pid, connector, external_id, name, priority, meta) in remote {
        let lid = match one::<i64>(c, "SELECT id FROM source WHERE connector = ? AND external_id = ?", [&connector, &external_id])? {
            Some(id) => {
                let (lname, lprio, lmeta): (String, i64, Option<String>) =
                    c.query_row("SELECT name, priority, meta FROM source WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
                let (r_at, r_by) = setting(&meta);
                let (l_at, l_by) = setting(&lmeta);
                let future = r_at > (now_ms + MAX_SKEW_MS) << crate::correction::HLC_SHIFT;
                if !future && (r_at, r_by.as_str(), priority, name.as_str()) > (l_at, l_by.as_str(), lprio, lname.as_str()) {
                    let mut m = parse_meta(lmeta);
                    for k in ["set_at", "set_by"] {
                        match parse_meta(meta.clone()).get(k) {
                            Some(v) => m.insert(k.into(), v.clone()),
                            None => m.remove(k),
                        };
                    }
                    let m = (!m.is_empty()).then(|| serde_json::Value::Object(m).to_string());
                    c.execute("UPDATE source SET name = ?, priority = ?, meta = ? WHERE id = ?", rusqlite::params![name, priority, m, id])?;
                }
                id
            }
            None => {
                // a stamp from the future would push this device's HLC ahead: it comes in unstamped (R3, G1)
                let mut meta = meta;
                if setting(&meta).0 > (now_ms + MAX_SKEW_MS) << crate::correction::HLC_SHIFT {
                    let mut m = parse_meta(meta.clone());
                    m.remove("set_at");
                    m.remove("set_by");
                    meta = (!m.is_empty()).then(|| serde_json::Value::Object(m).to_string());
                }
                c.execute(
                    "INSERT INTO source (connector, external_id, name, priority, meta) VALUES (?, ?, ?, ?, ?)",
                    rusqlite::params![connector, external_id, name, priority, meta],
                )?;
                rep.added_sources += 1;
                c.last_insert_rowid()
            }
        };
        c.execute("INSERT INTO merge_source VALUES (?, ?)", [pid, lid])?;
        map_source.insert(pid, lid);
    }

    // 3. imports by uid
    let translate = |meta: Option<String>| -> (serde_json::Map<String, serde_json::Value>, Span) {
        let mut m = parse_meta(meta);
        let span: Span = span_of(&m).into_iter().filter_map(|(k, v)| map_metric.get(&k).map(|l| (*l, v))).collect();
        set_span(&mut m, &span);
        (m, span)
    };
    let remote: Vec<PImport> = c
        .prepare("SELECT id, uid, source_id, parser, blob, status, meta FROM plain.import WHERE status IN ('done', 'erased', 'review') ORDER BY id")?
        // a blob that isn't a sha arrives as NULL, on every path (P5)
        .query_map([], |r| {
            Ok(PImport {
                id: r.get(0)?,
                uid: r.get(1)?,
                source_id: r.get(2)?,
                parser: r.get(3)?,
                blob: r.get::<_, Option<String>>(4)?.filter(|b| crate::blob::is_sha(b)),
                status: r.get(5)?,
                meta: r.get(6)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut new_imports: Vec<(i64, Span)> = Vec::new();
    let mut same_imports: Vec<i64> = Vec::new(); // done on both sides: report text decided below
    let mut touched: Vec<(i64, Span)> = Vec::new(); // (local source id, span) to rebuild
    const NEXT_ID: &str = "(SELECT coalesce(max(id), 0) + 1 FROM import)";
    for mut i in remote {
        let Some(&sid) = map_source.get(&i.source_id) else { continue };
        // one place for every path (new import, R2, done/done, review/review): the file it brought, as a sha (R6b v6)
        if i.status != "erased" {
            i.meta = Some(serde_json::Value::Object(with_file(parse_meta(i.meta.take()), &i.blob)).to_string());
        }
        if !plausible_uid(c, &i.uid, sid, now_ms)? {
            rep.refused_imports += 1;
            continue;
        }
        let local: Option<(i64, String, Option<String>, i64)> = c
            .query_row("SELECT id, status, meta, source_id FROM import WHERE uid = ?", [&i.uid], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .ok();
        match local {
            None => {
                if i.status == "erased" {
                    // keep the tombstone so an older copy cannot bring the data back later
                    c.execute(
                        &format!("INSERT INTO import (id, uid, source_id, parser, blob, status, meta) VALUES ({NEXT_ID}, ?, ?, ?, NULL, 'erased', NULL)"),
                        rusqlite::params![i.uid, sid, i.parser],
                    )?;
                    rep.added_imports += 1;
                    continue;
                }
                // the same file imported on two devices: the smaller uid keeps it (R6)
                let mut blob = i.blob.clone();
                if let Some(b) = &blob
                    && !take_blob(c, &i.uid, b, None)?
                {
                    blob = None;
                    rep.dropped_blobs += 1;
                }
                if i.status == "review" {
                    // no rows yet; candidates use global codes, so meta travels as is
                    c.execute(
                        &format!("INSERT INTO import (id, uid, source_id, parser, blob, status, meta) VALUES ({NEXT_ID}, ?, ?, ?, ?, 'review', ?)"),
                        rusqlite::params![i.uid, sid, i.parser, blob, i.meta],
                    )?;
                    rep.added_imports += 1;
                    rep.needed_blobs.extend(blob);
                    continue;
                }
                let (meta, span) = translate(i.meta.clone());
                c.execute(
                    &format!(
                        "INSERT INTO import (id, uid, source_id, parser, blob, status, meta) VALUES ({NEXT_ID}, ?, ?, ?, ?, 'done', ?)"
                    ),
                    rusqlite::params![i.uid, sid, i.parser, blob, serde_json::Value::Object(meta).to_string()],
                )?;
                let lid: i64 = c.query_row("SELECT id FROM import WHERE uid = ?", [&i.uid], |r| r.get(0))?;
                c.execute("INSERT INTO merge_import VALUES (?, ?)", [i.id, lid])?;
                new_imports.push((lid, span.clone()));
                touched.push((sid, span));
                rep.added_imports += 1;
                rep.needed_blobs.extend(blob);
            }
            // pending or done here, gone there: erase here too
            Some((lid, ls, _, _)) if (ls == "done" || ls == "review") && i.status == "erased" => {
                rep.orphan_blobs.extend(crate::erase::erase(c, lid, now_ms)?.orphan_blobs);
                rep.erased_imports += 1;
            }
            Some((lid, ls, lmeta, lsid)) if ls == "done" && i.status == "done" => {
                // the same import on both sides: rows merge by the usual rule, spans unite
                c.execute("INSERT INTO merge_import VALUES (?, ?)", [i.id, lid])?;
                let (_, t) = translate(i.meta.clone());
                let mut lm = parse_meta(lmeta);
                let mut cur = span_of(&lm);
                for (k, (a, b)) in &t {
                    let e = cur.entry(*k).or_insert((*a, *b));
                    *e = (e.0.min(*a), e.1.max(*b));
                }
                set_span(&mut lm, &cur);
                keep_file(&mut lm, &i.meta);
                c.execute("UPDATE import SET meta = ? WHERE id = ?", rusqlite::params![serde_json::Value::Object(lm).to_string(), lid])?;
                // a file the other side holds for this import and this side doesn't: taken under R6
                if let Some(b) = &i.blob
                    && one::<Option<String>>(c, "SELECT blob FROM import WHERE id = ?", [lid])?.flatten().is_none()
                    && take_blob(c, &i.uid, b, Some(lid))?
                {
                    c.execute("UPDATE import SET blob = ? WHERE id = ?", rusqlite::params![b, lid])?;
                    rep.needed_blobs.push(b.clone());
                }
                same_imports.push(lid);
                touched.push((lsid, t));
            }
            // a review confirmed on the other device: it becomes that import here (R2). Renumbered as
            // `review::confirm` does; a remote NULL file never clears the local one; review imports hold no rows or text.
            Some((lid, ls, lmeta, _)) if ls == "review" && i.status == "done" => {
                let local_blob: Option<String> = one(c, "SELECT blob FROM import WHERE id = ?", [lid])?.flatten();
                let blob = match (&i.blob, local_blob) {
                    (Some(b), None) => take_blob(c, &i.uid, b, Some(lid))?.then(|| b.clone()),
                    (_, local) => local,
                };
                let (mut meta, span) = translate(i.meta.clone());
                // the remote meta, keeping the local file if the remote names none (R6b)
                if let (false, Some(f)) = (meta.contains_key("file"), parse_meta(lmeta).get("file").cloned()) {
                    meta.insert("file".into(), f);
                }
                c.execute(
                    &format!("UPDATE import SET status = 'done', parser = ?, blob = ?, meta = ?, id = {NEXT_ID} WHERE id = ?"),
                    rusqlite::params![i.parser, blob, serde_json::Value::Object(meta).to_string(), lid],
                )?;
                let lid: i64 = c.query_row("SELECT id FROM import WHERE uid = ?", [&i.uid], |r| r.get(0))?;
                c.execute("INSERT INTO merge_import VALUES (?, ?)", [i.id, lid])?;
                new_imports.push((lid, span.clone()));
                touched.push((sid, span));
                rep.confirmed_reviews += 1;
                rep.needed_blobs.extend(blob);
            }
            // the same review on both sides: only the file can differ; a local NULL takes the remote one (R6b)
            Some((lid, ls, lmeta, _)) if ls == "review" && i.status == "review" => {
                let mut lm = parse_meta(lmeta);
                if keep_file(&mut lm, &i.meta) {
                    c.execute(
                        "UPDATE import SET meta = ? WHERE id = ?",
                        rusqlite::params![serde_json::Value::Object(lm).to_string(), lid],
                    )?;
                }
                if let Some(b) = &i.blob
                    && one::<Option<String>>(c, "SELECT blob FROM import WHERE id = ?", [lid])?.flatten().is_none()
                    && take_blob(c, &i.uid, b, Some(lid))?
                {
                    c.execute("UPDATE import SET blob = ? WHERE id = ?", rusqlite::params![b, lid])?;
                    rep.needed_blobs.push(b.clone());
                }
            }
            // locally erased stays erased; running / failed: untouched
            Some(_) => {}
        }
    }

    // manual imports holding rows now: one emptied by this merge is erased below (R7b)
    let manual_held: Vec<i64> = c
        .prepare(
            "SELECT i.id FROM import i JOIN source s ON s.id = i.source_id
              WHERE s.connector = 'manual' AND s.external_id = '' AND i.status = 'done'",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?
        .into_iter()
        .map(|id| crate::manual::rows_held(c, id).map(|n| (id, n)))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .filter_map(|(id, n)| (n > 0).then_some(id))
        .collect();

    // a row's value is judged by the local measure; a row of a measure skipped here counts only for its shape
    rep.refused_rows = c.query_row(
        &format!(
            "SELECT (SELECT count(*) FROM plain.observation o JOIN merge_import mi ON mi.p = o.import_id
                       LEFT JOIN merge_metric mm ON mm.p = o.metric_id LEFT JOIN metric lm ON lm.id = mm.l
                      WHERE NOT coalesce({ROW_SHAPE}, 0) OR (lm.agg IS NOT NULL AND NOT coalesce({}, 0)))
                  + (SELECT count(*) FROM plain.correction WHERE start_ms NOT BETWEEN 0 AND ?1)",
            value_ok("lm.agg")
        ),
        [crate::write::MAX_TIME_MS],
        |r| r.get::<_, i64>(0),
    )? as u64;

    // 4. observations: translate ids, larger uid wins; rows of the same import are decided by value (R1)
    c.execute(
        &format!(
            "INSERT INTO observation (metric_id, start_ms, source_id, end_ms, tz_min, value, import_id, detail)
             SELECT mm.l, o.start_ms, ms.l, o.end_ms, o.tz_min, o.value, mi.l, o.detail
               FROM plain.observation o
               JOIN merge_metric mm ON mm.p = o.metric_id
               JOIN metric lm ON lm.id = mm.l
               JOIN merge_source ms ON ms.p = o.source_id
               JOIN merge_import mi ON mi.p = o.import_id
              WHERE ms.l = (SELECT source_id FROM import WHERE id = mi.l) -- a row belongs to its import's source (R9)
                AND {ok} -- only what the writers would accept (R13, R14)
             ON CONFLICT (metric_id, start_ms, source_id) DO UPDATE SET
               end_ms = excluded.end_ms, tz_min = excluded.tz_min, value = excluded.value, import_id = excluded.import_id, detail = excluded.detail
             WHERE (SELECT uid FROM import WHERE id = excluded.import_id) > (SELECT uid FROM import WHERE id = observation.import_id)
                OR ((SELECT uid FROM import WHERE id = excluded.import_id) = (SELECT uid FROM import WHERE id = observation.import_id)
                    AND {newer})",
            ok = row_ok("lm.agg"),
            newer = newer_row("excluded", "observation")
        ),
        [],
    )?;

    // spans cover every row that came with an import, even one outside the span it was sent with (R10): from the
    // incoming rows, grouped, so no local table is scanned by import_id
    let grown: Vec<(i64, i64, i64, i64)> = c
        .prepare(&format!(
            "SELECT mi.l, mm.l, min(o.start_ms), max(o.start_ms)
               FROM plain.observation o
               JOIN merge_metric mm ON mm.p = o.metric_id
               JOIN metric lm ON lm.id = mm.l
               JOIN merge_import mi ON mi.p = o.import_id
              WHERE {}
              GROUP BY 1, 2",
            row_ok("lm.agg")
        ))?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut by_import: HashMap<i64, Span> = HashMap::new();
    for (lid, metric, from, to) in grown {
        by_import.entry(lid).or_default().insert(metric, (from, to));
    }
    for (lid, add) in by_import {
        let (sid, meta): (i64, Option<String>) =
            c.query_row("SELECT source_id, meta FROM import WHERE id = ?", [lid], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let mut m = parse_meta(meta);
        let mut span = span_of(&m);
        for (metric, (a, b)) in &add {
            let e = span.entry(*metric).or_insert((*a, *b));
            *e = (e.0.min(*a), e.1.max(*b));
        }
        set_span(&mut m, &span);
        c.execute("UPDATE import SET meta = ? WHERE id = ?", rusqlite::params![serde_json::Value::Object(m).to_string(), lid])?;
        touched.push((sid, add));
    }

    // 5. corrections; one from the future would beat every later local correction
    let max_at = (now_ms + MAX_SKEW_MS) << crate::correction::HLC_SHIFT;
    rep.refused_corrections = c.query_row("SELECT count(*) FROM plain.correction WHERE at > ?", [max_at], |r| r.get::<_, i64>(0))? as u64;
    c.execute(
        &format!(
            "INSERT INTO correction (metric_id, source_id, start_ms, at, value)
             SELECT mm.l, ms.l, c.start_ms, c.at, c.value
               FROM plain.correction c
               JOIN merge_metric mm ON mm.p = c.metric_id
               JOIN merge_source ms ON ms.p = c.source_id
              WHERE c.at <= ?1 AND c.start_ms BETWEEN 0 AND 253402041600000
             ON CONFLICT (metric_id, source_id, start_ms) DO UPDATE SET at = excluded.at, value = excluded.value WHERE {CORRECTION_WINS}"
        ),
        [max_at],
    )?;
    // the days of every correction that applied are rebuilt, whether or not its import was in this merge (R5).
    // Refused ones (future `at`) never match the local row's `at`.
    let corrected: Vec<Scope> = c
        .prepare(
            "SELECT l.metric_id, l.source_id, l.start_ms
               FROM plain.correction c
               JOIN merge_metric mm ON mm.p = c.metric_id
               JOIN merge_source ms ON ms.p = c.source_id
               JOIN correction l ON l.metric_id = mm.l AND l.source_id = ms.l AND l.start_ms = c.start_ms
              WHERE l.at = c.at AND l.value IS c.value",
        )?
        .query_map([], |r| Ok(Scope { metric_id: r.get(0)?, source_id: r.get(1)?, from: r.get(2)?, to: r.get(2)? }))?
        .collect::<Result<_, _>>()?;

    // 6. genotypes and full text of new imports
    // the primary key includes the import, so a conflict is the same import: the larger (genotype, rsid) wins (R1)
    c.execute(
        &format!(
            "INSERT INTO genotype (import_id, chrom, pos, rsid, genotype)
             SELECT mi.l, g.chrom, g.pos, g.rsid, g.genotype FROM plain.genotype g JOIN merge_import mi ON mi.p = g.import_id WHERE true
             ON CONFLICT (import_id, chrom, pos) DO UPDATE SET genotype = excluded.genotype, rsid = excluded.rsid
             WHERE excluded.genotype > genotype OR (excluded.genotype = genotype AND {})",
            gt("excluded.rsid", "rsid")
        ),
        [],
    )?;
    // report text: copied when missing here; for the same import the larger text wins (R1). FTS5: delete, then insert.
    for lid in new_imports.iter().map(|(l, _)| *l).chain(same_imports.iter().copied()) {
        let remote: Option<String> =
            one(c, "SELECT t.text FROM plain.report_text t JOIN merge_import mi ON mi.p = t.rowid WHERE mi.l = ?", [lid])?;
        let Some(remote) = remote else { continue };
        let local: Option<String> = one(c, "SELECT text FROM report_text WHERE rowid = ?", [lid])?;
        if local.as_ref().is_none_or(|l| remote > *l) {
            c.execute("DELETE FROM report_text WHERE rowid = ?", [lid])?;
            c.execute("INSERT INTO report_text (rowid, text) VALUES (?, ?)", rusqlite::params![lid, remote])?;
        }
    }
    for (lid, span) in &new_imports {
        // files that waveform pointers need
        for (mid, (a, b)) in span {
            if one::<String>(c, "SELECT agg FROM metric WHERE id = ?", [mid])?.as_deref() != Some("none") {
                continue;
            }
            let mut st =
                c.prepare("SELECT DISTINCT value FROM observation WHERE metric_id = ? AND start_ms BETWEEN ? AND ? AND import_id = ?")?;
            for v in st.query_map([*mid, *a, *b, *lid], |r| r.get::<_, crate::Value>(0))? {
                if let crate::Value::Text(s) = v?
                    && crate::blob::is_sha(&s)
                {
                    rep.needed_blobs.push(s);
                }
            }
        }
    }

    // a manual entry superseded by a newer one from another device: its emptied import is erased, so the tombstone
    // travels and a device still holding it can't bring the old value back (R7b, as R7 does for local writes)
    for id in manual_held {
        let status: Option<String> = one(c, "SELECT status FROM import WHERE id = ?", [id])?;
        if status.as_deref() == Some("done") && crate::manual::rows_held(c, id)? == 0 {
            rep.orphan_blobs.extend(crate::erase::erase(c, id, now_ms)?.orphan_blobs);
            rep.erased_imports += 1;
        }
    }

    // 7. rebuild affected daily rows (erase already rebuilt its own)
    let scopes: Vec<Scope> = touched
        .iter()
        .flat_map(|(sid, span)| span.iter().map(move |(m, (a, b))| Scope { metric_id: *m, source_id: *sid, from: *a, to: *b }))
        .chain(corrected)
        .collect();
    crate::daily::rebuild(c, &scopes, now_ms)?;
    c.execute_batch("DROP TABLE merge_metric; DROP TABLE merge_source; DROP TABLE merge_import;")?;
    rep.needed_blobs.sort();
    rep.needed_blobs.dedup();
    // the same list in the same order on both implementations (merge-fixes R4)
    rep.skipped_metrics.sort();
    // erase (step 3) judged orphans before later steps added rows; a file referenced again must stay
    let mut orphans = Vec::new();
    for sha in std::mem::take(&mut rep.orphan_blobs) {
        if !crate::erase::referenced(c, &sha)? && !orphans.contains(&sha) {
            orphans.push(sha);
        }
    }
    rep.orphan_blobs = orphans;
    Ok(rep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Value;
    use crate::keys::MemoryStore;
    use crate::profile::Profile;
    use crate::write::{Begin, ObsRow, SourceSpec, begin, finish, write};

    const NOW: i64 = 1_795_176_000_000;
    const T: i64 = 1_790_000_000_000;

    /// R14 for an INTEGER beyond 2^53 too, which shared case 23 can't hold (the web's SQLite binding can't read it
    /// back): rows the writers would refuse are skipped and counted, the good one merges.
    #[test]
    fn rows_the_writers_would_refuse_are_counted() {
        let dir = tempfile::tempdir().unwrap();
        let keys = MemoryStore::default();
        let a = Profile::init(dir.path(), "a", &keys).unwrap();
        let b = Profile::init(dir.path(), "b", &keys).unwrap();
        let src = SourceSpec::new("whoop", "u1");
        let (id, _) = begin(&b.db, Begin { source: &src, parser: "test", blob: None, uid: None, candidates: None }, NOW).unwrap();
        let good = ObsRow {
            metric: "loinc:40443-4".into(),
            start_ms: T,
            end_ms: None,
            tz_min: 480,
            value: Value::Int(60),
            unit: None,
            detail: None,
        };
        write(&b.db, id, &[good]).unwrap();
        finish(&b.db, id, NOW).unwrap();
        // past the writer, on the same import: an offset of 15 h, an INTEGER of 2^53, NULL on an instant measure
        for (at, tz, v) in [(T + 1, 900, Value::Int(61)), (T + 8, 480, Value::Int(9_007_199_254_740_992)), (T + 9, 480, Value::Null)] {
            b.db.execute(
                "INSERT INTO observation (metric_id, start_ms, source_id, end_ms, tz_min, value, import_id)
                 SELECT o.metric_id, ?2, o.source_id, NULL, ?3, ?4, o.import_id FROM observation o WHERE o.import_id = ?1 AND o.start_ms = ?5",
                rusqlite::params![id, at, tz, v, T],
            )
            .unwrap();
        }
        let pack = dir.path().join("b.db");
        export_plain(&b.db, &pack).unwrap();
        let r = merge_from(&a.db, &pack, NOW).unwrap();
        assert_eq!(r.refused_rows, 3);
        let rows: Vec<(i64, i64)> =
            a.db.prepare("SELECT start_ms, value FROM observation")
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
        assert_eq!(rows, [(T, 60)]);
    }
}
