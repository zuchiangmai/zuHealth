//! Erase by import (DB design §5.4), ported from the web `db/erase.ts`:
//!   1. per metric in meta.span, primary-key range delete of rows still owned by the import; genotype and full text by id
//!   2. the import becomes an `erased` tombstone with a new id (max+1), blob and meta cleared
//!   3. returns blobs no longer referenced; the caller deletes the files
//!
//! Rows taken over by a newer import are untouched (ownership = the last import that delivered the row).

use crate::daily::Scope;
use crate::db::{Db, one, tx};
use crate::error::{Error, Result};
use crate::write::{parse_meta, span_of};

#[derive(Debug, Default, serde::Serialize, schemars::JsonSchema)]
pub struct EraseResult {
    pub orphan_blobs: Vec<String>,
    pub deleted: u64,
}

fn is_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Erases one import. An already erased one is a no-op.
pub fn erase(c: &Db, import_id: i64, now_ms: i64) -> Result<EraseResult> {
    tx(c, || {
        let (source, blob, status, meta): (i64, Option<String>, String, Option<String>) = c
            .query_row("SELECT source_id, blob, status, meta FROM import WHERE id = ?", [import_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .map_err(|_| Error::not_found("no_import", import_id.to_string()))?;
        if status == "erased" {
            return Ok(EraseResult::default());
        }
        let mut candidates: Vec<String> = blob.clone().into_iter().collect();
        let mut scopes = Vec::new();
        let mut deleted = 0u64;
        for (metric_id, (from, to)) in span_of(&parse_meta(meta)) {
            let args = rusqlite::params![metric_id, from, to, import_id];
            if one::<String>(c, "SELECT agg FROM metric WHERE id = ?", [metric_id])?.as_deref() == Some("none") {
                let mut st =
                    c.prepare("SELECT value FROM observation WHERE metric_id = ? AND start_ms BETWEEN ? AND ? AND import_id = ?")?;
                for v in st.query_map(args, |r| r.get::<_, crate::value::Value>(0))? {
                    if let crate::value::Value::Text(s) = v?
                        && is_sha(&s)
                        && !candidates.contains(&s)
                    {
                        candidates.push(s);
                    }
                }
            }
            deleted +=
                c.execute("DELETE FROM observation WHERE metric_id = ? AND start_ms BETWEEN ? AND ? AND import_id = ?", args)? as u64;
            scopes.push(Scope { metric_id, source_id: source, from, to });
        }
        c.execute("DELETE FROM genotype WHERE import_id = ?", [import_id])?;
        c.execute("DELETE FROM report_text WHERE rowid = ?", [import_id])?;
        c.execute(
            "UPDATE import SET status = 'erased', blob = NULL, meta = NULL, id = (SELECT max(id) + 1 FROM import) WHERE id = ?",
            [import_id],
        )?;
        // the file passes to the import with the smallest uid that also brought it, rather than being deleted
        // (merge-fixes R6b: a pending review keeps its photo)
        if let Some(sha) = &blob {
            let heir: Option<i64> = one(
                c,
                "SELECT id FROM import
                  WHERE status IN ('done', 'review') AND blob IS NULL
                    AND (CASE WHEN json_valid(meta) THEN json_extract(meta, '$.file') END) = ?
                  ORDER BY uid LIMIT 1",
                [sha],
            )?;
            if let Some(h) = heir {
                c.execute("UPDATE import SET blob = ? WHERE id = ?", rusqlite::params![sha, h])?;
            }
        }
        crate::daily::rebuild(c, &scopes, now_ms)?;
        let mut orphan_blobs = Vec::new();
        for sha in candidates {
            if !referenced(c, &sha)? {
                orphan_blobs.push(sha);
            }
        }
        Ok(EraseResult { orphan_blobs, deleted })
    })
}

/// Is the file still referenced: by any import's blob, or by an agg = none pointer value?
pub fn referenced(c: &Db, sha: &str) -> Result<bool> {
    if one::<i64>(c, "SELECT 1 FROM import WHERE blob = ?", [sha])?.is_some() {
        return Ok(true);
    }
    Ok(one::<i64>(
        c,
        "SELECT 1 FROM observation WHERE metric_id IN (SELECT id FROM metric WHERE agg = 'none') AND value = ? LIMIT 1",
        [sha],
    )?
    .is_some())
}
