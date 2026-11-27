//! Local text embeddings (multilingual-e5-small, int8; web `ocr/embed.ts`): printed names and catalog
//! names become 384-dim unit vectors, ranked by similarity. Only ranks candidates; never stores anything.
//! e5 wants "query: " / "passage: " prefixes.

use tokenizers::Tokenizer;
use tract_onnx::prelude::*;

pub const EMBED_DIM: usize = 384;
const MAX_TOKENS: usize = 64;
const BATCH: usize = 16;

pub struct Embedder {
    plan: Arc<TypedSimplePlan>,
    inputs: usize,
    tok: Tokenizer,
}

impl Embedder {
    pub fn new(model: &[u8], tokenizer: &[u8]) -> anyhow::Result<Embedder> {
        let m = tract_onnx::onnx()
            .with_ignore_output_shapes(true)
            .with_ignore_value_info(true)
            .model_for_read(&mut std::io::Cursor::new(model))?;
        let inputs = m.inputs.len();
        let (b, s) = (m.symbols.sym("B"), m.symbols.sym("S"));
        let mut m = m;
        for i in 0..inputs {
            m = m.with_input_fact(i, i64::fact(&[b.to_dim(), s.to_dim()]).into())?;
        }
        let plan = m.into_optimized()?.into_runnable()?;
        let tok = Tokenizer::from_bytes(tokenizer).map_err(|e| anyhow::anyhow!("tokenizer: {e}"))?;
        Ok(Embedder { plan, inputs, tok })
    }

    /// One unit vector per text.
    pub fn embed(&self, texts: &[String], kind: &str) -> anyhow::Result<Vec<Vec<f32>>> {
        let mut out = Vec::new();
        for batch in texts.chunks(BATCH) {
            let ids: Vec<Vec<i64>> = batch
                .iter()
                .map(|t| {
                    let e = self.tok.encode(format!("{kind}: {t}"), true).map_err(|e| anyhow::anyhow!("tokenize: {e}"))?;
                    Ok(e.get_ids().iter().take(MAX_TOKENS).map(|&x| x as i64).collect())
                })
                .collect::<anyhow::Result<_>>()?;
            let len = ids.iter().map(Vec::len).max().unwrap_or(1).max(1);
            let n = ids.len();
            let mut id = vec![0i64; n * len];
            let mut mask = vec![0i64; n * len];
            for (r, row) in ids.iter().enumerate() {
                for (c, &x) in row.iter().enumerate() {
                    id[r * len + c] = x;
                    mask[r * len + c] = 1;
                }
            }
            let mut feeds = tvec!(Tensor::from_shape(&[n, len], &id)?.into(), Tensor::from_shape(&[n, len], &mask)?.into());
            if self.inputs == 3 {
                feeds.push(Tensor::from_shape(&[n, len], &vec![0i64; n * len])?.into());
            }
            let res = self.plan.run(feeds)?;
            let h: Vec<f32> = res[0].to_plain_array_view::<f32>()?.iter().copied().collect();
            for (r, row) in ids.iter().enumerate() {
                // mean over the real tokens, then unit length
                let mut v = vec![0f32; EMBED_DIM];
                for c in 0..row.len() {
                    for d in 0..EMBED_DIM {
                        v[d] += h[(r * len + c) * EMBED_DIM + d];
                    }
                }
                let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
                let norm = if norm == 0.0 { 1.0 } else { norm };
                out.push(v.iter().map(|x| x / norm).collect());
            }
        }
        Ok(out)
    }
}

pub fn cosine(a: &[f32], b: &[f32]) -> f64 {
    a.iter().zip(b).map(|(x, y)| *x as f64 * *y as f64).sum()
}
