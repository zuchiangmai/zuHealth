//! The two OCR models joined (web `ocr/engine.ts`): detect, straighten a slanted page and detect again,
//! recognise each box. Inference is tract (pure Rust): no native runtime to download (decision 50).

use crate::det::{DetOptions, det_boxes, det_prepare, det_skew, rotate};
use crate::rec::{REC_H, ctc_decode, parse_dict, rec_prepare};
use crate::types::{Img, Line};
use std::collections::HashMap;
use std::sync::Mutex;
use tract_onnx::prelude::*;

/// Slant above this (radians, about 0.4°) is straightened; less isn't worth a second detection
const SKEW_MIN: f64 = 0.007;

type Plan = TypedSimplePlan;

pub struct Engine {
    /// The detection model is compiled per input size (the declared symbolic shapes don't unify in tract)
    det_model: InferenceModel,
    det_plans: Mutex<HashMap<(usize, usize), Arc<Plan>>>,
    rec: Arc<Plan>,
    table: Vec<String>,
}

fn load(bytes: &[u8]) -> TractResult<InferenceModel> {
    tract_onnx::onnx().with_ignore_output_shapes(true).with_ignore_value_info(true).model_for_read(&mut std::io::Cursor::new(bytes))
}

impl Engine {
    pub fn new(det: &[u8], rec: &[u8], dict: &str) -> TractResult<Engine> {
        let det_model = load(det)?;
        let rec_model = load(rec)?;
        let w = rec_model.symbols.sym("W");
        let rec = rec_model
            .with_input_fact(0, f32::fact(&[1.to_dim(), 3.to_dim(), REC_H.to_dim(), w.to_dim()]).into())?
            .into_optimized()?
            .into_runnable()?;
        Ok(Engine { det_model, det_plans: Mutex::new(HashMap::new()), rec, table: parse_dict(dict) })
    }

    fn det_plan(&self, h: usize, w: usize) -> TractResult<Arc<Plan>> {
        if let Some(p) = self.det_plans.lock().unwrap().get(&(h, w)) {
            return Ok(p.clone());
        }
        let p = self.det_model.clone().with_input_fact(0, f32::fact([1, 3, h, w]).into())?.into_optimized()?.into_runnable()?;
        self.det_plans.lock().unwrap().insert((h, w), p.clone());
        Ok(p)
    }

    fn detect(&self, img: &Img, limit: f64) -> TractResult<(crate::det::DetInput, Vec<f32>)> {
        let d = det_prepare(img, limit, true);
        let input = Tensor::from_shape(&[1, 3, d.h, d.w], &d.tensor)?;
        let out = self.det_plan(d.h, d.w)?.run(tvec!(input.into()))?;
        let prob = out[0].to_plain_array_view::<f32>()?.iter().copied().collect();
        Ok((d, prob))
    }

    /// Text lines of one page, in image coordinates of the (possibly straightened) page.
    /// `progress(done, total)` once the boxes are recognised.
    pub fn recognize(&self, input: &Img, progress: &mut dyn FnMut(usize, usize)) -> TractResult<Vec<Line>> {
        let limit = 1920.0;
        let mut img = input.clone();
        let (mut d, mut prob) = self.detect(&img, limit)?;
        // slanted more than 0.4°: straighten the whole page and detect again
        let a = det_skew(&prob, d.w, d.h, d.sx, d.sy);
        if a.abs() > SKEW_MIN {
            img = rotate(&img, a);
            (d, prob) = self.detect(&img, limit)?;
        }
        let boxes = det_boxes(&prob, d.w, d.h, d.sx, d.sy, &DetOptions::default());
        // boxes are independent: recognise them on every core, then decode in reading order
        let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).clamp(1, 8);
        let done = std::sync::atomic::AtomicUsize::new(0);
        let results: Vec<TractResult<(Vec<f32>, usize, usize)>> = std::thread::scope(|sc| {
            let chunk = boxes.len().div_ceil(threads).max(1);
            let handles: Vec<_> = boxes
                .chunks(chunk)
                .map(|part| {
                    let (img, rec, done) = (&img, &self.rec, &done);
                    sc.spawn(move || {
                        part.iter()
                            .map(|b| {
                                let (tensor, w) = rec_prepare(img, b, true);
                                let out = rec.run(tvec!(Tensor::from_shape(&[1, 3, REC_H, w], &tensor)?.into()))?;
                                done.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                let shape = out[0].shape().to_vec();
                                Ok((out[0].to_plain_array_view::<f32>()?.iter().copied().collect(), shape[1], shape[2]))
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().expect("recognition thread")).collect()
        });
        progress(done.into_inner(), boxes.len());
        let mut lines = Vec::new();
        for (b, r) in boxes.iter().zip(results) {
            let (logits, steps, classes) = r?;
            let (text, score) = ctc_decode(&logits, steps, classes, &self.table);
            let text = text.trim();
            if !text.is_empty() {
                lines.push(Line { text: text.to_string(), bx: *b, score });
            }
        }
        Ok(lines)
    }
}
