//! Lab device results read as measurements, not loose rows (as the web's db/handlers.ts `bodyScans` / `fdTrials` and
//! fd-model.ts):
//! - seca mBCA Pro: one body composition measurement = a lab source's values at one `start_ms` that include `x:seca/`.
//! - VALD ForceDecks: one jump = a lab source's `x:fd/<test>/` values at one `start_ms`; jumps of the same device
//!   and test no more than 15 minutes apart are one time on the plates (the result carries no session id); its best
//!   jump has the highest key figure (CMJ: jump height by impulse-momentum), the earlier one on a tie, the last
//!   jump when none has it.
//!
//! Reads go through `v_observation`, so corrections apply. Owner only (the UI's report pages).

use crate::db::Db;
use crate::error::Result;
use crate::value::Value;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

/// Two jumps this close (same device, same test) are one time on the plates.
pub const GAP_MS: i64 = 15 * 60_000;

/// The figure a test's best jump is picked by, per test (the code's middle part).
pub fn key_of(test: &str) -> Option<&'static str> {
    match test {
        "cmj" => Some("x:fd/cmj/jump_height_imp_mom"),
        _ => None,
    }
}

/// Where the home page shows a measure (the web's model.ts category): ForceDecks has its own card.
pub fn category_of(code: &str) -> &'static str {
    if code.starts_with("x:fd/") { "force" } else { crate::catalog::group_of(code) }
}

#[derive(Debug, Clone, Serialize, PartialEq, schemars::JsonSchema)]
pub struct Measurement {
    pub start_ms: i64,
    pub tz_min: i64,
    /// The lab device (its source's external id)
    pub device: String,
    /// Metric code → value
    pub values: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, schemars::JsonSchema)]
pub struct FdSession {
    pub device: String,
    /// The test, lower case (the code's middle part): `cmj`
    pub test: String,
    /// The jumps, oldest first
    pub trials: Vec<Measurement>,
    /// Index into `trials` of the best jump
    pub best: usize,
}

/// A lab source's values at one time, for the codes matching `like`, grouped by (source, time, `split`), newest first.
fn measurements(c: &Db, like: &str, whole: bool, split: &dyn Fn(&str) -> String) -> Result<Vec<(String, Measurement)>> {
    // whole: every value at a time that has one matching code (seca's report holds a few LOINC codes too)
    let sql = if whole {
        "SELECT o.source_id, o.start_ms, o.tz_min, s.external_id, m.code, o.value
           FROM v_observation o JOIN metric m ON m.id = o.metric_id JOIN source s ON s.id = o.source_id
          WHERE s.connector = 'lab'
            AND (o.source_id, o.start_ms) IN (SELECT o2.source_id, o2.start_ms FROM v_observation o2
                                               WHERE o2.metric_id IN (SELECT id FROM metric WHERE code LIKE ?1))
          ORDER BY o.start_ms DESC, o.source_id"
    } else {
        "SELECT o.source_id, o.start_ms, o.tz_min, s.external_id, m.code, o.value
           FROM v_observation o JOIN metric m ON m.id = o.metric_id JOIN source s ON s.id = o.source_id
          WHERE s.connector = 'lab' AND o.metric_id IN (SELECT id FROM metric WHERE code LIKE ?1)
          ORDER BY o.start_ms DESC, o.source_id"
    };
    let mut st = c.prepare(sql)?;
    let mut rows = st.query([like])?;
    let mut out: Vec<(String, Measurement)> = Vec::new();
    let mut at: HashMap<(i64, i64, String), usize> = HashMap::new();
    while let Some(r) = rows.next()? {
        let (source, start_ms, tz_min, device, code, value): (i64, i64, i64, String, String, Value) =
            (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?);
        let part = split(&code);
        let i = *at.entry((source, start_ms, part.clone())).or_insert_with(|| {
            out.push((part, Measurement { start_ms, tz_min, device, values: BTreeMap::new() }));
            out.len() - 1
        });
        out[i].1.values.insert(code, value);
    }
    Ok(out)
}

/// seca body composition measurements, newest first.
pub fn body_scans(c: &Db) -> Result<Vec<Measurement>> {
    Ok(measurements(c, "x:seca/%", true, &|_| String::new())?.into_iter().map(|(_, m)| m).collect())
}

/// ForceDecks jumps, newest first, with their test.
pub fn fd_trials(c: &Db) -> Result<Vec<(String, Measurement)>> {
    measurements(c, "x:fd/%", false, &|code| code.split('/').nth(1).unwrap_or_default().to_string())
}

fn figure(m: &Measurement, code: &str) -> Option<f64> {
    match m.values.get(code)? {
        Value::Int(i) => Some(*i as f64),
        Value::Real(r) if r.is_finite() => Some(*r),
        _ => None,
    }
}

/// The best jump's index: the highest key figure, the earlier one on a tie; the last jump when none has it.
pub fn best_of(trials: &[Measurement], test: &str) -> usize {
    let mut best: Option<(usize, f64)> = None;
    if let Some(key) = key_of(test) {
        for (i, t) in trials.iter().enumerate() {
            if let Some(v) = figure(t, key)
                && best.is_none_or(|(_, top)| v > top)
            {
                best = Some((i, v));
            }
        }
    }
    best.map_or(trials.len().saturating_sub(1), |(i, _)| i)
}

/// Jumps grouped into times on the plates, newest first.
pub fn sessions_of(trials: Vec<(String, Measurement)>, gap: i64) -> Vec<FdSession> {
    let mut by_kind: BTreeMap<(String, String), Vec<Measurement>> = BTreeMap::new();
    for (test, m) in trials {
        by_kind.entry((m.device.clone(), test)).or_default().push(m);
    }
    let mut out = Vec::new();
    for ((device, test), mut list) in by_kind {
        list.sort_by_key(|m| m.start_ms);
        let mut cur: Vec<Measurement> = Vec::new();
        let close = |cur: &mut Vec<Measurement>, out: &mut Vec<FdSession>| {
            if !cur.is_empty() {
                let trials = std::mem::take(cur);
                out.push(FdSession { device: device.clone(), test: test.clone(), best: best_of(&trials, &test), trials });
            }
        };
        for m in list {
            if cur.last().is_some_and(|l| m.start_ms - l.start_ms > gap) {
                close(&mut cur, &mut out);
            }
            cur.push(m);
        }
        close(&mut cur, &mut out);
    }
    out.sort_by(|a, b| b.trials[0].start_ms.cmp(&a.trials[0].start_ms));
    out
}

/// ForceDecks times on the plates, newest first.
pub fn fd_sessions(c: &Db) -> Result<Vec<FdSession>> {
    Ok(sessions_of(fd_trials(c)?, GAP_MS))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jump(device: &str, at_min: i64, height: Option<f64>) -> (String, Measurement) {
        let mut values = BTreeMap::new();
        if let Some(h) = height {
            values.insert("x:fd/cmj/jump_height_imp_mom".into(), Value::Real(h));
        }
        values.insert("x:fd/cmj/peak_power".into(), Value::Int(3000));
        ("cmj".into(), Measurement { start_ms: at_min * 60_000, tz_min: 480, device: device.into(), values })
    }

    #[test]
    fn jumps_15_minutes_apart_are_one_session_and_the_highest_is_best() {
        let s = sessions_of(
            vec![jump("fd1", 0, Some(30.0)), jump("fd1", 5, Some(34.5)), jump("fd1", 20, Some(33.0)), jump("fd1", 200, Some(29.0))],
            GAP_MS,
        );
        assert_eq!(s.len(), 2, "200 min later is another time on the plates");
        assert_eq!(s[1].trials.len(), 4 - 1);
        assert_eq!((s[1].best, s[0].best), (1, 0));
        // newest first
        assert!(s[0].trials[0].start_ms > s[1].trials[0].start_ms);
    }

    #[test]
    fn a_tie_keeps_the_earlier_jump_none_with_the_figure_takes_the_last_and_devices_stay_apart() {
        let s = sessions_of(vec![jump("fd1", 0, Some(31.0)), jump("fd1", 1, Some(31.0))], GAP_MS);
        assert_eq!(s[0].best, 0);
        let s = sessions_of(vec![jump("fd1", 0, None), jump("fd1", 1, None), jump("fd1", 2, None)], GAP_MS);
        assert_eq!(s[0].best, 2);
        let s = sessions_of(vec![jump("fd1", 0, Some(1.0)), jump("fd2", 1, Some(1.0))], GAP_MS);
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn categories() {
        assert_eq!(category_of("x:fd/cmj/peak_power"), "force");
        assert_eq!(category_of("loinc:2345-7"), crate::catalog::group_of("loinc:2345-7"));
    }
}
