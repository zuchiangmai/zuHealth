//! The operation table (plan §2.3). Every entry point (CLI, HTTP, MCP, FFI) calls `call()`, which always runs
//! validate → authorize → execute → audit, so the rules are written once.

pub mod account;
mod lab;
mod ops;
pub mod sync;
pub mod whoop;

use health_core::access::{Audit, Grant, WriteLevel};
use health_core::profile::Profile;
use health_core::query::Withheld;
use health_core::scope::Scope;
use health_core::{Error, Kind, Result};
use serde_json::Value as Json;

/// Who is calling: the person (GUI, their own CLI) or a delegate holding a grant token.
#[derive(Debug, Clone)]
pub enum Caller {
    Owner,
    Delegate(Grant),
}

/// What a delegate may do with an op. Deny by default: `Never` unless listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Delegate {
    Never,
    Read,
    Propose,
    Derived,
}

pub struct Ctx<'a> {
    pub profile: &'a Profile,
    pub now_ms: i64,
    pub caller: Caller,
    /// Run a write op and roll it back.
    pub dry_run: bool,
    /// Blob files to delete once the transaction has committed.
    after_commit: Vec<String>,
    /// WHOOP's data was deleted: stamp `whoop/stopped` in the vault once the transaction has committed
    stop_whoop_after_commit: bool,
}

impl<'a> Ctx<'a> {
    pub fn new(profile: &'a Profile, now_ms: i64, caller: Caller) -> Self {
        Ctx { profile, now_ms, caller, dry_run: false, after_commit: Vec::new(), stop_whoop_after_commit: false }
    }
    pub fn grant(&self) -> Option<&Grant> {
        match &self.caller {
            Caller::Owner => None,
            Caller::Delegate(g) => Some(g),
        }
    }
    /// What this caller may read.
    pub fn scope(&self) -> Scope {
        match &self.caller {
            Caller::Owner => Scope::all(),
            Caller::Delegate(g) => Scope::of(&g.spec, self.now_ms),
        }
    }
    pub fn db(&self) -> &health_core::db::Db {
        &self.profile.db
    }
    pub(crate) fn delete_blobs_after_commit(&mut self, shas: Vec<String>) {
        self.after_commit.extend(shas);
    }
    pub(crate) fn stop_whoop_after_commit(&mut self) {
        self.stop_whoop_after_commit = true;
    }
}

pub struct OpDef {
    pub name: &'static str,
    pub about: &'static str,
    /// Needs the writer lock; runs in a write transaction.
    pub write: bool,
    /// The only list of what delegates may call; MCP tools are exactly the ops with `delegate != Never`.
    pub delegate: Delegate,
    /// Manages its own transaction (ATTACH cannot run inside one); no dry run.
    pub manual_tx: bool,
    pub req: fn() -> schemars::Schema,
    pub resp: fn() -> schemars::Schema,
    pub run: fn(&mut Ctx, Json) -> Result<Json>,
}

pub struct Outcome {
    pub value: Json,
    /// Delegates only: what the grant hides, so "not visible" is never read as "none".
    pub withheld: Option<Withheld>,
}

pub fn ops() -> &'static [OpDef] {
    ops::OPS
}

pub fn find(name: &str) -> Result<&'static OpDef> {
    ops::OPS.iter().find(|o| o.name == name).ok_or_else(|| Error::new(Kind::Usage, "no_op", name.to_string()))
}

fn denied(why: &str) -> Error {
    Error::new(Kind::Denied, "denied", why.to_string())
}

fn authorize(op: &OpDef, g: &Grant) -> Result<()> {
    let need = match op.delegate {
        Delegate::Never => return Err(denied("not available to delegates")),
        Delegate::Read => WriteLevel::None,
        Delegate::Propose => WriteLevel::Propose,
        Delegate::Derived => WriteLevel::Derived,
    };
    if g.spec.write < need {
        return Err(denied("the grant does not allow this write"));
    }
    if op.name.starts_with("obs.") && !g.spec.detail {
        return Err(denied("the grant gives daily summaries only"));
    }
    if op.name.starts_with("report.") && !g.spec.reports {
        return Err(denied("the grant does not include report text"));
    }
    if op.name == "profile.get" && !g.spec.profile {
        return Err(denied("the grant does not include age and sex"));
    }
    Ok(())
}

/// Not database writes (no transaction to roll back) but they change something: a dry run is refused.
const EFFECTS_OUTSIDE_TX: &[&str] = &["grant.create", "grant.revoke", "export.csv", "import.ocr", "profile.set"];

/// Metric codes a request asks about: `metric`, `code`, or the metrics of its rows / inputs.
fn metrics_of(req: &Json) -> Vec<String> {
    let mut out: Vec<String> = ["metric", "code"].iter().filter_map(|k| req.get(*k).and_then(Json::as_str)).map(String::from).collect();
    // derived.write: the metric it writes
    if let (Some(a), Some(n)) = (req.get("algo").and_then(Json::as_str), req.pointer("/metric/name").and_then(Json::as_str)) {
        out.push(format!("x:derived/{a}/{n}"));
    }
    for key in ["rows", "inputs"] {
        if let Some(rows) = req.get(key).and_then(Json::as_array) {
            out.extend(rows.iter().filter_map(|r| r.get("metric").and_then(Json::as_str)).map(String::from));
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Runs one operation. `req` is the request JSON (validated against the op's type).
pub fn call(ctx: &mut Ctx, name: &str, req: Json) -> Result<Outcome> {
    let op = find(name)?;
    let Some(grant) = ctx.grant().cloned() else {
        return Ok(Outcome { value: execute(ctx, op, req)?, withheld: None });
    };
    let scope = ctx.scope();
    let now = ctx.now_ms;
    let audit = |rows: i64, denied: bool| Audit {
        at: now,
        grant_id: grant.id,
        op: op.name.into(),
        metrics: metrics_of(&req),
        from_ms: (scope.from_ms != i64::MIN).then_some(scope.from_ms),
        to_ms: (scope.to_ms != i64::MAX).then_some(scope.to_ms),
        rows,
        denied,
    };
    if let Err(e) = authorize(op, &grant) {
        ctx.profile.access.record(&audit(0, true))?;
        return Err(e);
    }
    if op.write {
        // A write is audited before it can commit: no audit row, no write.
        let n = req.get("rows").and_then(Json::as_array).map_or(1, |r| r.len() as i64);
        let id = ctx.profile.access.record(&audit(n, false))?;
        let result = execute(ctx, op, req.clone());
        // the outcome replaces the provisional row: a refused or failed write must not read as a normal one
        if let Err(e) = &result {
            // keep the op's own error if amending fails; `denied` only for refusals, as on reads
            let _ = ctx.profile.access.amend(id, 0, e.kind == Kind::Denied);
        }
        let value = result.map_err(|e| if e.kind == Kind::Other { Error::other("internal", "internal error") } else { e })?;
        return Ok(Outcome { value, withheld: Some(health_core::query::withheld(ctx.db(), &scope)?) });
    }
    let result = execute(ctx, op, req.clone());
    let denied = matches!(&result, Err(e) if e.kind == Kind::Denied);
    let rows = match &result {
        Ok(Json::Array(a)) => a.len() as i64,
        Ok(_) => 1,
        Err(_) => 0,
    };
    // Fail closed: no audit row, no answer.
    ctx.profile.access.record(&audit(rows, denied))?;
    let value = result.map_err(|e| if e.kind == Kind::Other { Error::other("internal", "internal error") } else { e })?;
    let withheld = Some(health_core::query::withheld(ctx.db(), &scope)?);
    Ok(Outcome { value, withheld })
}

fn execute(ctx: &mut Ctx, op: &OpDef, req: Json) -> Result<Json> {
    if op.write && !ctx.profile.is_writer() {
        return Err(Error::other("not_writer", "write op on a read-only profile"));
    }
    if ctx.dry_run && EFFECTS_OUTSIDE_TX.contains(&op.name) {
        return Err(Error::new(Kind::Usage, "no_dry_run", op.name.to_string()));
    }
    if !op.write || op.manual_tx {
        if ctx.dry_run && op.manual_tx {
            return Err(Error::new(Kind::Usage, "no_dry_run", op.name.to_string()));
        }
        return (op.run)(ctx, req);
    }
    ctx.after_commit.clear();
    ctx.stop_whoop_after_commit = false;
    ctx.db().execute_batch("BEGIN IMMEDIATE")?;
    let out = (op.run)(ctx, req);
    let orphans = std::mem::take(&mut ctx.after_commit);
    let stop_whoop = std::mem::take(&mut ctx.stop_whoop_after_commit);
    if out.is_err() || ctx.dry_run {
        // SQLite may already have rolled back; the op's own error is the one to report.
        let _ = ctx.db().execute_batch("ROLLBACK");
        return out;
    }
    if let Err(e) = ctx.db().execute_batch("COMMIT") {
        let _ = ctx.db().execute_batch("ROLLBACK");
        return Err(e.into());
    }
    ctx.profile.blobs.remove(&orphans);
    if stop_whoop {
        // the vault isn't in the transaction: only a committed delete stops WHOOP (docs/lan-sync.md §8)
        let device = ctx.profile.vault.device_id()?;
        ctx.profile.vault.update(|st| health_core::sync::stop_whoop(ctx.db(), st, &device, ctx.now_ms))?;
    }
    out
}

/// Self-contained JSON Schema (no `$ref`, no `$schema`): what MCP clients and code generators expect.
pub(crate) fn schema_of<T: schemars::JsonSchema>() -> schemars::Schema {
    schemars::generate::SchemaSettings::draft2020_12()
        .with(|s| {
            s.inline_subschemas = true;
            s.meta_schema = None;
        })
        .into_generator()
        .into_root_schema_for::<T>()
}

pub(crate) fn bad_request(e: serde_json::Error) -> Error {
    Error::invalid("bad_request", e.to_string())
}
