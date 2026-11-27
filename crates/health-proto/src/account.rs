//! The health account (protocol 0.1, 0.2): 32 random bytes (the AMK) on the person's own devices; the signing
//! key, the inbox key and the account id are derived from it, so every device holding it is the same account.

use crate::b64::b64u;
use ed25519_dalek::{Signer, SigningKey};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const SALT: &[u8] = b"health-amk-v1";

pub struct Account {
    /// Lower-case hex SHA-256 of the Ed25519 public key (the UID)
    pub id: String,
    pub sign_pub: [u8; 32],
    /// The X25519 secret results are sealed to, and its public key (the identity code's PK)
    pub inbox_secret: Zeroizing<[u8; 32]>,
    pub inbox_pub: [u8; 32],
    signing: SigningKey,
}

fn derive(amk: &[u8; 32], info: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(SALT), amk).expand(info, &mut out[..]).expect("32 bytes");
    out
}

impl Account {
    pub fn of(amk: &[u8; 32]) -> Account {
        let seed = derive(amk, b"sign/v1");
        Account::from_seed(&seed, derive(amk, b"inbox/v1"))
    }

    fn from_seed(seed: &[u8; 32], inbox_secret: Zeroizing<[u8; 32]>) -> Account {
        let signing = SigningKey::from_bytes(seed);
        let sign_pub = signing.verifying_key().to_bytes();
        let inbox_pub = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(*inbox_secret)).to_bytes();
        Account { id: hex::encode(Sha256::digest(sign_pub)), sign_pub, inbox_secret, inbox_pub, signing }
    }

    /// An account from a raw Ed25519 seed (the protocol's vectors start there).
    pub fn from_sign_seed(seed: &[u8; 32]) -> Account {
        Account::from_seed(seed, Zeroizing::new([0; 32]))
    }

    /// A compact JWS (protocol 0.1): header `{alg, typ, jwk}` and the payload text as given (its key order is
    /// part of the signed bytes, so callers write it with `payload`).
    pub fn sign(&self, typ: &str, payload_json: &str) -> String {
        let header = format!(
            r#"{{"alg":"EdDSA","typ":{},"jwk":{{"kty":"OKP","crv":"Ed25519","x":"{}"}}}}"#,
            serde_json::to_string(typ).expect("str"),
            b64u(&self.sign_pub)
        );
        let input = format!("{}.{}", b64u(header.as_bytes()), b64u(payload_json.as_bytes()));
        let sig = self.signing.sign(input.as_bytes());
        format!("{input}.{}", b64u(&sig.to_bytes()))
    }
}

/// A request's payload text (protocol 0.1), keys in the web's order: the body's own fields, then `aud`, `at`,
/// `jti` (16 random bytes). `body` is a list of (key, JSON value) pairs, in order.
pub fn payload(body: &[(&str, serde_json::Value)], aud: &str, at_ms: i64, random16: &[u8; 16]) -> String {
    let mut fields: Vec<String> = body.iter().map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap(), v)).collect();
    fields.push(format!("\"aud\":{}", serde_json::to_string(aud).unwrap()));
    fields.push(format!("\"at\":{at_ms}"));
    fields.push(format!("\"jti\":\"{}\"", b64u(random16)));
    format!("{{{}}}", fields.join(","))
}

/// The X25519 public key of a secret (RFC 7748 clamping applied).
pub fn x25519_public(sk: &[u8; 32]) -> [u8; 32] {
    x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(*sk)).to_bytes()
}
