//! Lab-report OCR in the data layer: ingest into a review batch, and confirm it. Port of the web `db/ocr.ts`,
//! `ocr/codes.ts` and the confirm rules of `ocr-review-form.ts`. Recognition itself (pixels → items) lives in
//! `health-ocr`; nothing here reads images or the clock.
//!
//! Invariant 6: an OCR batch holds no rows until the person confirms it, so no query and no agent sees it.

use crate::db::{Db, one, tx};
use crate::error::{Error, Result};
use crate::review::{self, Alias, Confirmed};
use crate::units::{allowed_units, js_space, same_unit};
use crate::value::Value;
use crate::write::{Begin, ObsRow, SourceSpec, begin};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::collections::HashMap;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

/// Parser name of OCR batches: model + parsing rules version (as the web).
pub const OCR_PARSER: &str = "ocr-ppv5@2";

/// A printed result: a number, or a qualitative text ("Negative", "+", "0-1").
/// Whole numbers serialise as JSON integers, as JS writes them (the web reads the same candidates).
#[derive(Debug, Clone, PartialEq, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum Printed {
    Num(f64),
    Text(String),
}

impl Serialize for Printed {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Printed::Num(x) if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 => s.serialize_i64(*x as i64),
            Printed::Num(x) => s.serialize_f64(*x),
            Printed::Text(t) => s.serialize_str(t),
        }
    }
}

impl Printed {
    pub fn is_text(&self) -> bool {
        matches!(self, Printed::Text(_))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Suggestion {
    pub code: String,
    pub score: f64,
}

/// One line of a lab report as printed, with what matching found for it.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct OcrItem {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel: Option<String>,
    /// "urine" when the table reads as a urine test (same names mean other measures there)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub specimen: Option<String>,
    pub v: Printed,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cmp: Option<String>,
    #[serde(default)]
    pub unit: String,
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flag: Option<String>,
    /// The whole printed line, for the person to check against
    #[serde(default)]
    pub text: String,
    /// Preselected measure (alias table, or a confident match); the person can change it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Ranked candidates (unit-filtered, at most 3)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suggest: Vec<Suggestion>,
}

/// What recognition hands over (`items` may carry `pre`: a confident embedding match).
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Recognized {
    pub items: Vec<RecognizedItem>,
    /// Full text of every page (searchable after confirmation)
    pub text: String,
    /// Report date found on the page, as YYYY-MM-DD; None when no date could be read with certainty
    #[serde(default)]
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RecognizedItem {
    #[serde(flatten)]
    pub item: OcrItem,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre: Option<String>,
}

/// Stored in the review batch's `meta.candidates`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct OcrCandidates {
    pub kind: String,
    /// Test date (ms): the one recognised, else the import time
    pub at: i64,
    /// Was the date recognised? false = `at` is only the import time; the person sets it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dated: Option<bool>,
    pub tz: i64,
    pub items: Vec<OcrItem>,
    pub text: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Ingested {
    pub import_id: i64,
    pub items: usize,
    /// Items preselected by the alias table
    pub matched: usize,
}

/* ---------- common items: printed name → code (ocr/codes.ts) ---------- */

#[derive(Deserialize)]
struct CodeTable {
    /// [keys, code, kind] or [keys, code, kind, ctx]
    rows: Vec<Vec<Json>>,
}

struct Entry {
    code: String,
    text: bool,
    ctx: Option<String>,
}

/// Folded name: NFKC, lower case, no whitespace, brackets, stars or bullets ("LDL (calculate)" → "ldlcalculate").
pub fn fold_name(s: &str) -> String {
    s.nfkc().collect::<String>().to_lowercase().chars().filter(|c| !js_space(*c) && !"()（）*#·•".contains(*c)).collect()
}

static CODES: LazyLock<HashMap<String, Vec<Entry>>> = LazyLock::new(|| {
    let t: CodeTable = serde_json::from_str(include_str!("../data/ocr-codes.json")).expect("ocr-codes.json");
    let mut by: HashMap<String, Vec<Entry>> = HashMap::new();
    for row in t.rows {
        let s = |i: usize| row.get(i).and_then(Json::as_str).map(String::from);
        let (Some(code), Some(kind)) = (s(1), s(2)) else { panic!("ocr-codes.json row") };
        for k in row[0].as_array().into_iter().flatten().filter_map(Json::as_str) {
            by.entry(fold_name(k)).or_default().push(Entry { code: code.clone(), text: kind == "text", ctx: s(3) });
        }
    }
    by
});

static OTHER_SPECIMEN: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)stool|f(a)?eces|fecal|occult\s*blood\s*stool|csf|cerebrospinal|pleural|peritoneal|ascit|synovial|sputum|semen|body\s*fluid|粪|大便|便常规|脑脊液|胸水|腹水|积液|关节液|痰|精液").unwrap()
});
static URINE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)urin|尿").unwrap());
static PAREN: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"[（(][^()（）]*[)）]").unwrap());
static PAREN_IN: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"[（(]([^()（）]+)[)）]").unwrap());

/// Ways to read a name, in order: whole, without the bracketed part, the bracketed part ("AST (SGOT)").
fn variants(name: &str) -> Vec<String> {
    let s: String = name.nfkc().collect();
    let mut out = vec![s.clone(), PAREN.replace_all(&s, " ").into_owned()];
    out.extend(PAREN_IN.captures_iter(&s).map(|c| c[1].to_string()));
    let mut seen = Vec::new();
    for v in out.iter().map(|v| fold_name(v)).filter(|v| !v.is_empty()) {
        if !seen.contains(&v) {
            seen.push(v);
        }
    }
    seen
}

/// The code a printed name maps to directly (by result kind and specimen), or None.
pub fn code_for(name: &str, panel: Option<&str>, specimen: Option<&str>, v: &Printed) -> Option<String> {
    let text = v.is_text();
    let place = format!("{name} {}", panel.unwrap_or(""));
    let urine = specimen == Some("urine") || URINE.is_match(&place);
    let other = !urine && OTHER_SPECIMEN.is_match(&place);
    let ok = |e: &Entry| {
        e.text == text
            && if other {
                e.ctx.is_none()
            } else {
                match e.ctx.as_deref() {
                    Some("urine") => urine || text,
                    Some("blood") => !urine,
                    _ => true,
                }
            }
    };
    let panel = panel.map(|p| {
        let v = variants(p);
        v.get(1).or(v.first()).cloned().unwrap_or_default()
    });
    for v in variants(name) {
        let keys = match panel.as_deref() {
            Some(p) if !p.is_empty() => vec![format!("{p}{v}"), v.clone()],
            _ => vec![v.clone()],
        };
        for key in keys {
            let es: Vec<&Entry> = CODES.get(&key).map(|es| es.iter().filter(|e| ok(e)).collect()).unwrap_or_default();
            let want = if urine { "urine" } else { "blood" };
            if let Some(e) = es.iter().find(|e| e.ctx.as_deref() == Some(want)).or(es.first()) {
                return Some(e.code.clone());
            }
        }
    }
    None
}

/* ---------- units ---------- */

/// The printed unit fits one of the measure's units (no printed unit fits anything).
pub fn unit_fits(printed: &str, units: &[String]) -> bool {
    printed.trim().is_empty() || units.iter().any(|u| same_unit(printed, u))
}

/// The unit to preselect: the printed one when it fits; with nothing printed, the only unit there is.
/// A single unit that doesn't fit the printed one stays unset: storing it unconverted could be 1000× off.
pub fn pick_unit(units: &[String], printed: &str) -> Option<String> {
    let p = printed.trim();
    if p.is_empty() {
        return if units.len() == 1 { units.first().cloned() } else { None };
    }
    // a ratio has no unit; the printed one (often a misprinted mg/dL) doesn't count
    if units.len() == 1 && units[0] == "{ratio}" {
        return Some("{ratio}".into());
    }
    units.iter().find(|u| *u == p).or_else(|| units.iter().find(|u| same_unit(p, u))).cloned()
}

/* ---------- ingest ---------- */

struct MetricInfo {
    code: String,
    unit: String,
    agg: String,
}

fn metric(c: &Db, code: &str) -> Result<Option<MetricInfo>> {
    Ok(c.query_row("SELECT code, unit, agg FROM metric WHERE code = ?", [code], |r| {
        Ok(MetricInfo { code: r.get(0)?, unit: r.get(1)?, agg: r.get(2)? })
    })
    .ok())
}

fn units_of(m: &MetricInfo) -> Vec<String> {
    allowed_units(&m.code, &m.unit)
}

/// Records a recognised report as a review batch: no rows, the items in `meta.candidates`.
/// `sha` is the original file's (its blob is stored by the caller in the same transaction).
pub fn ingest(c: &Db, sha: &str, r: &Recognized, at: i64, tz: i64, now_ms: i64) -> Result<Ingested> {
    if !crate::blob::is_sha(sha) {
        return Err(Error::invalid("bad_blob", "sha"));
    }
    if r.items.is_empty() {
        return Err(Error::invalid("empty", "no lab items were found"));
    }
    tx(c, || {
        let mut matched = 0;
        let known = |it: &OcrItem| -> Result<Option<String>> {
            let Some(code) = code_for(&it.name, it.panel.as_deref(), it.specimen.as_deref(), &it.v) else { return Ok(None) };
            let Some(m) = metric(c, &code)? else { return Ok(None) };
            let text = m.agg == "none";
            if text != it.v.is_text() {
                return Ok(None);
            }
            if !text && m.unit != "{ratio}" && !unit_fits(&it.unit, &units_of(&m)) {
                return Ok(None);
            }
            Ok(Some(m.code))
        };
        let mut items = Vec::with_capacity(r.items.len());
        for ri in &r.items {
            let mut it = ri.item.clone();
            let alias = review::lookup_alias(c, &it.name, &it.unit, it.panel.as_deref())?;
            if alias.is_some() {
                matched += 1;
            }
            let pre = match &ri.pre {
                Some(p) if metric(c, p)?.is_some() => Some(p.clone()),
                _ => None,
            };
            it.code = match alias.or(pre) {
                Some(code) => Some(code),
                None => known(&it)?,
            };
            items.push(it);
        }
        let n = items.len();
        let cand = OcrCandidates {
            kind: "ocr".into(),
            at,
            dated: Some(r.date.is_some()),
            tz,
            items,
            text: r.text.chars().take(100_000).collect(),
        };
        let src = SourceSpec::new("ocr", "photo");
        let (import_id, _) = begin(
            c,
            Begin { source: &src, parser: OCR_PARSER, blob: Some(sha), uid: None, candidates: Some(serde_json::to_value(&cand)?) },
            now_ms,
        )?;
        Ok(Ingested { import_id, items: n, matched })
    })
}

/* ---------- measures made from a report (x:ocr/…) ---------- */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct NewMetric {
    pub code: String,
    pub name: String,
    pub unit: String,
    pub agg: String,
}

fn slug(s: &str) -> String {
    let s = s.replace(['µ', 'μ'], "u").replace('%', "pct").replace('‰', "permille");
    let s: String = s.nfkc().collect::<String>().to_lowercase();
    let mut out = String::new();
    let mut dash = false;
    for ch in s.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ('\u{3400}'..='\u{9fff}').contains(&ch) {
            out.push(ch);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    out.trim_matches('-').chars().take(60).collect()
}

/// The measure "create new" makes for an item: numbers are instant with the printed unit, text has none.
pub fn new_metric_of(name: &str, unit: &str, v: &Printed) -> NewMetric {
    let text = v.is_text();
    let unit: String = if text {
        String::new()
    } else {
        unit.nfkc().collect::<String>().chars().filter(|c| !js_space(*c)).collect::<String>().replace('μ', "µ").chars().take(24).collect()
    };
    let us = if unit.is_empty() { String::new() } else { slug(&unit) };
    let suffix = if us.is_empty() { String::new() } else { format!(".{us}") };
    let base = slug(name);
    NewMetric {
        code: format!("x:ocr/{}{suffix}", if base.is_empty() { "item" } else { &base }),
        name: name.nfkc().collect::<String>().trim().chars().take(80).collect(),
        unit,
        agg: if text { "none" } else { "instant" }.into(),
    }
}

static NEW_CODE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^x:ocr/[a-z0-9\x{3400}-\x{9fff}-]{1,60}(\.[a-z0-9\x{3400}-\x{9fff}-]{1,60})?$").unwrap());

/// Creates the measures that don't exist yet; returns how many were new.
fn create_metrics(c: &Db, list: &[NewMetric]) -> Result<usize> {
    let mut n = 0;
    for m in list {
        if !NEW_CODE.is_match(&m.code)
            || m.name.is_empty()
            || m.name.chars().count() > 80
            || m.unit.chars().count() > 24
            || !["instant", "none"].contains(&m.agg.as_str())
        {
            return Err(Error::invalid("bad_metric", &m.code));
        }
        if one::<i64>(c, "SELECT 1 FROM metric WHERE code = ?", [&m.code])?.is_some() {
            continue;
        }
        c.execute("INSERT INTO metric (code, name, unit, agg) VALUES (?, ?, ?, ?)", rusqlite::params![m.code, m.name, m.unit, m.agg])?;
        n += 1;
    }
    Ok(n)
}

/* ---------- confirm ---------- */

/// The person's decision for one item, in item order.
#[derive(Debug, Clone, Default, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    /// Leave this item out
    #[serde(default)]
    pub skip: bool,
    /// The measure it is (a catalog code or an existing x:ocr/ one)
    #[serde(default)]
    pub code: Option<String>,
    /// Make a new measure from the printed name and unit
    #[serde(default)]
    pub new: bool,
    /// The unit the printed value is in (one of the measure's units); omitted: the printed unit when it fits
    #[serde(default)]
    pub unit: Option<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct OcrConfirmed {
    #[serde(flatten)]
    pub confirmed: Confirmed,
    /// Items saved
    pub saved: usize,
    /// Items not saved because they weren't complete (no measure, or no fitting unit)
    pub left: usize,
    /// New measures created
    pub created: usize,
}

/// The candidates of an OCR review batch.
pub fn candidates(c: &Db, import_id: i64) -> Result<OcrCandidates> {
    let meta: Option<String> =
        one::<Option<String>>(c, "SELECT meta FROM import WHERE id = ? AND status = 'review'", [import_id])?.flatten();
    let cand = crate::write::parse_meta(meta).remove("candidates");
    match cand {
        Some(v) if v.get("kind").and_then(Json::as_str) == Some("ocr") => Ok(serde_json::from_value(v)?),
        _ => Err(Error::not_found("no_ocr_review", import_id.to_string())),
    }
}

enum Target {
    Existing(MetricInfo, Option<String>),
    New(NewMetric),
}

/// Confirms an OCR batch: the choices become rows at `at` (the test date), new measures are made, and
/// the name → measure pairs are learnt as aliases. Incomplete items are left out (the person's rule,
/// 2026-11-18); two items aimed at one measure are refused (the later would overwrite the earlier).
pub fn confirm(c: &Db, import_id: i64, choices: &[Choice], at: i64, tz: i64, now_ms: i64) -> Result<OcrConfirmed> {
    tx(c, || {
        let cand = candidates(c, import_id)?;
        if choices.len() != cand.items.len() {
            return Err(Error::invalid("bad_request", format!("{} choices for {} items", choices.len(), cand.items.len())));
        }
        let mut targets: Vec<Option<Target>> = Vec::new();
        let mut left = 0;
        for (it, ch) in cand.items.iter().zip(choices) {
            let t = if ch.skip {
                None
            } else if ch.new {
                Some(Target::New(new_metric_of(&it.name, &it.unit, &it.v)))
            } else if let Some(code) = &ch.code {
                let m = metric(c, code)?.ok_or_else(|| Error::not_found("no_metric", code))?;
                let numeric = m.agg != "none" && m.agg != "interval";
                let all = units_of(&m);
                let units: Vec<String> = all.iter().filter(|u| !u.is_empty()).cloned().collect();
                // no unit chosen: the one the form would preselect (the printed one when it fits)
                let unit = ch.unit.clone().or_else(|| pick_unit(&all, &it.unit)).filter(|u| !u.is_empty());
                let ready = if numeric {
                    !it.v.is_text() && (units.is_empty() || unit.as_ref().is_some_and(|u| units.contains(u)))
                } else {
                    m.agg == "none" && it.v.is_text()
                };
                if ready { Some(Target::Existing(m, if numeric && !units.is_empty() { unit } else { None })) } else { None }
            } else {
                None
            };
            if t.is_none() && !ch.skip {
                left += 1;
            }
            targets.push(t);
        }
        // two items aimed at one measure: the same day and source hold one value
        let code_of = |t: &Target| match t {
            Target::Existing(m, _) => m.code.clone(),
            Target::New(n) => n.code.clone(),
        };
        let mut by: HashMap<String, Vec<&str>> = HashMap::new();
        for (it, t) in cand.items.iter().zip(&targets) {
            if let Some(t) = t {
                by.entry(code_of(t)).or_default().push(&it.name);
            }
        }
        let dups: Vec<&str> = by.values().filter(|v| v.len() > 1).flatten().copied().collect();
        if !dups.is_empty() {
            return Err(Error::conflict("duplicate_target", dups.join(", ")));
        }
        let saved = targets.iter().filter(|t| t.is_some()).count();
        if saved == 0 {
            return Err(Error::invalid("nothing_to_save", "choose a measure for at least one item"));
        }
        let fresh: Vec<NewMetric> =
            targets.iter().filter_map(|t| if let Some(Target::New(n)) = t { Some(n.clone()) } else { None }).collect();
        let created = create_metrics(c, &fresh)?;
        // another report of the same day already holds this measure (all reports share the photo source and
        // local noon): writing would silently replace it, so refuse and name the measures (web noOverwrite)
        let source: Option<i64> = one(c, "SELECT source_id FROM import WHERE id = ?", [import_id])?;
        let mut clash: Vec<String> = Vec::new();
        for t in targets.iter().flatten() {
            let code = code_of(t);
            let taken: Option<i64> = one(
                c,
                "SELECT 1 FROM observation o JOIN metric m ON m.id = o.metric_id WHERE m.code = ? AND o.start_ms = ? AND o.source_id = ? AND o.import_id <> ?",
                rusqlite::params![code, at, source.unwrap_or(-1), import_id],
            )?;
            if taken.is_some() && !clash.contains(&code) {
                clash.push(code);
            }
        }
        if !clash.is_empty() {
            return Err(Error::conflict("same_day_report", clash.join(", ")));
        }
        let mut rows = Vec::new();
        let mut aliases = Vec::new();
        for (it, t) in cand.items.iter().zip(&targets) {
            let Some(t) = t else { continue };
            let (code, unit) = match t {
                Target::Existing(m, u) => (m.code.clone(), u.clone()),
                // an existing x:ocr/ measure keeps its spelling of the unit (mg/dl vs mg/dL)
                Target::New(n) => {
                    let have: Option<String> = one(c, "SELECT unit FROM metric WHERE code = ?", [&n.code])?;
                    let unit = match have {
                        Some(h) if !n.unit.is_empty() && same_unit(&h, &n.unit) => h,
                        _ => n.unit.clone(),
                    };
                    (n.code.clone(), (!unit.is_empty()).then_some(unit))
                }
            };
            let mut printed = json!({ "name": it.name, "text": it.text });
            if let Some(p) = &it.panel {
                printed["panel"] = json!(p);
            }
            if !it.unit.is_empty() {
                printed["unit"] = json!(it.unit);
            }
            if let Some(x) = &it.cmp {
                printed["cmp"] = json!(x);
            }
            if let Some(x) = &it.reference {
                printed["ref"] = json!(x);
            }
            if let Some(x) = &it.flag {
                printed["flag"] = json!(x);
            }
            let mut detail = json!({ "printed": printed });
            if let Some(x) = &it.cmp {
                detail["comparator"] = json!(x);
            }
            rows.push(ObsRow {
                metric: code.clone(),
                start_ms: at,
                end_ms: None,
                tz_min: tz,
                value: match &it.v {
                    Printed::Num(x) => Value::number(*x),
                    Printed::Text(s) => Value::Text(s.clone()),
                },
                unit,
                detail: Some(detail),
            });
            aliases.push(Alias { name: it.name.clone(), unit: it.unit.clone(), panel: it.panel.clone(), code });
        }
        let confirmed = review::confirm(c, import_id, &rows, Some(&cand.text), &aliases, now_ms)?;
        Ok(OcrConfirmed { confirmed, saved, left, created })
    })
}
