//! Text recognition (PP-OCRv5 mobile rec, CTC): crop a line, scale to height 48, normalise, greedy decode.
//! Port of the web `ocr/rec.ts`.

use crate::types::{Bx, Img};

pub const REC_H: usize = 48;
/// Widest line the model gets; longer ones are squeezed
pub const REC_MAX_W: usize = 1600;

/// Crops `b` (padded a little), scales it to height 48, (v/255 − 0.5)/0.5. Returns the tensor and its width.
pub fn rec_prepare(img: &Img, b: &Bx, bgr: bool) -> (Vec<f32>, usize) {
    let pad_x = (b.h * 0.1).round();
    let pad_y = (b.h * 0.05).round();
    let x0 = (b.x - pad_x).floor().max(0.0) as usize;
    let y0 = (b.y - pad_y).floor().max(0.0) as usize;
    let x1 = (img.width as f64).min((b.x + b.w + pad_x).ceil()) as usize;
    let y1 = (img.height as f64).min((b.y + b.h + pad_y).ceil()) as usize;
    let cw = x1.saturating_sub(x0).max(1);
    let ch = y1.saturating_sub(y0).max(1);
    let w = REC_MAX_W.min(((REC_H / 2) as f64).max(((REC_H * cw) as f64 / ch as f64).ceil()) as usize);
    let plane = REC_H * w;
    let mut out = vec![0f32; 3 * plane];
    let order = if bgr { [2, 1, 0] } else { [0, 1, 2] };
    for y in 0..REC_H {
        let fy = ((ch - 1) as f64).min((((y as f64 + 0.5) * ch as f64) / REC_H as f64 - 0.5).max(0.0));
        let ya = fy.floor() as usize;
        let yb = (ch - 1).min(ya + 1);
        let wy = fy - ya as f64;
        for x in 0..w {
            let fx = ((cw - 1) as f64).min((((x as f64 + 0.5) * cw as f64) / w as f64 - 0.5).max(0.0));
            let xa = fx.floor() as usize;
            let xb = (cw - 1).min(xa + 1);
            let wx = fx - xa as f64;
            for c in 0..3 {
                let k = order[c];
                let at = |yy: usize, xx: usize| img.data[((y0 + yy) * img.width + (x0 + xx)) * 4 + k] as f64;
                let v = (at(ya, xa) * (1.0 - wx) + at(ya, xb) * wx) * (1.0 - wy) + (at(yb, xa) * (1.0 - wx) + at(yb, xb) * wx) * wy;
                out[c * plane + y * w + x] = ((v / 255.0 - 0.5) / 0.5) as f32;
            }
        }
    }
    (out, w)
}

/// Dictionary → character table: class 0 is the CTC blank, 1…n the dictionary, the last a space.
pub fn parse_dict(text: &str) -> Vec<String> {
    let mut chars: Vec<String> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect();
    if chars.last().is_some_and(|l| l.is_empty()) {
        chars.pop();
    }
    let mut t = vec![String::new()];
    t.extend(chars);
    t.push(" ".into());
    t
}

/// Logits/probabilities [T, C] → text and confidence (greedy: best per step, repeats merged, blanks dropped).
pub fn ctc_decode(out: &[f32], steps: usize, classes: usize, table: &[String]) -> (String, f64) {
    let mut text = String::new();
    let (mut sum, mut n) = (0f64, 0usize);
    let mut prev = usize::MAX;
    for t in 0..steps {
        let row = &out[t * classes..(t + 1) * classes];
        let (mut best, mut bv) = (0usize, f32::NEG_INFINITY);
        for (c, &v) in row.iter().enumerate() {
            if v > bv {
                bv = v;
                best = c;
            }
        }
        if best != 0 && best != prev {
            text.push_str(table.get(best).map(String::as_str).unwrap_or(""));
            sum += bv as f64;
            n += 1;
        }
        prev = best;
    }
    (text, if n > 0 { sum / n as f64 } else { 0.0 })
}
