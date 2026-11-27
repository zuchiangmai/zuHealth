//! A received result file checked before it is stored (protocol 2.3 steps 1–3; W `proto/result.ts`). Decryption
//! comes before it, ingest after.

use crate::b64::unb64u;
use crate::sig::{ed_verify, jcs, key_of};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabKey {
    /// did:key:z…
    pub key: String,
    /// The src kinds it may sign: "lab", "room"
    pub may: Vec<String>,
}

pub struct Context<'a> {
    /// The person's account id
    pub me: &'a str,
    pub lab_keys: &'a [LabKey],
    /// The attestation key built in for the backend this app talks to (None: not configured), and its host
    pub att_key: Option<[u8; 32]>,
    pub iss: &'a str,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Ok(Map<String, Value>),
    /// Discard it (and count it); the reason is a code
    Drop(&'static str),
    /// Can't be checked yet (no attestation key): the cursor stays before it
    Later,
}

/// What the backend vouched for in a manual result (protocol 2.1, 4 `attest`).
#[derive(Debug, Clone, PartialEq)]
pub struct Attestation {
    pub h: String,
    pub staff: String,
    pub iss: String,
    pub at: f64,
}

/// Checks an attestation against the key built in for the backend, never one it names: header exactly
/// `{alg: EdDSA, typ: health-att}`, `iss` the backend.
pub fn verify_att(att: &Value, key: &[u8; 32], iss: &str) -> Option<Attestation> {
    let att = att.as_str().filter(|a| a.len() <= 2048)?;
    let mut parts = att.split('.');
    let (h64, p64, s64) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let (head, body, sig) = (unb64u(h64)?, unb64u(p64)?, unb64u(s64)?);
    let h: Map<String, Value> = serde_json::from_slice(&head).ok()?;
    let mut keys: Vec<&String> = h.keys().collect();
    keys.sort();
    if keys != ["alg", "typ"] || h["alg"] != "EdDSA" || h["typ"] != "health-att" {
        return None;
    }
    if !ed_verify(key, format!("{h64}.{p64}").as_bytes(), &sig) {
        return None;
    }
    let p: Map<String, Value> = serde_json::from_slice(&body).ok()?;
    let hex64 = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
            .map(str::to_string)
    };
    let (hh, staff) = (hex64(p.get("h"))?, hex64(p.get("staff"))?);
    if p.get("iss").and_then(Value::as_str) != Some(iss) {
        return None;
    }
    Some(Attestation { h: hh, staff, iss: iss.to_string(), at: p.get("at")?.as_f64()? })
}

pub fn check(plain: &[u8], ctx: &Context) -> Verdict {
    let Ok(Value::Object(doc)) = serde_json::from_slice::<Value>(plain) else { return Verdict::Drop("parse") };
    if doc.get("v").and_then(Value::as_f64) != Some(1.0) {
        return Verdict::Drop("version");
    }
    if !doc.get("uid").and_then(Value::as_str).is_some_and(|u| u.eq_ignore_ascii_case(ctx.me)) {
        return Verdict::Drop("uid");
    }
    let (Some(_), Some(src), Some(at), Some(obs), Some(Value::Object(sig))) = (
        doc.get("id").and_then(Value::as_str),
        doc.get("src").and_then(Value::as_str),
        doc.get("at").filter(|v| v.is_number()),
        doc.get("obs").and_then(Value::as_array),
        doc.get("sig"),
    ) else {
        return Verdict::Drop("shape");
    };
    let kind = match src.split_once(':').map(|(k, _)| k) {
        Some(k @ ("lab" | "room" | "staff")) => k,
        _ => return Verdict::Drop("src"),
    };
    let mut bare = doc.clone();
    bare.remove("sig");
    let Some(bytes) = jcs(&Value::Object(bare)) else { return Verdict::Drop("parse") };

    if kind != "staff" {
        let (Some(key), Some(s)) = (sig.get("key").and_then(Value::as_str), sig.get("s").and_then(Value::as_str)) else {
            return Verdict::Drop("sig-kind");
        };
        if sig.contains_key("att") {
            return Verdict::Drop("sig-kind");
        }
        if !ctx.lab_keys.iter().any(|k| k.key == key && k.may.iter().any(|m| m == kind)) {
            return Verdict::Drop("key");
        }
        let ok = key_of(key).zip(crate::b64::unb64_loose(s)).is_some_and(|(pk, s)| ed_verify(&pk, bytes.as_bytes(), &s));
        if !ok {
            return Verdict::Drop("signature");
        }
    } else {
        if !sig.get("att").is_some_and(Value::is_string) || sig.len() != 1 {
            return Verdict::Drop("sig-kind");
        }
        let Some(key) = ctx.att_key else { return Verdict::Later };
        let Some(a) = verify_att(&sig["att"], &key, ctx.iss) else { return Verdict::Drop("signer") };
        if a.h != hex::encode(Sha256::digest(bytes.as_bytes())) {
            return Verdict::Drop("hash");
        }
    }

    let mut seen = std::collections::HashSet::new();
    for o in obs {
        let Some(code) = o.as_object().and_then(|o| o.get("code")).and_then(Value::as_str) else { return Verdict::Drop("obs") };
        // `??` in the web: null and absent are the same
        let t = o.get("t").filter(|t| !t.is_null()).unwrap_or(at);
        let s = o.get("s").unwrap_or(&Value::Null);
        if !seen.insert(format!("{code}\u{0}{}\u{0}{s}", jcs(t).unwrap_or_default())) {
            return Verdict::Drop("dup");
        }
    }
    Verdict::Ok(doc)
}
