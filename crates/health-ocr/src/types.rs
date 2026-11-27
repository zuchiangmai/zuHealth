//! Shared types of the OCR pipeline (web `ocr/types.ts`).

/// RGBA pixels, row by row (the browser's ImageData layout).
#[derive(Clone)]
pub struct Img {
    pub data: Vec<u8>,
    pub width: usize,
    pub height: usize,
}

/// Axis-aligned text box in image pixels.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Bx {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// One recognised text box.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Line {
    pub text: String,
    #[serde(rename = "box")]
    pub bx: Bx,
    /// Mean of each character's best probability (0–1)
    pub score: f64,
}

/// JS Uint8ClampedArray assignment: clamp to 0–255, round half to even.
pub fn clamp_u8(v: f64) -> u8 {
    if v.is_nan() { 0 } else { v.clamp(0.0, 255.0).round_ties_even() as u8 }
}
