//! Metric catalog, compiled in from data/metrics.tsv (generated from the web catalog by scripts/gen-catalog.ts).

use crate::db::Db;
use crate::error::Result;

const TSV: &str = include_str!("../data/metrics.tsv");

/// (code, name, unit, agg)
pub fn rows() -> impl Iterator<Item = (&'static str, &'static str, &'static str, &'static str)> {
    lines().map(|f| (f[0], f[1], f[2], f[3]))
}

fn lines() -> impl Iterator<Item = [&'static str; 5]> {
    TSV.lines().filter(|l| !l.starts_with('#') && !l.is_empty()).map(|l| {
        let mut f = l.split('\t');
        let mut next = || f.next().expect("metrics.tsv has 5 columns");
        [next(), next(), next(), next(), next()]
    })
}

/// Sensitivity groups (external-analysis grading): normal ones first.
pub const GROUPS: &[(&str, bool)] = &[
    ("body", false),
    ("sleep", false),
    ("cardio", false),
    ("activity", false),
    ("lab", false),
    ("infectious", true),
    ("tumor", true),
    ("repro", true),
    ("custom", true),
    ("lab_other", true),
    ("other", true),
    ("derived", true),
];

/// Is the code one of the compiled-in catalog's (public knowledge, no personal data)?
pub fn is_catalog(code: &str) -> bool {
    use std::sync::OnceLock;
    static SET: OnceLock<std::collections::HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| lines().map(|f| f[0]).collect()).contains(code)
}

/// Group of a metric code: catalog column; user-made `x:ocr/` = custom; anything unknown = other (strict).
pub fn group_of(code: &str) -> &'static str {
    use std::sync::OnceLock;
    static MAP: OnceLock<std::collections::HashMap<&'static str, &'static str>> = OnceLock::new();
    if code.starts_with("x:ocr/") {
        return "custom";
    }
    if code.starts_with("x:derived/") {
        return "derived";
    }
    MAP.get_or_init(|| lines().map(|f| (f[0], f[4])).collect()).get(code).copied().unwrap_or("other")
}

/// Inserts catalog metrics that are missing (by code). Returns how many were added.
pub fn seed(c: &Db) -> Result<usize> {
    let mut st = c.prepare("INSERT OR IGNORE INTO metric (code, name, unit, agg) VALUES (?, ?, ?, ?)")?;
    let mut n = 0;
    for (code, name, unit, agg) in rows() {
        n += st.execute([code, name, unit, agg])?;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    #[test]
    fn catalog_is_well_formed() {
        let mut seen = std::collections::HashSet::new();
        for (code, name, _, agg) in super::rows() {
            assert!(seen.insert(code), "duplicate {code}");
            assert!(!name.is_empty());
            assert!(["instant", "cumulative", "interval", "level", "none"].contains(&agg), "{code} {agg}");
            assert!(super::GROUPS.iter().any(|(g, _)| *g == super::group_of(code)), "{code}");
        }
        assert!(seen.len() > 900);
        assert_eq!(super::group_of("loinc:2345-7"), "lab");
        assert_eq!(super::group_of("loinc:22322-2"), "infectious");
        assert_eq!(super::group_of("x:ocr/ferritin"), "custom");
        assert_eq!(super::group_of("x:never-seen"), "other");
    }
}
