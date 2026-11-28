//! What a caller may read: metric groups and a time window. Queries turn it into SQL conditions,
//! so rows outside it never leave the database. The owner's scope is `Scope::all()`.

use crate::access::{GrantSpec, Window};
use crate::db::Db;
use crate::error::Result;

#[derive(Debug, Clone)]
pub struct Scope {
    /// None = every metric
    groups: Option<Vec<String>>,
    pub from_ms: i64,
    pub to_ms: i64,
    /// Sources holding the system's health data may be read (`GrantSpec::system_health`)
    pub system_health: bool,
}

/// Sources of the system's health data: Apple Health (its export or HealthKit: one source, so the two merge) and
/// Health Connect, and results an agent derived from them (marked when written, `derived.rs`).
pub const SYSTEM_SOURCES: &str = "SELECT id FROM source WHERE connector IN ('apple_health', 'health_connect')
     OR (json_valid(meta) AND json_extract(meta, '$.system_health') IS 1)";

impl Scope {
    pub fn all() -> Scope {
        Scope { groups: None, from_ms: i64::MIN, to_ms: i64::MAX, system_health: true }
    }

    pub fn of(g: &GrantSpec, now_ms: i64) -> Scope {
        let (from_ms, to_ms) = match g.window {
            Window::All => (i64::MIN, i64::MAX),
            Window::LastDays(n) => (now_ms - n.max(0) * 86_400_000, i64::MAX),
            Window::Range { from_ms, to_ms } => (from_ms, to_ms),
        };
        Scope { groups: Some(g.groups.clone()), from_ms, to_ms, system_health: g.system_health }
    }

    pub fn is_all(&self) -> bool {
        self.groups.is_none() && self.from_ms == i64::MIN && self.to_ms == i64::MAX && self.system_health
    }

    /// JSON array of the source ids this scope may not read, for `json_each`, or None when it may read them all.
    pub fn hidden_sources(&self, c: &Db) -> Result<Option<String>> {
        if self.system_health {
            return Ok(None);
        }
        let ids: Vec<i64> = c.prepare(SYSTEM_SOURCES)?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(Some(serde_json::to_string(&ids)?))
    }

    pub fn allows(&self, code: &str) -> bool {
        self.groups.as_ref().is_none_or(|g| g.iter().any(|x| x == crate::catalog::group_of(code)))
    }

    /// JSON array of allowed metric ids for `json_each`, or None for all.
    pub fn ids(&self, c: &Db) -> Result<Option<String>> {
        if self.groups.is_none() {
            return Ok(None);
        }
        let mut st = c.prepare("SELECT id, code FROM metric")?;
        let ids: Vec<i64> = st
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .filter_map(|r| r.ok())
            .filter(|(_, code)| self.allows(code))
            .map(|(id, _)| id)
            .collect();
        Ok(Some(serde_json::to_string(&ids)?))
    }

    pub fn is_owner(&self) -> bool {
        self.is_all()
    }

    /// First and last local day lying wholly inside the window for any tz within ±14 h,
    /// so a daily sum never includes a point from outside it.
    pub fn days(&self) -> (String, String) {
        const H14: i64 = 14 * 3_600_000;
        const DAY: i64 = 86_400_000;
        let lo = if self.from_ms == i64::MIN { String::new() } else { crate::daily::iso_day(self.from_ms + H14 + DAY - 1) };
        let hi = if self.to_ms == i64::MAX { "9999".into() } else { crate::daily::iso_day(self.to_ms - H14 - DAY) };
        (lo, hi)
    }
}
