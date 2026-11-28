//! Read surface. Everything goes through v_observation / v_daily, so corrections apply, deleted points are gone
//! and unconfirmed reviews are invisible. Censored values come back with their comparator.

use crate::db::{Db, one};
use crate::error::{Error, Result};
use crate::scope::Scope;
use crate::value::Value;
use rusqlite::{OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value as Json;

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Metric {
    pub code: String,
    pub name: String,
    pub unit: String,
    pub agg: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct MetricInfo {
    #[serde(flatten)]
    pub metric: Metric,
    /// Units accepted on input, canonical first
    pub units: Vec<String>,
    /// Visible points
    pub points: i64,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Source {
    pub id: i64,
    pub connector: String,
    pub external_id: String,
    pub name: String,
    /// Smaller wins the daily election
    pub priority: i64,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Point {
    pub metric: String,
    /// Display name, canonical unit, aggregation and data group of the metric
    pub name: String,
    pub unit: String,
    pub agg: String,
    pub group: String,
    /// Where the home page shows it: the group, except lab device results with a card of their own (ForceDecks:
    /// `force`, as the web's model.ts). Exports and grants go by `group`.
    pub category: String,
    pub start_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<i64>,
    pub tz_min: i64,
    pub value: Value,
    /// "<", ">", "<=", ">=" for a censored value: the value is a bound, not a measurement
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comparator: Option<String>,
    pub source_id: i64,
    pub import_id: i64,
    /// The value comes from a user correction
    pub corrected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Json>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Day {
    pub day: String,
    pub source_id: i64,
    pub n: i64,
    pub sum: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub seconds: Option<i64>,
    /// instant: sum / n; level: sum / seconds (time-weighted); otherwise absent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mean: Option<f64>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct ReportHit {
    pub import_id: i64,
    pub source_id: i64,
    pub snippet: String,
}

fn metric_row(r: &Row) -> rusqlite::Result<Metric> {
    Ok(Metric { code: r.get(0)?, name: r.get(1)?, unit: r.get(2)?, agg: r.get(3)? })
}

fn metric_id(c: &Db, code: &str) -> Result<(i64, String)> {
    c.query_row("SELECT id, agg FROM metric WHERE code = ?", [code], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|_| Error::not_found("no_metric", code))
}

fn like(q: &str) -> String {
    format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

fn out_of_scope(code: &str) -> Error {
    Error::new(crate::Kind::Denied, "out_of_scope", format!("{code} is not in this grant"))
}

/// Catalog codes are public; any other code (user-made, derived, merged from a backup) only within the scope.
fn listable(scope: &Scope, code: &str) -> bool {
    crate::catalog::is_catalog(code) || scope.allows(code)
}

/// Searches the catalog: `codes` first (measures the UI matched by the name it shows, in its own language, which
/// the catalog's English can't), then code, name and the names printed on reports (aliases). `manual`: only the
/// measures a person enters one number of (instant, cumulative), as the web's manual entry. Every word must appear
/// in the name, the code or an alias ("heart rest" finds "Resting Heart Rate").
pub fn metric_search(c: &Db, scope: &Scope, q: &str, limit: i64, codes: &[String], manual: bool) -> Result<Vec<Metric>> {
    let fits = |m: &Metric| (!manual || m.agg == "instant" || m.agg == "cumulative") && listable(scope, &m.code);
    let limit = limit.clamp(0, 100) as usize;
    let mut out: Vec<Metric> = Vec::new();
    let mut by_code = c.prepare("SELECT code, name, unit, agg FROM metric WHERE code = ?")?;
    for code in codes.iter().take(500) {
        if out.len() >= limit {
            break;
        }
        if let Some(m) = by_code.query_row([code], metric_row).optional()?
            && fits(&m)
            && !out.iter().any(|o| o.code == m.code)
        {
            out.push(m);
        }
    }
    let words: Vec<String> = q.split_whitespace().map(str::to_lowercase).collect();
    let Some(first) = words.iter().max_by_key(|w| w.len()) else { return Ok(out) };
    let mut st = c.prepare(
        "SELECT m.code, m.name, m.unit, m.agg, group_concat(a.alias, ' ') FROM metric m
          LEFT JOIN metric_alias a ON a.metric_id = m.id
          WHERE m.code LIKE ?1 ESCAPE '\\' OR m.name LIKE ?1 ESCAPE '\\' OR a.alias LIKE ?1 ESCAPE '\\'
          GROUP BY m.id
          ORDER BY (m.code = ?2) DESC, (m.name LIKE ?3 ESCAPE '\\') DESC, length(m.name), m.name",
    )?;
    let prefix = format!("{}%", q.trim().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows = st.query_map(rusqlite::params![like(first), q.trim(), prefix], |r| {
        Ok((metric_row(r)?, r.get::<_, Option<String>>(4)?.unwrap_or_default()))
    })?;
    for row in rows {
        if out.len() >= limit {
            break;
        }
        let (m, aliases) = row?;
        let named = format!("{} {}", m.name.to_lowercase(), m.code.to_lowercase());
        let hay = format!("{named} {}", aliases.to_lowercase());
        // aliases are names printed on the person's own reports: a match through one alone says they had that test,
        // so it counts only within the scope (a catalog measure is otherwise listable to anyone)
        let by_alias = !words.iter().all(|w| named.contains(w.as_str()));
        if words.iter().all(|w| hay.contains(w.as_str()))
            && fits(&m)
            && (!by_alias || scope.allows(&m.code))
            && !out.iter().any(|o| o.code == m.code)
        {
            out.push(m);
        }
    }
    Ok(out)
}

pub fn metric_show(c: &Db, scope: &Scope, code: &str) -> Result<MetricInfo> {
    if !listable(scope, code) {
        return Err(out_of_scope(code));
    }
    let metric = c
        .query_row("SELECT code, name, unit, agg FROM metric WHERE code = ?", [code], metric_row)
        .map_err(|_| Error::not_found("no_metric", code))?;
    let numeric = metric.agg != "none" && metric.agg != "interval";
    let units = if numeric { crate::units::allowed_units(&metric.code, &metric.unit) } else { vec![] };
    let points = if scope.allows(code) {
        c.query_row(
            "SELECT count(*) FROM v_observation WHERE metric_id = (SELECT id FROM metric WHERE code = ?) AND start_ms BETWEEN ? AND ?",
            rusqlite::params![code, scope.from_ms, scope.to_ms],
            |r| r.get(0),
        )?
    } else {
        0
    };
    Ok(MetricInfo { metric, units, points })
}

fn point(r: &Row) -> rusqlite::Result<Point> {
    let detail: Option<String> = r.get(8)?;
    let detail: Option<Json> = detail.and_then(|d| serde_json::from_str(&d).ok());
    let comparator = detail.as_ref().and_then(|d| d.get("comparator")).and_then(Json::as_str).map(String::from);
    let metric: String = r.get(0)?;
    Ok(Point {
        group: crate::catalog::group_of(&metric).into(),
        category: crate::labs::category_of(&metric).into(),
        name: r.get(9)?,
        unit: r.get(10)?,
        agg: r.get(11)?,
        metric,
        start_ms: r.get(1)?,
        source_id: r.get(2)?,
        end_ms: r.get(3)?,
        tz_min: r.get(4)?,
        value: r.get(5)?,
        import_id: r.get(6)?,
        corrected: r.get(7)?,
        comparator,
        detail,
    })
}

/// For delegates, `detail` keeps only what external analysis may see (grading §2.3): comparator, reference range, flag, precision.
fn safe(scope: &Scope, mut p: Point) -> Point {
    if scope.is_owner() {
        return p;
    }
    p.detail = p.detail.map(|d| {
        let mut out = serde_json::Map::new();
        let pick = |k: &str| d.get(k).or_else(|| d.get("printed").and_then(|x| x.get(k))).cloned();
        for k in ["comparator", "ref", "flag", "precision"] {
            if let Some(v) = pick(k) {
                out.insert(k.into(), v);
            }
        }
        Json::Object(out)
    });
    p.detail = p.detail.filter(|d| d.as_object().is_some_and(|o| !o.is_empty()));
    p
}

const POINT_COLS: &str =
    "m.code, o.start_ms, o.source_id, o.end_ms, o.tz_min, o.value, o.import_id, o.corrected, o.detail, m.name, m.unit, m.agg";

/// Points of one metric in [from, to) (UTC ms), oldest first.
pub fn obs_query(
    c: &Db,
    scope: &Scope,
    code: &str,
    from: Option<i64>,
    to: Option<i64>,
    source: Option<i64>,
    limit: i64,
) -> Result<Vec<Point>> {
    obs_query_ordered(c, scope, code, from, to, source, limit, false)
}

/// As `obs_query`; `newest_first` takes the limit from the newest end (newest first).
#[allow(clippy::too_many_arguments)]
pub fn obs_query_ordered(
    c: &Db,
    scope: &Scope,
    code: &str,
    from: Option<i64>,
    to: Option<i64>,
    source: Option<i64>,
    limit: i64,
    newest_first: bool,
) -> Result<Vec<Point>> {
    if !scope.allows(code) {
        return Err(out_of_scope(code));
    }
    let (id, _) = metric_id(c, code)?;
    let from = from.unwrap_or(i64::MIN).max(scope.from_ms);
    let to = to.unwrap_or(i64::MAX).min(scope.to_ms.saturating_add(1));
    let order = if newest_first { "DESC" } else { "" };
    let mut st = c.prepare(&format!(
        "SELECT {POINT_COLS} FROM v_observation o JOIN metric m ON m.id = o.metric_id
          WHERE o.metric_id = ?1 AND o.start_ms >= ?2 AND o.start_ms < ?3 AND (?4 IS NULL OR o.source_id = ?4)
          ORDER BY o.start_ms {order}, o.source_id LIMIT ?5"
    ))?;
    let rows = st.query_map(rusqlite::params![id, from, to, source, limit], point)?;
    Ok(rows.map(|p| p.map(|p| safe(scope, p))).collect::<Result<_, _>>()?)
}

/// Newest points one import still owns for one metric in its span (primary-key range, like erase).
pub(crate) fn newest_of_import(c: &Db, metric_id: i64, from: i64, to: i64, import_id: i64, limit: i64) -> Result<Vec<Point>> {
    let mut st = c.prepare(&format!(
        "SELECT {POINT_COLS} FROM v_observation o JOIN metric m ON m.id = o.metric_id
          WHERE o.metric_id = ? AND o.start_ms BETWEEN ? AND ? AND o.import_id = ? ORDER BY o.start_ms DESC LIMIT ?"
    ))?;
    Ok(st.query_map([metric_id, from, to, import_id, limit], point)?.collect::<Result<_, _>>()?)
}

/// The newest point of each metric (or of one metric), across sources.
pub fn latest(c: &Db, scope: &Scope, code: Option<&str>) -> Result<Vec<Point>> {
    let filter = match code {
        Some(code) if !scope.allows(code) => return Err(out_of_scope(code)),
        Some(code) => Some(metric_id(c, code)?.0),
        None => None,
    };
    let mut st = c.prepare(&format!(
        "SELECT {POINT_COLS} FROM v_observation o JOIN metric m ON m.id = o.metric_id
          JOIN (SELECT metric_id, max(start_ms) AS t FROM v_observation
                 WHERE (?1 IS NULL OR metric_id = ?1) AND (?2 IS NULL OR metric_id IN (SELECT value FROM json_each(?2)))
                   AND start_ms BETWEEN ?3 AND ?4
                 GROUP BY metric_id) l
            ON l.metric_id = o.metric_id AND l.t = o.start_ms
          ORDER BY m.code, o.source_id"
    ))?;
    let rows: Vec<Point> =
        st.query_map(rusqlite::params![filter, scope.ids(c)?, scope.from_ms, scope.to_ms], point)?.collect::<Result<_, _>>()?;
    // One per metric: the first source in (priority, id) order.
    let pri: std::collections::HashMap<i64, i64> =
        c.prepare("SELECT id, priority FROM source")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    let mut out: Vec<Point> = Vec::new();
    for p in rows {
        match out.last_mut() {
            Some(last) if last.metric == p.metric => {
                if (pri[&p.source_id], p.source_id) < (pri[&last.source_id], last.source_id) {
                    *last = p;
                }
            }
            _ => out.push(p),
        }
    }
    Ok(out.into_iter().map(|p| safe(scope, p)).collect())
}

/// Daily summaries of one metric, one elected source per day; `from`/`to` are inclusive local days.
pub fn daily(c: &Db, scope: &Scope, code: &str, from: Option<&str>, to: Option<&str>) -> Result<Vec<Day>> {
    if !scope.allows(code) {
        return Err(out_of_scope(code));
    }
    let (id, agg) = metric_id(c, code)?;
    let (lo, hi) = scope.days();
    let from = from.unwrap_or("").max(lo.as_str());
    let to = to.unwrap_or("9999").min(hi.as_str());
    let mut st = c.prepare(
        "SELECT day, source_id, n, sum, min, max, seconds FROM v_daily
          WHERE metric_id = ? AND day >= ? AND day <= ? ORDER BY day",
    )?;
    let rows = st.query_map(rusqlite::params![id, from, to], |r| {
        let (n, sum, seconds): (i64, Option<f64>, Option<i64>) = (r.get(2)?, r.get(3)?, r.get(6)?);
        let mean = match agg.as_str() {
            "instant" if n > 0 => sum.map(|s| s / n as f64),
            "level" => sum.zip(seconds.filter(|s| *s > 0)).map(|(s, t)| s / t as f64),
            _ => None,
        };
        Ok(Day { day: r.get(0)?, source_id: r.get(1)?, n, sum, min: r.get(4)?, max: r.get(5)?, seconds, mean })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn sources(c: &Db) -> Result<Vec<Source>> {
    let mut st = c.prepare("SELECT id, connector, external_id, name, priority FROM source ORDER BY priority, id")?;
    let rows = st.query_map([], |r| {
        Ok(Source { id: r.get(0)?, connector: r.get(1)?, external_id: r.get(2)?, name: r.get(3)?, priority: r.get(4)? })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Renames a source or changes its priority; the change is stamped (`set_at`, `set_by`) so it wins on other devices
/// (merge-fixes R3).
pub fn source_update(c: &Db, id: i64, name: Option<&str>, priority: Option<i64>, now_ms: i64, set_by: &str) -> Result<Source> {
    if one::<i64>(c, "SELECT 1 FROM source WHERE id = ?", [id])?.is_none() {
        return Err(Error::not_found("no_source", id.to_string()));
    }
    if let Some(n) = name {
        if n.trim().is_empty() {
            return Err(Error::invalid("bad_name", ""));
        }
        c.execute("UPDATE source SET name = ? WHERE id = ?", rusqlite::params![n, id])?;
    }
    if let Some(p) = priority {
        c.execute("UPDATE source SET priority = ? WHERE id = ?", rusqlite::params![p, id])?;
    }
    if name.is_some() || priority.is_some() {
        crate::write::stamp_source(c, id, now_ms, set_by)?;
    }
    Ok(sources(c)?.into_iter().find(|s| s.id == id).expect("source exists"))
}

/// Full-text search of confirmed reports (trigram: substrings of 3+ characters; shorter queries use LIKE).
/// A report is inside the scope's window when its import was made inside it (UUIDv7 time).
fn report_in_window(c: &Db, scope: &Scope, import_id: i64) -> Result<bool> {
    if scope.is_owner() {
        return Ok(true);
    }
    let uid: Option<String> = one(c, "SELECT uid FROM import WHERE id = ?", [import_id])?;
    Ok(uid.and_then(|u| crate::batches::uuid_time(&u)).is_some_and(|t| t >= scope.from_ms && t <= scope.to_ms))
}

pub fn report_search(c: &Db, scope: &Scope, q: &str, limit: i64) -> Result<Vec<ReportHit>> {
    let q = q.trim();
    if q.is_empty() {
        return Err(Error::invalid("bad_query", "empty"));
    }
    let (cond, arg) =
        if q.chars().count() >= 3 { ("t.text MATCH ?1", format!("\"{}\"", q.replace('"', "\"\""))) } else { ("t.text LIKE ?1", like(q)) };
    let mut st = c.prepare(&format!(
        "SELECT t.rowid, i.source_id, snippet(report_text, 0, '[', ']', '…', 12) FROM report_text t JOIN import i ON i.id = t.rowid
          WHERE {cond} AND i.status = 'done' ORDER BY t.rowid DESC"
    ))?;
    // the window first, then the limit: an agent's window in the past still finds its reports under newer ones
    let rows = st.query_map([arg], |r| Ok(ReportHit { import_id: r.get(0)?, source_id: r.get(1)?, snippet: r.get(2)? }))?;
    let mut out = Vec::new();
    for h in rows {
        if out.len() as i64 >= limit {
            break;
        }
        let h = h?;
        if report_in_window(c, scope, h.import_id)? {
            out.push(h);
        }
    }
    Ok(out)
}

pub fn report_show(c: &Db, scope: &Scope, import_id: i64) -> Result<String> {
    if !report_in_window(c, scope, import_id)? {
        return Err(Error::not_found("no_report", import_id.to_string()));
    }
    one(c, "SELECT t.text FROM report_text t JOIN import i ON i.id = t.rowid WHERE t.rowid = ? AND i.status = 'done'", [import_id])?
        .ok_or_else(|| Error::not_found("no_report", import_id.to_string()))
}

/// What a scope hides, so a delegate never reads "not visible" as "none".
#[derive(Debug, Serialize, serde::Deserialize, schemars::JsonSchema, PartialEq)]
pub struct Withheld {
    /// Metrics holding data outside the granted groups
    pub metrics: i64,
    /// Granted metrics have data before the window
    pub earlier_data: bool,
}

pub fn withheld(c: &Db, scope: &Scope) -> Result<Withheld> {
    let mut st = c.prepare("SELECT id, code FROM metric WHERE EXISTS (SELECT 1 FROM v_observation o WHERE o.metric_id = metric.id)")?;
    let with_data: Vec<(i64, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    let mut w = Withheld { metrics: 0, earlier_data: false };
    for (id, code) in with_data {
        if !scope.allows(&code) {
            w.metrics += 1;
        } else if !w.earlier_data && scope.from_ms > i64::MIN {
            w.earlier_data =
                one::<i64>(c, "SELECT 1 FROM v_observation WHERE metric_id = ? AND start_ms < ? LIMIT 1", [id, scope.from_ms])?.is_some();
        }
    }
    Ok(w)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::GrantSpec;
    use crate::keys::MemoryStore;
    use crate::profile::Profile;

    /// An alias is a name printed on the person's own report: a grant without that measure's group finds nothing
    /// through it (it would tell the agent the person had the test), while the owner still does
    #[test]
    fn a_printed_name_finds_a_measure_only_within_the_grant() {
        let dir = tempfile::tempdir().unwrap();
        let p = Profile::init(dir.path(), "a", &MemoryStore::default()).unwrap();
        p.db.execute(
            "INSERT INTO metric_alias (alias, unit, metric_id) SELECT 'hcv load', '', id FROM metric WHERE code = 'loinc:11011-4'",
            [],
        )
        .unwrap();
        let spec: GrantSpec = serde_json::from_value(serde_json::json!({
            "name": "t", "groups": ["body"], "detail": true, "window": "all", "reports": false, "write": "none", "expires_ms": i64::MAX
        }))
        .unwrap();
        let codes = |scope: &Scope, q: &str| -> Vec<String> {
            metric_search(&p.db, scope, q, 20, &[], false).unwrap().into_iter().map(|m| m.code).collect()
        };
        assert_eq!(codes(&Scope::all(), "hcv load"), ["loinc:11011-4"]);
        assert!(codes(&Scope::of(&spec, 0), "hcv load").is_empty());
        // the catalog by its own name stays public
        assert!(codes(&Scope::of(&spec, 0), "Hepatitis C virus RNA").contains(&"loinc:11011-4".to_string()));
    }
}
