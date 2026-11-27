//! The signature helpers results are checked with (W `lib/sig.ts`): RFC 8785 canonical JSON, did:key, and
//! Ed25519 verified as everywhere else in the system: libsodium's rejection list (S < L, a canonical key, neither
//! the key nor R one of the seven small-order encodings), then the equation without the cofactor.

use serde_json::Value;

/// Nesting deeper than this isn't made canonical (the backend counts the same way).
pub const MAX_DEPTH: usize = 400;

/// RFC 8785: keys sorted by UTF-16 code units; numbers and strings as `JSON.stringify` writes them.
pub fn jcs(v: &Value) -> Option<String> {
    let mut out = String::new();
    canon(v, 0, &mut out)?;
    Some(out)
}

fn canon(v: &Value, depth: usize, out: &mut String) -> Option<()> {
    if depth > MAX_DEPTH {
        return None;
    }
    match v {
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canon(x, depth + 1, out)?;
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).ok()?);
                out.push(':');
                canon(&o[k], depth + 1, out)?;
            }
            out.push('}');
        }
        Value::Number(n) => out.push_str(&js_number(n.as_f64()?)),
        other => out.push_str(&serde_json::to_string(other).ok()?),
    }
    Some(())
}

/// ECMAScript Number::toString (shortest round-trip digits).
pub fn js_number(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    if !x.is_finite() {
        return "null".into();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let e = format!("{:e}", x.abs()); // d[.ddd]e<exp>, shortest round-trip
    let (mant, exp) = e.split_once('e').expect("exponent");
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().expect("int") + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let es = if e >= 0 { format!("+{e}") } else { e.to_string() };
        if k == 1 { format!("{digits}e{es}") } else { format!("{}.{}e{es}", &digits[..1], &digits[1..]) }
    };
    format!("{sign}{body}")
}

const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn unbase58(s: &str) -> Option<Vec<u8>> {
    if s.len() > 128 {
        return None;
    }
    let mut n: Vec<u8> = Vec::new(); // big-endian
    for c in s.bytes() {
        let mut carry = B58.iter().position(|&b| b == c)? as u32;
        for d in n.iter_mut().rev() {
            carry += *d as u32 * 58;
            *d = carry as u8;
            carry >>= 8;
        }
        while carry > 0 {
            n.insert(0, carry as u8);
            carry >>= 8;
        }
    }
    let zeros = s.bytes().take_while(|&c| c == b'1').count();
    Some([vec![0; zeros], n].concat())
}

/// The Ed25519 public key a did:key names (multicodec 0xed01).
pub fn key_of(did: &str) -> Option<[u8; 32]> {
    let b = unbase58(did.strip_prefix("did:key:z")?)?;
    (b.len() == 34 && b[0] == 0xed && b[1] == 0x01).then(|| b[2..].try_into().expect("32"))
}

const SMALL: [&str; 7] = [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0100000000000000000000000000000000000000000000000000000000000000",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
];

fn small(p: &[u8]) -> bool {
    SMALL.iter().any(|q| {
        let q = hex::decode(q).expect("hex");
        q.iter().enumerate().all(|(i, &b)| b == if i == 31 { p[i] & 0x7f } else { p[i] })
    })
}

/// Little-endian `a < b` for 32-byte numbers.
fn lt(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().rev().cmp(b.iter().rev()) == std::cmp::Ordering::Less
}

const L: [u8; 32] = [
    0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0x10,
];
const P: [u8; 32] = [
    0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
];

/// Whether `sig` is the Ed25519 signature of `msg` under `public`.
pub fn ed_verify(public: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let (Ok(pk), Ok(sg)) = (<[u8; 32]>::try_from(public), <[u8; 64]>::try_from(sig)) else { return false };
    let s: [u8; 32] = sg[32..].try_into().expect("32");
    let mut y = pk;
    y[31] &= 0x7f;
    if !lt(&s, &L) || !lt(&y, &P) || small(&pk) || small(&sg[..32]) {
        return false;
    }
    let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(&pk) else { return false };
    key.verify_strict(msg, &ed25519_dalek::Signature::from_bytes(&sg)).is_ok()
}
