//! Review queue (DB design §3 stage 5, §4.2 aliases), ported from the web `db/review.ts`.
//! A review import holds candidates in meta and no rows, so it is invisible to every query (invariant 6).
//! Confirming renumbers it to max(id)+1 (nothing references it yet), then writes rows and full text.

use crate::db::{Db, one, tx};
use crate::error::{Error, Result};
use crate::write::{ObsRow, WriteResult, finish, parse_meta, write};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

/// Folded alias form: NFKC, lower case, no whitespace.
pub fn fold(s: &str) -> String {
    s.nfkc().collect::<String>().to_lowercase().chars().filter(|c| !crate::units::js_space(*c)).collect()
}

fn alias_key(name: &str, panel: Option<&str>) -> String {
    match panel {
        Some(p) => format!("{}/{}", fold(p), fold(name)),
        None => fold(name),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Alias {
    pub name: String,
    pub unit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel: Option<String>,
    /// metric.code
    pub code: String,
}

pub fn add_alias(c: &Db, a: &Alias) -> Result<()> {
    let id: i64 = one(c, "SELECT id FROM metric WHERE code = ?", [&a.code])?.ok_or_else(|| Error::not_found("no_metric", &a.code))?;
    c.execute(
        "INSERT OR REPLACE INTO metric_alias (alias, unit, metric_id) VALUES (?, ?, ?)",
        rusqlite::params![alias_key(&a.name, a.panel.as_deref()), fold(&a.unit), id],
    )?;
    Ok(())
}

/// Panel-prefixed alias first, then the bare name; name and unit must both match.
pub fn lookup_alias(c: &Db, name: &str, unit: &str, panel: Option<&str>) -> Result<Option<String>> {
    let mut tries = vec![fold(name)];
    if panel.is_some() {
        tries.insert(0, alias_key(name, panel));
    }
    for alias in tries {
        let hit = one(
            c,
            "SELECT m.code FROM metric_alias a JOIN metric m ON m.id = a.metric_id WHERE a.alias = ? AND a.unit = ?",
            [alias, fold(unit)],
        )?;
        if hit.is_some() {
            return Ok(hit);
        }
    }
    Ok(None)
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Confirmed {
    /// The import's new id
    pub import_id: i64,
    pub written: u64,
}

/// Confirms a review import with the rows the person settled on. Any rejected row rolls everything back
/// (the import stays in review), so nothing is silently lost.
pub fn confirm(c: &Db, import_id: i64, rows: &[ObsRow], text: Option<&str>, aliases: &[Alias], now_ms: i64) -> Result<Confirmed> {
    tx(c, || {
        let (status, meta): (String, Option<String>) = c
            .query_row("SELECT status, meta FROM import WHERE id = ?", [import_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|_| Error::not_found("no_import", import_id.to_string()))?;
        if status != "review" {
            return Err(Error::conflict("import_state", status));
        }
        let mut meta = parse_meta(meta);
        meta.remove("candidates");
        c.execute(
            "UPDATE import SET status = 'running', meta = ?, id = (SELECT max(id) + 1 FROM import) WHERE id = ?",
            rusqlite::params![serde_json::Value::Object(meta).to_string(), import_id],
        )?;
        let id: i64 = c.query_row("SELECT max(id) FROM import", [], |r| r.get(0))?;
        let WriteResult { written, rejected, .. } = write(c, id, rows)?;
        if !rejected.is_empty() {
            return Err(Error::invalid("rejected", serde_json::to_string(&rejected)?));
        }
        if let Some(t) = text.filter(|t| !t.is_empty()) {
            c.execute("INSERT INTO report_text (rowid, text) VALUES (?, ?)", rusqlite::params![id, t])?;
        }
        finish(c, id, now_ms)?;
        for a in aliases {
            add_alias(c, a)?;
        }
        Ok(Confirmed { import_id: id, written })
    })
}

/// Discards a review import: erased, the tombstone keeps the same uid from coming in again.
pub fn discard(c: &Db, import_id: i64, now_ms: i64) -> Result<Vec<String>> {
    let status: String = one(c, "SELECT status FROM import WHERE id = ?", [import_id])?
        .ok_or_else(|| Error::not_found("no_import", import_id.to_string()))?;
    if status != "review" {
        return Err(Error::conflict("import_state", status));
    }
    Ok(crate::erase::erase(c, import_id, now_ms)?.orphan_blobs)
}

const MAX_PROPOSAL_ROWS: usize = 10_000;
const MAX_PENDING: i64 = 20;

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Proposed {
    /// Review import waiting for the owner
    pub import_id: i64,
    pub rows: usize,
}

/// An agent's proposed rows: a review import (invisible until confirmed) under source (agent, `writer`).
/// Rows are checked up front so the owner is never asked to confirm something the database would refuse.
pub fn propose(c: &Db, scope: &crate::scope::Scope, writer: &str, rows: &[ObsRow], note: Option<&str>, now_ms: i64) -> Result<Proposed> {
    if rows.is_empty() || rows.len() > MAX_PROPOSAL_ROWS {
        return Err(Error::invalid("bad_request", format!("1 to {MAX_PROPOSAL_ROWS} rows")));
    }
    crate::derived::outside_window(scope, rows, now_ms)?;
    for r in rows {
        if !scope.allows(&r.metric) {
            return Err(Error::new(crate::Kind::Denied, "out_of_scope", format!("{} is not in this grant", r.metric)));
        }
        let m = crate::write::metric_by_code(c, &r.metric)?.ok_or_else(|| Error::not_found("no_metric", &r.metric))?;
        if let Err(why) = crate::write::check_row(&m, r) {
            return Err(Error::invalid("rejected", format!("{} at {}: {why:?}", r.metric, r.start_ms)));
        }
    }
    let source = crate::write::SourceSpec::new("agent", writer);
    tx(c, || {
        let pending: i64 = c.query_row(
            "SELECT count(*) FROM import i JOIN source s ON s.id = i.source_id WHERE s.connector = 'agent' AND s.external_id = ? AND i.status = 'review'",
            [writer],
            |r| r.get(0),
        )?;
        if pending >= MAX_PENDING {
            return Err(Error::conflict("too_many_pending", format!("{pending} proposals wait for review")));
        }
        let cand = serde_json::json!({ "kind": "proposal", "rows": rows, "note": note, "by": writer });
        let (import_id, _) = crate::write::begin(
            c,
            crate::write::Begin { source: &source, parser: "agent@1", blob: None, uid: None, candidates: Some(cand) },
            now_ms,
        )?;
        Ok(Proposed { import_id, rows: rows.len() })
    })
}

/// The rows a proposal carries (for confirming it as proposed).
pub fn proposal_rows(c: &Db, import_id: i64) -> Result<Option<Vec<ObsRow>>> {
    let meta: Option<String> =
        one::<Option<String>>(c, "SELECT meta FROM import WHERE id = ? AND status = 'review'", [import_id])?.flatten();
    let cand = parse_meta(meta).remove("candidates");
    Ok(match cand {
        Some(v) if v.get("kind").and_then(|k| k.as_str()) == Some("proposal") => Some(serde_json::from_value(v["rows"].clone())?),
        _ => None,
    })
}
