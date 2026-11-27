//! Root key and derived keys (plan §3.3). One 32-byte random root key per profile; everything else is HKDF of it.
//! Where the root key lives is a platform matter: `KeyStore` is implemented by the binary (OS keychain, key file).

use crate::error::Result;
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

pub type Key = Zeroizing<[u8; 32]>;

pub trait KeyStore {
    /// Short name for `status` ("keychain", "file").
    fn kind(&self) -> &'static str;
    /// The root key of profile `id`, or None if none is stored.
    fn load(&self, id: &str) -> Result<Option<Key>>;
    fn store(&self, id: &str, key: &Key) -> Result<()>;
}

pub fn new_root() -> Key {
    Zeroizing::new(crate::aead::random())
}

/// Sub-key for one purpose: "health/db", "health/blob", ...
pub fn derive(root: &Key, purpose: &str) -> Key {
    let mut k = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(None, &root[..]).expand(purpose.as_bytes(), &mut k[..]).expect("32 bytes is a valid HKDF length");
    k
}

/// Passphrase lock (plan §3.3): the root key sealed under Argon2id(passphrase).
/// Layout: "HKW1" ‖ m_kib u32 ‖ t u32 ‖ p u32 ‖ salt(16) ‖ nonce(12) ‖ AES-256-GCM(root) — the header is the AAD.
const WRAP_M_KIB: u32 = 64 * 1024;
const WRAP_T: u32 = 3;

fn kek(passphrase: &str, salt: &[u8], m: u32, t: u32, p: u32) -> Result<Key> {
    let params = argon2::Params::new(m, t, p, Some(32)).map_err(|_| crate::Error::invalid("bad_keywrap", "params"))?;
    let mut k = Zeroizing::new([0u8; 32]);
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut k[..])
        .map_err(|_| crate::Error::invalid("bad_keywrap", "kdf"))?;
    Ok(k)
}

pub fn wrap(root: &Key, passphrase: &str) -> Vec<u8> {
    let salt: [u8; 16] = crate::aead::random();
    let nonce: [u8; 12] = crate::aead::random();
    let mut out = b"HKW1".to_vec();
    for v in [WRAP_M_KIB, WRAP_T, 1] {
        out.extend_from_slice(&v.to_be_bytes());
    }
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    let k = kek(passphrase, &salt, WRAP_M_KIB, WRAP_T, 1).expect("fixed params are valid");
    let ct = seal(&k, &nonce, &out, &root[..]);
    out.extend_from_slice(&ct);
    out
}

pub fn unwrap(w: &[u8], passphrase: &str) -> Result<Key> {
    let bad = || crate::Error::invalid("bad_keywrap", "not a key wrap");
    if w.len() != 4 + 12 + 16 + 12 + 48 || &w[..4] != b"HKW1" {
        return Err(bad());
    }
    let u = |i: usize| u32::from_be_bytes(w[i..i + 4].try_into().unwrap());
    let (m, t, p) = (u(4), u(8), u(12));
    if m > 1024 * 1024 || t > 16 || p > 8 {
        return Err(bad());
    }
    let (salt, nonce, header) = (&w[16..32], &w[32..44], &w[..44]);
    let k = kek(passphrase, salt, m, t, p)?;
    let plain = open(&k, nonce, header, &w[44..]).ok_or_else(|| crate::Error::new(crate::Kind::Locked, "bad_passphrase", ""))?;
    let mut root = Zeroizing::new([0u8; 32]);
    root.copy_from_slice(&plain);
    Ok(root)
}

fn seal(k: &Key, nonce: &[u8], aad: &[u8], msg: &[u8]) -> Vec<u8> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    let n: [u8; 12] = nonce.try_into().unwrap();
    aes_gcm::Aes256Gcm::new((&**k).into()).encrypt(&aes_gcm::Nonce::from(n), Payload { msg, aad }).expect("encrypt")
}

fn open(k: &Key, nonce: &[u8], aad: &[u8], ct: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    let n: [u8; 12] = nonce.try_into().unwrap();
    aes_gcm::Aes256Gcm::new((&**k).into()).decrypt(&aes_gcm::Nonce::from(n), Payload { msg: ct, aad }).ok().map(Zeroizing::new)
}

/// File in the profile dir holding the wrapped root key; its presence means passphrase mode.
pub const KEYWRAP: &str = "keywrap";

/// Passphrase mode (plan §3.3): the root key never sits in the keychain, only wrapped in `keywrap`.
pub struct PassphraseStore {
    file: std::path::PathBuf,
    passphrase: Zeroizing<String>,
}

impl PassphraseStore {
    pub fn new(file: &std::path::Path, passphrase: &str) -> Self {
        PassphraseStore { file: file.to_path_buf(), passphrase: Zeroizing::new(passphrase.to_string()) }
    }
    /// SHA-256 of the key-encryption key: proves the passphrase to a running serve without sending it.
    pub fn proof(&self) -> Result<String> {
        proof(&std::fs::read(&self.file)?, &self.passphrase)
    }
}

/// Owner proof for passphrase mode: hex SHA-256 of Argon2id(passphrase, keywrap salt).
pub fn proof(w: &[u8], passphrase: &str) -> Result<String> {
    use sha2::Digest;
    if w.len() < 32 || &w[..4] != b"HKW1" {
        return Err(crate::Error::invalid("bad_keywrap", ""));
    }
    let u = |i: usize| u32::from_be_bytes(w[i..i + 4].try_into().unwrap());
    let (m, t, p) = (u(4), u(8), u(12));
    if m > 1024 * 1024 || t > 16 || p > 8 {
        return Err(crate::Error::invalid("bad_keywrap", "params"));
    }
    let k = kek(passphrase, &w[16..32], m, t, p)?;
    Ok(hex::encode(sha2::Sha256::digest(&k[..])))
}

impl KeyStore for PassphraseStore {
    fn kind(&self) -> &'static str {
        "passphrase"
    }
    fn load(&self, _id: &str) -> Result<Option<Key>> {
        match std::fs::read(&self.file) {
            Ok(w) => unwrap(&w, &self.passphrase).map(Some),
            Err(_) => Ok(None),
        }
    }
    fn store(&self, _id: &str, key: &Key) -> Result<()> {
        if self.passphrase.chars().count() < 8 {
            return Err(crate::Error::invalid("weak_passphrase", "at least 8 characters"));
        }
        let mut f = crate::profile::create_private(&self.file)?;
        std::io::Write::write_all(&mut f, &wrap(key, &self.passphrase))?;
        f.sync_all()?;
        Ok(())
    }
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemoryStore(pub std::sync::Mutex<std::collections::HashMap<String, [u8; 32]>>);

impl KeyStore for MemoryStore {
    fn kind(&self) -> &'static str {
        "memory"
    }
    fn load(&self, id: &str) -> Result<Option<Key>> {
        Ok(self.0.lock().unwrap().get(id).map(|k| Zeroizing::new(*k)))
    }
    fn store(&self, id: &str, key: &Key) -> Result<()> {
        self.0.lock().unwrap().insert(id.into(), **key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn derived_keys_differ() {
        let r = super::new_root();
        assert_ne!(*super::derive(&r, "health/db"), *super::derive(&r, "health/blob"));
        assert_eq!(*super::derive(&r, "health/db"), *super::derive(&r, "health/db"));
    }
}

#[cfg(test)]
mod wrap_tests {
    use super::*;

    #[test]
    fn a_wrapped_root_key_opens_only_with_its_passphrase() {
        let root = new_root();
        let w = wrap(&root, "correct horse battery");
        assert_eq!(*unwrap(&w, "correct horse battery").unwrap(), *root);
        assert_eq!(unwrap(&w, "wrong").unwrap_err().code, "bad_passphrase");
    }
}
