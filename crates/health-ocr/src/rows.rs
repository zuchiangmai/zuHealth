//! Reading recognised lines as a table (web `ocr/rows.ts`, rule for rule): name, value, comparator, unit,
//! reference range, high/low flag and panel of each item. With a header row, cells go by column position
//! (any column order; a header repeated side by side splits into two blocks); without one, by content.
//! A slanted page is straightened first (coordinates only). Only what is printed is read here: matching a
//! measure is `matcher`, and nothing is converted.
//!
//! Regex notes for the port: JS `\d` and `\b` are ASCII, so they are written `[0-9]` and with explicit
//! neighbour checks; lookaround needs `fancy_regex`.

use crate::types::{Bx, Line};
use health_core::ocr::{OcrItem, Printed};
use health_core::units::js_space;
use regex::Regex;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Name,
    Result,
    Ref,
    Unit,
    Other,
}

#[derive(Debug, Clone)]
struct Col {
    kind: Kind,
    left: f64,
    mid: f64,
    half: f64,
}

pub struct Table {
    pub items: Vec<OcrItem>,
    /// Was a header row found (otherwise the columns were guessed from content)?
    pub header: bool,
}

fn nfkc(s: &str) -> String {
    s.nfkc().collect()
}
fn fold(s: &str) -> String {
    nfkc(s).to_lowercase().chars().filter(|c| !js_space(*c)).collect()
}
fn re(p: &str) -> Regex {
    Regex::new(p).unwrap()
}
fn fre(p: &str) -> fancy_regex::Regex {
    fancy_regex::Regex::new(p).unwrap()
}
/// JS `\s+` → one replacement
fn squeeze(s: &str, with: &str) -> String {
    let mut out = String::new();
    let mut in_space = false;
    for c in s.chars() {
        if js_space(c) {
            if !in_space {
                out.push_str(with);
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}
fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

static HEADERS: LazyLock<Vec<(Kind, Regex)>> = LazyLock::new(|| {
    vec![
        (
            Kind::Name,
            re(
                r"^(testname|test|tests|labtest|labtests|testdescription|description|investigation|investigations|parameter|parameters|examination|name|item|items|analyte|项目|检验项目|检查项目|项目名称|检测项目|名称|中文名称|檢驗項目|檢查項目|項目|項目名稱)$",
            ),
        ),
        (Kind::Result, re(r"^(result|results|value|values|resultvalue|observedvalue|结果|检验结果|检测结果|测定值|结果值|結果|檢驗結果)$")),
        (
            Kind::Ref,
            re(
                r"^(biologicalreference|biologicalreferenceinterval|referenceinterval|referenceintervals|referencerange|referenceranges|referencevalue|referencevalues|ref\.?range|normalrange|normalvalue|normalvalues|reference|ref|参考范围|参考值|参考区间|正常值|正常范围|参考|參考範圍|參考值|參考區間)$",
            ),
        ),
        (Kind::Unit, re(r"^(unit|units|单位|單位)$")),
        (
            Kind::Other,
            re(r"^(specimen|sample|method|testmethod|methodology|remarks?|flag|备注|标本|样本|方法|检测方法|提示|状态|英文缩写|缩写)$"),
        ),
    ]
});

fn kind_of(text: &str) -> Option<Kind> {
    let f = fold(text);
    HEADERS.iter().find(|(_, r)| r.is_match(&f)).map(|(k, _)| *k).or(if f == "interval" { Some(Kind::Ref) } else { None })
}

/* ---------- slant ---------- */

fn cy(b: &Bx) -> f64 {
    b.y + b.h / 2.0
}
fn cx(b: &Bx) -> f64 {
    b.x + b.w / 2.0
}

/// Page slant (radians): the angle within ±6° at which cells of one row line up best. Under 6 boxes: 0.
pub fn skew_of(lines: &[Line]) -> f64 {
    if lines.len() < 6 {
        return 0.0;
    }
    let pts: Vec<(f64, f64, f64)> = lines.iter().map(|l| (cx(&l.bx), cy(&l.bx), l.bx.h.clamp(4.0, 80.0).max(4.0))).collect();
    let score = |a: f64| {
        let t = a.tan();
        let mut ys: Vec<(f64, f64)> = pts.iter().map(|p| (p.1 - p.0 * t, p.2)).collect();
        ys.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap());
        let mut s = 0.0;
        for i in 0..ys.len() {
            for j in i + 1..ys.len() {
                let d = ys[j].0 - ys[i].0;
                let tol = ys[i].1.min(ys[j].1) * 0.25;
                if d > tol {
                    break;
                }
                s += 1.0 - d / if tol == 0.0 { 1.0 } else { tol };
            }
        }
        s
    };
    let mut best = 0.0f64;
    let mut best_score = score(0.0);
    let step = std::f64::consts::PI / 720.0;
    for k in -24i32..=24 {
        if k == 0 {
            continue;
        }
        let a = k as f64 * step;
        let s = score(a);
        if s > best_score * 1.05 || (s > best_score && a.abs() < best.abs()) {
            best = a;
            best_score = s;
        }
    }
    best
}

/// Straightens the boxes by `a`: centres turn about the origin, height loses the slanted extra.
pub fn deskew(lines: &[Line], a: f64) -> Vec<Line> {
    if a == 0.0 {
        return lines.to_vec();
    }
    let (c, s) = (a.cos(), a.sin());
    lines
        .iter()
        .map(|l| {
            let (x, y) = (cx(&l.bx), cy(&l.bx));
            let nx = x * c + y * s;
            let ny = -x * s + y * c;
            let h = (l.bx.h * 0.4).max(l.bx.h - l.bx.w * s.abs());
            Line { bx: Bx { x: nx - l.bx.w / 2.0, y: ny - h / 2.0, w: l.bx.w, h }, ..l.clone() }
        })
        .collect()
}

/* ---------- rows ---------- */

fn overlap(a: &Bx, y: f64, h: f64) -> f64 {
    let top = a.y.max(y);
    let bottom = (a.y + a.h).min(y + h);
    (bottom - top).max(0.0) / a.h.min(h)
}

pub struct Row {
    pub y: f64,
    pub h: f64,
    pub cells: Vec<Line>,
}

/// Cells overlapping a row by more than half belong to it; cells left to right.
pub fn group_rows(lines: &[Line]) -> Vec<Row> {
    let mut sorted = lines.to_vec();
    sorted.sort_by(|a, b| cy(&a.bx).partial_cmp(&cy(&b.bx)).unwrap());
    let mut rows: Vec<Row> = Vec::new();
    for l in sorted {
        if let Some(row) = rows.iter_mut().find(|r| overlap(&l.bx, r.y, r.h) > 0.5) {
            let top = row.y.min(l.bx.y);
            row.h = (row.y + row.h).max(l.bx.y + l.bx.h) - top;
            row.y = top;
            row.cells.push(l);
        } else {
            rows.push(Row { y: l.bx.y, h: l.bx.h, cells: vec![l] });
        }
    }
    for r in &mut rows {
        r.cells.sort_by(|a, b| a.bx.x.partial_cmp(&b.bx.x).unwrap());
    }
    rows.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap());
    rows
}

/* ---------- cell text ---------- */

static DIGIT_ONLY: LazyLock<Regex> = LazyLock::new(|| re(r"^[0-9Oo.,\-–—~<>≤≥↑↓HL%*\s]+$"));
/// OCR reads 0 as O in numbers
fn digits(s: &str) -> String {
    if s.chars().any(|c| c.is_ascii_digit()) && DIGIT_ONLY.is_match(s) { s.replace(['O', 'o'], "0") } else { s.to_string() }
}

static THOUSANDS: LazyLock<Regex> = LazyLock::new(|| re(r"[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?"));
fn word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}
/// Thousands separators ("4,260", "1,234.5"); JS `\b…\b` with ASCII word characters
fn thousands(s: &str) -> String {
    let mut out = String::new();
    let mut last = 0;
    let mut pos = 0;
    while let Some(m) = THOUSANDS.find_at(s, pos) {
        let before = s[..m.start()].chars().next_back();
        // the match must start at a word boundary (JS \b): the previous char is not a word char
        if word(before) {
            pos = m.start() + s[m.start()..].chars().next().unwrap().len_utf8();
            continue;
        }
        // and end at one; the regex is greedy, so back off to a shorter match that ends on a boundary
        let mut end = m.end();
        let mut ok = !word(s[end..].chars().next());
        if !ok {
            // try shorter forms: drop the decimal part, then whole ",ddd" groups
            let text = m.as_str();
            let mut cands: Vec<usize> = Vec::new();
            if let Some(dot) = text.find('.') {
                for k in (dot + 2..text.len()).rev() {
                    cands.push(m.start() + k);
                }
            }
            let mut idx: Vec<usize> = text.match_indices(',').map(|(i, _)| i).collect();
            idx.reverse();
            for i in idx {
                if i > 0 {
                    cands.push(m.start() + i + 4);
                }
            }
            for e in cands {
                if e <= m.end()
                    && e > m.start()
                    && THOUSANDS.find_at(&s[..e], m.start()).is_some_and(|mm| mm.start() == m.start() && mm.end() == e)
                    && !word(s[e..].chars().next())
                {
                    end = e;
                    ok = true;
                    break;
                }
            }
        }
        if ok {
            out.push_str(&s[last..m.start()]);
            out.push_str(&s[m.start()..end].replace(',', ""));
            last = end;
            pos = end;
        } else {
            pos = m.start() + 1;
        }
        if pos >= s.len() {
            break;
        }
    }
    out.push_str(&s[last..]);
    out
}

fn flag_of(s: &str) -> Option<&'static str> {
    match s {
        "H" | "h" | "↑" | "高" => Some("H"),
        "L" | "l" | "↓" | "低" => Some("L"),
        _ => None,
    }
}

static QUAL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)^(阴性|阳性|弱阳性|正常|异常|未检出|检出|痕量|neg(ative)?|pos(itive)?|normal|abnormal|trace|nil|none|absent|present|reactive|non-?reactive|borderline|equivocal|indeterminate|detected|not ?detected|few|rare|occasional|moderate|many|numerous|clear|hazy|cloudy|turbid|slightly ?turbid|yellow|pale ?yellow|light ?yellow|dark ?yellow|straw|amber|colou?rless|orange|red|brown|[1-4]\+|[+\-±]{1,4})$",
    )
});
static SHORT_TEXT: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z一-鿿][A-Za-z一-鿿 +\-/]{0,23}$"));
static RANGE_RESULT: LazyLock<Regex> = LazyLock::new(|| re(r"^([0-9]+(?:\.[0-9]+)?)\s*[-–—~]\s*([0-9]+(?:\.[0-9]+)?)$"));
static NUM: LazyLock<Regex> = LazyLock::new(|| re(r"^(<=|>=|<|>|≤|≥)?\s*(-?[0-9]+(?:\.[0-9]+)?)\s*([HLhl↑↓高低])?\s*\*?$"));
static TAIL_ARROW: LazyLock<Regex> = LazyLock::new(|| re(r"^((?s).*?)\s*([↑↓])?$"));
static PAREN: LazyLock<Regex> = LazyLock::new(|| re(r"^((?s).*?)\s*[（(]\s*([^()（）]*?)\s*[)）]$"));
static LETTER: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)[a-z一-鿿]"));

pub struct Parsed {
    pub v: Printed,
    pub cmp: Option<String>,
    pub flag: Option<String>,
}

pub fn parse_value(raw: &str, in_result_column: bool) -> Option<Parsed> {
    let s = thousands(&digits(js_trim(&nfkc(raw))));
    if let Some(m) = NUM.captures(&s) {
        let cmp = m.get(1).map(|c| match c.as_str() {
            "≤" => "<=".to_string(),
            "≥" => ">=".to_string(),
            o => o.to_string(),
        });
        return Some(Parsed {
            v: Printed::Num(m[2].parse().ok()?),
            cmp,
            flag: m.get(3).and_then(|f| flag_of(f.as_str())).map(String::from),
        });
    }
    if in_result_column && let Some(r) = RANGE_RESULT.captures(&s) {
        return Some(Parsed { v: Printed::Text(format!("{}-{}", &r[1], &r[2])), cmp: None, flag: None });
    }
    let q = TAIL_ARROW.captures(&s);
    let mut text = js_trim(q.as_ref().and_then(|q| q.get(1)).map(|m| m.as_str()).unwrap_or(&s)).to_string();
    if let Some(p) = PAREN.captures(&text.clone()) {
        let base = js_trim(&p[1]).to_string();
        let inner = js_trim(&p[2]).to_string();
        if base.is_empty() && QUAL.is_match(&inner) {
            text = inner;
        } else if QUAL.is_match(&base) {
            text = base;
        }
    }
    let flag = q.as_ref().and_then(|q| q.get(2)).and_then(|f| flag_of(f.as_str())).map(String::from);
    if QUAL.is_match(&text) {
        return Some(Parsed { v: Printed::Text(text), cmp: None, flag });
    }
    if in_result_column && SHORT_TEXT.is_match(&text) && LETTER.is_match(&text) {
        return Some(Parsed { v: Printed::Text(squeeze(&text, " ")), cmp: None, flag });
    }
    None
}

static REF: LazyLock<Regex> =
    LazyLock::new(|| re(r"^[(（]?\s*([<>≤≥]=?\s*)?[0-9]+(\.[0-9]+)?\s*([-–—~至]\s*[0-9]+(\.[0-9]+)?)?\s*[)）]?$"));
static REF_SIGN: LazyLock<Regex> = LazyLock::new(|| re(r"[-–—~至<>≤≥]"));
pub fn is_ref(raw: &str) -> bool {
    let s = thousands(&digits(js_trim(&nfkc(raw))));
    REF.is_match(&s) && REF_SIGN.is_match(&s)
}
pub fn ref_text(raw: &str) -> String {
    let s: String = thousands(&digits(&nfkc(raw))).chars().filter(|c| !js_space(*c)).collect();
    s.replace(['–', '—', '~', '至'], "-")
}

static UNIT: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(?:[x×*]?10\^?[0-9]+\s*/\s*)?[a-zA-Zµμ%‰°]+(?:\s*/\s*[a-zA-Zµμ0-9%.]+)*$|^[%‰]$|^[x×]?10\^?[0-9]+\s*/?$"));
pub fn unit_text(raw: &str) -> String {
    let u: String = nfkc(raw).replace('μ', "µ").chars().filter(|c| !js_space(*c)).collect();
    if !u.is_empty() && u.chars().all(|c| matches!(c, '-' | '–' | '—')) {
        return String::new();
    }
    match u.as_str() {
        "f" | "fl" | "fi" => "fL".into(),
        "9/dL" => "g/dL".into(),
        "9/L" => "g/L".into(),
        _ => u,
    }
}
fn looks_unit(raw: &str) -> bool {
    raw.encode_utf16().count() <= 16 && UNIT.is_match(js_trim(&nfkc(raw)))
}

static SKIP_PANEL: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(sample|specimen|note|remark|样本|标本|备注|注|--|—)|end of|^[-–—*\s]+$"));
static CLEAN_1: LazyLock<fancy_regex::Regex> = LazyLock::new(|| fre(r"^[\s*#·•●○◦▪]+|[0-9]+[.、)]\s*(?=[^0-9])"));
static CLEAN_2: LazyLock<fancy_regex::Regex> = LazyLock::new(|| fre(r"^[-–—]\s*(?=[A-Za-z一-鿿])"));
static CLEAN_3: LazyLock<fancy_regex::Regex> = LazyLock::new(|| fre(r"^[oO0]\s+(?=[A-Z])"));
/// Marks before a name: stars, hashes, bullets, numbering, list dashes, an "o " read as "0 "
fn clean_name(s: &str) -> String {
    let s = nfkc(s);
    let s = CLEAN_1.replace_all(&s, "").into_owned();
    let s = CLEAN_2.replace(&s, "").into_owned();
    let s = CLEAN_3.replace(&s, "").into_owned();
    js_trim(&s).to_string()
}
static NO_ANALYTE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(others?|其他|其它)$"));
static URINE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)urin|尿"));
static URINE_ONLY: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)specific\s*gravity|leukocyte\s*esterase|occult\s*blood|turbidity|urobilinogen|nitrite|ketone|epithelial|bacteria|mucous|mucus|crystal|\bcasts?\b|比重|潜血|隐血|亚硝酸盐|尿胆原|酮体|上皮细胞|管型|结晶",
    )
});
static TABLE_END: LazyLock<fancy_regex::Regex> = LazyLock::new(|| {
    fre(
        r"(?i)^(remarks?|comments?|reported\s*by|approved\s*by|authori[sz]ed\s*by|verified\s*by|checked\s*by|signature|end\s*of\s*report|报告者|报告人|审核者|审核人|检验者|檢驗者|審核者)(?![a-z])",
    )
});
static SCALE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\(?\s*[x×*]\s*10\s*\^?\s*([0-9]{1,2})\s*\)?"));
static PER: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(?:cells?)?/(u|µ)l$|^(?:cells?)?/(mm3|cumm)$"));
static SINGLE_FLAG: LazyLock<Regex> = LazyLock::new(|| re(r"^[HL↑↓]$"));

/// A scale in the name ("RBC (x10^6)") with a per-volume unit ("Cells/uL") moves into the unit.
fn scale_from_name(name: &str, unit: &str) -> (String, String) {
    let Some(m) = SCALE.captures(name) else { return (name.to_string(), unit.to_string()) };
    let per = PER.captures(unit);
    if per.is_none() && !unit.is_empty() {
        return (name.to_string(), unit.to_string());
    }
    let mm = per.as_ref().and_then(|p| p.get(2)).is_some();
    (js_trim(&name.replacen(&m[0], "", 1)).to_string(), format!("10^{}/{}", &m[1], if mm { "mm3" } else { "uL" }))
}

/* ---------- header ---------- */

struct Head {
    cols: Vec<Col>,
    bottom: f64,
    top: f64,
}

fn find_columns(lines: &[Line]) -> Option<Head> {
    let hits: Vec<(Kind, &Line)> = lines.iter().filter_map(|l| kind_of(&l.text).map(|k| (k, l))).collect();
    let mut by_y = hits.clone();
    by_y.sort_by(|a, b| a.1.bx.y.partial_cmp(&b.1.bx.y).unwrap());
    for h in &by_y {
        let mut near: Vec<(Kind, &Line)> =
            hits.iter().filter(|x| (x.1.bx.y - h.1.bx.y).abs() <= 100f64.max(h.1.bx.h * 3.0)).cloned().collect();
        let mut kinds: Vec<Kind> = Vec::new();
        for n in &near {
            if !kinds.contains(&n.0) {
                kinds.push(n.0);
            }
        }
        if kinds.len() < 3 || !near.iter().any(|n| n.0 == Kind::Result) {
            continue;
        }
        near.sort_by(|a, b| a.1.bx.x.partial_cmp(&b.1.bx.x).unwrap());
        let mut cols: Vec<Col> = Vec::new();
        for n in &near {
            if !cols.iter().any(|c| (c.left - n.1.bx.x).abs() < n.1.bx.h * 2.0) {
                cols.push(Col { kind: n.0, left: n.1.bx.x, mid: cx(&n.1.bx), half: n.1.bx.w / 2.0 });
            }
        }
        let bottom = near.iter().map(|n| n.1.bx.y + n.1.bx.h).fold(f64::NEG_INFINITY, f64::max);
        let top = near.iter().map(|n| n.1.bx.y).fold(f64::INFINITY, f64::min);
        return Some(Head { cols, bottom, top });
    }
    None
}

/// The first column kind again in one header row: split there into left and right blocks
fn split_blocks(cols: &[Col]) -> Vec<Vec<Col>> {
    let first = cols.first().map(|c| c.kind);
    let mut blocks: Vec<Vec<Col>> = vec![vec![]];
    for c in cols {
        let cur = blocks.last_mut().unwrap();
        if !cur.is_empty() && Some(c.kind) == first {
            blocks.push(vec![c.clone()]);
        } else {
            cur.push(c.clone());
        }
    }
    blocks
}

/* ---------- reading ---------- */

/// Reads the whole table from OCR lines (image coordinates).
pub fn read_table(input: &[Line]) -> Table {
    let lines = deskew(input, skew_of(input));
    let Some(head) = find_columns(&lines) else { return Table { items: read_block(&lines, None, false), header: false } };
    let title = lines.iter().any(|l| l.bx.y + l.bx.h <= head.top + 4.0 && URINE.is_match(&l.text));
    let below: Vec<Line> = lines.iter().filter(|l| cy(&l.bx) > head.bottom).cloned().collect();
    let blocks = split_blocks(&head.cols);
    if blocks.len() == 1 {
        return Table { items: read_block(&below, Some(&head.cols), title), header: true };
    }
    let starts: Vec<f64> = blocks
        .iter()
        .enumerate()
        .map(|(i, b)| {
            if i == 0 {
                f64::NEG_INFINITY
            } else {
                let last = blocks[i - 1].last().unwrap();
                (last.mid + last.half + b[0].left) / 2.0
            }
        })
        .collect();
    let mut items = Vec::new();
    for (i, b) in blocks.iter().enumerate() {
        let lo = starts[i];
        let hi = starts.get(i + 1).copied().unwrap_or(f64::INFINITY);
        let part: Vec<Line> = below.iter().filter(|l| cx(&l.bx) >= lo && cx(&l.bx) < hi).cloned().collect();
        items.extend(read_block(&part, Some(b), title));
    }
    Table { items, header: true }
}

fn push<'a>(k: Kind, l: &'a Line, cell: &mut Vec<(Kind, Vec<&'a Line>)>) {
    if let Some(e) = cell.iter_mut().find(|e| e.0 == k) {
        e.1.push(l);
    } else {
        cell.push((k, vec![l]));
    }
}

fn read_block(lines: &[Line], cols: Option<&Vec<Col>>, urine_title: bool) -> Vec<OcrItem> {
    let rows = group_rows(lines);
    let mut items: Vec<OcrItem> = Vec::new();
    let mut panel: Option<String> = None;
    let mut pending_name = String::new();

    let col_of = |l: &Line| -> Option<Kind> {
        let cols = cols?;
        let c = cx(&l.bx);
        let rel = |k: &Col| (c - k.mid).abs() / k.half.max(1.0);
        let mut best: Option<&Col> = None;
        for k in cols {
            if (c - k.mid).abs() <= k.half + l.bx.h && best.is_none_or(|b| rel(k) < rel(b)) {
                best = Some(k);
            }
        }
        if let Some(b) = best {
            return Some(b.kind);
        }
        let tol = l.bx.h * 0.8;
        let mut hit: Option<&Col> = None;
        for k in cols {
            if k.left <= l.bx.x + tol {
                hit = Some(k);
            }
        }
        Some(hit.map(|h| h.kind).unwrap_or(cols[0].kind))
    };

    for r in &rows {
        if cols.is_some() && r.cells.iter().any(|l| TABLE_END.is_match(js_trim(&nfkc(&l.text))).unwrap_or(false)) {
            break;
        }
        let mut cell: Vec<(Kind, Vec<&Line>)> = Vec::new();
        let has = |cell: &Vec<(Kind, Vec<&Line>)>, k: Kind| cell.iter().any(|e| e.0 == k && !e.1.is_empty());
        if cols.is_some() {
            for l in &r.cells {
                let mut k = col_of(l).unwrap_or(Kind::Other);
                // a lone H/L flag next to the result belongs to it
                if k != Kind::Result && SINGLE_FLAG.is_match(js_trim(&l.text)) && has(&cell, Kind::Result) {
                    k = Kind::Result;
                }
                push(k, l, &mut cell);
            }
        } else {
            // no header: guess by content
            let rest: Vec<&Line> = r.cells.iter().collect();
            let name: Vec<&Line> = rest
                .iter()
                .copied()
                .filter(|l| parse_value(&l.text, false).is_none() && !is_ref(&l.text) && !looks_unit(&l.text))
                .collect();
            let vi = rest.iter().position(|l| parse_value(&l.text, false).is_some());
            if let (Some(n0), Some(vi)) = (name.first(), vi)
                && n0.bx.x < rest[vi].bx.x
            {
                push(Kind::Name, n0, &mut cell);
            } else if name.is_empty() || vi.is_none() {
                if let Some(n0) = name.first() {
                    push(Kind::Name, n0, &mut cell);
                } else {
                    // JS: cell.name = [] (an empty slice): the name key exists but holds nothing
                    cell.push((Kind::Name, vec![]));
                }
            }
            if let Some(vi) = vi {
                push(Kind::Result, rest[vi], &mut cell);
                let after = &rest[vi + 1..];
                let ri = after.iter().position(|l| is_ref(&l.text));
                if let Some(ri) = ri {
                    push(Kind::Ref, after[ri], &mut cell);
                }
                if let Some(ui) = after.iter().enumerate().position(|(i, l)| Some(i) != ri && looks_unit(&l.text)) {
                    push(Kind::Unit, after[ui], &mut cell);
                }
            } else if !cell.iter().any(|e| e.0 == Kind::Name)
                && let Some(first) = rest.first()
            {
                push(Kind::Name, first, &mut cell);
            }
        }
        let join = |k: Kind| -> String {
            let parts: Vec<&str> = cell.iter().filter(|e| e.0 == k).flat_map(|e| e.1.iter().map(|l| l.text.as_str())).collect();
            js_trim(&parts.join(" ")).to_string()
        };
        let name_text = clean_name(&join(Kind::Name));
        let res_text = join(Kind::Result);
        let ref_raw = join(Kind::Ref);
        let unit_raw = join(Kind::Unit);
        let parsed = if res_text.is_empty() { None } else { parse_value(&res_text, cols.is_some()) };

        let Some(parsed) = parsed else {
            // no result: a panel title, a wrapped name or unit, or a note
            if res_text.is_empty() && name_text.is_empty() && !unit_raw.is_empty() && !items.is_empty() {
                let last = items.last_mut().unwrap();
                if last.unit.ends_with('/') {
                    last.unit += &unit_text(&unit_raw);
                }
                continue;
            }
            if !name_text.is_empty()
                && res_text.is_empty()
                && unit_raw.is_empty()
                && name_text.encode_utf16().count() <= 40
                && !SKIP_PANEL.is_match(&name_text)
                && LETTER.is_match(&name_text)
            {
                pending_name = name_text;
            }
            continue;
        };
        let name0 = if name_text.is_empty() { pending_name.clone() } else { name_text.clone() };
        if name0.is_empty() {
            continue;
        }
        // previous row was only a name, this one has a name and a value: the previous was a panel title
        if !pending_name.is_empty() && !name_text.is_empty() {
            panel = Some(pending_name.clone());
        }
        pending_name.clear();
        if NO_ANALYTE.is_match(&name0) {
            continue;
        }
        let (name, unit) = scale_from_name(&name0, &if unit_raw.is_empty() { String::new() } else { unit_text(&unit_raw) });
        let urine = urine_title || panel.as_deref().is_some_and(|p| URINE.is_match(p));
        let text: Vec<&str> = [Kind::Name, Kind::Result, Kind::Ref, Kind::Unit]
            .iter()
            .flat_map(|k| cell.iter().filter(move |e| e.0 == *k).flat_map(|e| e.1.iter().map(|l| l.text.as_str())))
            .collect();
        items.push(OcrItem {
            name,
            panel: panel.clone(),
            specimen: urine.then(|| "urine".to_string()),
            v: parsed.v,
            cmp: parsed.cmp,
            unit,
            reference: (!ref_raw.is_empty()).then(|| ref_text(&ref_raw)),
            flag: parsed.flag,
            text: text.join("  "),
            code: None,
            suggest: vec![],
        });
    }
    if items.iter().filter(|i| URINE_ONLY.is_match(&i.name)).count() >= 2 {
        for i in &mut items {
            i.specimen = Some("urine".into());
        }
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thousands_like_js() {
        assert_eq!(thousands("4,260"), "4260");
        assert_eq!(thousands("1,234.5 mg"), "1234.5 mg");
        assert_eq!(thousands("5,6"), "5,6");
        assert_eq!(thousands("a4,260"), "a4,260");
        assert_eq!(thousands("血4,260"), "血4260");
    }
}
