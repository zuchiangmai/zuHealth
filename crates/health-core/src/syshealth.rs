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
}
