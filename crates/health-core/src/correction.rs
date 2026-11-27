//! User correction layer (DB design §4.6), ported from the web `db/correction.ts` and `db/hlc.ts`.
//! One row per point; the winner is decided in SQL (CORRECTION_WINS), independent of arrival order:
//! larger `at` wins; on equal `at` the larger value wins, NULL (delete) being smallest; on equal values the larger
//! `typeof` (merge-fixes R12).

use crate::daily::Scope;
use crate::db::{Db, one, tx};
use crate::error::{Error, Result};
use crate::value::{MAX_SAFE, Value};

/// HLC: at = physical ms × 65536 + counter.
pub const HLC_SHIFT: u32 = 16;

/// Next HLC value after everything already in the database, corrections and source settings alike (merged ones
/// included, merge-fixes G2/R3): strictly increasing, even if the clock goes back.
pub fn next_at(c: &Db, now_ms: i64) -> Result<i64> {
    // a source's meta comes from backups and other devices: unparsable or future stamps are ignored, never fatal
    let limit = (now_ms.max(0) + crate::merge::MAX_SKEW_MS) << HLC_SHIFT;
    let last: i64 = one::<Option<i64>>(
        c,
        // G5: only a string of digits without a leading zero counts, as in the merge
        "SELECT max(m) FROM (SELECT max(at) AS m FROM correction
                             UNION ALL SELECT max(s) FROM (
                               SELECT CAST(v AS INTEGER) AS s FROM (
                                 -- the guard inside one expression: SQLite may evaluate WHERE terms in any order
                                 SELECT CASE WHEN json_valid(meta) AND json_type(meta, '$.set_at') = 'text'
                                             THEN json_extract(meta, '$.set_at') END AS v FROM source)
                                WHERE v GLOB '[1-9]*' AND v NOT GLOB '*[^0-9]*' AND length(v) <= 19) WHERE s <= ?1)",
        [limit],
    )?
    .flatten()
    .unwrap_or(0);
    let wall = now_ms.max(0) << HLC_SHIFT;
    Ok(if wall > last { wall } else { last + 1 })
}

pub const CORRECTION_WINS: &str = "(excluded.at > correction.at
  OR (excluded.at = correction.at AND excluded.value IS NOT NULL AND (correction.value IS NULL OR excluded.value > correction.value))
  OR (excluded.at = correction.at AND excluded.value IS correction.value AND typeof(excluded.value) > typeof(correction.value)))";

#[derive(Debug, Clone, Copy)]
pub struct Key {
    pub metric_id: i64,
    pub source_id: i64,
    pub start_ms: i64,
}

/// Writes one correction (local or from another device). Returns whether it took effect.
pub fn put(c: &Db, k: Key, at: i64, value: &Value, now_ms: i64) -> Result<bool> {
    tx(c, || {
        let agg: String = one(c, "SELECT agg FROM metric WHERE id = ?", [k.metric_id])?
            .ok_or_else(|| Error::not_found("no_metric", k.metric_id.to_string()))?;
        let ok = match value {
            Value::Null => true,
            Value::Text(_) => agg == "none",
            Value::Int(i) => agg != "none" && agg != "interval" && (*i as f64).abs() <= MAX_SAFE,
            Value::Real(r) => agg != "none" && agg != "interval" && r.is_finite() && !(r.fract() == 0.0 && r.abs() > MAX_SAFE),
        };
        if !ok {
            return Err(Error::invalid("bad_value", ""));
        }
        let value = match value {
            Value::Real(r) => Value::number(*r),
            v => v.clone(),
        };
        let read = || -> Result<Option<(i64, Value)>> {
            Ok(c.query_row(
                "SELECT at, value FROM correction WHERE metric_id = ? AND source_id = ? AND start_ms = ?",
                [k.metric_id, k.source_id, k.start_ms],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok())
        };
        let before = read()?;
        c.execute(
            &format!(
                "INSERT INTO correction (metric_id, source_id, start_ms, at, value) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (metric_id, source_id, start_ms) DO UPDATE SET at = excluded.at, value = excluded.value WHERE {CORRECTION_WINS}"
            ),
            rusqlite::params![k.metric_id, k.source_id, k.start_ms, at, value],
        )?;
        let after = read()?;
        let applied = after.as_ref() == Some(&(at, value.clone())) && before != after;
        if applied {
            crate::daily::rebuild(
                c,
                &[Scope { metric_id: k.metric_id, source_id: k.source_id, from: k.start_ms, to: k.start_ms }],
                now_ms,
            )?;
        }
        Ok(applied)
    })
}

/// The person changes (or deletes, value = Null) a point. Returns the HLC used.
pub fn correct(c: &Db, k: Key, value: &Value, now_ms: i64) -> Result<i64> {
    let at = next_at(c, now_ms)?;
    put(c, k, at, value, now_ms)?;
    Ok(at)
}
