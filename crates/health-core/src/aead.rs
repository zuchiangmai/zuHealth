//! Chunked AES-256-GCM shared by backups and blob files.
//! iv = prefix(8) ‖ u32be(seq); aad = context ‖ u32be(seq) ‖ u8(last). Swapping, repeating, truncating or appending chunks fails auth.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

pub const TAG: usize = 16;

pub struct Chunks {
    cipher: Aes256Gcm,
    prefix: [u8; 8],
    context: Vec<u8>,
}

impl Chunks {
    pub fn new(key: &[u8; 32], prefix: [u8; 8], context: Vec<u8>) -> Self {
        Chunks { cipher: Aes256Gcm::new(key.into()), prefix, context }
    }

    fn iv_aad(&self, seq: u32, last: bool) -> ([u8; 12], Vec<u8>) {
        let mut iv = [0u8; 12];
        iv[..8].copy_from_slice(&self.prefix);
        iv[8..].copy_from_slice(&seq.to_be_bytes());
        let mut aad = self.context.clone();
        aad.extend_from_slice(&seq.to_be_bytes());
        aad.push(last as u8);
        (iv, aad)
    }

    pub fn seal(&self, seq: u32, last: bool, plain: &[u8]) -> Vec<u8> {
        let (iv, aad) = self.iv_aad(seq, last);
        self.cipher.encrypt(&Nonce::from(iv), Payload { msg: plain, aad: &aad }).expect("AES-GCM encrypt")
    }

    /// None = authentication failed.
    pub fn open(&self, seq: u32, last: bool, sealed: &[u8]) -> Option<Vec<u8>> {
        let (iv, aad) = self.iv_aad(seq, last);
        self.cipher.decrypt(&Nonce::from(iv), Payload { msg: sealed, aad: &aad }).ok()
    }
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::fill(&mut b);
    b
}
