//! Grants, tokens and the audit log (plan §5), in `access.db`, kept apart from the health data:
//! erasing one never touches the other. Tokens are shown once; only their SHA-256 is stored.

use crate::error::{Error, Kind, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS grant_ (
  id         INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  spec       TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  revoked_ms INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS audit (
  at       INTEGER NOT NULL,
  grant_id INTEGER NOT NULL,
  op       TEXT NOT NULL,
  metrics  TEXT NOT NULL,
  from_ms  INTEGER,
  to_ms    INTEGER,
  rows     INTEGER NOT NULL,
  denied   INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS audit_grant ON audit (grant_id, at);
";

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Window {
    All,
    LastDays(i64),
    Range { from_ms: i64, to_ms: i64 },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum WriteLevel {
    None,
    /// Rows go to the review queue; the owner confirms them.
    Propose,
    /// Propose, plus derived results under their own `derived/<algo>@<version>` source.
    Derived,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GrantSpec {
    /// Shown to the owner, e.g. "Claude Desktop"
    pub name: String,
    /// Metric groups: body sleep cardio activity lab (normal), infectious tumor repro custom lab_other other (sensitive)
    pub groups: Vec<String>,
    /// false = daily summaries only
    pub detail: bool,
    pub window: Window,
    /// Full text of confirmed reports
    pub reports: bool,
    pub write: WriteLevel,
    pub expires_ms: i64,
    /// Age (whole years) and sex from the personal profile, never the birth month (owner, 2026-11-22: a tick of
    /// its own, off unless chosen)
    #[serde(default)]
    pub profile: bool,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct Grant {
    pub id: i64,
    /// Who wrote an agent's proposals and derived results: "g" + the start of the token hash. Stable and unique
    /// even when grant ids restart in a new access.db.
    pub writer: String,
    #[serde(flatten)]
    pub spec: GrantSpec,
    pub created_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct Audit {
    pub at: i64,
    pub grant_id: i64,
    pub op: String,
    /// Metric codes the call asked about
    pub metrics: Vec<String>,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    /// Rows returned (never the values)
    pub rows: i64,
    pub denied: bool,
}

pub struct AccessDb {
    c: Connection,
}

fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn writer_key(token_hash: &str) -> String {
    format!("g{}", &token_hash[..16])
}

fn denied() -> Error {
    Error::new(Kind::Denied, "denied", "unknown, revoked or expired token")
}

impl AccessDb {
    /// Ends a transaction an interrupted call left open (see `Profile::recover`).
    pub fn recover(&self) {
        if !self.c.is_autocommit() {
            let _ = self.c.execute_batch("ROLLBACK");
        }
    }

    pub fn open(path: &Path, key: &[u8; 32]) -> Result<Self> {
        let c = Connection::open(path)?;
        c.pragma_update(None, "key", zeroize::Zeroizing::new(format!("x'{}'", hex::encode(key))).as_str())?;
        c.execute_batch(SCHEMA)?;
        Ok(AccessDb { c })
    }

    pub fn open_memory() -> Result<Self> {
        let c = Connection::open_in_memory()?;
        c.execute_batch(SCHEMA)?;
        Ok(AccessDb { c })
    }

    /// Creates a grant; the returned token is shown once and never stored.
    pub fn create(&self, spec: &GrantSpec, now_ms: i64) -> Result<(Grant, String)> {
        if spec.name.trim().is_empty() {
            return Err(Error::invalid("bad_grant", "name"));
        }
        if let Some(g) = spec.groups.iter().find(|g| !crate::catalog::GROUPS.iter().any(|(k, _)| k == g)) {
            return Err(Error::invalid("bad_grant", format!("unknown group {g}")));
        }
        match spec.window {
            Window::LastDays(n) if !(1..=36_500).contains(&n) => return Err(Error::invalid("bad_grant", "last_days must be 1 to 36500")),
            Window::Range { from_ms, to_ms } if from_ms > to_ms => return Err(Error::invalid("bad_grant", "range from_ms > to_ms")),
            _ => {}
        }
        if spec.expires_ms <= now_ms {
            return Err(Error::invalid("bad_grant", "expires_ms must be in the future"));
        }
        let token = format!("hk_{}", hex::encode(crate::aead::random::<32>()));
        self.c.execute(
            "INSERT INTO grant_ (token_hash, spec, created_ms) VALUES (?, ?, ?)",
            params![hash(&token), serde_json::to_string(spec)?, now_ms],
        )?;
        let id = self.c.last_insert_rowid();
        Ok((Grant { id, writer: writer_key(&hash(&token)), spec: spec.clone(), created_ms: now_ms, revoked_ms: None }, token))
    }

    fn row(r: &rusqlite::Row) -> rusqlite::Result<(i64, String, i64, Option<i64>, String)> {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
    }

    fn grant((id, spec, created_ms, revoked_ms, token_hash): (i64, String, i64, Option<i64>, String)) -> Result<Grant> {
        Ok(Grant {
            id,
            writer: writer_key(&token_hash),
            spec: serde_json::from_str(&spec).map_err(|e| Error::other("bad_grant", e.to_string()))?,
            created_ms,
            revoked_ms,
        })
    }

    pub fn list(&self) -> Result<Vec<Grant>> {
        let mut st = self.c.prepare("SELECT id, spec, created_ms, revoked_ms, token_hash FROM grant_ ORDER BY id")?;
        let rows: Vec<_> = st.query_map([], Self::row)?.collect::<Result<_, _>>()?;
        rows.into_iter().map(Self::grant).collect()
    }

    pub fn revoke(&self, id: i64, now_ms: i64) -> Result<()> {
        if self.c.execute("UPDATE grant_ SET revoked_ms = ? WHERE id = ? AND revoked_ms IS NULL", [now_ms, id])? == 0 {
            return Err(Error::not_found("no_grant", id.to_string()));
        }
        Ok(())
    }

    /// The live grant behind a token; anything else is `denied`.
    pub fn resolve(&self, token: &str, now_ms: i64) -> Result<Grant> {
        let row = self
            .c
            .query_row("SELECT id, spec, created_ms, revoked_ms, token_hash FROM grant_ WHERE token_hash = ?", [hash(token)], Self::row)
            .optional()?
            .ok_or_else(denied)?;
        let g = Self::grant(row)?;
        if g.revoked_ms.is_some() || g.spec.expires_ms <= now_ms {
            return Err(denied());
        }
        Ok(g)
    }

    /// Writes an audit row; returns its id (for `amend`).
    pub fn record(&self, a: &Audit) -> Result<i64> {
        self.c.execute(
            "INSERT INTO audit (at, grant_id, op, metrics, from_ms, to_ms, rows, denied) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![a.at, a.grant_id, a.op, serde_json::to_string(&a.metrics)?, a.from_ms, a.to_ms, a.rows, a.denied],
        )?;
        Ok(self.c.last_insert_rowid())
    }

    /// Fills in the outcome of a write audited before it ran: rows written, or refused / failed.
    pub fn amend(&self, id: i64, rows: i64, denied: bool) -> Result<()> {
        self.c.execute("UPDATE audit SET rows = ?, denied = ? WHERE rowid = ?", params![rows, denied, id])?;
        Ok(())
    }

    /// Newest first.
    pub fn audit(&self, grant_id: Option<i64>, limit: i64) -> Result<Vec<Audit>> {
        let mut st = self.c.prepare(
            "SELECT at, grant_id, op, metrics, from_ms, to_ms, rows, denied FROM audit WHERE ?1 IS NULL OR grant_id = ?1 ORDER BY at DESC, rowid DESC LIMIT ?2",
        )?;
        let rows = st.query_map(params![grant_id, limit], |r| {
            let metrics: String = r.get(3)?;
            Ok(Audit {
                at: r.get(0)?,
                grant_id: r.get(1)?,
                op: r.get(2)?,
                metrics: serde_json::from_str(&metrics).unwrap_or_default(),
                from_ms: r.get(4)?,
                to_ms: r.get(5)?,
                rows: r.get(6)?,
                denied: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}
