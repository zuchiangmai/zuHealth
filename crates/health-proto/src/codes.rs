//! The texts shown as QR codes: the identity code `SBH1:<UID>:<PK>` (protocol 1) and the link code
//! `ZUHL1:<channel>:<one-time key>` with its check code (protocol 3.5).

use crate::b64::{base32, unbase32};
use sha2::{Digest, Sha256};

pub const LINK_PREFIX: &str = "ZUHL1:";

pub fn identity(uid: &str, pk: &[u8; 32]) -> String {
    format!("SBH1:{}:{}", uid.to_ascii_uppercase(), base32(pk))
}

/// `(uid in lower case, pk)` of an identity code written exactly one way; None otherwise.
pub fn read_identity(text: &str) -> Option<(String, [u8; 32])> {
    let rest = text.strip_prefix("SBH1:")?;
    let (uid, pk) = rest.split_once(':')?;
    if uid.len() != 64 || !uid.bytes().all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b)) {
        return None;
    }
    Some((uid.to_ascii_lowercase(), unbase32(pk, 32)?.try_into().ok()?))
}

pub fn link(channel: &str, pk: &[u8; 32]) -> String {
    format!("{LINK_PREFIX}{channel}:{}", base32(pk))
}

/// A link code (surrounding whitespace allowed, as the web trims): `(channel, one-time public key)`.
pub fn read_link(text: &str) -> Option<(String, [u8; 32])> {
    let (channel, pk) = text.trim().strip_prefix(LINK_PREFIX)?.split_once(':')?;
    unbase32(channel, 16)?;
    Some((channel.to_string(), unbase32(pk, 32)?.try_into().ok()?))
}

/// The eight digits both devices show during a link, bound to this link and this account ("1234 5678").
pub fn link_check(channel: &str, pk: &[u8; 32], account_id: &str) -> String {
    let d = Sha256::digest(format!("health-link-1:{channel}:{}:{account_id}", base32(pk)).as_bytes());
    let n = u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % 100_000_000;
    let s = format!("{n:08}");
    format!("{} {}", &s[..4], &s[4..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connection_code_starts_with_zuhl1_and_the_old_prefix_is_refused() {
        let pk = [9u8; 32];
        let code = link("IRCEIRCEIRCEIRCEIRCEIRCEIQ", &pk);
        assert!(code.starts_with("ZUHL1:"));
        assert_eq!(read_link(&code).map(|(_, k)| k), Some(pk));
        assert_eq!(read_link(&code.replacen("ZUHL1:", "SBHL1:", 1)), None);
    }
}
