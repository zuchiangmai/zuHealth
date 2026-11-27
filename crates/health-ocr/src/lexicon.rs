//! Common Chinese names and abbreviations of lab items → English (web `ocr/lexicon.ts`): the embedding model
//! matches Chinese medical terms poorly, so known names are translated before searching. Table generated
//! from the web (data/lexicon.json).

use health_core::units::js_space;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

fn fold(s: &str) -> String {
    s.nfkc().collect::<String>().to_lowercase().chars().filter(|c| !js_space(*c)).collect()
}

fn cjk(s: &str) -> bool {
    s.chars().any(|c| ('一'..='\u{9fff}').contains(&c))
}

/// (folded key, English), longest key first
static TABLE: LazyLock<Vec<(String, String)>> = LazyLock::new(|| {
    let v: serde_json::Value = serde_json::from_str(include_str!("../data/lexicon.json")).expect("lexicon.json");
    let mut t: Vec<(String, String)> = Vec::new();
    for row in v["rows"].as_array().expect("rows") {
        let row: Vec<&str> = row.as_array().expect("row").iter().filter_map(|x| x.as_str()).collect();
        let (english, keys) = row.split_last().expect("row");
        t.extend(keys.iter().map(|k| (fold(k), english.to_string())));
    }
    // JS sorts by UTF-16 length, longest first (stable)
    t.sort_by_key(|e| std::cmp::Reverse(e.0.encode_utf16().count()));
    t
});

/// Printed name → the English to search with: a whole-key match, or a longer Chinese key inside the name.
/// Abbreviations match only whole. Unknown names come back unchanged.
pub fn english_for(printed: &str) -> String {
    let f = fold(printed);
    if f.is_empty() {
        return printed.to_string();
    }
    if let Some((_, e)) = TABLE.iter().find(|(k, _)| *k == f) {
        return e.clone();
    }
    TABLE
        .iter()
        .find(|(k, _)| cjk(k) && k.encode_utf16().count() >= 2 && f.contains(k.as_str()))
        .map(|(_, e)| e.clone())
        .unwrap_or_else(|| printed.to_string())
}

/// Query texts: the English, plus an English printed name itself (Chinese originals embed poorly).
pub fn queries_of(name: &str) -> Vec<String> {
    let en = english_for(name);
    let mut out = vec![en.clone()];
    if en != name && !name.chars().any(|c| ('\u{3400}'..='\u{9fff}').contains(&c)) {
        out.push(name.to_string());
    }
    out
}
