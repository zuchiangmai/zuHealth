//! Lab report OCR (plan §4.4, M5): image or PDF → text lines → table items → measure candidates.
//! A port of the web `ocr/` modules; runs only in the `health ocr-worker` process, never in the writer.

pub mod components;
pub mod date;
pub mod det;
pub mod embed;
pub mod engine;
pub mod input;
pub mod lexicon;
pub mod matcher;
pub mod rec;
pub mod rows;
pub mod types;

use engine::Engine;
use health_core::ocr::{Recognized, RecognizedItem};
use types::Line;

/// The loaded models: recognition always, matching when the embedding model is installed.
pub struct Models {
    pub engine: Engine,
    pub embed: Option<embed::Embedder>,
}

/// One page's lines as text: rows top to bottom, cells joined by spaces (web `pageText`).
pub fn page_text(lines: &[Line]) -> String {
    rows::group_rows(lines)
        .iter()
        .map(|r| r.cells.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every page → table items with candidates, the full text and the report date (web `ocr-flow.ts`).
/// `this_year` comes from the caller. `progress(page, pages)` before each page. Matching failing is not
/// fatal: the items just carry no candidates.
pub fn recognize(m: &Models, input: &input::Input, this_year: i32, progress: &mut dyn FnMut(usize, usize)) -> anyhow::Result<Recognized> {
    let mut items = Vec::new();
    let mut texts = Vec::new();
    let mut all: Vec<Line> = Vec::new();
    let pages = input.page_count();
    for i in 0..pages {
        progress(i, pages);
        let lines = m.engine.recognize(&input.page(i), &mut |_, _| {})?;
        texts.push(page_text(&lines));
        items.extend(rows::read_table(&lines).items);
        all.extend(lines);
    }
    let sug = match &m.embed {
        Some(e) => matcher::match_items(e, &items).unwrap_or_default(),
        None => vec![],
    };
    let items = items
        .into_iter()
        .enumerate()
        .map(|(i, mut item)| {
            let s = sug.get(i).cloned().unwrap_or_default();
            let pre = matcher::preselected(&s).map(|x| x.code.clone());
            item.suggest = s;
            RecognizedItem { item, pre }
        })
        .collect();
    let text: String = texts.join("\n").chars().take(100_000).collect();
    Ok(Recognized { items, text, date: date::report_date(&all, this_year).map(|d| d.iso()) })
}
