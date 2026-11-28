//! Import batches and the shared write pipeline (DB design §3 stages 1–6), ported from the web `db/write.ts`:
//!   begin(source, parser, blob)  import row, status = running
//!   write(import, rows)          convert units, gate by agg, UPSERT (larger uid wins), merge span into meta
//!   finish(import)               status = done, rebuild the affected daily rows
//! Rejected rows are not written; counts by reason go to `import.meta.rejected`.

use crate::db::{Db, one, tx};
use crate::error::{Error, Result};
use crate::units::to_canonical;
use crate::value::{MAX_SAFE, Value};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone)]
pub struct SourceSpec {
    pub connector: String,
    pub external_id: String,
    pub name: Option<String>,
    pub priority: Option<i64>,
    pub meta: Option<Json>,
}

impl SourceSpec {
    pub fn new(connector: &str, external_id: &str) -> Self {
        SourceSpec { connector: connector.into(), external_id: external_id.into(), name: None, priority: None, meta: None }
    }
}

/// One incoming row, before conversion.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ObsRow {
    /// metric.code
    pub metric: String,
    pub start_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<i64>,
    pub tz_min: i64,
    pub value: Value,
    /// Printed unit of the value; defaults to the canonical unit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Json>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reject {
    Metric,
    Unit,
    Value,
    Time,
}

impl Reject {
    fn key(self) -> &'static str {
        match self {
            Reject::Metric => "metric",
            Reject::Unit => "unit",
            Reject::Value => "value",
            Reject::Time => "time",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, schemars::JsonSchema)]
pub struct WriteResult {
    pub written: u64,
    /// Rows already owned by a newer import (larger uid), left as they were
    pub kept: u64,
    /// Rejected row counts by reason: metric | unit | value | time.
    pub rejected: BTreeMap<String, u64>,
}

#[derive(Debug, Clone)]
pub struct MetricRow {
    pub id: i64,
    pub code: String,
    pub unit: String,
    pub agg: String,
}

pub fn metric_by_code(c: &Db, code: &str) -> Result<Option<MetricRow>> {
    Ok(c.query_row("SELECT id, code, unit, agg FROM metric WHERE code = ?", [code], |r| {
        Ok(MetricRow { id: r.get(0)?, code: r.get(1)?, unit: r.get(2)?, agg: r.get(3)? })
    })
    .map(Some)
    .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })?)
}

/// import.meta as a JSON object (null → empty).
pub fn parse_meta(s: Option<String>) -> Map<String, Json> {
    s.and_then(|s| serde_json::from_str::<Json>(&s).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

pub type Span = BTreeMap<i64, (i64, i64)>;

/// `meta.span`: {metric_id: [first, last start_ms]}.
pub fn span_of(meta: &Map<String, Json>) -> Span {
    let mut out = Span::new();
    if let Some(obj) = meta.get("span").and_then(Json::as_object) {
        for (k, v) in obj {
            if let (Ok(id), Some([a, b])) = (k.parse(), v.as_array().map(Vec::as_slice))
                && let (Some(a), Some(b)) = (a.as_i64(), b.as_i64())
            {
                out.insert(id, (a, b));
            }
        }
    }
    out
}

fn span_json(span: &Span) -> Json {
    Json::Object(span.iter().map(|(k, (a, b))| (k.to_string(), json!([a, b]))).collect())
}

pub fn set_span(meta: &mut Map<String, Json>, span: &Span) {
    meta.insert("span".into(), span_json(span));
}

/// A connector's default source priority (smaller wins). Shared with the web for R3's upgrade stamp.
pub fn default_priority(connector: &str) -> i64 {
    match connector {
        "manual" => 0,
        "derived" => crate::derived::PRIORITY,
        _ => 100,
    }
}

/// Stamps a source's name/priority setting with an HLC and the device that set it (merge-fixes R3). The HLC is
/// kept as a decimal string: it exceeds what a JSON number carries exactly.
pub fn stamp_source(c: &Db, id: i64, now_ms: i64, by: &str) -> Result<()> {
    let at = crate::correction::next_at(c, now_ms)?;
    let meta: Option<String> = c.query_row("SELECT meta FROM source WHERE id = ?", [id], |r| r.get(0))?;
    let mut m = parse_meta(meta);
    m.insert("set_at".into(), Json::String(at.to_string()));
    m.insert("set_by".into(), Json::String(by.to_string()));
    c.execute("UPDATE source SET meta = ? WHERE id = ?", rusqlite::params![Json::Object(m).to_string(), id])?;
    Ok(())
}

/// Once per profile in effect (idempotent): a priority chosen before settings were stamped (it differs from the
/// connector's default and has no `set_at`) is stamped now, so an unstamped default elsewhere can't revert it.
pub fn stamp_legacy_sources(c: &Db, now_ms: i64) -> Result<()> {
    let rows: Vec<(i64, String, i64, Option<String>)> = c
        .prepare("SELECT id, connector, priority, meta FROM source")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, connector, priority, meta) in rows {
        if priority != default_priority(&connector) && !parse_meta(meta).contains_key("set_at") {
            stamp_source(c, id, now_ms, "")?;
        }
    }
    Ok(())
}

/// Finds or creates a source. Manual data gets priority 0, everything else 100 (`default_priority`).
pub fn source_id(c: &Db, s: &SourceSpec) -> Result<i64> {
    let priority = s.priority.unwrap_or(default_priority(&s.connector));
    let name = s.name.clone().unwrap_or_else(|| if s.external_id.is_empty() { s.connector.clone() } else { s.external_id.clone() });
    c.execute(
        "INSERT INTO source (connector, external_id, name, priority, meta) VALUES (?, ?, ?, ?, ?) ON CONFLICT (connector, external_id) DO NOTHING",
        rusqlite::params![s.connector, s.external_id, name, priority, s.meta.as_ref().map(Json::to_string)],
    )?;
    Ok(c.query_row("SELECT id FROM source WHERE connector = ? AND external_id = ?", [&s.connector, &s.external_id], |r| r.get(0))?)
}

/// A UUIDv7 for `now_ms`, strictly greater than every uid in the database, so "the newer import wins"
/// holds even when the clock is pinned or goes back.
/// A hyphenated UUIDv7 (either case) as its 128-bit value, as the web's newUid reads one
fn v7(uid: &str) -> Option<u128> {
    let b = uid.as_bytes();
    let shape = b.len() == 36
        && b.iter().enumerate().all(|(i, &x)| if matches!(i, 8 | 13 | 18 | 23) { x == b'-' } else { x.is_ascii_hexdigit() })
        && b[14] == b'7';
    shape.then(|| u128::from_str_radix(&uid.replace('-', ""), 16).ok()).flatten()
}

pub fn new_uid(c: &Db, now_ms: i64) -> Result<String> {
    let ts = uuid::Timestamp::from_unix(uuid::NoContext, (now_ms.max(0) / 1000) as u64, ((now_ms.max(0) % 1000) * 1_000_000) as u32);
    let mut u = uuid::Uuid::new_v7(ts).as_u128();
    // above every UUIDv7 here, as 128-bit values: one uid that doesn't parse is skipped, not the floor. Lowercase
    // uids sort as their values, so the uid index read from the top finds it at once (a phone's first sync of its
    // health store makes thousands of imports: a full read per import was quadratic); only a profile holding an
    // uppercase uid (none is written here, but a foreign one could be) is read whole.
    let mixed: bool = c.query_row("SELECT EXISTS (SELECT 1 FROM import WHERE uid GLOB '*[A-F]*')", [], |r| r.get(0))?;
    let sql = if mixed {
        "SELECT uid FROM import WHERE length(uid) = 36 AND substr(uid, 15, 1) = '7'"
    } else {
        "SELECT uid FROM import ORDER BY uid DESC"
    };
    let mut st = c.prepare(sql)?;
    let uids = st.query_map([], |r| r.get::<_, String>(0))?.filter_map(|r| r.ok().and_then(|uid| v7(&uid)));
    let floor = if mixed { uids.max() } else { uids.take(1).next() };
    if let Some(m) = floor
        && u <= m
    {
        u = m + 1;
    }
    Ok(uuid::Uuid::from_u128(u).hyphenated().to_string())
}

pub struct Begin<'a> {
    pub source: &'a SourceSpec,
    pub parser: &'a str,
    pub blob: Option<&'a str>,
    pub uid: Option<String>,
    /// Some = review import (OCR, unknown result lines): no rows, candidates kept in meta.
    pub candidates: Option<Json>,
}

/// Creates an import batch; a file (blob) can be imported only once. Returns (id, uid).
/// One-time upgrade 2 (merge-fixes R6b, R10): every import holding a file records it in `meta.file`, and every
/// import's span covers the rows it owns (web data written under the R8 bug can hold rows outside it).
pub fn upgrade_files_and_spans(c: &Db) -> Result<()> {
    tx(c, || {
        let held: Vec<(i64, String, Option<String>)> = c
            .prepare("SELECT id, blob, meta FROM import WHERE blob IS NOT NULL")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (id, blob, meta) in held {
            let mut m = parse_meta(meta);
            if !m.contains_key("file") {
                m.insert("file".into(), Json::String(blob));
                c.execute("UPDATE import SET meta = ? WHERE id = ?", rusqlite::params![Json::Object(m).to_string(), id])?;
            }
        }
        let rows: Vec<(i64, i64, i64, i64)> = c
            .prepare("SELECT import_id, metric_id, min(start_ms), max(start_ms) FROM observation GROUP BY 1, 2")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut by: BTreeMap<i64, Span> = BTreeMap::new();
        for (id, metric, a, b) in rows {
            by.entry(id).or_default().insert(metric, (a, b));
        }
        for (id, add) in by {
            let meta: Option<String> = c.query_row("SELECT meta FROM import WHERE id = ?", [id], |r| r.get(0))?;
            let mut m = parse_meta(meta);
            let mut span = span_of(&m);
            let before = span.clone();
            for (k, (a, b)) in add {
                let e = span.entry(k).or_insert((a, b));
                *e = (e.0.min(a), e.1.max(b));
            }
            if span != before {
                set_span(&mut m, &span);
                c.execute("UPDATE import SET meta = ? WHERE id = ?", rusqlite::params![Json::Object(m).to_string(), id])?;
            }
        }
        Ok(())
    })
}

/// The latest time a row may have, on every writer and in every merge (merge-fixes R13): 9999-12-29T00:00:00Z, so
/// `to` plus the daily padding stays inside year 9999 for SQLite's strftime, JS Date and chrono alike.
pub const MAX_TIME_MS: i64 = 253_402_041_600_000;

/// A uid that syncs safely: 1-64 bytes, each 0x21-0x7E (merge-fixes P5). Spaces or newlines would forge lines.
pub fn plain_uid(u: &str) -> bool {
    (1..=64).contains(&u.len()) && u.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

pub fn begin(c: &Db, b: Begin<'_>, now_ms: i64) -> Result<(i64, String)> {
    tx(c, || {
        if let Some(sha) = b.blob
            && one::<i64>(c, "SELECT 1 FROM import WHERE blob = ?", [sha])?.is_some()
        {
            return Err(Error::conflict("blob_dup", sha));
        }
        let sid = source_id(c, b.source)?;
        let uid = match b.uid {
            Some(u) if plain_uid(&u) => u,
            Some(u) => return Err(Error::invalid("bad_uid", format!("{} bytes", u.len()))),
            None => new_uid(c, now_ms)?,
        };
        // an import that brings a file records it, so the file can pass to it when its holder is erased (R6b)
        let (status, meta) = match (&b.candidates, b.blob) {
            (Some(cand), Some(f)) => ("review", Some(json!({ "candidates": cand, "file": f }).to_string())),
            (Some(cand), None) => ("review", Some(json!({ "candidates": cand }).to_string())),
            (None, Some(f)) => ("running", Some(json!({ "file": f }).to_string())),
            (None, None) => ("running", None),
        };
        c.execute(
            "INSERT INTO import (uid, source_id, parser, blob, status, meta) VALUES (?, ?, ?, ?, ?, ?)",
            rusqlite::params![uid, sid, b.parser, b.blob, status, meta],
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
                Error::conflict("uid_dup", uid.clone())
            }
            e => e.into(),
        })?;
        Ok((c.last_insert_rowid(), uid))
    })
}

const UPSERT: &str = "INSERT INTO observation (metric_id, start_ms, source_id, end_ms, tz_min, value, import_id, detail)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (metric_id, start_ms, source_id) DO UPDATE SET
    end_ms = excluded.end_ms, tz_min = excluded.tz_min, value = excluded.value, import_id = excluded.import_id, detail = excluded.detail
  WHERE (SELECT uid FROM import WHERE id = excluded.import_id) >= (SELECT uid FROM import WHERE id = observation.import_id)";

/// Validates and converts one row: the value to store, or why it is rejected.
pub fn check_row(m: &MetricRow, r: &ObsRow) -> std::result::Result<Value, Reject> {
    let safe = |t: i64| (0..=MAX_TIME_MS).contains(&t);
    if r.start_ms < 0 || !safe(r.start_ms) || !(-840..=840).contains(&r.tz_min) {
        return Err(Reject::Time);
    }
    if r.end_ms.is_some_and(|e| e < r.start_ms || !safe(e)) {
        return Err(Reject::Time);
    }
    match m.agg.as_str() {
        // a span with no value
        "interval" => {
            if !r.end_ms.is_some_and(|e| e > r.start_ms) {
                return Err(Reject::Time);
            }
            if r.value.is_null() { Ok(Value::Null) } else { Err(Reject::Value) }
        }
        // text or a blob pointer
        "none" => match &r.value {
            Value::Text(s) if !s.is_empty() => Ok(r.value.clone()),
            _ => Err(Reject::Value),
        },
        // instant / cumulative must have a number; level NULL = no reading from here on
        agg => {
            if r.value.is_null() && agg == "level" {
                return Ok(Value::Null);
            }
            let v = match r.value {
                Value::Int(i) if (i as f64).abs() <= MAX_SAFE => i as f64,
                Value::Real(x) if x.is_finite() && !(x.fract() == 0.0 && x.abs() > MAX_SAFE) => x,
                _ => return Err(Reject::Value),
            };
            let v = to_canonical(&m.code, &m.unit, v, r.unit.as_deref().unwrap_or(&m.unit)).ok_or(Reject::Unit)?;
            if !v.is_finite() || (v.fract() == 0.0 && v.abs() > MAX_SAFE) {
                return Err(Reject::Value);
            }
            // JS has one number type, so an integral result is stored as INTEGER there too.
            Ok(Value::number(v))
        }
    }
}

/// One transaction: convert, check, UPSERT, and merge this batch's span into import.meta.
pub fn write(c: &Db, import_id: i64, rows: &[ObsRow]) -> Result<WriteResult> {
    tx(c, || {
        let (source, status, meta): (i64, String, Option<String>) = c
            .query_row("SELECT source_id, status, meta FROM import WHERE id = ?", [import_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|_| Error::not_found("no_import", import_id.to_string()))?;
        if status != "running" {
            return Err(Error::conflict("import_state", status));
        }
        let mut meta = parse_meta(meta);
        let mut span = span_of(&meta);
        let mut rejected: BTreeMap<String, u64> = meta
            .get("rejected")
            .and_then(Json::as_object)
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_u64().unwrap_or(0))).collect())
            .unwrap_or_default();
        let mut res = WriteResult::default();
        let mut metrics: HashMap<String, Option<MetricRow>> = HashMap::new();
        let mut st = c.prepare_cached(UPSERT)?;
        for r in rows {
            if !metrics.contains_key(&r.metric) {
                metrics.insert(r.metric.clone(), metric_by_code(c, &r.metric)?);
            }
            let checked = match &metrics[&r.metric] {
                None => Err(Reject::Metric),
                Some(m) => check_row(m, r).map(|v| (m.id, v)),
            };
            match checked {
                Err(why) => {
                    *rejected.entry(why.key().into()).or_default() += 1;
                    *res.rejected.entry(why.key().into()).or_default() += 1;
                }
                Ok((mid, v)) => {
                    let n = st.execute(rusqlite::params![
                        mid,
                        r.start_ms,
                        source,
                        r.end_ms,
                        r.tz_min,
                        v,
                        import_id,
                        r.detail.as_ref().map(Json::to_string)
                    ])?;
                    let e = span.entry(mid).or_insert((r.start_ms, r.start_ms));
                    *e = (e.0.min(r.start_ms), e.1.max(r.start_ms));
                    if n == 1 { res.written += 1 } else { res.kept += 1 }
                }
            }
        }
        set_span(&mut meta, &span);
        if !rejected.is_empty() {
            meta.insert("rejected".into(), serde_json::to_value(&rejected)?);
        }
        c.execute("UPDATE import SET meta = ? WHERE id = ?", rusqlite::params![Json::Object(meta).to_string(), import_id])?;
        Ok(res)
    })
}

/// status = done, then rebuild daily for what the batch wrote.
pub fn finish(c: &Db, import_id: i64, now_ms: i64) -> Result<()> {
    tx(c, || {
        let status: String = one(c, "SELECT status FROM import WHERE id = ?", [import_id])?
            .ok_or_else(|| Error::not_found("no_import", import_id.to_string()))?;
        if status != "running" {
            return Err(Error::conflict("import_state", status));
        }
        c.execute("UPDATE import SET status = 'done' WHERE id = ?", [import_id])?;
        crate::daily::rebuild(c, &crate::daily::scopes_of_import(c, import_id)?, now_ms)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::MemoryStore;
    use crate::profile::Profile;

    fn v7_at(ms: i64) -> String {
        uuid::Uuid::from_u128(((ms as u128) << 80) | (7 << 76) | (2 << 62)).hyphenated().to_string()
    }

    /// The floor is the largest UUIDv7 here, even when the largest uid of that shape isn't one (it used to be
    /// read with max(uid) and dropped when it didn't parse)
    #[test]
    fn new_uid_stays_above_every_uuidv7() {
        let dir = tempfile::tempdir().unwrap();
        let p = Profile::init(dir.path(), "a", &MemoryStore::default()).unwrap();
        let src = SourceSpec::new("lab", "dev-1");
        let later = v7_at(1_900_000_000_000);
        for uid in [later.clone(), "zzzzzzzz-zzzz-7zzz-zzzz-zzzzzzzzzzzz".into()] {
            begin(&p.db, Begin { source: &src, parser: "test", blob: None, uid: Some(uid), candidates: None }, 0).unwrap();
        }
        let u = new_uid(&p.db, 1_795_176_000_000).unwrap();
        assert!(u > later, "{u} not above {later}");
        assert_eq!(v7(&u), v7(&later).map(|x| x + 1));
    }
}
