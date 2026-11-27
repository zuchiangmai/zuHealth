//! The only place that reads the clock and the time zone. HEALTH_NOW (ms) and HEALTH_TZ_MIN pin them for tests.

use chrono::{DateTime, FixedOffset, Local, NaiveDate, NaiveDateTime, Offset, TimeZone};
use health_core::{Error, Kind, Result};

/// HEALTH_NOW pins the clock in debug builds (tests); a release build always reads the real clock,
/// so no environment can move grant expiry or windows.
pub fn now_ms() -> i64 {
    let pinned = if cfg!(debug_assertions) { std::env::var("HEALTH_NOW").ok().and_then(|s| s.parse().ok()) } else { None };
    pinned.unwrap_or_else(|| chrono::Utc::now().timestamp_millis())
}

/// The UTC offset (minutes) at `ms` here (HEALTH_TZ_MIN pins it).
pub fn tz_at(ms: i64) -> i64 {
    pinned_tz().unwrap_or_else(|| Local.timestamp_millis_opt(ms).single().map_or(0, |d| d.offset().fix().local_minus_utc() as i64 / 60))
}

/// The calendar year at `ms` in the local zone (pinned in tests).
pub fn year(ms: i64) -> i32 {
    use chrono::Datelike;
    let tz = pinned_tz()
        .unwrap_or_else(|| Local.timestamp_millis_opt(ms).single().map_or(0, |d| d.offset().fix().local_minus_utc() as i64 / 60));
    chrono::DateTime::from_timestamp_millis(ms + tz * 60_000).map_or(2026, |d| d.year())
}

fn pinned_tz() -> Option<i64> {
    std::env::var("HEALTH_TZ_MIN").ok().and_then(|s| s.parse().ok()).filter(|t: &i64| t.abs() <= 840)
}

fn usage(s: &str) -> Error {
    Error::new(Kind::Usage, "bad_time", format!("{s}: use YYYY-MM-DD, YYYY-MM-DDTHH:MM[:SS][±HH:MM] or epoch ms"))
}

/// A parsed time: UTC ms, the local offset there, and whether only a date was given.
pub struct When {
    pub ms: i64,
    pub tz_min: i64,
    pub date: Option<String>,
}

/// Offset (minutes) of the local zone at a local wall-clock time; DST-aware unless pinned.
fn local(naive: NaiveDateTime, s: &str) -> Result<(i64, i64)> {
    if let Some(tz) = pinned_tz() {
        let off = FixedOffset::east_opt((tz * 60) as i32).expect("valid offset");
        let dt = off.from_local_datetime(&naive).single().ok_or_else(|| usage(s))?;
        return Ok((dt.timestamp_millis(), tz));
    }
    let dt = Local.from_local_datetime(&naive).earliest().ok_or_else(|| usage(s))?;
    Ok((dt.timestamp_millis(), dt.offset().fix().local_minus_utc() as i64 / 60))
}

pub fn parse(s: &str) -> Result<When> {
    let s = s.trim();
    if let Ok(ms) = s.parse::<i64>() {
        let tz = pinned_tz()
            .unwrap_or_else(|| Local.timestamp_millis_opt(ms).single().map_or(0, |d| d.offset().fix().local_minus_utc() as i64 / 60));
        return Ok(When { ms, tz_min: tz, date: None });
    }
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Ok(When { ms: d.timestamp_millis(), tz_min: d.offset().local_minus_utc() as i64 / 60, date: None });
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        let (ms, tz_min) = local(d.and_hms_opt(0, 0, 0).unwrap(), s)?;
        return Ok(When { ms, tz_min, date: Some(s.to_string()) });
    }
    for f in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, f) {
            let (ms, tz_min) = local(n, s)?;
            return Ok(When { ms, tz_min, date: None });
        }
    }
    Err(usage(s))
}
