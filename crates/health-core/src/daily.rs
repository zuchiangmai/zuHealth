//! Daily rebuild (DB design §5.1, §5.2), ported from the web `db/daily.ts`. Reads v_observation, so corrections
//! apply and deleted points are gone. Censored rows (detail.comparator) never count.
//!   instant / cumulative  local day of start_ms + tz_min; only the affected days, aggregated in SQL
//!   interval              local day of the end; union of overlapping spans; whole series
//!   level                 time-weighted per day; the last value carries on until `now`; whole series

use crate::db::{Db, one, tx};
use crate::error::Result;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, Copy)]
pub struct Scope {
    pub metric_id: i64,
    pub source_id: i64,
    /// start_ms range of the changed rows (inclusive); interval and level ignore it
    pub from: i64,
    pub to: i64,
}

const MIN: i64 = 60_000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;
/// tz_min is within ±14 h, so a local day's rows fall in [midnight − 14 h, next midnight + 14 h).
const TZ_PAD: i64 = 14 * HOUR;

const NOT_CENSORED: &str = "(detail IS NULL OR NOT json_valid(detail) OR json_extract(detail, '$.comparator') IS NULL)";

/// `YYYY-MM-DD` of a UTC ms instant.
pub fn iso_day(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

pub fn local_day(ms: i64, tz_min: i64) -> String {
    iso_day(ms + tz_min * MIN)
}

/// UTC ms of `YYYY-MM-DD`T00:00Z, or None if it is not a real date.
pub fn day_start(day: &str) -> Option<i64> {
    let d = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    (d.format("%Y-%m-%d").to_string() == day).then(|| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis())
}

/// Scopes written by one import, from import.meta.span.
pub fn scopes_of_import(c: &Db, import_id: i64) -> Result<Vec<Scope>> {
    let row: Option<(i64, Option<String>)> =
        c.query_row("SELECT source_id, meta FROM import WHERE id = ?", [import_id], |r| Ok((r.get(0)?, r.get(1)?))).ok();
    let Some((source_id, meta)) = row else { return Ok(vec![]) };
    let span = crate::write::span_of(&crate::write::parse_meta(meta));
    Ok(span.into_iter().map(|(metric_id, (from, to))| Scope { metric_id, source_id, from, to }).collect())
}

pub fn rebuild(c: &Db, scopes: &[Scope], now_ms: i64) -> Result<()> {
    if scopes.is_empty() {
        return Ok(());
    }
    let mut merged: BTreeMap<(i64, i64), Scope> = BTreeMap::new();
    for s in scopes {
        merged
            .entry((s.metric_id, s.source_id))
            .and_modify(|m| {
                m.from = m.from.min(s.from);
                m.to = m.to.max(s.to);
            })
            .or_insert(*s);
    }
    tx(c, || {
        for s in merged.values() {
            match one::<String>(c, "SELECT agg FROM metric WHERE id = ?", [s.metric_id])?.as_deref() {
                Some("instant" | "cumulative") => rebuild_window(c, s)?,
                Some("interval") => rebuild_intervals(c, s)?,
                Some("level") => rebuild_level(c, s, now_ms)?,
                _ => {}
            }
        }
        Ok(())
    })
}

/// Rebuilds every daily row (after a merge, or on request).
pub fn rebuild_all(c: &Db, now_ms: i64) -> Result<()> {
    tx(c, || {
        c.execute("DELETE FROM daily", [])?;
        let scopes = c
            .prepare("SELECT metric_id, source_id, min(start_ms), max(start_ms) FROM observation GROUP BY metric_id, source_id")?
            .query_map([], |r| Ok(Scope { metric_id: r.get(0)?, source_id: r.get(1)?, from: r.get(2)?, to: r.get(3)? }))?
            .collect::<Result<Vec<_>, _>>()?;
        rebuild(c, &scopes, now_ms)
    })
}

fn rebuild_window(c: &Db, s: &Scope) -> Result<()> {
    // One extra day each side: a re-import with another tz_min can move a row from the neighbouring day.
    // saturating: a time from an untrusted pack must not overflow (merge-fixes R13 skips such rows anyway)
    let lo = iso_day(s.from.saturating_sub(TZ_PAD + DAY));
    let hi = iso_day(s.to.saturating_add(TZ_PAD + DAY));
    let a = day_start(&lo).unwrap_or(0).saturating_sub(TZ_PAD);
    let b = day_start(&hi).unwrap_or(0).saturating_add(DAY + TZ_PAD);
    c.execute(
        "DELETE FROM daily WHERE metric_id = ? AND source_id = ? AND day BETWEEN ? AND ?",
        rusqlite::params![s.metric_id, s.source_id, lo, hi],
    )?;
    c.execute(
        &format!(
            "INSERT INTO daily (metric_id, day, source_id, n, sum, min, max, seconds)
             SELECT metric_id, day, source_id, count(*), sum(value), min(value), max(value), NULL
               FROM (SELECT metric_id, source_id, value, strftime('%Y-%m-%d', (start_ms + tz_min * 60000) / 1000, 'unixepoch') AS day
                       FROM v_observation
                      WHERE metric_id = ?1 AND source_id = ?2 AND start_ms >= ?3 AND start_ms < ?4
                        AND typeof(value) IN ('integer', 'real') AND {NOT_CENSORED})
              WHERE day BETWEEN ?5 AND ?6
              GROUP BY metric_id, source_id, day"
        ),
        rusqlite::params![s.metric_id, s.source_id, a, b, lo, hi],
    )?;
    Ok(())
}

fn rebuild_intervals(c: &Db, s: &Scope) -> Result<()> {
    c.execute("DELETE FROM daily WHERE metric_id = ? AND source_id = ?", [s.metric_id, s.source_id])?;
    let rows: Vec<(i64, i64, i64)> = c
        .prepare(&format!(
            "SELECT start_ms, end_ms, tz_min FROM v_observation
              WHERE metric_id = ? AND source_id = ? AND end_ms IS NOT NULL AND {NOT_CENSORED} ORDER BY start_ms"
        ))?
        .query_map([s.metric_id, s.source_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let mut days: BTreeMap<String, Vec<(i64, i64)>> = BTreeMap::new();
    for (a, b, tz) in rows {
        days.entry(local_day(b, tz)).or_default().push((a, b));
    }
    for (day, list) in days {
        // Union, never sum: overlapping parts count once. Rows are sorted by start.
        let (mut total, mut cur) = (0i64, None::<(i64, i64)>);
        for &(a, b) in &list {
            cur = match cur {
                Some((s0, e0)) if a <= e0 => Some((s0, e0.max(b))),
                Some((s0, e0)) => {
                    total += e0 - s0;
                    Some((a, b))
                }
                None => Some((a, b)),
            };
        }
        if let Some((s0, e0)) = cur {
            total += e0 - s0;
        }
        insert(c, s, &day, list.len() as i64, None, None, None, js_round(total as f64 / 1000.0))?;
    }
    Ok(())
}

struct Acc {
    sum: f64,
    ms: i64,
    n: i64,
    min: f64,
    max: f64,
}

fn rebuild_level(c: &Db, s: &Scope, now_ms: i64) -> Result<()> {
    c.execute("DELETE FROM daily WHERE metric_id = ? AND source_id = ?", [s.metric_id, s.source_id])?;
    let rows: Vec<(i64, i64, Option<f64>)> = c
        .prepare(&format!(
            "SELECT start_ms, tz_min, value FROM v_observation
              WHERE metric_id = ? AND source_id = ? AND (value IS NULL OR typeof(value) IN ('integer', 'real')) AND {NOT_CENSORED}
              ORDER BY start_ms"
        ))?
        .query_map([s.metric_id, s.source_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let mut days: HashMap<String, Acc> = HashMap::new();
    for (i, &(t0, tz, v)) in rows.iter().enumerate() {
        // NULL = no reading from here on: the previous value stops.
        let Some(v) = v else { continue };
        let t1 = rows.get(i + 1).map_or(now_ms, |r| r.0);
        let mut cur = t0;
        while cur < t1 {
            let next = ((cur + tz * MIN).div_euclid(DAY) + 1) * DAY - tz * MIN; // next local midnight
            let end = t1.min(next);
            let d = days.entry(local_day(cur, tz)).or_insert(Acc { sum: 0.0, ms: 0, n: 0, min: v, max: v });
            d.sum += v * (end - cur) as f64 / 1000.0;
            d.ms += end - cur;
            d.n += 1;
            d.min = d.min.min(v);
            d.max = d.max.max(v);
            cur = end;
        }
    }
    for (day, d) in days {
        insert(c, s, &day, d.n, Some(d.sum), Some(d.min), Some(d.max), js_round(d.ms as f64 / 1000.0))?;
    }
    Ok(())
}

/// Math.round: halves go up.
fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

#[allow(clippy::too_many_arguments)]
fn insert(c: &Db, s: &Scope, day: &str, n: i64, sum: Option<f64>, min: Option<f64>, max: Option<f64>, seconds: i64) -> Result<()> {
    c.execute(
        "INSERT INTO daily (metric_id, day, source_id, n, sum, min, max, seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![s.metric_id, day, s.source_id, n, sum, min, max, seconds],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_days() {
        // 2026-11-09 16:00Z is 2026-11-10 00:00 at +08:00
        assert_eq!(local_day(1_762_704_000_000, 480), "2025-11-10");
        assert_eq!(day_start("2026-02-30"), None);
        assert_eq!(js_round(2.5), 3);
    }
}
