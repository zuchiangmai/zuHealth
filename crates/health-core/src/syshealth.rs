//! Health Connect records → observation rows, by the Apple export's rules (`apple.rs`) so the two read alike: an
//! instant type is one row per sample; a cumulative type is summed per metric into 15-minute UTC slots, each record
//! wholly in the slot of its start; sleep stages are intervals with no value. The plugin sends each record in the
//! unit named here; the writer converts a printed unit to the catalog's (`check_row`). One call is one source (an app
//! on one device: the caller groups them).

use crate::apple::precision12;
use crate::value::Value;
use crate::write::ObsRow;
use std::collections::BTreeMap;

const SLOT: i64 = 15 * 60_000;

/// One Health Connect sample as the plugin hands it over. Series records (heart rate) come one sample each; blood
/// pressure as two kinds, `BloodPressureSystolic` and `BloodPressureDiastolic`.
#[derive(Debug, Clone, serde::Deserialize, schemars::JsonSchema)]
pub struct HcRecord {
    pub kind: String,
    #[serde(default)]
    pub value: Option<f64>,
    pub start_ms: i64,
    #[serde(default)]
    pub end_ms: Option<i64>,
    /// The record's own zone offset (minutes)
    pub tz_min: i64,
    /// Sleep: the stage's name (`REM`, `DEEP`, `LIGHT`, `SLEEPING`, `AWAKE`, `AWAKE_IN_BED`, `OUT_OF_BED`,
    /// `UNKNOWN`); a session without stages comes as `SLEEPING`
    #[serde(default)]
    pub stage: Option<String>,
}

/// An instant kind's metric and the unit the plugin sends it in
fn instant(kind: &str) -> Option<(&'static str, &'static str)> {
    Some(match kind {
        "HeartRate" => ("loinc:8867-4", "/min"),
        "RestingHeartRate" => ("loinc:40443-4", "/min"),
        // RMSSD: Apple's SDNN (loinc:112429-6) is another measure
        "HeartRateVariabilityRmssd" => ("x:hrv_rmssd", "ms"),
        // already 0–100 (Apple's export is 0–1)
        "OxygenSaturation" => ("loinc:59408-5", "%"),
        "RespiratoryRate" => ("loinc:9279-1", "/min"),
        "BodyTemperature" => ("loinc:8310-5", "Cel"),
        "BloodPressureSystolic" => ("loinc:8480-6", "mm[Hg]"),
        "BloodPressureDiastolic" => ("loinc:8462-4", "mm[Hg]"),
        "BloodGlucose" => ("loinc:2339-0", "mmol/L"),
        "Vo2Max" => ("x:vo2_max", "mL/min/kg"),
        "Weight" => ("loinc:29463-7", "kg"),
        "Height" => ("loinc:8302-2", "m"),
        "BodyFat" => ("loinc:41982-0", "%"),
        // as Apple's LeanBodyMass
        "LeanBodyMass" => ("loinc:91557-9", "kg"),
        // a rate at one moment (kcal a day), not energy over a time
        "BasalMetabolicRate" => ("x:bmr", "kcal"),
        _ => return None,
    })
}

/// A cumulative kind's metric and unit (summed per slot)
fn summed(kind: &str) -> Option<(&'static str, &'static str)> {
    Some(match kind {
        "Steps" => ("loinc:55423-8", "{#}"),
        "Distance" => ("loinc:112427-0", "m"),
        "FloorsClimbed" => ("loinc:100304-5", "{#}"),
        "ActiveCaloriesBurned" => ("loinc:41981-2", "kcal"),
        _ => return None,
    })
}

/// A sleep stage's metric, as Apple's stages map; None: not a time asleep or awake in bed (skipped)
fn stage(s: &str) -> Option<&'static str> {
    Some(match s {
        "REM" => "x:sleep_asleep_rem",
        "DEEP" => "x:sleep_asleep_deep",
        "LIGHT" => "x:sleep_asleep_core",
        "SLEEPING" => "x:sleep_unspecified",
        "AWAKE" | "AWAKE_IN_BED" => "x:sleep_awake",
        _ => return None,
    })
}

#[derive(Debug, Default, Clone, serde::Serialize, schemars::JsonSchema)]
pub struct HcStats {
    pub records: u64,
    pub mapped: u64,
    /// kinds not read, and how often
    pub skipped: BTreeMap<String, u64>,
    /// no value, a bad time
    pub broken: u64,
}

/// One source's records → rows (instant and sleep rows in order, then the slot sums).
pub fn rows(records: &[HcRecord], stats: &mut HcStats) -> Vec<ObsRow> {
    let mut out = Vec::new();
    // (metric, slot) → (sum, unit, tz of the first record in it)
    let mut sums: BTreeMap<(&'static str, i64), (f64, &'static str, i64)> = BTreeMap::new();
    for r in records {
        stats.records += 1;
        if r.kind == "SleepSession" {
            let Some(metric) = r.stage.as_deref().and_then(stage) else {
                *stats.skipped.entry(format!("SleepSession/{}", r.stage.as_deref().unwrap_or(""))).or_default() += 1;
                continue;
            };
            match r.end_ms {
                Some(e) if e > r.start_ms => {
                    stats.mapped += 1;
                    out.push(ObsRow {
                        metric: metric.into(),
                        start_ms: r.start_ms,
                        end_ms: Some(e),
                        tz_min: r.tz_min,
                        value: Value::Null,
                        unit: None,
                        detail: None,
                    });
                }
                _ => stats.broken += 1,
            }
            continue;
        }
        let Some(v) = r.value.filter(|v| v.is_finite()) else {
            if instant(&r.kind).or_else(|| summed(&r.kind)).is_some() {
                stats.broken += 1;
            } else {
                *stats.skipped.entry(r.kind.clone()).or_default() += 1;
            }
            continue;
        };
        if let Some((metric, unit)) = instant(&r.kind) {
            stats.mapped += 1;
            out.push(ObsRow {
                metric: metric.into(),
                start_ms: r.start_ms,
                end_ms: None,
                tz_min: r.tz_min,
                value: Value::number(v),
                unit: Some(unit.into()),
                detail: None,
            });
        } else if let Some((metric, unit)) = summed(&r.kind) {
            stats.mapped += 1;
            let e = sums.entry((metric, r.start_ms.div_euclid(SLOT))).or_insert((0.0, unit, r.tz_min));
            e.0 += v;
        } else {
            *stats.skipped.entry(r.kind.clone()).or_default() += 1;
        }
    }
    for ((metric, slot), (v, unit, tz)) in sums {
        let start = slot * SLOT;
        out.push(ObsRow {
            metric: metric.into(),
            start_ms: start,
            end_ms: Some(start + SLOT),
            tz_min: tz,
            value: Value::number(precision12(v)),
            unit: Some(unit.into()),
            detail: None,
        });
    }
    out
}

/// Where one day of a system sync went.
#[derive(Debug, serde::Serialize, schemars::JsonSchema)]
pub struct DayOutcome {
    pub import_id: i64,
    /// rows written (rows already holding the same value are left as they are)
    pub written: u64,
    /// a new import for the day (the first, after a rebuild, or above a newer import)
    pub fresh: bool,
    /// the day's earlier import was erased: a row went down or away
    pub rebuilt: bool,
    /// rows left out: an unknown measure or unit, a bad offset (like `write`, which counts and goes on)
    pub skipped: u64,
    /// the day's import now, (id, uid); None: the day holds none (erased, nothing left)
    pub holds: Option<(i64, String)>,
}

/// R1's order for two rows at one key (merge::newer_row): typeof, then value, end_ms, tz_min (no detail here).
fn r1_cmp(a: &(Value, ObsRow), b: &(Value, ObsRow)) -> std::cmp::Ordering {
    let rank = |v: &Value| match v {
        Value::Int(_) => 1,
        Value::Null => 2,
        Value::Real(_) => 3,
        Value::Text(_) => 4,
    };
    let num = |v: &Value| match v {
        Value::Int(i) => *i as f64,
        Value::Real(f) => *f,
        _ => 0.0,
    };
    rank(&a.0)
        .cmp(&rank(&b.0))
        .then(num(&a.0).total_cmp(&num(&b.0)))
        .then_with(|| match (&a.0, &b.0) {
            (Value::Text(x), Value::Text(y)) => x.cmp(y),
            _ => std::cmp::Ordering::Equal,
        })
        .then(a.1.end_ms.cmp(&b.1.end_ms))
        .then(a.1.tz_min.cmp(&b.1.tz_min))
}

/// One UTC day of one source, read whole from the system (HealthKit or Health Connect).
pub struct SyncDay<'a> {
    pub source: &'a crate::write::SourceSpec,
    /// `healthkit-1` or `health-connect-1`
    pub parser: &'a str,
    /// days since 1970-01-01, UTC
    pub day: i64,
    /// the device that read it, and its name
    pub reader: &'a str,
    pub reader_name: &'a str,
    /// when the reader was connected (`SystemHealthState::connected_at_ms`)
    pub connected_at_ms: i64,
    /// every row of the day, as converted for the catalog by `apple::Parser::record` or `rows`
    pub rows: &'a [ObsRow],
    /// Rows the read has but leaves to an export (an export's rows stay the export's): not gone from the system,
    /// and not written, except one this day's import already holds (it came before the export: it stays ours)
    pub left_to_export: &'a [ObsRow],
    /// The day's import (id, uid) when the caller already knows it (`Some(None)`: none), read once for a whole
    /// sync instead of a scan of every import per day; `None`: looked up here
    pub held: Option<Option<(i64, String)>>,
}

pub const DAY_MS: i64 = 86_400_000;

/// A stored row: value, end, offset, detail, its import and that import's uid
type Stored = (Value, Option<i64>, i64, Option<String>, i64, String);

/// Writes one day of a system sync (plan §二, decision 120). Each (source, UTC day) is one import, added to on later
/// syncs, never erased and rebuilt for a mere addition: LAN sync then resends one small import, with no tombstone.
/// But a re-read row that would not win an equal-uid merge (R1) — a sample deleted in the system, a sum that
/// shrank, an offset that changed — would leave devices apart for good, so then the day's import is erased and the
/// day written anew; and where a newer import (an export imported later) holds a row the read changes, the day goes
/// to a new import above it. A row already holding the same value is not written, so an export's rows stay with
/// the export. All in one transaction: a crash never leaves a running import to be erased at the next open.
pub fn sync_day(c: &crate::db::Db, d: &SyncDay, now_ms: i64) -> crate::error::Result<DayOutcome> {
    use crate::db::{one, tx};
    use crate::error::Error;
    use crate::write::{Begin, begin, check_row, finish, metric_by_code, source_id, write};
    let lo = d.day * DAY_MS;
    if let Some(r) = d.rows.iter().find(|r| r.start_ms < lo || r.start_ms >= lo + DAY_MS) {
        return Err(Error::invalid("bad_request", format!("{} at {} is outside day {}", r.metric, r.start_ms, d.day)));
    }
    use rusqlite::OptionalExtension;
    tx(c, || {
        let sid = source_id(c, d.source)?;
        // a known import is taken only if it is still there (LAN sync may have erased it meanwhile: never append to
        // an erased import); else looked up
        let known = match &d.held {
            Some(Some((id, uid))) => {
                one::<i64>(c, "SELECT 1 FROM import WHERE id = ? AND status = 'done'", [id])?.map(|_| Some((*id, uid.clone())))
            }
            Some(None) => Some(None),
            None => None,
        };
        let held: Option<(i64, String)> = match known {
            Some(h) => h,
            None => c
                .query_row(
                    "SELECT id, uid FROM import WHERE source_id = ? AND parser = ? AND status = 'done'
                       AND json_valid(meta) AND json_extract(meta, '$.day') = ? ORDER BY uid DESC LIMIT 1",
                    rusqlite::params![sid, d.parser, d.day],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?,
        };
        // rows the catalog takes, as stored (catalog unit), one per (measure, start): the R1 winner, so two
        // samples at one key don't make the day flip between them sync after sync
        let mut skipped = 0u64;
        let mut by_key: std::collections::BTreeMap<(String, i64), (Value, ObsRow, crate::write::MetricRow)> = Default::default();
        // a row left to the export that the day's import holds is still the import's
        let ours_already = |r: &ObsRow| -> crate::error::Result<bool> {
            let Some((id, _)) = &held else { return Ok(false) };
            let Some(m) = metric_by_code(c, &r.metric)? else { return Ok(false) };
            Ok(one::<i64>(
                c,
                "SELECT 1 FROM observation WHERE metric_id = ? AND start_ms = ? AND source_id = ? AND import_id = ?",
                rusqlite::params![m.id, r.start_ms, sid, id],
            )?
            .is_some())
        };
        let mut read: Vec<&ObsRow> = d.rows.iter().collect();
        for r in d.left_to_export {
            if ours_already(r)? {
                read.push(r);
            }
        }
        let left: std::collections::HashSet<(String, i64)> = d.left_to_export.iter().map(|r| (r.metric.clone(), r.start_ms)).collect();
        for r in read {
            let Some(m) = metric_by_code(c, &r.metric)? else {
                skipped += 1;
                continue;
            };
            let Ok(v) = check_row(&m, r) else {
                skipped += 1;
                continue;
            };
            let k = (r.metric.clone(), r.start_ms);
            let keep = match by_key.get(&k) {
                Some((ov, or, _)) => r1_cmp(&(v.clone(), r.clone()), &(ov.clone(), or.clone())).is_gt(),
                None => true,
            };
            if keep {
                by_key.insert(k, (v, r.clone(), m));
            }
        }
        let valid: Vec<ObsRow> = by_key.values().map(|(_, r, _)| r.clone()).collect();
        let newer = format!(
            "SELECT {} FROM (SELECT ?1 AS value, ?2 AS end_ms, ?3 AS tz_min, NULL AS detail) n, observation o
              WHERE o.metric_id = ?4 AND o.start_ms = ?5 AND o.source_id = ?6",
            crate::merge::newer_row("n", "o")
        );
        let (mut fresh, mut rebuilt) = (held.is_none(), false);
        let mut todo: Vec<&ObsRow> = Vec::new();
        for (v, r, m) in by_key.values() {
            let v = v.clone();
            let stored: Option<Stored> = c
                .query_row(
                    "SELECT o.value, o.end_ms, o.tz_min, o.detail, o.import_id, i.uid FROM observation o JOIN import i ON i.id = o.import_id
                      WHERE o.metric_id = ? AND o.start_ms = ? AND o.source_id = ?",
                    rusqlite::params![m.id, r.start_ms, sid],
                    |x| Ok((x.get(0)?, x.get(1)?, x.get(2)?, x.get(3)?, x.get(4)?, x.get(5)?)),
                )
                .optional()?;
            let Some((sv, se, stz, sd, owner, owner_uid)) = stored else {
                todo.push(r);
                continue;
            };
            // the same: left with whichever import holds it. An instant keeps the offset it was stored with
            // (plan §二): a sample without its own zone gets the phone's, which changes when the person travels.
            if sv == v && se == r.end_ms && sd.is_none() && (stz == r.tz_min || r.end_ms.is_none()) {
                continue;
            }
            match &held {
                Some((id, _)) if owner == *id => {
                    let wins: bool = c.query_row(&newer, rusqlite::params![v, r.end_ms, r.tz_min, m.id, r.start_ms, sid], |x| x.get(0))?;
                    rebuilt |= !wins;
                }
                Some((_, uid)) if owner_uid > *uid => fresh = true,
                _ => {}
            }
            todo.push(r);
        }
        // a row the day's import holds that the read no longer has: gone from the system
        // (by the primary key, a measure at a time: observation has no index on import_id)
        if let Some((id, _)) = &held {
            let meta: Option<String> = c.query_row("SELECT meta FROM import WHERE id = ?", [id], |x| x.get(0))?;
            let mut st = c.prepare(
                "SELECT o.start_ms FROM observation o WHERE o.metric_id = ? AND o.start_ms >= ? AND o.start_ms < ?
                   AND o.source_id = ? AND o.import_id = ?",
            )?;
            'held: for (metric_id, _) in crate::write::span_of(&crate::write::parse_meta(meta)) {
                let code: String = c.query_row("SELECT code FROM metric WHERE id = ?", [metric_id], |x| x.get(0))?;
                for t in st.query_map(rusqlite::params![metric_id, lo, lo + DAY_MS, sid, id], |x| x.get::<_, i64>(0))? {
                    let k = (code.clone(), t?);
                    if !by_key.contains_key(&k) && !left.contains(&k) {
                        rebuilt = true;
                        break 'held;
                    }
                }
            }
        }
        let rows: Vec<ObsRow> = if rebuilt {
            // anew: every row of the day (none left: the day is only erased)
            crate::erase::erase(c, held.as_ref().expect("held").0, now_ms)?;
            if valid.is_empty() {
                return Ok(DayOutcome { import_id: 0, written: 0, fresh: false, rebuilt, skipped, holds: None });
            }
            fresh = true;
            valid.clone()
        } else if fresh {
            valid.clone()
        } else {
            todo.into_iter().cloned().collect()
        };
        if rows.is_empty() {
            // nothing the catalog takes, or nothing new
            return Ok(DayOutcome {
                import_id: held.as_ref().map_or(0, |h| h.0),
                written: 0,
                fresh: false,
                rebuilt,
                skipped,
                holds: held.clone(),
            });
        }
        let import_id = if fresh {
            let (id, _) = begin(c, Begin { source: d.source, parser: d.parser, blob: None, uid: None, candidates: None }, now_ms)?;
            c.execute(
                "UPDATE import SET meta = json_set(coalesce(meta, '{}'), '$.day', ?, '$.reader', ?, '$.reader_name', ?, '$.connected_at', ?)
                  WHERE id = ?",
                rusqlite::params![d.day, d.reader, d.reader_name, d.connected_at_ms, id],
            )?;
            id
        } else {
            let id = held.as_ref().expect("held").0;
            c.execute("UPDATE import SET status = 'running' WHERE id = ?", [id])?;
            id
        };
        let res = write(c, import_id, &rows)?;
        finish(c, import_id, now_ms)?;
        let uid: String = c.query_row("SELECT uid FROM import WHERE id = ?", [import_id], |r| r.get(0))?;
        Ok(DayOutcome { import_id, written: res.written as u64, fresh, rebuilt, skipped, holds: Some((import_id, uid)) })
    })
}

/// A lab result to have in the phone's store (plan §二: body composition only, from lab, staff and room results).
#[derive(Debug, Clone, PartialEq, serde::Serialize, schemars::JsonSchema)]
pub struct Want {
    /// Stable across devices and syncs: the result's id, the measure, the time
    pub id: String,
    /// The store's type: HealthKit's identifier without its prefix (`BodyMass`), or Health Connect's record (`Weight`)
    pub kind: &'static str,
    pub value: f64,
    /// HealthKit's unit string (`kg`, `m`, `count`, `%` as a fraction) or Health Connect's (`kg`, `m`, `percent`)
    pub unit: &'static str,
    pub start_ms: i64,
    pub tz_min: i64,
    /// The winning correction's HLC time, else 0: the same on every device, only ever rising (a string: it exceeds 2^53)
    pub version: String,
}

/// What each store takes: measure → (kind, unit, factor from the catalog's value). Health Connect has no BMI or
/// waist type.
fn written(store: &str, code: &str) -> Option<(&'static str, &'static str, f64)> {
    match (store, code) {
        ("healthkit", "loinc:29463-7") => Some(("BodyMass", "kg", 1.0)),
        ("healthkit", "loinc:8302-2") => Some(("Height", "m", 1.0)),
        ("healthkit", "loinc:39156-5") => Some(("BodyMassIndex", "count", 1.0)),
        // HealthKit keeps a fraction
        ("healthkit", "loinc:41982-0") => Some(("BodyFatPercentage", "%", 0.01)),
        ("healthkit", "x:fat_free_mass") => Some(("LeanBodyMass", "kg", 1.0)),
        ("healthkit", "x:waist_circumference") => Some(("WaistCircumference", "m", 1.0)),
        ("health_connect", "loinc:29463-7") => Some(("Weight", "kg", 1.0)),
        ("health_connect", "loinc:8302-2") => Some(("Height", "m", 1.0)),
        // Health Connect keeps 0–100
        ("health_connect", "loinc:41982-0") => Some(("BodyFat", "percent", 1.0)),
        ("health_connect", "x:fat_free_mass") => Some(("LeanBodyMass", "kg", 1.0)),
        _ => None,
    }
}

/// Every lab result that should be in the store (`healthkit` or `health_connect`), as the data holds it now:
/// erased results are gone, corrected values corrected.
pub fn wanted(c: &crate::db::Db, store: &str) -> crate::error::Result<Vec<Want>> {
    let mut st = c.prepare(
        "SELECT i.uid, m.code, o.start_ms, o.tz_min, o.value, (SELECT max(k.at) FROM correction k
                 WHERE k.metric_id = o.metric_id AND k.source_id = o.source_id AND k.start_ms = o.start_ms)
           FROM v_observation o JOIN metric m ON m.id = o.metric_id JOIN source s ON s.id = o.source_id
           JOIN import i ON i.id = o.import_id
          WHERE s.connector IN ('lab', 'staff', 'room') AND typeof(o.value) IN ('integer', 'real')
            AND m.code IN ('loinc:29463-7', 'loinc:8302-2', 'loinc:39156-5', 'loinc:41982-0', 'x:fat_free_mass', 'x:waist_circumference')
          ORDER BY o.start_ms",
    )?;
    let rows = st.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, f64>(4)?,
            r.get::<_, Option<i64>>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (uid, code, start_ms, tz_min, value, at) = row?;
        if let Some((kind, unit, factor)) = written(store, &code) {
            out.push(Want {
                id: format!("{uid}:{code}:{start_ms}"),
                kind,
                value: precision12(value * factor),
                unit,
                start_ms,
                tz_min,
                version: at.unwrap_or(0).to_string(),
            });
        }
    }
    Ok(out)
}

/// What this app has in the store now, as the store reports it (the plugin reads its own samples back).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Have {
    pub id: String,
    pub version: String,
    pub value: f64,
}

/// What to delete and what to write so the store holds `want`: missing ones written; a changed version written
/// over; a changed value at the same version deleted first (the store ignores an equal version); leftovers deleted.
pub fn reconcile(want: &[Want], have: &[Have]) -> (Vec<String>, Vec<Want>) {
    let mut delete: Vec<String> = have.iter().filter(|h| !want.iter().any(|w| w.id == h.id)).map(|h| h.id.clone()).collect();
    let mut write = Vec::new();
    for w in want {
        match have.iter().find(|h| h.id == w.id) {
            None => write.push(w.clone()),
            Some(h) if h.version != w.version => write.push(w.clone()),
            Some(h) if (h.value - w.value).abs() > 1e-9 * w.value.abs().max(1.0) => {
                delete.push(h.id.clone());
                write.push(w.clone());
            }
            Some(_) => {}
        }
    }
    (delete, write)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(kind: &str, value: Option<f64>, start_ms: i64) -> HcRecord {
        HcRecord { kind: kind.into(), value, start_ms, end_ms: None, tz_min: 480, stage: None }
    }

    #[test]
    fn records_map_as_apple_export_rows() {
        let t = 1_790_000_100_000 / SLOT * SLOT; // a slot's start
        let mut sleep = rec("SleepSession", None, t);
        sleep.end_ms = Some(t + 3_600_000);
        sleep.stage = Some("LIGHT".into());
        let mut out_of_bed = sleep.clone();
        out_of_bed.stage = Some("OUT_OF_BED".into());
        let records = [
            rec("HeartRate", Some(61.0), t),
            rec("OxygenSaturation", Some(97.0), t),
            rec("BloodPressureSystolic", Some(120.0), t),
            rec("Steps", Some(100.0), t + 60_000),
            // the same slot, then the next one: each record wholly in its start's slot
            rec("Steps", Some(50.0), t + SLOT - 1),
            rec("Steps", Some(7.0), t + SLOT),
            rec("Hydration", Some(250.0), t),
            rec("Weight", None, t),
            sleep,
            out_of_bed,
        ];
        let mut stats = HcStats::default();
        let rows = rows(&records, &mut stats);
        let find =
            |m: &str, s: i64| rows.iter().find(|r| r.metric == m && r.start_ms == s).map(|r| (r.value.clone(), r.unit.clone(), r.end_ms));
        assert_eq!(find("loinc:8867-4", t), Some((Value::Int(61), Some("/min".into()), None)));
        assert_eq!(find("loinc:59408-5", t).unwrap().0, Value::Int(97), "0–100, not multiplied");
        assert_eq!(find("loinc:8480-6", t).unwrap().1.as_deref(), Some("mm[Hg]"));
        assert_eq!(find("loinc:55423-8", t), Some((Value::Int(150), Some("{#}".into()), Some(t + SLOT))));
        assert_eq!(find("loinc:55423-8", t + SLOT).unwrap().0, Value::Int(7));
        assert_eq!(find("x:sleep_asleep_core", t), Some((Value::Null, None, Some(t + 3_600_000))));
        assert_eq!(stats.records, 10);
        assert_eq!(stats.mapped, 7);
        assert_eq!(stats.broken, 1);
        assert_eq!(stats.skipped.get("Hydration"), Some(&1));
        assert_eq!(stats.skipped.get("SleepSession/OUT_OF_BED"), Some(&1));
    }

    #[test]
    fn a_day_is_added_to_and_rebuilt_only_when_it_must_be() {
        use crate::keys::MemoryStore;
        use crate::profile::Profile;
        use crate::write::{Begin, SourceSpec, begin, finish, write};
        let dir = tempfile::tempdir().unwrap();
        let p = Profile::init(dir.path(), "a", &MemoryStore::default()).unwrap();
        let day = 20_717; // 2026-09-21
        let t = day * DAY_MS;
        let src = SourceSpec::new("apple_health", "Watch");
        let hr = |at: i64, v: i64| ObsRow {
            metric: "loinc:8867-4".into(),
            start_ms: t + at,
            end_ms: None,
            tz_min: 480,
            value: Value::Int(v),
            unit: Some("/min".into()),
            detail: None,
        };
        let steps = |v: i64| ObsRow {
            metric: "loinc:55423-8".into(),
            start_ms: t,
            end_ms: Some(t + SLOT),
            tz_min: 480,
            value: Value::Int(v),
            unit: Some("{#}".into()),
            detail: None,
        };
        let sync = |rows: &[ObsRow]| {
            sync_day(
                &p.db,
                &SyncDay {
                    source: &src,
                    parser: "healthkit-1",
                    day,
                    reader: "d1",
                    reader_name: "iPhone",
                    connected_at_ms: 1,
                    rows,
                    held: None,
                    left_to_export: &[],
                },
                t + DAY_MS,
            )
            .unwrap()
        };
        let live = || -> i64 {
            p.db.query_row("SELECT count(*) FROM import WHERE parser = 'healthkit-1' AND status = 'done'", [], |r| r.get(0)).unwrap()
        };
        let erased = || -> i64 {
            p.db.query_row("SELECT count(*) FROM import WHERE parser = 'healthkit-1' AND status = 'erased'", [], |r| r.get(0)).unwrap()
        };

        let a = sync(&[hr(0, 60), steps(100)]);
        assert!(a.fresh && !a.rebuilt && a.written == 2);
        let meta: String = p.db.query_row("SELECT meta FROM import WHERE id = ?", [a.import_id], |r| r.get(0)).unwrap();
        assert!(meta.contains("\"day\":20717") && meta.contains("\"reader\":\"d1\""), "{meta}");
        // more samples, a sum that grew: added to the same import
        let b = sync(&[hr(0, 60), hr(60_000, 62), steps(150)]);
        assert_eq!((b.import_id, b.fresh, b.rebuilt, b.written), (a.import_id, false, false, 2));
        // the same again: nothing written
        assert_eq!(sync(&[hr(0, 60), hr(60_000, 62), steps(150)]).written, 0);
        // a sum went down: the day is erased and written anew
        let c = sync(&[hr(0, 60), hr(60_000, 62), steps(120)]);
        assert!(c.rebuilt && c.fresh && c.import_id != a.import_id);
        assert_eq!((live(), erased()), (1, 1));
        // a sample deleted in the system: rebuilt again
        let d = sync(&[hr(0, 60), steps(120)]);
        assert!(d.rebuilt);
        assert_eq!((live(), erased()), (1, 2));
        let n: i64 = p.db.query_row("SELECT count(*) FROM v_observation", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        // two samples at one key: the R1 winner, the same every time (no rebuild loop); a measure the catalog
        // doesn't know: left out and counted; an instant read with another offset (travel): left as stored
        let unknown = ObsRow { metric: "x:no_such_measure".into(), ..hr(0, 1) };
        let moved = ObsRow { tz_min: 0, ..hr(0, 60) };
        for _ in 0..2 {
            let f = sync(&[hr(0, 59), moved.clone(), steps(120), unknown.clone()]);
            assert_eq!((f.written, f.rebuilt, f.skipped), (0, false, 1));
        }

        // an export imported afterwards (a newer uid) holds the hour: a changed read goes to a new import above it
        let (zip, _) =
            begin(&p.db, Begin { source: &src, parser: "apple-export-1", blob: None, uid: None, candidates: None }, t + DAY_MS).unwrap();
        write(&p.db, zip, &[hr(0, 61)]).unwrap();
        finish(&p.db, zip, t + DAY_MS).unwrap();
        let e = sync(&[hr(0, 63), steps(120)]);
        assert!(e.fresh && !e.rebuilt && e.import_id != d.import_id);
        let v: i64 =
            p.db.query_row(
                "SELECT value FROM v_observation WHERE start_ms = ? AND metric_id = (SELECT id FROM metric WHERE code = 'loinc:8867-4')",
                [t],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, 63);

        // every sample of a day deleted in the system: the day is erased, no empty import left
        let src2 = SourceSpec::new("apple_health", "Scale");
        let w = ObsRow { metric: "loinc:29463-7".into(), unit: Some("kg".into()), value: Value::Real(70.5), ..hr(0, 0) };
        let one_day = |rows: &[ObsRow]| {
            sync_day(
                &p.db,
                &SyncDay {
                    source: &src2,
                    parser: "healthkit-1",
                    day,
                    reader: "d1",
                    reader_name: "iPhone",
                    connected_at_ms: 1,
                    rows,
                    held: None,
                    left_to_export: &[],
                },
                t + DAY_MS,
            )
            .unwrap()
        };
        assert!(one_day(std::slice::from_ref(&w)).fresh);
        let g = one_day(&[]);
        assert!(g.rebuilt && !g.fresh);
        let left: i64 =
            p.db.query_row(
                "SELECT count(*) FROM v_observation WHERE metric_id = (SELECT id FROM metric WHERE code = 'loinc:29463-7')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
        assert!(!one_day(&[]).rebuilt, "nothing held any more");

        // a row outside the day is refused
        assert!(
            sync_day(
                &p.db,
                &SyncDay {
                    source: &src,
                    parser: "healthkit-1",
                    day,
                    reader: "d1",
                    reader_name: "iPhone",
                    connected_at_ms: 1,
                    rows: &[hr(DAY_MS, 1)],
                    held: None,
                    left_to_export: &[],
                },
                t
            )
            .is_err()
        );
    }

    #[test]
    fn lab_body_composition_is_wanted_and_reconciled() {
        use crate::keys::MemoryStore;
        use crate::profile::Profile;
        use crate::write::{Begin, SourceSpec, begin, finish, write};
        let dir = tempfile::tempdir().unwrap();
        let p = Profile::init(dir.path(), "a", &MemoryStore::default()).unwrap();
        let t = 1_790_000_000_000;
        let row = |m: &str, v: f64| ObsRow {
            metric: m.into(),
            start_ms: t,
            end_ms: None,
            tz_min: 480,
            value: Value::number(v),
            unit: None,
            detail: None,
        };
        for (connector, uid) in [("lab", "res-1"), ("whoop", "w-1")] {
            let src = SourceSpec::new(connector, "dev-1");
            let (id, _) =
                begin(&p.db, Begin { source: &src, parser: "t", blob: None, uid: Some(uid.into()), candidates: None }, t).unwrap();
            write(&p.db, id, &[row("loinc:29463-7", 77.5), row("loinc:41982-0", 21.8), row("loinc:39156-5", 24.0)]).unwrap();
            finish(&p.db, id, t).unwrap();
        }
        let hk = wanted(&p.db, "healthkit").unwrap();
        assert_eq!(hk.len(), 3, "the lab's three, not WHOOP's");
        let fat = hk.iter().find(|w| w.kind == "BodyFatPercentage").unwrap();
        assert_eq!((fat.value, fat.unit, fat.id.as_str(), fat.version.as_str()), (0.218, "%", "res-1:loinc:41982-0:1790000000000", "0"));
        let hc = wanted(&p.db, "health_connect").unwrap();
        assert_eq!(hc.len(), 2, "no BMI in Health Connect");
        assert_eq!(hc.iter().find(|w| w.kind == "BodyFat").unwrap().value, 21.8);

        let have = |id: &str, version: &str, value: f64| Have { id: id.into(), version: version.into(), value };
        let w = &hk[0];
        // already there: nothing to do; a new version: written; the same version, another value: deleted, written
        assert_eq!(reconcile(std::slice::from_ref(w), &[have(&w.id, "0", w.value)]), (vec![], vec![]));
        assert_eq!(reconcile(std::slice::from_ref(w), &[have(&w.id, "-1", w.value)]).1.len(), 1);
        let (d, n) = reconcile(std::slice::from_ref(w), &[have(&w.id, "0", w.value + 1.0)]);
        assert_eq!((d, n.len()), (vec![w.id.clone()], 1));
        // gone from the data: deleted
        assert_eq!(reconcile(&[], &[have("old", "0", 1.0)]).0, vec!["old".to_string()]);
    }
}
