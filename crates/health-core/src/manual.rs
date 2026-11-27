//! Manual entry, ported from the web `db/manual.ts`. Source (manual, ''), one import per save, parser 'manual'.
//! Editing one's own entry overwrites it through a newer import, not the correction layer (DB design §4.6).
//! A multi-unit metric needs an explicit unit. A date-only entry is stored at local midnight with detail.precision = "day".

use crate::db::{Db, one, tx};
use crate::error::{Error, Result};
use crate::units::allowed_units;
use crate::value::Value;
use crate::write::{Begin, ObsRow, SourceSpec, WriteResult, begin, finish, metric_by_code, parse_meta, span_of, write};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum When {
    /// An exact instant (UTC ms), optionally with an end.
    At {
        ms: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        end_ms: Option<i64>,
        tz_min: i64,
    },
    /// A local date only (YYYY-MM-DD).
    Date { date: String, tz_min: i64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Entry {
    pub metric: String,
    pub value: Value,
    /// Required for multi-unit metrics; must be one of the metric's allowed units.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    pub at: When,
}

pub fn manual_source() -> SourceSpec {
    SourceSpec { name: Some("manual".into()), ..SourceSpec::new("manual", "") }
}

/// UTC ms of local midnight of `date`, or None for an invalid date.
pub fn local_midnight(date: &str, tz_min: i64) -> Option<i64> {
    crate::daily::day_start(date).map(|ms| ms - tz_min * 60_000)
}

fn start_of(at: &When) -> Option<i64> {
    match at {
        When::At { ms, .. } => Some(*ms),
        When::Date { date, tz_min } => local_midnight(date, *tz_min),
    }
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Entered {
    /// The last import written (the only one for a single entry)
    pub import_id: i64,
    /// One import per entry, in order (merge-fixes R7: a manual import holds one row)
    pub import_ids: Vec<i64>,
    #[serde(flatten)]
    pub result: WriteResult,
}

pub fn enter(c: &Db, entries: &[Entry], now_ms: i64) -> Result<Entered> {
    tx(c, || {
        let mut rows = Vec::new();
        for e in entries {
            let m = metric_by_code(c, &e.metric)?.ok_or_else(|| Error::not_found("no_metric", &e.metric))?;
            let numeric = m.agg != "none" && m.agg != "interval";
            let units = allowed_units(&m.code, &m.unit);
            if numeric && units.len() > 1 && e.unit.is_none() {
                return Err(Error::invalid("unit_required", &e.metric));
            }
            if let Some(u) = &e.unit
                && !units.contains(u)
            {
                return Err(Error::invalid("unit_unknown", format!("{} {u}", e.metric)));
            }
            let mut raw = json!({ "value": e.value });
            if numeric {
                raw["unit"] = json!(e.unit.clone().unwrap_or(m.unit.clone()));
            }
            let mut detail = json!({ "raw": raw });
            let (start_ms, end_ms, tz_min) = match &e.at {
                When::Date { date, tz_min } => {
                    detail["precision"] = json!("day");
                    (local_midnight(date, *tz_min).ok_or_else(|| Error::invalid("bad_date", date))?, None, *tz_min)
                }
                When::At { ms, end_ms, tz_min } => (*ms, *end_ms, *tz_min),
            };
            rows.push(ObsRow {
                metric: e.metric.clone(),
                start_ms,
                end_ms,
                tz_min,
                value: e.value.clone(),
                unit: e.unit.clone(),
                detail: Some(detail),
            });
        }
        // one import per entry, all in one transaction (merge-fixes R7)
        let src = manual_source();
        let mut import_ids = Vec::new();
        let mut total = WriteResult::default();
        for row in rows {
            // the import that owns this entry now: this entry takes its row over
            let before: Vec<i64> = owner_of(c, &row.metric, row.start_ms).ok().map(|(id, _)| id).into_iter().collect();
            let (import_id, _) = begin(c, Begin { source: &src, parser: "manual", blob: None, uid: None, candidates: None }, now_ms)?;
            let result = write(c, import_id, std::slice::from_ref(&row))?;
            // A person typing a value must hear that it was refused; nothing is saved then (decision 10).
            if !result.rejected.is_empty() {
                return Err(Error::invalid("rejected", serde_json::to_string(&result.rejected)?));
            }
            finish(c, import_id, now_ms)?;
            erase_if_empty(c, &before, now_ms)?;
            total.written += result.written;
            total.kept += result.kept;
            import_ids.push(import_id);
        }
        let import_id = *import_ids.last().ok_or_else(|| Error::invalid("no_entries", ""))?;
        Ok(Entered { import_id, import_ids, result: total })
    })
}

/// Superseded and now empty: erase it, so a backup holding the old import cannot bring the old value back
/// after the entry is removed (decision 16; the web keeps such imports `done`).
fn erase_if_empty(c: &Db, imports: &[i64], now_ms: i64) -> Result<()> {
    for &id in imports {
        let status: Option<String> = one(c, "SELECT status FROM import WHERE id = ?", [id])?;
        if status.as_deref() == Some("done") && rows_held(c, id)? == 0 {
            crate::erase::erase(c, id, now_ms)?;
        }
    }
    Ok(())
}

/// The import that owns the manual entry (code, start_ms), and how many rows it holds now.
fn owner_of(c: &Db, code: &str, start_ms: i64) -> Result<(i64, u64)> {
    let import_id: i64 = c
        .query_row(
            "SELECT o.import_id FROM observation o JOIN metric m ON m.id = o.metric_id JOIN source s ON s.id = o.source_id
              WHERE m.code = ? AND o.start_ms = ? AND s.connector = 'manual' AND s.external_id = ''",
            rusqlite::params![code, start_ms],
            |r| r.get(0),
        )
        .map_err(|_| Error::not_found("no_row", format!("{code} {start_ms}")))?;
    Ok((import_id, rows_held(c, import_id)?))
}

/// Rows an import still owns (found through its span, as erase finds them).
pub(crate) fn rows_held(c: &Db, import_id: i64) -> Result<u64> {
    let meta: Option<String> = c.query_row("SELECT meta FROM import WHERE id = ?", [import_id], |r| r.get(0))?;
    let mut rows = 0u64;
    for (mid, (from, to)) in span_of(&parse_meta(meta)) {
        rows += c.query_row(
            "SELECT count(*) FROM observation WHERE metric_id = ? AND start_ms BETWEEN ? AND ? AND import_id = ?",
            [mid, from, to, import_id],
            |r| r.get::<_, i64>(0),
        )? as u64;
    }
    Ok(rows)
}

/// Deletes a manual entry by erasing its import (the tombstone keeps a later merge from bringing it back).
pub fn remove(c: &Db, code: &str, start_ms: i64, now_ms: i64) -> Result<()> {
    tx(c, || {
        let (import_id, rows) = owner_of(c, code, start_ms)?;
        if rows != 1 {
            return Err(Error::conflict("import_state", format!("{rows} rows")));
        }
        crate::erase::erase(c, import_id, now_ms)?;
        Ok(())
    })
}

/// Replaces a manual entry. Same metric and time: the newer import takes the row over; otherwise the old one is removed.
pub fn edit(c: &Db, code: &str, start_ms: i64, entry: &Entry, now_ms: i64) -> Result<Entered> {
    tx(c, || {
        let (old, _) = owner_of(c, code, start_ms)?;
        let res = enter(c, std::slice::from_ref(entry), now_ms)?;
        if entry.metric != code || start_of(&entry.at) != Some(start_ms) {
            remove(c, code, start_ms, now_ms)?;
        }
        erase_if_empty(c, &[old], now_ms)?;
        Ok(res)
    })
}
