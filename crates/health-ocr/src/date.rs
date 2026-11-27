//! The test date on a report (web `ocr/date.ts`): sampling date first, then report date; only unambiguous
//! forms (2021-11-07, the CJK year-month-day form, dd/mm/yyyy when day or month is over 12). Two-digit years are 20xx but not
//! after next year (Buddhist-era "69" is refused). `this_year` comes from the caller (no clock here).

use crate::types::Line;
use regex::Regex;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Ymd {
    pub y: i32,
    pub m: u32,
    pub d: u32,
}

impl Ymd {
    pub fn iso(&self) -> String {
        format!("{:04}-{:02}-{:02}", self.y, self.m, self.d)
    }
}

static LABELS: LazyLock<[Regex; 2]> = LazyLock::new(|| {
    [
        Regex::new(
            r"(?i)(采样|采集|送检|检验日期|检测日期|检查日期|collected|collection|sample\s*date|sampled|specimen\s*date|test\s*date)",
        )
        .unwrap(),
        Regex::new(r"(?i)(报告日期|报告时间|reported|report\s*date)").unwrap(),
    ]
});
static BIRTH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(birth|dob|出生|生日)").unwrap());
static YMD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([0-9]{4})\s*[-/.年]\s*([0-9]{1,2})\s*[-/.月]\s*([0-9]{1,2})").unwrap());
static DMY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([0-9]{1,2})\s*[-/.]\s*([0-9]{1,2})\s*[-/.]\s*([0-9]{4})").unwrap());
static DMY2: LazyLock<fancy_regex::Regex> =
    LazyLock::new(|| fancy_regex::Regex::new(r"(?<![0-9])([0-9]{1,2})\s*[-/.]\s*([0-9]{1,2})\s*[-/.]\s*([0-9]{2})(?![0-9])").unwrap());

fn valid(y: i32, m: u32, d: u32) -> Option<Ymd> {
    ((1990..=2100).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d)).then_some(Ymd { y, m, d })
}

fn day_month(a: u32, b: u32, y: i32) -> Option<Ymd> {
    if a == b || (a > 12 && b <= 12) {
        valid(y, b, a)
    } else if b > 12 && a <= 12 {
        valid(y, a, b)
    } else {
        None
    }
}

pub fn parse_ymd(raw: &str, this_year: i32) -> Option<Ymd> {
    let s: String = raw.nfkc().collect();
    if let Some(m) = YMD.captures(&s) {
        return valid(m[1].parse().ok()?, m[2].parse().ok()?, m[3].parse().ok()?);
    }
    if let Some(m) = DMY.captures(&s)
        && let Some(r) = day_month(m[1].parse().ok()?, m[2].parse().ok()?, m[3].parse().ok()?)
    {
        return Some(r);
    }
    if let Ok(Some(m)) = DMY2.captures(&s) {
        let y = 2000 + m[3].parse::<i32>().ok()?;
        if y > this_year + 1 {
            return None;
        }
        return day_month(m[1].parse().ok()?, m[2].parse().ok()?, y);
    }
    None
}

/// The first certain date on a line carrying a date label (sampling first). A label and its date may sit in
/// neighbouring cells, so the cells of the same row are read together.
pub fn report_date(lines: &[Line], this_year: i32) -> Option<Ymd> {
    let cy = |l: &Line| l.bx.y + l.bx.h / 2.0;
    for label in LABELS.iter() {
        for l in lines {
            if !label.is_match(&l.text) {
                continue;
            }
            let mut row: Vec<&Line> = lines.iter().filter(|x| (cy(x) - cy(l)).abs() < l.bx.h * 0.6).collect();
            row.sort_by(|a, b| a.bx.x.partial_cmp(&b.bx.x).unwrap());
            let text = row.iter().map(|x| x.text.as_str()).collect::<Vec<_>>().join(" ");
            if BIRTH.is_match(&text) {
                continue;
            }
            if let Some(found) = parse_ymd(&text, this_year) {
                return Some(found);
            }
        }
    }
    None
}
