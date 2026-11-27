//! WHOOP developer API v2 responses → observation rows. Port of the web `whoop/decode.ts`, rule for rule:
//! only SCORED scores; a day starts at waking (night sleep, recovery and cycle are anchored at the wake time);
//! naps are one nap duration at their start; workouts at their start with an end; body data at local midnight of `now`.
//! Re-pulling the same period anchors identically, so rows overwrite instead of multiplying.

use crate::value::Value;
use crate::write::ObsRow;
use serde::Deserialize;
use serde_json::{Value as J, json};
use std::collections::HashMap;

#[derive(Debug, Default, Clone, serde::Deserialize, schemars::JsonSchema)]
pub struct WhoopData {
    /// WHOOP user id (the API returns a number): the source's external id
    #[serde(deserialize_with = "id_string")]
    pub user_id: String,
    #[serde(default)]
    pub cycles: Vec<J>,
    #[serde(default)]
    pub sleeps: Vec<J>,
    #[serde(default)]
    pub recoveries: Vec<J>,
    #[serde(default)]
    pub workouts: Vec<J>,
    #[serde(default)]
    pub body: Option<J>,
    /// UTC offset (minutes) for anchoring body data at local midnight
    #[serde(default)]
    pub tz: Option<i64>,
}

fn id_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    match J::deserialize(d)? {
        J::String(s) => Ok(s),
        J::Number(n) => Ok(n.to_string()),
        _ => Err(serde::de::Error::custom("user_id must be a string or a number")),
    }
}

/// "+07:00" / "-05:30" / "Z" → minutes.
pub fn tz_min(s: &J) -> Option<i64> {
    let s = s.as_str()?;
    if s == "Z" {
        return Some(0);
    }
    let b = s.as_bytes();
    if b.len() != 6 || !(b[0] == b'+' || b[0] == b'-') || b[3] != b':' {
        return None;
    }
    let (h, m): (i64, i64) = (s[1..3].parse().ok()?, s[4..6].parse().ok()?);
    Some(if b[0] == b'-' { -1 } else { 1 } * (h * 60 + m))
}

fn ms(v: &J) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(v.as_str()?).ok().map(|d| d.timestamp_millis())
}

fn num(v: &J) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

fn scored(r: &J) -> bool {
    r["score_state"] == "SCORED" && r["score"].is_object()
}

/// JS String(x) for an id
fn id(v: &J) -> String {
    match v {
        J::String(s) => s.clone(),
        J::Null => "null".into(),
        other => other.to_string(),
    }
}

fn row(metric: &str, start: i64, end: Option<i64>, tz: i64, value: Value, unit: Option<&str>, detail: Option<J>) -> ObsRow {
    ObsRow { metric: metric.into(), start_ms: start, end_ms: end, tz_min: tz, value, unit: unit.map(String::from), detail }
}

pub fn decode(d: &WhoopData, now: Option<i64>) -> Vec<ObsRow> {
    let mut out = Vec::new();
    for s in &d.sleeps {
        let (Some(start), Some(end), Some(tz)) = (ms(&s["start"]), ms(&s["end"]), tz_min(&s["timezone_offset"])) else { continue };
        if end <= start {
            continue;
        }
        let detail = json!({ "whoop": id(&s["id"]) });
        if s["nap"].as_bool() == Some(true) {
            out.push(row("x:sleep_nap", start, Some(end), tz, Value::Int(end - start), Some("ms"), Some(detail)));
            continue;
        }
        if !scored(s) {
            continue;
        }
        let mut at = |metric: &str, v: &J, unit: Option<&str>| {
            if let Some(x) = num(v) {
                out.push(row(metric, end, None, tz, Value::number(x), unit, Some(detail.clone())));
            }
        };
        let st = &s["score"]["stage_summary"];
        at("x:daily_light_sleep", &st["total_light_sleep_time_milli"], Some("ms"));
        at("x:daily_deep_sleep", &st["total_slow_wave_sleep_time_milli"], Some("ms"));
        at("x:daily_rem_sleep", &st["total_rem_sleep_time_milli"], Some("ms"));
        at("x:daily_awake_time", &st["total_awake_time_milli"], Some("ms"));
        at("x:daily_sleep_cycle_times", &st["sleep_cycle_count"], None);
        at("loinc:103211-9", &st["disturbance_count"], None);
        at("x:daily_sleep_respiratory_rate", &s["score"]["respiratory_rate"], None);
        at("x:sleep_efficiency", &s["score"]["sleep_efficiency_percentage"], None);
        at("x:sleep_performance", &s["score"]["sleep_performance_percentage"], None);
        at("x:sleep_consistency", &s["score"]["sleep_consistency_percentage"], None);
        out.push(row("loinc:103213-5", start, Some(end), tz, Value::Null, None, Some(detail)));
    }

    // wake times of night sleep, by sleep id (recoveries) and by cycle id (earliest wake of the cycle)
    let mut wake_by_sleep: HashMap<String, (i64, i64)> = HashMap::new();
    let mut wake_by_cycle: HashMap<String, (i64, i64)> = HashMap::new();
    for s in &d.sleeps {
        let (Some(end), Some(tz)) = (ms(&s["end"]), tz_min(&s["timezone_offset"])) else { continue };
        if s["nap"].as_bool() == Some(true) {
            continue;
        }
        wake_by_sleep.insert(id(&s["id"]), (end, tz));
        if !s["cycle_id"].is_null() {
            let k = id(&s["cycle_id"]);
            if wake_by_cycle.get(&k).is_none_or(|w| w.0 > end) {
                wake_by_cycle.insert(k, (end, tz));
            }
        }
    }
    let mut cycle_tz: HashMap<String, i64> = HashMap::new();
    for c in &d.cycles {
        if let Some(tz) = tz_min(&c["timezone_offset"])
            && !c["id"].is_null()
        {
            cycle_tz.insert(id(&c["id"]), tz);
        }
    }

    for r in &d.recoveries {
        if !scored(r) {
            continue;
        }
        let wake = wake_by_sleep.get(&id(&r["sleep_id"]));
        let Some(at) = wake.map(|w| w.0).or_else(|| ms(&r["created_at"])) else { continue };
        let tz = wake.map(|w| w.1).or_else(|| cycle_tz.get(&id(&r["cycle_id"])).copied()).unwrap_or(0);
        let sc = &r["score"];
        let mut detail = json!({ "whoop": id(&r["cycle_id"]) });
        if sc["user_calibrating"] == true {
            detail["calibrating"] = json!(true);
        }
        let mut put = |metric: &str, v: &J, unit: Option<&str>| {
            if let Some(x) = num(v) {
                out.push(row(metric, at, None, tz, Value::number(x), unit, Some(detail.clone())));
            }
        };
        put("x:recovery_score", &sc["recovery_score"], None);
        put("loinc:40443-4", &sc["resting_heart_rate"], None);
        put("x:hrv_rmssd", &sc["hrv_rmssd_milli"], Some("ms"));
        put("loinc:59408-5", &sc["spo2_percentage"], None);
        put("x:skin_temperature", &sc["skin_temp_celsius"], Some("Cel"));
    }

    for c in &d.cycles {
        if !scored(c) {
            continue;
        }
        let (Some(start), Some(tz)) = (ms(&c["start"]), tz_min(&c["timezone_offset"])) else { continue };
        let wake = wake_by_cycle.get(&id(&c["id"]));
        let end = ms(&c["end"]);
        // in progress with no night sleep yet: wait, so the anchor is the wake time
        if wake.is_none() && end.is_none() {
            continue;
        }
        let at = wake.map_or(start, |w| w.0);
        let detail = json!({ "whoop": id(&c["id"]) });
        let end = end.filter(|e| *e >= at);
        let mut put = |metric: &str, v: &J, unit: Option<&str>| {
            if let Some(x) = num(v) {
                out.push(row(metric, at, end, tz, Value::number(x), unit, Some(detail.clone())));
            }
        };
        put("x:strain", &c["score"]["strain"], None);
        put("x:daily_calories_total", &c["score"]["kilojoule"], Some("kJ"));
        put("x:daily_heart_rate_avg", &c["score"]["average_heart_rate"], None);
        put("x:daily_heart_rate_max", &c["score"]["max_heart_rate"], None);
    }

    for w in &d.workouts {
        if !scored(w) {
            continue;
        }
        let (Some(start), Some(end), Some(tz)) = (ms(&w["start"]), ms(&w["end"]), tz_min(&w["timezone_offset"])) else { continue };
        if end < start {
            continue;
        }
        let mut detail = json!({ "whoop": id(&w["id"]) });
        if let Some(s) = w["sport_name"].as_str() {
            detail["sport"] = json!(s);
        }
        let mut put = |metric: &str, v: &J, unit: Option<&str>| {
            if let Some(x) = num(v) {
                out.push(row(metric, start, Some(end), tz, Value::number(x), unit, Some(detail.clone())));
            }
        };
        put("x:workout_strain", &w["score"]["strain"], None);
        put("x:heart_rate_max", &w["score"]["max_heart_rate"], None);
        put("loinc:55412-1", &w["score"]["distance_meter"], Some("m"));
    }

    if let (Some(b), Some(now)) = (d.body.as_ref().filter(|b| b.is_object()), now) {
        let tz = d.tz.unwrap_or(0);
        let day = (now + tz * 60_000).div_euclid(86_400_000) * 86_400_000 - tz * 60_000;
        let mut put = |metric: &str, v: &J, unit: Option<&str>| {
            if let Some(x) = num(v) {
                out.push(row(metric, day, None, tz, Value::number(x), unit, None));
            }
        };
        put("loinc:8302-2", &b["height_meter"], Some("m"));
        put("loinc:29463-7", &b["weight_kilogram"], Some("kg"));
        put("x:max_heart_rate_profile", &b["max_heart_rate"], None);
    }
    out
}
