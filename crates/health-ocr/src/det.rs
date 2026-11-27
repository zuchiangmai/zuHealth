//! Text detection (PP-OCRv5 mobile det, DB): scaling, normalising, binarising the probability map, boxes from
//! connected regions. Port of the web `ocr/det.ts`, rule for rule; only axis-aligned boxes. A slanted photo is
//! straightened first: `skew` measures the text-line angle, `rotate` turns the whole image.

use crate::types::{Bx, Img, clamp_u8};

const MEAN: [f64; 3] = [0.485, 0.456, 0.406];
const STD: [f64; 3] = [0.229, 0.224, 0.225];

pub struct DetInput {
    /// [1,3,h,w], NCHW
    pub tensor: Vec<f32>,
    pub w: usize,
    pub h: usize,
    /// model → image coordinates
    pub sx: f64,
    pub sy: f64,
}

/// Longest side to `target` (enlarging at most twice), both sides multiples of 32 (at least 32).
pub fn det_size(width: usize, height: usize, target: f64) -> (usize, usize) {
    let r = (target / width.max(height) as f64).min(2.0);
    let round32 = |v: usize| (((v as f64 * r) / 32.0).round() as usize * 32).max(32);
    (round32(width), round32(height))
}

/// Bilinear resize and normalise; "bgr" channel order as PaddleOCR.
pub fn det_prepare(img: &Img, limit: f64, bgr: bool) -> DetInput {
    let (w, h) = det_size(img.width, img.height, limit);
    let plane = w * h;
    let mut out = vec![0f32; 3 * plane];
    let order = if bgr { [2, 1, 0] } else { [0, 1, 2] };
    let xr = img.width as f64 / w as f64;
    let yr = img.height as f64 / h as f64;
    let (iw, ih) = (img.width, img.height);
    for y in 0..h {
        let fy = ((ih - 1) as f64).min((y as f64 + 0.5) * yr - 0.5);
        let y0 = fy.floor().max(0.0) as usize;
        let y1 = (ih - 1).min(y0 + 1);
        let wy = fy - y0 as f64;
        for x in 0..w {
            let fx = ((iw - 1) as f64).min((x as f64 + 0.5) * xr - 0.5);
            let x0 = fx.floor().max(0.0) as usize;
            let x1 = (iw - 1).min(x0 + 1);
            let wx = fx - x0 as f64;
            for c in 0..3 {
                let ch = order[c];
                let p = |yy: usize, xx: usize| img.data[(yy * iw + xx) * 4 + ch] as f64;
                let v = (p(y0, x0) * (1.0 - wx) + p(y0, x1) * wx) * (1.0 - wy) + (p(y1, x0) * (1.0 - wx) + p(y1, x1) * wx) * wy;
                out[c * plane + y * w + x] = ((v / 255.0 - MEAN[c]) / STD[c]) as f32;
            }
        }
    }
    DetInput { tensor: out, w, h, sx: iw as f64 / w as f64, sy: ih as f64 / h as f64 }
}

pub struct DetOptions {
    pub thresh: f64,
    pub box_thresh: f64,
    pub unclip: f64,
    pub min_size: f64,
}

impl Default for DetOptions {
    fn default() -> Self {
        DetOptions { thresh: 0.3, box_thresh: 0.6, unclip: 1.5, min_size: 3.0 }
    }
}

/// Probability map (h×w, 0–1) → boxes in image coordinates, top to bottom then left to right.
pub fn det_boxes(prob: &[f32], w: usize, h: usize, sx: f64, sy: f64, o: &DetOptions) -> Vec<Bx> {
    let mut seen = vec![false; w * h];
    let mut stack: Vec<usize> = Vec::new();
    let mut boxes = Vec::new();
    let above = |i: usize| prob[i] as f64 > o.thresh;
    for start in 0..w * h {
        if seen[start] || !above(start) {
            continue;
        }
        stack.clear();
        stack.push(start);
        seen[start] = true;
        let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
        let (mut sum, mut n) = (0f64, 0usize);
        while let Some(i) = stack.pop() {
            let x = i % w;
            let y = i / w;
            sum += prob[i] as f64;
            n += 1;
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
            let mut visit = |j: usize| {
                if !seen[j] && above(j) {
                    seen[j] = true;
                    stack.push(j);
                }
            };
            if x > 0 {
                visit(i - 1);
            }
            if x < w - 1 {
                visit(i + 1);
            }
            if y > 0 {
                visit(i - w);
            }
            if y < h - 1 {
                visit(i + w);
            }
        }
        if sum / (n as f64) < o.box_thresh {
            continue;
        }
        let bw = (x1 - x0 + 1) as f64;
        let bh = (y1 - y0 + 1) as f64;
        if bw.min(bh) * sx.min(sy) < o.min_size {
            continue;
        }
        // DB unclip: distance = area × ratio / perimeter, on every side
        let d = (bw * bh * o.unclip) / (2.0 * (bw + bh));
        let ex0 = (x0 as f64 - d).max(0.0);
        let ey0 = (y0 as f64 - d).max(0.0);
        let ex1 = (w as f64).min(x1 as f64 + 1.0 + d);
        let ey1 = (h as f64).min(y1 as f64 + 1.0 + d);
        boxes.push(Bx { x: ex0 * sx, y: ey0 * sy, w: (ex1 - ex0) * sx, h: (ey1 - ey0) * sy });
    }
    // JS: a.y - b.y || a.x - b.x
    boxes.sort_by(|a, b| {
        let dy = a.y - b.y;
        if dy != 0.0 { dy.partial_cmp(&0.0).unwrap() } else { (a.x - b.x).partial_cmp(&0.0).unwrap() }
    });
    boxes
}

/// Text-line angle (radians, positive = slanting down to the right): each long thin region's main axis by its
/// second moments, area-weighted median. Fewer than 5 such regions → 0.
pub fn det_skew(prob: &[f32], w: usize, h: usize, sx: f64, sy: f64) -> f64 {
    let thresh = 0.3;
    let mut seen = vec![false; w * h];
    let mut stack: Vec<usize> = Vec::new();
    let mut found: Vec<(f64, usize)> = Vec::new();
    let above = |i: usize| prob[i] as f64 > thresh;
    for start in 0..w * h {
        if seen[start] || !above(start) {
            continue;
        }
        stack.clear();
        stack.push(start);
        seen[start] = true;
        let mut n = 0usize;
        let (mut mx, mut my, mut mxx, mut myy, mut mxy) = (0f64, 0f64, 0f64, 0f64, 0f64);
        while let Some(i) = stack.pop() {
            let x = (i % w) as f64 * sx;
            let y = (i / w) as f64 * sy;
            n += 1;
            mx += x;
            my += y;
            mxx += x * x;
            myy += y * y;
            mxy += x * y;
            let px = i % w;
            let mut visit = |j: usize| {
                if !seen[j] && above(j) {
                    seen[j] = true;
                    stack.push(j);
                }
            };
            if px > 0 {
                visit(i - 1);
            }
            if px < w - 1 {
                visit(i + 1);
            }
            if i >= w {
                visit(i - w);
            }
            if i < w * (h - 1) {
                visit(i + w);
            }
        }
        if n < 30 {
            continue;
        }
        let nf = n as f64;
        mx /= nf;
        my /= nf;
        let cxx = mxx / nf - mx * mx;
        let cyy = myy / nf - my * my;
        let cxy = mxy / nf - mx * my;
        let a = 0.5 * (2.0 * cxy).atan2(cxx - cyy);
        let tr = cxx + cyy;
        let disc = (((cxx - cyy) / 2.0).powi(2) + cxy * cxy).max(0.0).sqrt();
        let l1 = tr / 2.0 + disc;
        let l2 = (tr / 2.0 - disc).max(1e-6);
        if l1 / l2 < 16.0 || a.abs() > std::f64::consts::PI / 18.0 {
            continue;
        }
        found.push((a, n));
    }
    if found.len() < 5 {
        return 0.0;
    }
    found.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap());
    let half = found.iter().map(|f| f.1 as f64).sum::<f64>() / 2.0;
    let mut acc = 0f64;
    for (a, n) in found {
        acc += n as f64;
        if acc >= half {
            return a;
        }
    }
    0.0
}

/// Rotates the image about its centre by −a (levels text slanted by a); same size, white outside. Bilinear.
pub fn rotate(img: &Img, a: f64) -> Img {
    let (ww, hh) = (img.width, img.height);
    let mut out = vec![0u8; ww * hh * 4];
    let (c, s) = (a.cos(), a.sin());
    let (cx, cy) = (ww as f64 / 2.0, hh as f64 / 2.0);
    for y in 0..hh {
        let dy = y as f64 - cy;
        for x in 0..ww {
            let dx = x as f64 - cx;
            let fx = cx + dx * c - dy * s;
            let fy = cy + dx * s + dy * c;
            let t = (y * ww + x) * 4;
            if fx < 0.0 || fy < 0.0 || fx > (ww - 1) as f64 || fy > (hh - 1) as f64 {
                out[t..t + 4].copy_from_slice(&[255, 255, 255, 255]);
                continue;
            }
            let x0 = fx.floor() as usize;
            let y0 = fy.floor() as usize;
            let x1 = (ww - 1).min(x0 + 1);
            let y1 = (hh - 1).min(y0 + 1);
            let wx = fx - x0 as f64;
            let wy = fy - y0 as f64;
            for k in 0..4 {
                let p = |yy: usize, xx: usize| img.data[(yy * ww + xx) * 4 + k] as f64;
                out[t + k] =
                    clamp_u8((p(y0, x0) * (1.0 - wx) + p(y0, x1) * wx) * (1.0 - wy) + (p(y1, x0) * (1.0 - wx) + p(y1, x1) * wx) * wy);
            }
        }
    }
    Img { data: out, width: ww, height: hh }
}
