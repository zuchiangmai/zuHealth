//! Apple Health export (export.xml) → observation rows. Port of the web `import/apple.ts`, rule for rule:
//! - one element per line; only `<Record` lines; `<Correlation>` children are skipped (the readings also appear on their own);
//! - instant types: one row per record; cumulative types: summed per (metric, source) into 15-minute UTC slots;
//! - sleep stages are intervals with no value; percentages are stored 0–1 by Apple and multiplied by 100;
//! - one source per `sourceName` (each watch / phone), so the daily election never adds a watch to a phone.

use crate::error::{Error, Result};
use crate::value::Value;
use crate::write::ObsRow;
use std::collections::HashMap;

pub const MAX_LINE: usize = 1024 * 1024;
const SLOT: i64 = 15 * 60_000;

enum Kind {
    Instant,
    /// summed in this catalog unit
    Sum(&'static str),
}

const Q: &str = "HKQuantityTypeIdentifier";

fn map(t: &str) -> Option<(&'static str, Kind)> {
    use Kind::*;
    Some(match t.strip_prefix(Q)? {
        "HeartRate" => ("loinc:8867-4", Instant),
        "RestingHeartRate" => ("loinc:40443-4", Instant),
        "WalkingHeartRateAverage" => ("x:walking_heart_rate", Instant),
        "HeartRateVariabilitySDNN" => ("loinc:112429-6", Instant),
        "HeartRateRecoveryOneMinute" => ("x:recovery_time", Instant),
        "OxygenSaturation" => ("loinc:59408-5", Instant),
        "BodyTemperature" => ("loinc:8310-5", Instant),
        "BloodPressureSystolic" => ("loinc:8480-6", Instant),
        "BloodPressureDiastolic" => ("loinc:8462-4", Instant),
        "RespiratoryRate" => ("loinc:9279-1", Instant),
        "VO2Max" => ("x:vo2_max", Instant),
        "WalkingSpeed" => ("x:walking_speed", Instant),
        "WalkingAsymmetryPercentage" => ("x:walking_asymmetry_percentage", Instant),
        "WalkingDoubleSupportPercentage" => ("loinc:112434-6", Instant),
        "StairAscentSpeed" => ("loinc:112431-2", Instant),
        "StairDescentSpeed" => ("loinc:112430-4", Instant),
        "SixMinuteWalkTestDistance" => ("loinc:64098-7", Instant),
        "BodyMass" => ("loinc:29463-7", Instant),
        "Height" => ("loinc:8302-2", Instant),
        "BodyMassIndex" => ("loinc:39156-5", Instant),
        "BodyFatPercentage" => ("loinc:41982-0", Instant),
        "LeanBodyMass" => ("loinc:91557-9", Instant),
        "WaistCircumference" => ("x:waist_circumference", Instant),
        "AppleSleepingWristTemperature" => ("x:wrist_temperature", Instant),
        "BloodGlucose" => ("loinc:2339-0", Instant),
        "PeripheralPerfusionIndex" => ("loinc:61006-3", Instant),
        "StepCount" => ("loinc:55423-8", Sum("{#}")),
        "DistanceWalkingRunning" => ("loinc:112427-0", Sum("m")),
        "FlightsClimbed" => ("loinc:100304-5", Sum("{#}")),
        "ActiveEnergyBurned" => ("loinc:41981-2", Sum("kcal")),
        "BasalEnergyBurned" => ("x:calories_basal", Sum("kcal")),
        "AppleExerciseTime" => ("x:active_time", Sum("min")),
        _ => return None,
    })
}

const SLEEP: &str = "HKCategoryTypeIdentifierSleepAnalysis";

fn stage(v: &str) -> Option<&'static str> {
    Some(match v.strip_prefix("HKCategoryValueSleepAnalysis")? {
        "InBed" => "loinc:103213-5",
        "AsleepREM" => "x:sleep_asleep_rem",
        "AsleepDeep" => "x:sleep_asleep_deep",
        "AsleepCore" => "x:sleep_asleep_core",
        "Awake" => "x:sleep_awake",
        "AsleepUnspecified" | "Asleep" => "x:sleep_unspecified",
        _ => return None,
    })
}

/// Apple's unit spelling → UCUM.
fn unit_of(u: &str) -> String {
    let m = match u {
        "count/min" => "/min",
        "count" => "{#}",
        "km/hr" => "km/h",
        "mL/min·kg" => "mL/min/kg",
        "degC" => "Cel",
        "mi/hr" => "[mi_i]/h",
        "ft/s" => "[ft_i]/s",
        "st" => "[stone_av]",
        "Cal" => "kcal",
        "degF" => "[degF]",
        "lb" => "[lb_av]",
        "mmHg" => "mm[Hg]",
        "hr" => "h",
        "in" => "[in_i]",
        "ft" => "[ft_i]",
        "mi" => "[mi_i]",
        _ => {
            // mmol<180.15588…>/L
            if let Some(rest) = u.strip_prefix("mmol<")
                && let Some(mid) = rest.strip_suffix(">/L")
                && !mid.is_empty()
                && mid.bytes().all(|b| b.is_ascii_digit() || b == b'.')
            {
                return "mmol/L".into();
            }
            return u.to_string();
        }
    };
    m.to_string()
}

fn unentity(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let end = tail[1..].find(';').map(|j| j + 1);
        let decoded = end.and_then(|e| {
            let ent = &tail[1..e];
            match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                _ if ent.starts_with("#x") || ent.starts_with("#X") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
                _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32),
                _ => None,
            }
            .map(|c| (c, e))
        });
        match decoded {
            Some((c, e)) => {
                out.push(c);
                rest = &tail[e + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// "2026-11-18 07:00:00 +0800" → (UTC ms, tz minutes); impossible dates are refused.
pub fn apple_time(s: &str) -> Option<(i64, i64)> {
    let (dt, off) = s.rsplit_once(' ')?;
    let b = off.as_bytes();
    if b.len() != 5 || !(b[0] == b'+' || b[0] == b'-') || !b[1..].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let tz = (if b[0] == b'-' { -1 } else { 1 }) * (off[1..3].parse::<i64>().ok()? * 60 + off[3..5].parse::<i64>().ok()?);
    let n = chrono::NaiveDateTime::parse_from_str(dt, "%Y-%m-%d %H:%M:%S").ok()?;
    if dt.len() != 19 {
        return None;
    }
    Some((n.and_utc().timestamp_millis() - tz * 60_000, tz))
}

/// JS `Number(x.toPrecision(12))`: drops float tails like 28.999999999999996.
pub fn precision12(x: f64) -> f64 {
    format!("{x:.11e}").parse().unwrap_or(x)
}

fn attrs(l: &str) -> HashMap<&str, &str> {
    // ` name="value"` pairs, as the web's / (\w+)="([^"]*)"/g
    let mut out = HashMap::new();
    let b = l.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b' ' {
            let start = i + 1;
            let mut j = start;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                j += 1;
            }
            if j > start
                && j + 1 < b.len()
                && b[j] == b'='
                && b[j + 1] == b'"'
                && let Some(k) = l[j + 2..].find('"')
            {
                out.entry(&l[start..j]).or_insert(&l[j + 2..j + 2 + k]);
                i = j + 2 + k + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

#[derive(Debug, Default, Clone, serde::Serialize, schemars::JsonSchema)]
pub struct Stats {
    /// `<Record>` elements seen
    pub records: u64,
    /// turned into rows (before 15-minute sums)
    pub mapped: u64,
    /// skipped types and how often
    pub skipped_types: std::collections::BTreeMap<String, u64>,
    /// bad time or value
    pub broken: u64,
    /// written by this app itself (its lab results, already here)
    #[serde(default)]
    pub own: u64,
}

/// The source name this app's own samples carry in Apple Health: they are its lab results, already here, so they are
/// not read back.
pub const OWN_SOURCE: &str = "PhysiMind";

/// One sample as Apple Health has it, from its export or read from HealthKit: the type identifier, the value (a
/// number, or the sleep stage's name), the unit as Apple writes it, start and end with their offsets, the source.
pub struct Record<'a> {
    pub ty: &'a str,
    /// The number, for quantity types
    pub number: Option<f64>,
    /// The category value as the export writes it (sleep: `HKCategoryValueSleepAnalysisAsleepREM`, ...)
    pub category: &'a str,
    pub unit: &'a str,
    /// (UTC ms, offset in minutes)
    pub start: Option<(i64, i64)>,
    pub end: Option<(i64, i64)>,
    /// The source's name, as the export writes it (entities still encoded)
    pub source: &'a str,
}

struct Group {
    source: String,
    metric: &'static str,
    unit: &'static str,
    tz: i64,
    slots: Vec<(i64, f64)>,
    index: HashMap<i64, usize>,
    tzs: HashMap<i64, i64>,
}

#[derive(Default)]
pub struct Parser {
    in_correlation: bool,
    groups: Vec<Group>,
    group_index: HashMap<(&'static str, String), usize>,
    sources: HashMap<String, String>,
    pub stats: Stats,
}

pub type Row = (String, ObsRow);

impl Parser {
    fn source(&mut self, raw: &str) -> String {
        if let Some(s) = self.sources.get(raw) {
            return s.clone();
        }
        let name: String = unentity(raw).trim().chars().take(120).collect();
        let name = if name.is_empty() { "Apple".to_string() } else { name };
        self.sources.insert(raw.to_string(), name.clone());
        name
    }

    /// One line of the XML; instant rows go to `emit`, sums wait for `finish`.
    pub fn line(&mut self, l: &str, emit: &mut impl FnMut(Row)) {
        if l.contains("<Correlation ") {
            self.in_correlation = !l.trim_end().ends_with("/>");
        }
        if l.contains("</Correlation>") {
            self.in_correlation = false;
            return;
        }
        if self.in_correlation {
            return;
        }
        let Some(i) = l.find("<Record ") else { return };
        let a = attrs(&l[i..]);
        let raw = a.get("value").copied().unwrap_or("");
        let r = Record {
            ty: a.get("type").copied().unwrap_or(""),
            number: raw.trim().parse().ok().filter(|v: &f64| v.is_finite() && !raw.is_empty()),
            category: raw,
            unit: a.get("unit").copied().unwrap_or(""),
            start: a.get("startDate").and_then(|s| apple_time(s)),
            end: a.get("endDate").and_then(|s| apple_time(s)),
            source: a.get("sourceName").copied().unwrap_or(""),
        };
        self.record(&r, emit);
    }

    /// One sample: rows as the export's would be (the export and HealthKit share this, so both give the same rows).
    pub fn record(&mut self, r: &Record, emit: &mut impl FnMut(Row)) {
        self.stats.records += 1;
        let (ty, start, end) = (r.ty, r.start, r.end);
        let src = self.source(r.source);
        if src == OWN_SOURCE {
            self.stats.own += 1;
            return;
        }
        if ty == SLEEP {
            let v = r.category;
            let Some(metric) = stage(v) else {
                *self.stats.skipped_types.entry(format!("{ty}/{v}")).or_default() += 1;
                return;
            };
            let (Some((s, tz)), Some((e, _))) = (start, end) else {
                self.stats.broken += 1;
                return;
            };
            if e <= s {
                self.stats.broken += 1;
                return;
            }
            self.stats.mapped += 1;
            emit((
                src,
                ObsRow { metric: metric.into(), start_ms: s, end_ms: Some(e), tz_min: tz, value: Value::Null, unit: None, detail: None },
            ));
            return;
        }
        let Some((metric, kind)) = map(ty) else {
            *self.stats.skipped_types.entry(ty.to_string()).or_default() += 1;
            return;
        };
        let (Some((s, tz)), Some(mut value)) = (start, r.number) else {
            self.stats.broken += 1;
            return;
        };
        let mut unit = unit_of(r.unit);
        if unit == "%" {
            value = precision12(value * 100.0);
        }
        self.stats.mapped += 1;
        match kind {
            Kind::Instant => emit((
                src,
                ObsRow {
                    metric: metric.into(),
                    start_ms: s,
                    end_ms: None,
                    tz_min: tz,
                    value: Value::number(value),
                    unit: Some(unit),
                    detail: None,
                },
            )),
            Kind::Sum(canon) => {
                let Some(v) = crate::units::to_canonical(metric, canon, value, &unit) else {
                    self.stats.broken += 1;
                    return;
                };
                unit = canon.to_string();
                let _ = unit;
                let slot = s.div_euclid(SLOT);
                let key = (metric, src.clone());
                let gi = *self.group_index.entry(key).or_insert_with(|| {
                    self.groups.push(Group {
                        source: src,
                        metric,
                        unit: canon,
                        tz,
                        slots: Vec::new(),
                        index: HashMap::new(),
                        tzs: HashMap::new(),
                    });
                    self.groups.len() - 1
                });
                let g = &mut self.groups[gi];
                match g.index.get(&slot) {
                    Some(&k) => g.slots[k].1 += v,
                    None => {
                        g.index.insert(slot, g.slots.len());
                        g.slots.push((slot, v));
                        if tz != g.tz {
                            g.tzs.insert(slot, tz);
                        }
                    }
                }
            }
        }
    }

    /// End of file: the 15-minute sums.
    pub fn finish(&mut self, emit: &mut impl FnMut(Row)) {
        for g in std::mem::take(&mut self.groups) {
            for (slot, v) in g.slots {
                let start = slot * SLOT;
                emit((
                    g.source.clone(),
                    ObsRow {
                        metric: g.metric.into(),
                        start_ms: start,
                        end_ms: Some(start + SLOT),
                        tz_min: *g.tzs.get(&slot).unwrap_or(&g.tz),
                        value: Value::number(precision12(v)),
                        unit: Some(g.unit.into()),
                        detail: None,
                    },
                ));
            }
        }
        self.group_index.clear();
    }
}

/// Streams the export's lines through a parser.
pub fn parse(mut r: impl std::io::BufRead, emit: &mut impl FnMut(Row)) -> Result<Stats> {
    let mut p = Parser::default();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = std::io::Read::take(&mut r, MAX_LINE as u64 + 1).read_until(b'\n', &mut buf)?;
        if n == 0 {
            break;
        }
        if buf.len() > MAX_LINE {
            return Err(Error::invalid("not_apple", "a line over 1 MiB"));
        }
        p.line(&String::from_utf8_lossy(&buf), emit);
    }
    p.finish(emit);
    Ok(p.stats)
}

use std::io::BufRead as _;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_units_entities() {
        assert_eq!(apple_time("2026-11-18 07:00:00 +0800"), Some((1_794_956_400_000, 480)));
        assert_eq!(apple_time("2026-02-30 07:00:00 +0800"), None);
        assert_eq!(unit_of("mmol<180.1558800000541>/L"), "mmol/L");
        assert_eq!(unentity("Test&apos;s &#x41;&#66; &bogus;"), "Test's AB &bogus;");
        assert_eq!(precision12(0.29 * 100.0), 29.0);
    }
}
