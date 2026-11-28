//! CSV for external analysis (the backend repo's export plan), ported from the web `export-csv.ts`:
//! UTF-8 with BOM, CRLF, RFC 4180; one row per observation in time order; 12 columns.
//! Only confirmed imports; corrections applied; from `detail` only comparator, reference range and flag.
//! Never identifiers (device ids, WHOOP ids, room entities, raw input, printed text). Formula-like text is defused.

use crate::db::Db;
use crate::error::{Error, Result};
use crate::value::Value;
use serde::Serialize;

const HEAD: [&str; 12] =
    ["Date", "Time", "Time zone", "End", "Category", "Metric", "Value", "Unit", "Reference range", "Flag", "Source", "Metric code"];

pub fn group_label(g: &str) -> &'static str {
    match g {
        "body" => "Body composition & vitals",
        "sleep" => "Sleep",
        "cardio" => "Heart & recovery",
        "activity" => "Activity & exercise",
        "lab" => "Routine lab",
        "infectious" => "Infectious disease tests",
        "tumor" => "Tumour markers",
        "repro" => "Reproductive & sexual health",
        "custom" => "Custom metrics",
        "lab_other" => "Other lab tests",
        "derived" => "Derived results",
        _ => "Other",
    }
}

fn source_label(connector: &str) -> &'static str {
    match connector {
        "lab" => "Lab",
        "staff" => "Staff entry",
        "manual" => "Manual",
        "ocr" => "Lab report photo",
        "whoop" => "WHOOP",
        "room" | "home_assistant" => "Sleep room",
        "apple_health" | "apple_export" | "healthkit" => "Apple Health",
        "agent" => "Agent",
        "derived" => "Derived",
        "file" => "File",
        _ => "Other",
    }
}

/// UCUM → what people write (the web's `unitLabel`).
pub fn unit_label(u: &str) -> String {
    let fixed = match u {
        "mm[Hg]" => "mmHg",
        "Cel" => "°C",
        "[lb_av]" => "lb",
        "[oz_av]" => "oz",
        "[stone_av]" => "st",
        "[in_i]" => "in",
        "[ft_i]" => "ft",
        "[yd_i]" => "yd",
        "[mi_i]" => "mi",
        "[degF]" => "°F",
        "[IU]/L" => "IU/L",
        "[IU]/mL" => "IU/mL",
        "m[IU]/L" => "mIU/L",
        "m[IU]/mL" => "mIU/mL",
        "k[IU]/L" => "kIU/L",
        "u[IU]/mL" => "uIU/mL",
        "[mi_i]/h" => "mph",
        "[ft_i]/s" => "ft/s",
        "[gal_us]" => "gal",
        "[foz_us]" => "fl oz",
        "meq/L" => "mEq/L",
        "1" => "",
        "/uL" => "/µL",
        "mL/min/{1.73_m2}" => "mL/min/1.73m²",
        _ => "",
    };
    if !fixed.is_empty() || u == "1" {
        return fixed.into();
    }
    // drop {annotations} and [brackets]; 10*3 → 10³; trailing uL → µL
    let mut s = String::new();
    let mut depth = 0;
    for ch in u.chars() {
        match ch {
            '{' => depth += 1,
            '}' if depth > 0 => depth -= 1,
            '[' | ']' if depth == 0 => {}
            c if depth == 0 => s.push(c),
            _ => {}
        }
    }
    const SUP: [char; 10] = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        out.push(c);
        if out.ends_with("10*") && it.peek().is_some_and(|d| d.is_ascii_digit()) {
            out.pop();
            while let Some(d) = it.peek().copied().filter(char::is_ascii_digit) {
                out.push(SUP[d as usize - '0' as usize]);
                it.next();
            }
        }
    }
    for tail in ["uL", "ul"] {
        if (out == tail || out.ends_with(&format!("/{tail}"))) && out.ends_with(tail) {
            out.truncate(out.len() - tail.len());
            out.push('µ');
            out.push(tail.chars().nth(1).unwrap());
        }
    }
    out
}

/// JS String(Number(n.toPrecision(12))).
fn clean(n: f64) -> String {
    let v = crate::apple::precision12(n);
    if v == 0.0 { "0".into() } else { format!("{v}") }
}

fn risky(t: &str) -> bool {
    t.starts_with(['=', '+', '@', '\t', '\r']) || (t.starts_with('-') && t.len() > 1 && t[1..].parse::<f64>().is_err())
}

fn defuse(s: &str) -> String {
    if risky(s) || risky(s.trim_start_matches([' ', '\u{a0}', '\t', '\n'])) { format!("'{s}") } else { s.to_string() }
}

fn cell(s: &str) -> String {
    if s.contains([',', '"', '\r', '\n']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() }
}

fn has_word(name: &str, w: &str) -> bool {
    name.split(|c: char| !c.is_ascii_alphanumeric()).any(|x| x == w)
}

/// Sleep durations stored in ms/s/min/h (not HRV, timestamps or indices): written as minutes.
fn sleep_duration(group: &str, name: &str) -> bool {
    let n = name.to_lowercase();
    group == "sleep"
        && (["light", "deep", "awake", "nap", "asleep", "in bed", "duration", "latency"].iter().any(|w| n.contains(w))
            || has_word(&n, "rem"))
        && !["hrv", "rmssd", "sdnn", "index", "capacity", "heart", "start", "end", "report"].iter().any(|w| n.contains(w))
}

fn per_ms(unit: &str) -> Option<f64> {
    Some(match unit {
        "ms" => 1.0,
        "s" => 1000.0,
        "min" => 60_000.0,
        "h" => 3_600_000.0,
        _ => return None,
    })
}

fn local(ms: i64, tz: i64) -> (String, String) {
    let d = chrono::DateTime::from_timestamp_millis(ms + tz * 60_000).unwrap_or_default();
    (d.format("%Y-%m-%d").to_string(), d.format("%H:%M").to_string())
}

fn offset(tz: i64) -> String {
    format!("{}{:02}:{:02}", if tz < 0 { '-' } else { '+' }, tz.abs() / 60, tz.abs() % 60)
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct GroupCount {
    pub group: String,
    pub label: String,
    pub sensitive: bool,
    pub rows: i64,
}

struct Row {
    code: String,
    name: String,
    unit: String,
    agg: String,
    start_ms: i64,
    end_ms: Option<i64>,
    tz: i64,
    value: Value,
    corrected: bool,
    connector: String,
    detail: Option<serde_json::Value>,
}

/// Streams the exportable rows in time order (never all of them in memory).
fn each_row(c: &Db, from_ms: i64, mut f: impl FnMut(Row) -> Result<()>) -> Result<()> {
    let mut st = c.prepare(
        "SELECT m.code, m.name, m.unit, m.agg, o.start_ms, o.end_ms, o.tz_min, o.value, o.corrected, s.connector, o.detail
           FROM v_observation o JOIN metric m ON m.id = o.metric_id JOIN source s ON s.id = o.source_id JOIN import i ON i.id = o.import_id
          WHERE i.status = 'done' AND o.start_ms >= ?
          ORDER BY o.start_ms, m.code",
    )?;
    let mut q = st.query([from_ms])?;
    while let Some(r) = q.next()? {
        let detail: Option<String> = r.get(10)?;
        f(Row {
            code: r.get(0)?,
            name: r.get(1)?,
            unit: r.get(2)?,
            agg: r.get(3)?,
            start_ms: r.get(4)?,
            end_ms: r.get(5)?,
            tz: r.get(6)?,
            value: r.get(7)?,
            corrected: r.get(8)?,
            connector: r.get(9)?,
            detail: detail.and_then(|d| serde_json::from_str(&d).ok()),
        })?;
    }
    Ok(())
}

/// Rows per group from `from_ms` on (shown before choosing what to export).
pub fn groups(c: &Db, from_ms: i64) -> Result<Vec<GroupCount>> {
    let mut n: std::collections::HashMap<&'static str, i64> = Default::default();
    let mut st = c.prepare(
        "SELECT m.code, count(*) FROM v_observation o JOIN metric m ON m.id = o.metric_id JOIN import i ON i.id = o.import_id
          WHERE i.status = 'done' AND o.start_ms >= ? GROUP BY m.code",
    )?;
    for row in st.query_map([from_ms], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (code, k) = row?;
        *n.entry(crate::catalog::group_of(&code)).or_default() += k;
    }
    Ok(crate::catalog::GROUPS
        .iter()
        .filter_map(|(g, sensitive)| {
            n.get(g).map(|&rows| GroupCount { group: g.to_string(), label: group_label(g).into(), sensitive: *sensitive, rows })
        })
        .collect())
}

/// The CSV text for the chosen groups (small exports and tests; files use `write`).
pub fn build(c: &Db, from_ms: i64, groups: &[String], date_only: bool) -> Result<(String, usize)> {
    let mut out = Vec::new();
    let n = write(c, from_ms, groups, date_only, &mut out)?;
    Ok((String::from_utf8(out).expect("utf-8"), n))
}

fn line(out: &mut impl std::io::Write, cols: &[String]) -> Result<()> {
    let l: Vec<String> = cols.iter().map(|c| cell(c)).collect();
    out.write_all(l.join(",").as_bytes())?;
    out.write_all(b"\r\n")?;
    Ok(())
}

/// Streams the CSV for the chosen groups into `out`; returns the number of data rows.
pub fn write(c: &Db, from_ms: i64, groups: &[String], date_only: bool, out: &mut impl std::io::Write) -> Result<usize> {
    if groups.is_empty() {
        return Err(Error::invalid("bad_request", "choose at least one group"));
    }
    out.write_all("\u{feff}".as_bytes())?;
    line(out, &HEAD.iter().map(|s| s.to_string()).collect::<Vec<_>>())?;
    let mut n = 0usize;
    each_row(c, from_ms, |r| {
        let g = crate::catalog::group_of(&r.code);
        if !groups.iter().any(|x| x == g) {
            return Ok(());
        }
        let d = r.detail.as_ref();
        let pick = |k: &str| {
            d.and_then(|d| d.get(k).or_else(|| d.get("printed").and_then(|p| p.get(k)))).and_then(|v| v.as_str()).map(String::from)
        };
        let cmp = pick("comparator").filter(|c| ["<", ">", "<=", ">="].contains(&c.as_str()));
        let day_only = d.and_then(|d| d.get("precision")).and_then(|p| p.as_str()) == Some("day");
        let (value, unit) = if r.agg == "interval" {
            match r.end_ms {
                Some(e) => (clean(((e - r.start_ms) as f64 / 6_000.0).round() / 10.0), "min".to_string()),
                None => (String::new(), String::new()),
            }
        } else {
            match &r.value {
                Value::Null => (String::new(), String::new()),
                Value::Text(t) => (defuse(t), String::new()),
                v => {
                    let x = v.as_f64().unwrap_or(0.0);
                    match per_ms(&r.unit).filter(|_| sleep_duration(g, &r.name)) {
                        Some(per) => (clean((x * per / 6_000.0).round() / 10.0), "min".into()),
                        None => {
                            let c = if r.corrected { String::new() } else { cmp.clone().unwrap_or_default() };
                            (format!("{c}{}", clean(x)), defuse(&unit_label(&r.unit)))
                        }
                    }
                }
            }
        };
        let (date, time) = local(r.start_ms, r.tz);
        let end = r.end_ms.map(|e| local(e, r.tz));
        let flag = if r.corrected {
            ""
        } else {
            match pick("flag").as_deref() {
                Some("H") => "↑",
                Some("L") => "↓",
                _ => "",
            }
        };
        n += 1;
        line(
            out,
            &[
                date,
                if date_only || day_only { String::new() } else { time },
                if date_only || day_only { String::new() } else { offset(r.tz) },
                end.map_or(String::new(), |(d, t)| if date_only { d } else { format!("{d} {t}") }),
                group_label(g).into(),
                defuse(&r.name),
                value,
                unit,
                pick("ref").filter(|_| !r.corrected).map(|s| defuse(&s)).unwrap_or_default(),
                flag.into(),
                source_label(&r.connector).into(),
                defuse(&r.code),
            ],
        )
    })?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_and_defusing() {
        assert_eq!(unit_label("10*3/uL"), "10³/µL");
        assert_eq!(unit_label("{#}"), "");
        assert_eq!(unit_label("mm[Hg]"), "mmHg");
        assert_eq!(defuse("=SUM(A1)"), "'=SUM(A1)");
        assert_eq!(defuse("-0.2"), "-0.2");
        assert_eq!(defuse("-cmd"), "'-cmd");
        assert_eq!(cell("a,\"b\""), "\"a,\"\"b\"\"\"");
        assert!(sleep_duration("sleep", "Daily Deep Sleep") && !sleep_duration("sleep", "Sleep HRV"));
    }
}
