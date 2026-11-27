//! A chosen file → its SHA-256 and pages of pixels (web `ocr-input.ts`): images are decoded (phone photos
//! turned upright by their EXIF orientation), PDFs rendered page by page (hayro, pure Rust). The longest
//! side is capped at 3200 px; transparency goes on white.

use crate::types::Img;
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub const MAX_SIDE: u32 = 3200;
pub const MAX_PAGES: usize = 12;
pub const MAX_BYTES: u64 = 40 * 1024 * 1024;
/// Largest image decoded (phone cameras reach about 8000 px a side)
const MAX_DECODE_SIDE: u32 = 12_000;
const MAX_DECODE_BYTES: u64 = 600 * 1024 * 1024;

fn too_big_or_unreadable(e: image::ImageError) -> InputError {
    if matches!(e, image::ImageError::Limits(_)) { InputError::TooBig } else { InputError::Unreadable }
}

pub struct Input {
    pub sha: String,
    pub pages: Vec<Img>,
}

/// Why a file can't be read, as a code the UI explains.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputError {
    TooBig,
    /// Not an image or PDF Health can read (HEIC too: export as JPEG)
    Unsupported,
    Unreadable,
    /// The PDF needs a password
    Password,
}

impl InputError {
    pub fn code(self) -> &'static str {
        match self {
            InputError::TooBig => "too_big",
            InputError::Unsupported => "unsupported",
            InputError::Unreadable => "unreadable",
            InputError::Password => "password",
        }
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn read_input(bytes: &[u8]) -> Result<Input, InputError> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err(InputError::TooBig);
    }
    let sha = sha256_hex(bytes);
    let pages = if bytes.starts_with(b"%PDF") { pdf_pages(bytes)? } else { vec![image_page(bytes)?] };
    if pages.is_empty() {
        return Err(InputError::Unreadable);
    }
    Ok(Input { sha, pages })
}

fn fit(w: u32, h: u32) -> (u32, u32) {
    let r = (MAX_SIDE as f64 / w.max(h) as f64).min(1.0);
    (((w as f64 * r).round() as u32).max(1), ((h as f64 * r).round() as u32).max(1))
}

fn image_page(bytes: &[u8]) -> Result<Img, InputError> {
    use image::{ImageDecoder, ImageReader};
    let format = image::guess_format(bytes).map_err(|_| InputError::Unsupported)?;
    let mut reader = ImageReader::with_format(std::io::Cursor::new(bytes), format);
    // a small file can declare a huge image (60000×60000 takes 9 GB): refuse before decoding
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DECODE_SIDE);
    limits.max_image_height = Some(MAX_DECODE_SIDE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(too_big_or_unreadable)?;
    let orientation = decoder.orientation().ok();
    let mut img = image::DynamicImage::from_decoder(decoder).map_err(too_big_or_unreadable)?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    let (w, h) = fit(img.width(), img.height());
    let rgba = if (w, h) == (img.width(), img.height()) {
        img.to_rgba8()
    } else {
        image::imageops::resize(&img.to_rgba8(), w, h, image::imageops::FilterType::Triangle)
    };
    // on white, as the browser's canvas does
    let mut data = rgba.into_raw();
    for p in data.as_chunks_mut::<4>().0 {
        let a = p[3] as u32;
        if a < 255 {
            for c in &mut p[..3] {
                *c = ((*c as u32 * a + 255 * (255 - a) + 127) / 255) as u8;
            }
            p[3] = 255;
        }
    }
    Ok(Img { data, width: w as usize, height: h as usize })
}

/// System fonts for PDFs that use a CJK font without embedding it.
fn cjk_font() -> Option<hayro::hayro_interpret::font::FontData> {
    const CANDIDATES: &[&str] = &[
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "C:\\Windows\\Fonts\\msyh.ttc",
        "C:\\Windows\\Fonts\\simsun.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
    ];
    CANDIDATES.iter().find_map(|p| std::fs::read(p).ok()).map(|d| Arc::new(d) as hayro::hayro_interpret::font::FontData)
}

fn pdf_pages(bytes: &[u8]) -> Result<Vec<Img>, InputError> {
    use hayro::hayro_interpret::font::FontQuery;
    use hayro::hayro_interpret::{InterpreterSettings, hayro_syntax::Pdf};
    use hayro::vello_cpu::color::palette::css::WHITE;
    use hayro::{PixmapSettings, RenderCache, RenderSettings, render};
    let pdf = Pdf::new(bytes.to_vec()).map_err(|e| match e {
        hayro::hayro_syntax::LoadPdfError::Decryption(hayro::hayro_syntax::DecryptionError::PasswordProtected) => InputError::Password,
        _ => InputError::Unreadable,
    })?;
    let cjk = std::sync::OnceLock::new();
    let settings = InterpreterSettings {
        font_resolver: Arc::new(move |q| match q {
            FontQuery::Standard(s) => Some(s.get_font_data()),
            FontQuery::Fallback(f) => {
                if f.character_collection.is_some()
                    && let Some(d) = cjk.get_or_init(cjk_font).clone()
                {
                    return Some((d, 0));
                }
                Some(f.pick_standard_font().get_font_data())
            }
        }),
        ..Default::default()
    };
    let cache = RenderCache::new();
    let mut out = Vec::new();
    for page in pdf.pages().iter().take(MAX_PAGES) {
        let (w1, h1) = page.render_dimensions();
        let scale = (3.0f32).min(MAX_SIDE as f32 / w1.max(h1));
        let px = render(
            page,
            &cache,
            &settings,
            &RenderSettings::default(),
            &PixmapSettings { x_scale: scale, y_scale: scale, bg_color: WHITE },
        );
        out.push(Img { data: px.data_as_u8_slice().to_vec(), width: px.width() as usize, height: px.height() as usize });
    }
    Ok(out)
}
