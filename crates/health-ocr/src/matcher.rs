//! Measure candidates for printed items (web `ocr/match.ts`): a printed name is translated (lexicon), embedded,
//! and compared with the catalog's precomputed vectors; only measures whose units fit the printed unit count.
//! A common item found directly (`health_core::ocr::code_for`) ranks first with score 1. Only a clear winner
//! is preselected; the person decides.

use crate::embed::{EMBED_DIM, Embedder, cosine};
use crate::lexicon::queries_of;
use health_core::ocr::{OcrItem, Suggestion, code_for, unit_fits};
use std::sync::LazyLock;

/// Measured on hospital CBC samples with multilingual-e5-small: right 0.88–0.93, wrong 0.83–0.87
pub const PRESELECT_MIN: f64 = 0.89;
pub const PRESELECT_GAP: f64 = 0.01;
pub const SUGGEST_MIN: f64 = 0.875;
pub const SUGGEST_MAX: usize = 3;

pub struct MetricRef {
    pub code: String,
    pub units: Vec<String>,
    /// text-valued (agg none)
    pub text: bool,
}

pub struct Index {
    pub refs: Vec<MetricRef>,
    pub vecs: Vec<Vec<f32>>,
}

/// Vectors stored as int8 plus one f32 scale each (data/catalog-vectors.bin), normalised on load.
pub fn unpack_vectors(bytes: &[u8], dim: usize) -> Vec<Vec<f32>> {
    bytes
        .chunks_exact(4 + dim)
        .map(|c| {
            let scale = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
            let mut v: Vec<f32> = c[4..].iter().map(|&b| (b as i8) as f32 * scale).collect();
            let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            let norm = if norm == 0.0 { 1.0 } else { norm };
            v.iter_mut().for_each(|x| *x /= norm);
            v
        })
        .collect()
}

/// The catalog index in the order of the precomputed vectors (data/ocr-metrics.txt).
pub static CATALOG: LazyLock<Index> = LazyLock::new(|| {
    let codes: Vec<&str> = include_str!("../data/ocr-metrics.txt").lines().filter(|l| !l.starts_with('#') && !l.is_empty()).collect();
    let vecs = unpack_vectors(include_bytes!("../data/catalog-vectors.bin"), EMBED_DIM);
    assert_eq!(codes.len(), vecs.len(), "ocr-metrics.txt and catalog-vectors.bin differ");
    let cat: std::collections::HashMap<&str, (&str, &str)> = health_core::catalog::rows().map(|(c, _, u, a)| (c, (u, a))).collect();
    let refs = codes
        .iter()
        .map(|code| {
            let (unit, agg) = cat.get(code).copied().unwrap_or(("", ""));
            MetricRef { code: code.to_string(), units: health_core::units::allowed_units(code, unit), text: agg == "none" }
        })
        .collect();
    Index { refs, vecs }
});

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// Candidates by similarity among measures of the right kind whose units fit (text results ignore units).
pub fn rank(index: &Index, queries: &[Vec<f32>], printed_unit: &str, text: Option<bool>) -> Vec<Suggestion> {
    let mut out: Vec<Suggestion> = Vec::new();
    for (r, v) in index.refs.iter().zip(&index.vecs) {
        if text.is_some_and(|t| t != r.text) {
            continue;
        }
        if !(text == Some(true) && r.text) && !unit_fits(printed_unit, &r.units) {
            continue;
        }
        let score = queries.iter().map(|q| cosine(q, v)).fold(f64::NEG_INFINITY, f64::max);
        if score >= SUGGEST_MIN {
            out.push(Suggestion { code: r.code.clone(), score: round3(score) });
        }
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
    out.truncate(SUGGEST_MAX);
    out
}

fn is_ratio(units: &[String]) -> bool {
    units.len() == 1 && units[0] == "{ratio}"
}

/// A common item found directly, if it is in the index and its unit fits (text and ratios ignore units).
pub fn direct(index: &Index, it: &OcrItem) -> Option<Suggestion> {
    let code = code_for(&it.name, it.panel.as_deref(), it.specimen.as_deref(), &it.v)?;
    let r = index.refs.iter().find(|r| r.code == code)?;
    if !it.v.is_text() && !is_ratio(&r.units) && !unit_fits(&it.unit, &r.units) {
        return None;
    }
    Some(Suggestion { code: r.code.clone(), score: 1.0 })
}

pub fn suggest(index: &Index, queries: &[Vec<f32>], it: &OcrItem) -> Vec<Suggestion> {
    let ranked = rank(index, queries, &it.unit, Some(it.v.is_text()));
    match direct(index, it) {
        Some(d) => {
            let mut out = vec![d.clone()];
            out.extend(ranked.into_iter().filter(|s| s.code != d.code));
            out.truncate(SUGGEST_MAX);
            out
        }
        None => ranked,
    }
}

/// The first candidate, when it is clearly ahead.
pub fn preselected(s: &[Suggestion]) -> Option<&Suggestion> {
    let a = s.first()?;
    if a.score < PRESELECT_MIN {
        return None;
    }
    match s.get(1) {
        Some(b) if a.score - b.score < PRESELECT_GAP => None,
        _ => Some(a),
    }
}

/// Candidates for every item. Each item's queries are embedded on their own, as the web does: the int8 model
/// quantises a whole batch at once, so batching items together would shift their scores.
pub fn match_items(e: &Embedder, items: &[OcrItem]) -> anyhow::Result<Vec<Vec<Suggestion>>> {
    items.iter().map(|it| Ok(suggest(&CATALOG, &e.embed(&queries_of(&it.name), "query")?, it))).collect()
}
