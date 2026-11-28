//! Derived results (invariant 8): an algorithm's output is a normal import with its own source
//! `derived/<algo>@<version>/<writer>` and its own metrics `x:derived/<algo>/<name>`, recording its inputs,
//! so it can be erased and recomputed. Its source priority (1000) never wins an election over measured data.

use crate::db::{Db, one, tx};
use crate::error::{Error, Result};
use crate::scope::Scope;
use crate::write::{Begin, ObsRow, SourceSpec, begin, finish, write};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub const PRIORITY: i64 = 1000;
const MAX_ROWS: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MetricDef {
    /// Lower-case slug, e.g. "slope"
    pub name: String,
    /// UCUM unit of the values, "" for none
    pub unit: String,
    /// instant | cumulative | level
    pub agg: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub metric: String,
    pub from_ms: i64,
    pub to_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Derive {
    /// Algorithm slug, e.g. "rhr-trend"
    pub algo: String,
    /// e.g. "1" or "1.2"
    pub version: String,
    pub metric: MetricDef,
    /// What the result was computed from (resolved to import uids, inside the caller's scope)
    pub inputs: Vec<Input>,
    /// Rows; their `metric` is ignored and set to the derived metric
    pub rows: Vec<ObsRow>,
    /// Erase this writer's earlier results of the same algorithm first (default true)
    #[serde(default = "yes")]
    pub replace: bool,
}
fn yes() -> bool {
    true
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Derived {
    pub metric: String,
    pub import_id: i64,
    pub written: u64,
    pub replaced: u64,
    /// Input readings found (left out for daily-only grants)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inputs: Option<usize>,
}

fn slug(s: &str, max: usize, extra: &str) -> bool {
    (1..=max).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || extra.as_bytes().contains(&b))
}

/// A delegate writes only inside its grant's time window, as it reads.
/// Also refuses times more than a day ahead of `now_ms`: nothing measured lies in the future, and a far-future
/// point would make the daily rebuild fill every day up to it (`level` metrics carry forward).
pub fn outside_window(scope: &Scope, rows: &[ObsRow], now_ms: i64) -> Result<()> {
    let ahead = now_ms.saturating_add(crate::merge::MAX_SKEW_MS);
    if let Some(r) = rows.iter().find(|r| r.start_ms > ahead || r.end_ms.is_some_and(|e| e > ahead)) {
        return Err(Error::invalid("future", format!("{} at {} is more than a day ahead", r.metric, r.start_ms)));
    }
    let to = scope.to_ms;
    if let Some(r) = rows.iter().find(|r| r.start_ms < scope.from_ms || r.start_ms > to || r.end_ms.is_some_and(|e| e > to)) {
        return Err(Error::new(
            crate::Kind::Denied,
            "out_of_scope",
            format!("{} at {} is outside the grant's time window", r.metric, r.start_ms),
        ));
    }
    Ok(())
}

/// `writer` = the grant's writer key ("g" + 16 hex) for a delegate, "owner" for the person.
pub fn write_derived(c: &Db, scope: &Scope, writer: &str, d: &Derive, now_ms: i64) -> Result<Derived> {
    if !slug(&d.algo, 40, "") || !slug(&d.metric.name, 40, "") || !slug(&d.version, 20, ".") {
        return Err(Error::invalid("bad_request", "algo, version and metric name are lower-case slugs"));
    }
    if !["instant", "cumulative", "level"].contains(&d.metric.agg.as_str()) || d.metric.unit.len() > 24 {
        return Err(Error::invalid("bad_request", "agg must be instant, cumulative or level"));
    }
    if d.rows.is_empty() || d.rows.len() > MAX_ROWS {
        return Err(Error::invalid("bad_request", format!("1 to {MAX_ROWS} rows")));
    }
    let code = format!("x:derived/{}/{}", d.algo, d.metric.name);
    if !scope.allows(&code) {
        return Err(Error::new(crate::Kind::Denied, "out_of_scope", "the grant does not include the derived group"));
    }
    outside_window(scope, &d.rows, now_ms)?;
    tx(c, || {
        match c.query_row("SELECT unit, agg FROM metric WHERE code = ?", [&code], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        {
            Ok((u, a)) if u != d.metric.unit || a != d.metric.agg => {
                return Err(Error::conflict("metric_mismatch", format!("{code} is {a} in {u}")));
            }
            Ok(_) => {}
            Err(_) => {
                c.execute("INSERT INTO metric (code, name, unit, agg) VALUES (?, ?, ?, ?)", [&code, &code, &d.metric.unit, &d.metric.agg])?;
            }
        }
        let mut uids: Vec<String> = Vec::new();
        let mut from_system = false;
        for i in &d.inputs {
            if !scope.allows(&i.metric) {
                return Err(Error::new(crate::Kind::Denied, "out_of_scope", format!("{} is not in this grant", i.metric)));
            }
            // only the data this grant may read; whether any of it is the system's health data
            let mut st = c.prepare(
                "SELECT DISTINCT im.uid FROM v_observation o JOIN import im ON im.id = o.import_id
                  WHERE o.metric_id = (SELECT id FROM metric WHERE code = ?1) AND o.start_ms BETWEEN ?2 AND ?3
                    AND (?4 IS NULL OR o.source_id NOT IN (SELECT value FROM json_each(?4))) LIMIT 1000",
            )?;
            let (a, b) = (i.from_ms.max(scope.from_ms), i.to_ms.min(scope.to_ms));
            let hidden = scope.hidden_sources(c)?;
            // over the whole range, not the first 1000 imports the uids list keeps
            if !from_system && scope.system_health {
                from_system = c.query_row(
                    &format!(
                        "SELECT EXISTS (SELECT 1 FROM v_observation o WHERE o.metric_id = (SELECT id FROM metric WHERE code = ?1)
                            AND o.start_ms BETWEEN ?2 AND ?3 AND o.source_id IN ({}))",
                        crate::scope::SYSTEM_SOURCES
                    ),
                    rusqlite::params![i.metric, a, b],
                    |r| r.get(0),
                )?;
            }
            for r in st.query_map(rusqlite::params![i.metric, a, b, hidden], |r| r.get::<_, String>(0))? {
                let u = r?;
                if !uids.contains(&u) {
                    uids.push(u);
                }
            }
        }
        // One source per (algorithm, writer); the version lives in the parser, so a new version replaces the old run.
        let source = SourceSpec {
            priority: Some(PRIORITY),
            name: Some(d.algo.clone()),
            ..SourceSpec::new("derived", &format!("{}/{writer}", d.algo))
        };
        let mut replaced = 0;
        let mid: i64 = c.query_row("SELECT id FROM metric WHERE code = ?", [&code], |r| r.get(0))?;
        if d.replace
            && let Some(sid) =
                one::<i64>(c, "SELECT id FROM source WHERE connector = 'derived' AND external_id = ?", [&source.external_id])?
        {
            // only earlier runs that wrote this metric: the algorithm's other outputs stay
            let ids: Vec<i64> = c
                .prepare(
                    "SELECT id FROM import WHERE source_id = ? AND status = 'done' AND json_extract(meta, '$.span.' || ?) IS NOT NULL",
                )?
                .query_map(rusqlite::params![sid, mid.to_string()], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            for id in ids {
                replaced += crate::erase::erase(c, id, now_ms)?.deleted;
            }
        }
        let parser = format!("{}@{}", d.algo, d.version);
        let (import_id, _) = begin(c, Begin { source: &source, parser: &parser, blob: None, uid: None, candidates: None }, now_ms)?;
        c.execute(
            "UPDATE import SET meta = ? WHERE id = ?",
            rusqlite::params![json!({ "inputs": uids, "by": writer }).to_string(), import_id],
        )?;
        // results derived from Apple Health or Health Connect count as that data: hidden from grants without it
        if from_system {
            c.execute(
                "UPDATE source SET meta = json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.system_health', json('true'))
                  WHERE id = (SELECT source_id FROM import WHERE id = ?)",
                [import_id],
            )?;
        }
        let rows: Vec<ObsRow> = d.rows.iter().map(|r| ObsRow { metric: code.clone(), ..r.clone() }).collect();
        let res = write(c, import_id, &rows)?;
        if !res.rejected.is_empty() {
            return Err(Error::invalid("rejected", serde_json::to_string(&res.rejected)?));
        }
        finish(c, import_id, now_ms)?;
        Ok(Derived { metric: code.clone(), import_id, written: res.written, replaced, inputs: Some(uids.len()) })
    })
}
