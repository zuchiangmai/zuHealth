//! Import batches as the person sees them (where data came from, and taking it back), ported from the web `db/batches.ts`.
//! A row belongs to the newest import that delivered it, so counts are of what a batch holds now.

use crate::db::{Db, one};
use crate::error::{Error, Result};
use crate::query::Point;
use crate::write::{parse_meta, span_of};
use serde::Serialize;
use serde_json::Value as Json;

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Batch {
    pub import_id: i64,
    pub uid: String,
    /// When it came in (ms), from the UUIDv7
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    pub source_id: i64,
    pub connector: String,
    pub parser: String,
    /// done | review
    pub status: String,
    /// Kinds of measure it wrote
    pub metrics: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<i64>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct BatchDetail {
    #[serde(flatten)]
    pub batch: Batch,
    /// Rows it holds now
    pub rows: u64,
    /// Newest rows it holds, at most `limit`
    pub items: Vec<Point>,
    pub has_text: bool,
    /// Review candidates (status = review only)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Json>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejected: Option<Json>,
}

/// Time inside a UUIDv7, else None.
pub fn uuid_time(uid: &str) -> Option<i64> {
    let u = uuid::Uuid::parse_str(uid).ok()?;
    (u.get_version_num() == 7).then(|| (u.as_u128() >> 80) as i64)
}

fn batch(r: &rusqlite::Row) -> rusqlite::Result<(Batch, Option<String>)> {
    let uid: String = r.get(1)?;
    let meta: Option<String> = r.get(6)?;
    let span = span_of(&parse_meta(meta.clone()));
    Ok((
        Batch {
            import_id: r.get(0)?,
            // the time in its UUIDv7, else the earliest time it holds (W whenOf)
            at: uuid_time(&uid).or_else(|| span.values().map(|s| s.0).min()),
            uid,
            source_id: r.get(2)?,
            connector: r.get(3)?,
            parser: r.get(4)?,
            status: r.get(5)?,
            metrics: span.len(),
            from: span.values().map(|s| s.0).min(),
            to: span.values().map(|s| s.1).max(),
        },
        meta,
    ))
}

const COLS: &str = "i.id, i.uid, i.source_id, s.connector, i.parser, i.status, i.meta FROM import i JOIN source s ON s.id = i.source_id";

/// Listed batches (done or review), newest first; optionally one connector or only reviews.
pub fn list(c: &Db, connector: Option<&str>, review_only: bool) -> Result<Vec<Batch>> {
    let statuses = if review_only { "('review')" } else { "('done','review')" };
    let mut st =
        c.prepare(&format!("SELECT {COLS} WHERE i.status IN {statuses} AND (?1 IS NULL OR s.connector = ?1) ORDER BY i.uid DESC"))?;
    let rows = st.query_map([connector], batch)?;
    Ok(rows.map(|r| r.map(|(b, _)| b)).collect::<Result<_, _>>()?)
}

pub fn show(c: &Db, import_id: i64, limit: i64) -> Result<BatchDetail> {
    let (batch, meta) = c
        .query_row(&format!("SELECT {COLS} WHERE i.id = ?"), [import_id], batch)
        .map_err(|_| Error::not_found("no_import", import_id.to_string()))?;
    let meta = parse_meta(meta);
    let mut rows = 0u64;
    let mut items = Vec::new();
    for (mid, (from, to)) in span_of(&meta) {
        rows += c.query_row(
            "SELECT count(*) FROM observation WHERE metric_id = ? AND start_ms BETWEEN ? AND ? AND import_id = ?",
            [mid, from, to, import_id],
            |r| r.get::<_, i64>(0),
        )? as u64;
        let pts = crate::query::newest_of_import(c, mid, from, to, import_id, limit)?;
        items.extend(pts);
    }
    items.sort_by(|a, b| b.start_ms.cmp(&a.start_ms).then_with(|| a.metric.cmp(&b.metric)));
    items.truncate(limit as usize);
    let has_text = one::<i64>(c, "SELECT 1 FROM report_text WHERE rowid = ?", [import_id])?.is_some();
    Ok(BatchDetail { batch, rows, items, has_text, candidates: meta.get("candidates").cloned(), rejected: meta.get("rejected").cloned() })
}

/// Erases a listed batch (done or review); a running or already erased one is not the person's to delete.
pub fn erase(c: &Db, import_id: i64, now_ms: i64) -> Result<crate::erase::EraseResult> {
    let status: String = one(c, "SELECT status FROM import WHERE id = ?", [import_id])?
        .ok_or_else(|| Error::not_found("no_import", import_id.to_string()))?;
    if status != "done" && status != "review" {
        return Err(Error::conflict("import_state", status));
    }
    crate::erase::erase(c, import_id, now_ms)
}

#[derive(Debug, Default, Serialize, schemars::JsonSchema)]
pub struct ErasedSource {
    /// Batches deleted
    pub batches: u64,
    /// Rows deleted
    pub deleted: u64,
    #[serde(skip)]
    pub orphan_blobs: Vec<String>,
}

/// Erases every listed batch (done or review) of a connector, in one transaction (W `eraseConnector`).
pub fn erase_connector(c: &Db, connector: &str, now_ms: i64) -> Result<ErasedSource> {
    crate::db::tx(c, || {
        let ids: Vec<i64> = c
            .prepare(
                "SELECT i.id FROM import i JOIN source s ON s.id = i.source_id
                  WHERE s.connector = ? AND i.status IN ('done','review') ORDER BY i.id",
            )?
            .query_map([connector], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut out = ErasedSource::default();
        // erase renumbers the import it deletes to max(id) + 1, which none of the ids still waiting can be
        for id in ids {
            let r = crate::erase::erase(c, id, now_ms)?;
            out.batches += 1;
            out.deleted += r.deleted;
            for b in r.orphan_blobs {
                if !out.orphan_blobs.contains(&b) {
                    out.orphan_blobs.push(b);
                }
            }
        }
        Ok(out)
    })
}
