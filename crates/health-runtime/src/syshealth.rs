//! Reading the phone's health store (HealthKit on iOS, Health Connect on Android) into the data, plan §二 and
//! decisions 120–121. The shell supplies the store through `SystemHealth` (its plugin reads and writes; nothing
//! here knows Swift or Kotlin); the rules are health-core's: samples become rows as an Apple export's do
//! (`apple::Parser::record`, `syshealth::rows`), and each (source, UTC day) is one import (`syshealth::sync_day`).
//! The store is read outside the profile lock; only writing a day takes it.

use health_core::apple::{Parser, Record};
use health_core::syncstate::SystemHealthState;
use health_core::syshealth::{DAY_MS, HcRecord, HcStats, SyncDay, sync_day};
use health_core::write::{ObsRow, SourceSpec};
use health_core::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// A sample as the store gives it.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "store", rename_all = "snake_case")]
pub enum Sample {
    /// HealthKit, as the export writes it (decision 120)
    Healthkit {
        #[serde(rename = "type")]
        ty: String,
        #[serde(default)]
        number: Option<f64>,
        #[serde(default)]
        category: String,
        #[serde(default)]
        unit: String,
        start_ms: i64,
        end_ms: i64,
        /// offset at the start, minutes
        tz_min: i64,
        source: String,
    },
    /// Health Connect: the record, the writing app's package and device, and the app's name
    HealthConnect {
        #[serde(flatten)]
        record: HcRecord,
        origin: String,
        #[serde(default)]
        device: String,
        #[serde(default)]
        origin_name: String,
    },
}

/// The phone's health store, as the shell's plugin offers it. Errors are the store's own words, for the person.
pub trait SystemHealth: Send + Sync {
    /// `healthkit` or `health_connect`
    fn kind(&self) -> &'static str;
    /// Whether the store is there (Health Connect may need installing)
    fn available(&self) -> bool;
    /// Asks the person for access (the system's own sheet)
    fn authorize(&self) -> std::result::Result<(), String>;
    /// Samples starting in [from, to), every source but this app's own
    fn read(&self, from_ms: i64, to_ms: i64) -> std::result::Result<Vec<Sample>, String>;
    /// UTC days holding samples added since `anchors` (which it moves on), from `floor_ms` on
    fn changed_days(&self, anchors: &mut Value, floor_ms: i64) -> std::result::Result<Vec<i64>, String>;
    /// The oldest sample the store will give (HealthKit's earliest permitted date; Health Connect: what it allows)
    fn earliest_ms(&self) -> i64;
}

/// Rows of whole UTC days, per source: (source, day) → rows.
type Days = BTreeMap<(SourceKey, i64), Vec<ObsRow>>;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct SourceKey {
    pub connector: &'static str,
    pub external_id: String,
    pub name: String,
}

impl SourceKey {
    pub fn spec(&self) -> SourceSpec {
        SourceSpec { name: Some(self.name.clone()), ..SourceSpec::new(self.connector, &self.external_id) }
    }
}

/// Samples → rows by the export's rules, grouped by source and the UTC day of each row's start.
pub fn days_of(samples: &[Sample]) -> Days {
    let mut out: Days = BTreeMap::new();
    let mut put = |key: SourceKey, r: ObsRow| out.entry((key, r.start_ms.div_euclid(DAY_MS))).or_default().push(r);
    // HealthKit: one parser for all (it names sources and sums per (metric, source) slot)
    let mut p = Parser::default();
    let mut apple: Vec<(String, ObsRow)> = Vec::new();
    let mut emit = |row: (String, ObsRow)| apple.push(row);
    for s in samples {
        if let Sample::Healthkit { ty, number, category, unit, start_ms, end_ms, tz_min, source } = s {
            let r =
                Record { ty, number: *number, category, unit, start: Some((*start_ms, *tz_min)), end: Some((*end_ms, *tz_min)), source };
            p.record(&r, &mut emit);
        }
    }
    p.finish(&mut emit);
    for (name, r) in apple {
        put(SourceKey { connector: "apple_health", external_id: name.clone(), name }, r);
    }
    // Health Connect: per (app, device)
    let mut by_source: BTreeMap<SourceKey, Vec<HcRecord>> = BTreeMap::new();
    for s in samples {
        if let Sample::HealthConnect { record, origin, device, origin_name } = s {
            let external_id: String = if device.is_empty() { origin.clone() } else { format!("{origin}/{device}") };
            let name = if origin_name.is_empty() { origin.clone() } else { origin_name.clone() };
            let name: String = if device.is_empty() { name } else { format!("{name} ({device})") };
            by_source
                .entry(SourceKey {
                    connector: "health_connect",
                    external_id: external_id.chars().take(120).collect(),
                    name: name.chars().take(120).collect(),
                })
                .or_default()
                .push(record.clone());
        }
    }
    for (key, records) in by_source {
        for r in health_core::syshealth::rows(&records, &mut HcStats::default()) {
            put(key.clone(), r);
        }
    }
    out
}

/// What a sync did, for the person.
#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub days: u64,
    pub written: u64,
    pub rebuilt: u64,
    /// History is still being read (another sync goes on)
    pub more: bool,
    /// Another device reads now: this one stopped
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_to: Option<String>,
}

/// How much history one sync reads at most (the rest next time): about a quarter at a time
const BACKFILL_PER_SYNC: i64 = 90 * DAY_MS;
/// The recent window, re-read whole every time (late samples, a watch syncing hours later)
const RECENT: i64 = 36 * 3_600_000;
/// Read the store this many days at a time
const CHUNK: i64 = 7 * DAY_MS;

/// The profile side of a sync, under the profile lock each time it's called.
pub trait Writer {
    /// Writes one day (sync_day) and returns its outcome counts
    fn day(&self, key: &SourceKey, day: i64, rows: &[ObsRow]) -> Result<(u64, bool)>;
    /// Where an export of this source ends, per metric (rows before it are the export's)
    fn export_ends(&self, key: &SourceKey) -> Result<BTreeMap<String, i64>>;
}

/// One sync: the recent window, the days the store says changed, then a step of history.
pub fn sync(store: &dyn SystemHealth, st: &mut SystemHealthState, w: &dyn Writer, now_ms: i64) -> Result<Report> {
    let fail = |e: String| Error::other("system_health", e);
    let floor_day = |t: i64| t.div_euclid(DAY_MS) * DAY_MS;
    let mut report = Report::default();
    // first time: everything from the store's earliest, read newest first, a step per sync
    if st.synced_to_ms == 0 && st.backfill_to_ms.is_none() {
        st.backfill_from_ms = floor_day(store.earliest_ms().max(0));
        st.backfill_to_ms = Some(floor_day(now_ms) - DAY_MS);
        st.synced_to_ms = floor_day(now_ms) - DAY_MS;
    }
    let mut ranges: Vec<(i64, i64)> = Vec::new();
    // the recent window, from a day boundary so every day and slot is read whole
    ranges.push((floor_day(st.synced_to_ms - RECENT), now_ms));
    // days the store says changed
    let changed = store.changed_days(&mut st.anchors, st.backfill_from_ms).map_err(fail)?;
    for d in changed {
        let from = d * DAY_MS;
        if from < floor_day(st.synced_to_ms - RECENT) && st.backfill_to_ms.is_none_or(|b| from >= b) {
            ranges.push((from, from + DAY_MS));
        }
    }
    // a step of history
    if let Some(to) = st.backfill_to_ms {
        let from = (to - BACKFILL_PER_SYNC).max(st.backfill_from_ms);
        if from < to {
            ranges.push((from, to));
        }
        st.backfill_to_ms = (from > st.backfill_from_ms).then_some(from);
        report.more = st.backfill_to_ms.is_some();
    }
    for (from, to) in ranges {
        let mut a = from;
        while a < to {
            let b = (a + CHUNK).min(to);
            let days = days_of(&store.read(a, b).map_err(fail)?);
            for ((key, day), mut rows) in days {
                // an export's rows stay the export's: from the slot where its data ends
                let ends = w.export_ends(&key)?;
                // a 15-minute sum from the slot holding the export's end (that slot may have been read part-way);
                // anything else strictly after it
                const SLOT: i64 = 15 * 60_000;
                rows.retain(|r| {
                    ends.get(&r.metric).is_none_or(|&e| {
                        if r.end_ms == Some(r.start_ms + SLOT) && r.start_ms % SLOT == 0 {
                            r.start_ms >= e.div_euclid(SLOT) * SLOT
                        } else {
                            r.start_ms > e
                        }
                    })
                });
                if rows.is_empty() {
                    continue;
                }
                let (written, rebuilt) = w.day(&key, day, &rows)?;
                report.days += 1;
                report.written += written;
                report.rebuilt += u64::from(rebuilt);
            }
            a = b;
        }
    }
    st.synced_to_ms = now_ms;
    st.last_sync_ms = now_ms;
    Ok(report)
}

/// `Writer` over an open profile.
pub struct ProfileWriter<'a> {
    pub db: &'a health_core::db::Db,
    pub parser: &'a str,
    pub reader: &'a str,
    pub reader_name: &'a str,
    pub now_ms: i64,
}

impl Writer for ProfileWriter<'_> {
    fn day(&self, key: &SourceKey, day: i64, rows: &[ObsRow]) -> Result<(u64, bool)> {
        let spec = key.spec();
        let o = sync_day(
            self.db,
            &SyncDay { source: &spec, parser: self.parser, day, reader: self.reader, reader_name: self.reader_name, rows },
            self.now_ms,
        )?;
        Ok((o.written, o.rebuilt))
    }

    fn export_ends(&self, key: &SourceKey) -> Result<BTreeMap<String, i64>> {
        if key.connector != "apple_health" {
            return Ok(BTreeMap::new());
        }
        let mut out: BTreeMap<String, i64> = BTreeMap::new();
        let mut st = self.db.prepare(
            "SELECT i.meta FROM import i JOIN source s ON s.id = i.source_id
              WHERE s.connector = 'apple_health' AND s.external_id = ? AND i.parser = 'apple-export-1' AND i.status = 'done'",
        )?;
        let metas: Vec<Option<String>> = st.query_map([&key.external_id], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
        for m in metas {
            for (metric_id, (_, end)) in health_core::write::span_of(&health_core::write::parse_meta(m)) {
                let code: String = self.db.query_row("SELECT code FROM metric WHERE id = ?", [metric_id], |r| r.get(0))?;
                let e = out.entry(code).or_insert(end);
                *e = (*e).max(end);
            }
        }
        Ok(out)
    }
}

/// The other device that read the store last, and when (its newest system-sync import): (id, name, ms). A
/// device connecting asks whether it read lately; the reading device, whether it read since this one last did.
pub fn other_reader(db: &health_core::db::Db, me: &str) -> Result<Option<(String, String, i64)>> {
    let r: Option<(Option<String>, Option<String>, String)> = db
        .query_row(
            "SELECT json_extract(meta, '$.reader'), json_extract(meta, '$.reader_name'), uid FROM import
              WHERE parser IN ('healthkit-1', 'health-connect-1') AND status = 'done' AND json_valid(meta)
                AND json_extract(meta, '$.reader') IS NOT ? ORDER BY uid DESC LIMIT 1",
            [me],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    Ok(r.and_then(|(id, name, uid)| Some((id?, name.unwrap_or_default(), health_core::batches::uuid_time(&uid).unwrap_or(0)))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use health_core::keys::MemoryStore;
    use health_core::profile::Profile;
    use std::sync::Mutex;

    struct Fake {
        samples: Mutex<Vec<Sample>>,
        earliest: i64,
    }

    impl SystemHealth for Fake {
        fn kind(&self) -> &'static str {
            "healthkit"
        }
        fn available(&self) -> bool {
            true
        }
        fn authorize(&self) -> std::result::Result<(), String> {
            Ok(())
        }
        fn read(&self, from_ms: i64, to_ms: i64) -> std::result::Result<Vec<Sample>, String> {
            let start = |s: &Sample| match s {
                Sample::Healthkit { start_ms, .. } => *start_ms,
                Sample::HealthConnect { record, .. } => record.start_ms,
            };
            Ok(self.samples.lock().unwrap().iter().filter(|s| (from_ms..to_ms).contains(&start(s))).cloned().collect())
        }
        fn changed_days(&self, _: &mut Value, _: i64) -> std::result::Result<Vec<i64>, String> {
            Ok(vec![])
        }
        fn earliest_ms(&self) -> i64 {
            self.earliest
        }
    }

    fn hk(ty: &str, v: f64, unit: &str, at: i64, source: &str) -> Sample {
        Sample::Healthkit {
            ty: format!("HKQuantityTypeIdentifier{ty}"),
            number: Some(v),
            category: String::new(),
            unit: unit.into(),
            start_ms: at,
            end_ms: at + 60_000,
            tz_min: 480,
            source: source.into(),
        }
    }

    #[test]
    fn a_sync_reads_days_once_by_the_export_rules() {
        let dir = tempfile::tempdir().unwrap();
        let p = Profile::init(dir.path(), "a", &MemoryStore::default()).unwrap();
        let now = 1_795_176_000_000_i64; // 2026-11-21
        let day0 = now.div_euclid(DAY_MS) * DAY_MS;
        let store = Fake {
            samples: Mutex::new(vec![
                hk("HeartRate", 61.0, "count/min", day0 - 3 * DAY_MS + 3_600_000, "Watch"),
                hk("StepCount", 100.0, "count", day0 + 3_600_000, "iPhone"),
                hk("StepCount", 20.0, "count", day0 + 3_660_000, "iPhone"),
                hk("BodyMass", 77.0, "kg", day0 + 1_000, "PhysiMind"),
                Sample::HealthConnect {
                    record: serde_json::from_value(
                        serde_json::json!({ "kind": "Weight", "value": 76.5, "start_ms": day0 + 2_000, "tz_min": 480 }),
                    )
                    .unwrap(),
                    origin: "com.example.scale".into(),
                    device: String::new(),
                    origin_name: "Scale".into(),
                },
            ]),
            earliest: day0 - 10 * DAY_MS,
        };
        let w = ProfileWriter { db: &p.db, parser: "healthkit-1", reader: "d1", reader_name: "iPhone", now_ms: now };
        let mut st = SystemHealthState { on: true, ..Default::default() };
        let r = sync(&store, &mut st, &w, now).unwrap();
        assert!(!r.more, "ten days of history fit one step");
        let count = |sql: &str| -> i64 { p.db.query_row(sql, [], |r| r.get(0)).unwrap() };
        // Watch's day, iPhone's day, the scale's day: three imports; PhysiMind's own weight not read back
        assert_eq!(count("SELECT count(*) FROM import WHERE parser = 'healthkit-1'"), 3);
        assert_eq!(count("SELECT count(*) FROM source WHERE external_id = 'PhysiMind'"), 0);
        assert_eq!(
            count("SELECT sum(value) FROM v_observation WHERE metric_id = (SELECT id FROM metric WHERE code = 'loinc:55423-8')"),
            120
        );
        assert_eq!(count("SELECT count(*) FROM source WHERE connector = 'health_connect' AND name = 'Scale'"), 1);
        // again: the recent window is read again, nothing new is written
        let r2 = sync(&store, &mut st, &w, now + 60_000).unwrap();
        assert_eq!(r2.written, 0);
        assert_eq!(count("SELECT count(*) FROM import WHERE parser = 'healthkit-1'"), 3);
        // a late sample in the recent window: added to that day's import
        store.samples.lock().unwrap().push(hk("StepCount", 5.0, "count", day0 + 7_200_000, "iPhone"));
        let r3 = sync(&store, &mut st, &w, now + 120_000).unwrap();
        assert_eq!((r3.written, r3.rebuilt), (1, 0));
        assert_eq!(count("SELECT count(*) FROM import WHERE parser = 'healthkit-1'"), 3);
    }

    #[test]
    fn an_export_keeps_its_rows() {
        let dir = tempfile::tempdir().unwrap();
        let p = Profile::init(dir.path(), "a", &MemoryStore::default()).unwrap();
        let now = 1_795_176_000_000_i64;
        let day0 = now.div_euclid(DAY_MS) * DAY_MS;
        // an export of Watch's heart rate up to 10:00
        let src = SourceSpec::new("apple_health", "Watch");
        let (zip, _) = health_core::write::begin(
            &p.db,
            health_core::write::Begin { source: &src, parser: "apple-export-1", blob: None, uid: None, candidates: None },
            now,
        )
        .unwrap();
        let hr = |at: i64, v: i64| ObsRow {
            metric: "loinc:8867-4".into(),
            start_ms: at,
            end_ms: None,
            tz_min: 480,
            value: health_core::Value::Int(v),
            unit: None,
            detail: None,
        };
        health_core::write::write(&p.db, zip, &[hr(day0 + 36_000_000, 60)]).unwrap();
        health_core::write::finish(&p.db, zip, now).unwrap();
        let store = Fake {
            samples: Mutex::new(vec![
                hk("HeartRate", 99.0, "count/min", day0 + 36_000_000, "Watch"),
                hk("HeartRate", 70.0, "count/min", day0 + 40_000_000, "Watch"),
            ]),
            earliest: day0 - DAY_MS,
        };
        let w = ProfileWriter { db: &p.db, parser: "healthkit-1", reader: "d1", reader_name: "iPhone", now_ms: now };
        let mut st = SystemHealthState { on: true, ..Default::default() };
        sync(&store, &mut st, &w, now + DAY_MS).unwrap();
        let v = |at: i64| -> i64 { p.db.query_row("SELECT value FROM v_observation WHERE start_ms = ?", [at], |r| r.get(0)).unwrap() };
        assert_eq!(v(day0 + 36_000_000), 60, "the export's reading stays the export's");
        assert_eq!(v(day0 + 40_000_000), 70, "after the export's end: read");
    }
}
