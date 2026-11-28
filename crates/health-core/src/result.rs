//! A received result file stored (protocol 2.3 steps 4–5; W `lib/health/db/ingest.ts`). Its signature and
//! decryption are checked before (health-proto). A known `id` (tombstones included) is `seen`; an unknown code or
//! unit, or a line `write` would refuse, puts the whole result in review (`kind: "result"`, no rows) so nothing is
//! silently lost; otherwise it is one import whose uid is the result's id.

use crate::db::{Db, one, tx};
use crate::error::{Error, Result};
use crate::units::allowed_units;
use crate::value::Value;
use crate::write::{Begin, ObsRow, SourceSpec, begin, check_row, finish, metric_by_code, parse_meta, write};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};

pub const PARSER: &str = "result@1";

/// One line of a result file (`obs[]`).
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, PartialEq)]
pub struct Line {
    pub code: String,
    /// A number, a text, or null
    pub v: Json,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub u: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s: Option<String>,
}

/// A result waiting for review (`import.meta.candidates`).
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Candidates {
    pub kind: String,
    pub src: String,
    pub at: i64,
    pub tz: i64,
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone, Copy, Serialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Saved,
    Seen,
    Review,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Ingested {
    pub outcome: Outcome,
    pub written: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub import_id: Option<i64>,
}

fn bad(m: &str) -> Error {
    Error::invalid("bad_result", m)
}

fn value_of(v: &Json) -> Value {
    match v {
        Json::Number(n) => n.as_f64().map_or(Value::Null, Value::number),
        Json::String(s) => Value::Text(s.clone()),
        _ => Value::Null,
    }
}

fn row_of(l: &Line, at: i64, tz: i64, detail: Option<Json>) -> ObsRow {
    ObsRow {
        metric: l.code.clone(),
        start_ms: l.t.unwrap_or(at),
        end_ms: l.end,
        tz_min: tz,
        value: value_of(&l.v),
        unit: l.u.clone().filter(|u| !u.is_empty()),
        detail,
    }
}

const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// `doc` has passed `health_proto::result::check`.
pub fn ingest(c: &Db, doc: &Map<String, Json>, now_ms: i64) -> Result<Ingested> {
    // the id becomes the import's uid: refused here if it couldn't sync (merge-fixes P5)
    let id = doc.get("id").and_then(Json::as_str).filter(|i| crate::write::plain_uid(i)).ok_or_else(|| bad("id"))?;
    // a UUIDv7 id from the future would outrank every later import (larger uid wins), as a merge refuses it
    if crate::batches::uuid_time(id).is_some_and(|t| t > now_ms + crate::merge::MAX_SKEW_MS) {
        return Err(bad("id from the future"));
    }
    let src = doc.get("src").and_then(Json::as_str).ok_or_else(|| bad("src"))?;
    let (kind, device) = src.split_once(':').ok_or_else(|| bad("src"))?;
    let device_ok = (1..=64).contains(&device.len()) && device.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !matches!(kind, "lab" | "staff" | "room") || !device_ok {
        return Err(bad("src"));
    }
    let at = doc.get("at").and_then(int).filter(|a| (0..=MAX_SAFE).contains(a)).ok_or_else(|| bad("at"))?;
    // tz absent is 0 (the protocol doesn't require it); present, an integer within ±840
    let tz = match doc.get("tz") {
        None => 0,
        Some(t) => int(t).filter(|t| t.abs() <= 840).ok_or_else(|| bad("tz"))?,
    };
    let obs = doc.get("obs").and_then(Json::as_array).ok_or_else(|| bad("obs"))?;
    // each line as the web reads it (typeof checks): a field of the wrong type is absent, so a line Health
    // can't read still reaches review in a shape it can be confirmed from
    let well_formed = obs.iter().all(|o| o.get("code").is_some_and(Json::is_string));
    let lines: Vec<Line> = obs.iter().map(normalise).collect();

    tx(c, || {
        if one::<i64>(c, "SELECT 1 FROM import WHERE uid = ?", [id])?.is_some() {
            return Ok(Ingested { outcome: Outcome::Seen, written: 0, import_id: None });
        }
        let source = SourceSpec::new(kind, device);
        let mut meta = json!({ "src": src, "at": at });
        // who entered a manual result: the staff account the backend vouched for (its attestation)
        if kind == "staff"
            && let Some(staff) = doc.get("sig").and_then(|s| s.get("att")).and_then(Json::as_str).and_then(att_staff)
        {
            meta["by"] = json!(staff);
        }
        // any line that isn't a well-formed line, names an unknown measure or unit, or would be refused
        let needs_review = !well_formed
            || lines.iter().any(|l| -> bool {
                let Ok(Some(m)) = metric_by_code(c, &l.code) else { return true };
                let numeric = m.agg != "none" && m.agg != "interval";
                if numeric {
                    let units = allowed_units(&m.code, &m.unit);
                    // several units and none printed: never assume the canonical one (glucose 5.5 could be mmol/L)
                    match l.u.as_deref().filter(|u| !u.is_empty()) {
                        None if units.len() > 1 => return true,
                        Some(u) if !units.iter().any(|x| x == u) => return true,
                        _ => {}
                    }
                }
                check_row(&m, &row_of(l, at, tz, None)).is_err()
            });
        if needs_review {
            let cand = json!({ "kind": "result", "src": src, "at": at, "tz": tz, "lines": lines });
            let (import_id, _) =
                begin(c, Begin { source: &source, parser: PARSER, blob: None, uid: Some(id.to_string()), candidates: Some(cand) }, now_ms)?;
            merge_meta(c, import_id, &meta)?;
            return Ok(Ingested { outcome: Outcome::Review, written: 0, import_id: Some(import_id) });
        }
        let (import_id, _) =
            begin(c, Begin { source: &source, parser: PARSER, blob: None, uid: Some(id.to_string()), candidates: None }, now_ms)?;
        merge_meta(c, import_id, &meta)?;
        let rows: Vec<ObsRow> = lines.iter().map(|l| row_of(l, at, tz, l.s.as_ref().map(|s| json!({ "s": s })))).collect();
        let res = write(c, import_id, &rows)?;
        finish(c, import_id, now_ms)?;
        Ok(Ingested { outcome: Outcome::Saved, written: res.written, import_id: Some(import_id) })
    })
}

/// A JSON number that is a whole number (480 and 480.0 alike, as JS sees them).
fn int(v: &Json) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().filter(|f| f.fract() == 0.0 && f.abs() <= MAX_SAFE as f64).map(|f| f as i64))
}

fn normalise(o: &Json) -> Line {
    let str_of = |k: &str| o.get(k).and_then(Json::as_str).map(String::from);
    let int_of = |k: &str| o.get(k).and_then(int);
    Line {
        code: str_of("code").unwrap_or_default(),
        v: match o.get("v") {
            Some(v @ (Json::Number(_) | Json::String(_))) => v.clone(),
            _ => Json::Null,
        },
        u: str_of("u"),
        t: int_of("t"),
        end: int_of("end"),
        s: str_of("s"),
    }
}

/// The `staff` of an attestation's payload (checked before ingest: health-proto `verify_att`).
fn att_staff(att: &str) -> Option<String> {
    let p = att.split('.').nth(1)?;
    let p = p.replace('-', "+").replace('_', "/");
    let bytes = b64_std(&p)?;
    let v: Json = serde_json::from_slice(&bytes).ok()?;
    v.get("staff").and_then(Json::as_str).map(String::from)
}

fn b64_std(s: &str) -> Option<Vec<u8>> {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let (mut acc, mut bits, mut out) = (0u32, 0u32, Vec::new());
    for c in s.trim_end_matches('=').bytes() {
        acc = acc << 6 | A.iter().position(|&a| a == c)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
        acc &= (1 << bits) - 1;
    }
    Some(out)
}

/// `meta` keys added to what `begin` wrote (its candidates stay).
fn merge_meta(c: &Db, import_id: i64, add: &Json) -> Result<()> {
    let keep: Option<String> = c.query_row("SELECT meta FROM import WHERE id = ?", [import_id], |r| r.get(0))?;
    let mut m = Map::new();
    if let Json::Object(a) = add {
        m.extend(a.clone());
    }
    m.extend(parse_meta(keep));
    c.execute("UPDATE import SET meta = ? WHERE id = ?", rusqlite::params![Json::Object(m).to_string(), import_id])?;
    Ok(())
}

/// One line's choice when a result waiting for review is confirmed (W `review-form.ts`).
#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LineChoice {
    #[serde(default)]
    pub skip: bool,
    /// The measure (catalog code) this line is
    #[serde(default)]
    pub code: Option<String>,
    /// The unit the value is in (numeric measures with units)
    #[serde(default)]
    pub unit: Option<String>,
}

/// Confirms a result waiting for review: each line a measure and unit, or skipped. Every line must be settled,
/// no two lines may land on the same measure at the same time, and at least one line is kept.
pub fn confirm(c: &Db, import_id: i64, choices: &[LineChoice], now_ms: i64) -> Result<crate::review::Confirmed> {
    let meta: Option<String> = c
        .query_row("SELECT meta FROM import WHERE id = ? AND status = 'review'", [import_id], |r| r.get(0))
        .map_err(|_| Error::not_found("no_import", import_id.to_string()))?;
    let meta = parse_meta(meta);
    let cand: Candidates = meta
        .get("candidates")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .filter(|c: &Candidates| c.kind == "result")
        .ok_or_else(|| Error::invalid("not_a_result", "this batch isn't a received result"))?;
    if choices.len() != cand.lines.len() {
        return Err(Error::invalid("bad_request", "one choice per line"));
    }
    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (l, ch) in cand.lines.iter().zip(choices) {
        if ch.skip {
            continue;
        }
        let code = ch.code.as_deref().ok_or_else(|| Error::invalid("line_open", l.code.clone()))?;
        let m = metric_by_code(c, code)?.ok_or_else(|| Error::not_found("no_metric", code))?;
        let numeric = m.agg != "none" && m.agg != "interval";
        let units = allowed_units(&m.code, &m.unit);
        // a unit is asked for only where the measure has one (a count like wheelchair use has none, and the choice
        // can't name it: it was refused as unit_required, so the line could only be skipped)
        let unit = if numeric && units.iter().any(|u| !u.is_empty()) {
            let u = ch.unit.clone().filter(|u| units.contains(u)).ok_or_else(|| Error::invalid("unit_required", l.code.clone()))?;
            Some(u)
        } else {
            None
        };
        let mut printed = json!({ "code": l.code });
        if let Some(u) = l.u.as_deref().filter(|u| !u.is_empty()) {
            printed["unit"] = json!(u);
        }
        let mut detail = json!({ "printed": printed });
        if let Some(s) = &l.s {
            detail["s"] = json!(s);
        }
        let row = ObsRow { unit, detail: Some(detail), ..row_of(l, cand.at, cand.tz, None) };
        let row = ObsRow { metric: m.code.clone(), ..row };
        check_row(&m, &row).map_err(|_| Error::invalid("rejected", l.code.clone()))?;
        if !seen.insert((m.code.clone(), row.start_ms)) {
            return Err(Error::invalid("duplicate_target", m.code.clone()));
        }
        rows.push(row);
    }
    if rows.is_empty() {
        return Err(Error::invalid("nothing_to_save", "skip fewer lines, or discard the result"));
    }
    crate::review::confirm(c, import_id, &rows, None, &[], now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::MemoryStore;
    use crate::profile::Profile;

    const NOW: i64 = 1_795_176_000_000;

    fn doc(id: &str) -> Map<String, Json> {
        json!({ "id": id, "src": "lab:dev-1", "at": NOW - 60_000, "obs": [] }).as_object().unwrap().clone()
    }
    fn v7_at(ms: i64) -> String {
        uuid::Uuid::from_u128(((ms as u128) << 80) | (7 << 76) | (2 << 62)).hyphenated().to_string()
    }

    /// A UUIDv7 id more than a day ahead is refused, as a merge refuses its uid; a day ahead and other ids are taken
    #[test]
    fn ids_from_the_future_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let p = Profile::init(dir.path(), "a", &MemoryStore::default()).unwrap();
        let ahead = ingest(&p.db, &doc(&v7_at(NOW + crate::merge::MAX_SKEW_MS + 1)), NOW).map(|_| ()).unwrap_err();
        assert!(ahead.to_string().contains("bad_result"), "{ahead}");
        ingest(&p.db, &doc(&v7_at(NOW + crate::merge::MAX_SKEW_MS)), NOW).unwrap();
        ingest(&p.db, &doc("res-42"), NOW).unwrap();
    }
}
