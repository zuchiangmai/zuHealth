//! Opening the database: SQLCipher key, pragmas, schema v1, version gate, crash recovery.

use crate::error::{Error, Kind, Result};
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

/// The spec schema, verbatim (docs/health-schema.sql).
pub const SCHEMA_SQL: &str = include_str!("../../../docs/health-schema.sql");
/// `PRAGMA user_version` this binary writes. Migrations only go forward.
pub const SCHEMA_VERSION: i64 = 1;

pub type Db = Connection;

/// The schema without its PRAGMA lines (they cannot run in a transaction; `prepare` sets them per connection).
pub fn schema_body() -> String {
    SCHEMA_SQL.lines().filter(|l| !l.trim_start().starts_with("PRAGMA")).collect::<Vec<_>>().join("\n")
}

/// Opens (creating if missing) an encrypted database. `key` = 32 raw bytes.
pub fn open(path: &Path, key: &[u8; 32]) -> Result<Db> {
    let c = Connection::open(path)?;
    let mut k = zeroize::Zeroizing::new(format!("x'{}'", hex::encode(key)));
    c.pragma_update(None, "key", k.as_str())?;
    zeroize::Zeroize::zeroize(&mut *k);
    prepare(&c)?;
    c.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    Ok(c)
}

/// Unencrypted file database: only for benchmarks that compare against SQLCipher.
#[doc(hidden)]
pub fn open_unencrypted(path: &Path) -> Result<Db> {
    let c = Connection::open(path)?;
    prepare(&c)?;
    c.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    Ok(c)
}

/// In-memory, unencrypted database with the schema and catalog (tests and scratch work).
pub fn open_memory() -> Result<Db> {
    let c = Connection::open_in_memory()?;
    prepare(&c)?;
    Ok(c)
}

fn prepare(c: &Db) -> Result<()> {
    // Not stored in the file: every connection sets it.
    c.pragma_update(None, "foreign_keys", "ON")?;
    c.busy_timeout(std::time::Duration::from_secs(5))?;
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(Error::new(Kind::Conflict, "db_newer", "this database was written by a newer version; please upgrade"));
    }
    if version == 0 {
        let empty: i64 = c.query_row("SELECT count(*) FROM sqlite_schema", [], |r| r.get(0))?;
        if empty != 0 {
            return Err(Error::other("db_unknown", "database has tables but no schema version"));
        }
        tx(c, || {
            c.execute_batch(&schema_body())?;
            c.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            crate::catalog::seed(c)?;
            Ok(())
        })?;
    }
    Ok(())
}

/// Runs `f` in a transaction (a SAVEPOINT, so calls nest). Any error rolls back.
pub fn tx<T>(c: &Db, f: impl FnOnce() -> Result<T>) -> Result<T> {
    c.execute_batch("SAVEPOINT h")?;
    match f() {
        Ok(v) => {
            c.execute_batch("RELEASE h")?;
            Ok(v)
        }
        Err(e) => {
            // Keep the original error if the rollback itself fails.
            let _ = c.execute_batch("ROLLBACK TO h; RELEASE h");
            Err(e)
        }
    }
}

/// Single value of a single row, or None.
pub fn one<T: rusqlite::types::FromSql>(c: &Db, sql: &str, p: impl rusqlite::Params) -> Result<Option<T>> {
    Ok(c.query_row(sql, p, |r| r.get(0)).optional()?)
}

/// After a crash: `running` imports become `failed` and are erased. Returns blobs that lost their last reference.
pub fn recover_crashed(c: &Db, now_ms: i64) -> Result<Vec<String>> {
    tx(c, || {
        let ids: Vec<i64> = c
            .prepare("SELECT id FROM import WHERE status = 'running' ORDER BY id")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let mut orphans = Vec::new();
        for id in ids {
            c.execute("UPDATE import SET status = 'failed' WHERE id = ?", [id])?;
            orphans.extend(crate::erase::erase(c, id, now_ms)?.orphan_blobs);
        }
        Ok(orphans)
    })
}
