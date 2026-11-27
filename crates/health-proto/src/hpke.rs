//! HPKE (RFC 9180) base mode, single shot: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM (protocol 2.2).
//! `info` and `aad` are arguments: results use "sibian-health-1" with no AAD, links "health-link-1" with the
//! channel as AAD. A port of W `lib/health/proto/hpke.ts`.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes128Gcm, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

const KEM: &[u8] = b"KEM\x00\x20";
const SUITE: &[u8] = b"HPKE\x00\x20\x00\x01\x00\x01";

fn labeled_extract(suite: &[u8], salt: &[u8], label: &str, ikm: &[u8]) -> Vec<u8> {
    let ikm = [b"HPKE-v1", suite, label.as_bytes(), ikm].concat();
    Hkdf::<Sha256>::extract(Some(salt), &ikm).0.to_vec()
}

fn labeled_expand(suite: &[u8], prk: &[u8], label: &str, info: &[u8], len: usize) -> Vec<u8> {
    let info = [&(len as u16).to_be_bytes()[..], b"HPKE-v1", suite, label.as_bytes(), info].concat();
    let mut out = vec![0; len];
    Hkdf::<Sha256>::from_prk(prk).expect("prk").expand(&info, &mut out).expect("len");
    out
}

fn schedule(dh: &[u8; 32], enc: &[u8; 32], pk_r: &[u8; 32], info: &[u8]) -> Option<(Aes128Gcm, [u8; 12])> {
    if dh.iter().all(|&b| b == 0) {
        return None; // a low-order point
    }
    let eae = labeled_extract(KEM, &[], "eae_prk", dh);
    let shared = labeled_expand(KEM, &eae, "shared_secret", &[&enc[..], &pk_r[..]].concat(), 32);
    let ctx = [&[0u8][..], &labeled_extract(SUITE, &[], "psk_id_hash", &[]), &labeled_extract(SUITE, &[], "info_hash", info)].concat();
    let secret = labeled_extract(SUITE, &shared, "secret", &[]);
    let key = labeled_expand(SUITE, &secret, "key", &ctx, 16);
    let nonce: [u8; 12] = labeled_expand(SUITE, &secret, "base_nonce", &ctx, 12).try_into().expect("12");
    Some((Aes128Gcm::new_from_slice(&key).expect("16"), nonce))
}

/// Seals `plain` to `pk_r` with the ephemeral secret `sk_e` (random in use; fixed only for vectors).
/// Returns `enc ‖ ciphertext`; None when `pk_r` is a low-order point.
pub fn seal(pk_r: &[u8; 32], plain: &[u8], info: &[u8], aad: &[u8], sk_e: &[u8; 32]) -> Option<Vec<u8>> {
    let sk = StaticSecret::from(*sk_e);
    let enc = PublicKey::from(&sk).to_bytes();
    let dh = sk.diffie_hellman(&PublicKey::from(*pk_r)).to_bytes();
    let (cipher, nonce) = schedule(&dh, &enc, pk_r, info)?;
    let ct = cipher.encrypt(&Nonce::from(nonce), Payload { msg: plain, aad }).ok()?;
    Some([&enc[..], &ct].concat())
}

/// Opens `enc ‖ ciphertext`; None on any failure (length, key, authentication).
pub fn open(sk_r: &[u8; 32], sealed: &[u8], info: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < 32 + 16 {
        return None;
    }
    let enc: [u8; 32] = sealed[..32].try_into().ok()?;
    let sk = StaticSecret::from(*sk_r);
    let pk_r = PublicKey::from(&sk).to_bytes();
    let dh = sk.diffie_hellman(&PublicKey::from(enc)).to_bytes();
    let (cipher, nonce) = schedule(&dh, &enc, &pk_r, info)?;
    cipher.decrypt(&Nonce::from(nonce), Payload { msg: &sealed[32..], aad }).ok()
}
