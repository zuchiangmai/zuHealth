//! LAN sync signalling (docs/lan-sync.md §4, §5): the day's key and rendezvous id from the AMK, sealed messages,
//! the checks on receipt, and keeping only host candidates of private addresses in an SDP. Pure: the time, random
//! bytes and the messages are handed in.

use crate::b64::{b64u, base32, unb64u};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::BTreeMap;
use std::net::IpAddr;
use zeroize::Zeroizing;

const SALT: &[u8] = b"health-amk-v1";
/// A message is accepted within this much of the local clock (§5.3).
pub const MAX_AGE_MS: i64 = 120_000;
/// Message ids are remembered this long, so a replay is ignored.
pub const SEEN_MS: i64 = 600_000;
/// Largest sealed message (decoded) the relay carries.
pub const MAX_CT: usize = 8 * 1024;
const DAY_MS: i64 = 86_400_000;

/// One UTC day's signalling key and rendezvous id.
pub struct Day {
    /// `YYYY-MM-DD` (UTC)
    pub day: String,
    pub key: Zeroizing<[u8; 32]>,
    /// 16 bytes, base32 lower case without padding (26 characters)
    pub rid: String,
}

fn derive(amk: &[u8; 32], info: &str) -> Zeroizing<[u8; 32]> {
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(SALT), amk).expand(info.as_bytes(), &mut out[..]).expect("32 bytes");
    out
}

/// `YYYY-MM-DD` of a UTC time (proleptic Gregorian, days from 1970).
pub fn utc_day(ms: i64) -> String {
    let z = ms.div_euclid(DAY_MS) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

impl Day {
    pub fn of(amk: &[u8; 32], day: &str) -> Day {
        let key = derive(amk, &format!("lan-sync/key/v1/{day}"));
        let rid_full = derive(amk, &format!("lan-sync/rid/v1/{day}"));
        Day { day: day.into(), key, rid: base32(&rid_full[..16]).to_lowercase() }
    }

    /// Seals a message JSON for this day's rid: base64url of `nonce ‖ AES-256-GCM(json, aad = rid)`.
    pub fn seal(&self, json: &[u8], nonce: [u8; 12]) -> String {
        let c = Aes256Gcm::new((&*self.key).into());
        let ct = c.encrypt(&Nonce::from(nonce), Payload { msg: json, aad: self.rid.as_bytes() }).expect("AES-GCM encrypt");
        b64u(&[&nonce[..], &ct].concat())
    }

    pub fn open(&self, ct: &str) -> Option<Vec<u8>> {
        let raw = unb64u(ct)?;
        if raw.len() < 12 + 16 || raw.len() > MAX_CT {
            return None;
        }
        let c = Aes256Gcm::new((&*self.key).into());
        let nonce: [u8; 12] = raw[..12].try_into().ok()?;
        c.decrypt(&Nonce::from(nonce), Payload { msg: &raw[12..], aad: self.rid.as_bytes() }).ok()
    }
}

/// The days whose rid this device polls and posts at `now_ms` (§4): today, plus yesterday for 10 minutes after
/// midnight and tomorrow for 2 minutes before it. The first is the one to post to.
pub fn days_at(now_ms: i64) -> Vec<String> {
    let mut out = vec![utc_day(now_ms)];
    let into = now_ms.rem_euclid(DAY_MS);
    if into < 10 * 60_000 {
        out.push(utc_day(now_ms - DAY_MS));
    }
    if into >= DAY_MS - 2 * 60_000 {
        out.push(utc_day(now_ms + DAY_MS));
    }
    out
}

/// A signalling message (§5.2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Signal {
    pub v: u32,
    /// When it was sent (ms)
    pub t: i64,
    /// 16 random bytes, base64url
    pub id: String,
    /// The sender's device id
    pub from: String,
    #[serde(flatten)]
    pub body: Body,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Body {
    Hello {
        #[serde(default)]
        name: String,
        #[serde(default)]
        proto: Vec<u32>,
    },
    Offer {
        to: String,
        sdp: String,
    },
    Answer {
        to: String,
        /// The offer's id
        re: String,
        sdp: String,
    },
}

/// Why a received message was ignored. `Skew` repeated means this clock is off (§5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ignored {
    Undecryptable,
    Malformed,
    Skew,
    Replay,
    Mine,
    NotForMe,
    UnknownOffer,
}

/// The receiving side's memory: ids seen in the last 10 minutes and the offers this device sent.
#[derive(Default)]
pub struct Inbox {
    seen: BTreeMap<String, i64>,
    offers: BTreeMap<String, (String, i64)>,
}

fn device_ok(d: &str) -> bool {
    d.len() == 32 && d.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

impl Inbox {
    /// Remembers an offer this device sent to `to`, so its answer is recognised.
    pub fn sent_offer(&mut self, id: &str, to: &str, now_ms: i64) {
        self.offers.insert(id.into(), (to.into(), now_ms));
    }

    /// Checks a sealed item from any of `days` (§5.3). `me` is this device's id.
    pub fn receive(&mut self, days: &[&Day], ct: &str, me: &str, now_ms: i64) -> Result<Signal, Ignored> {
        self.seen.retain(|_, t| now_ms - *t < SEEN_MS);
        self.offers.retain(|_, (_, t)| now_ms - *t < SEEN_MS);
        let plain = days.iter().find_map(|d| d.open(ct)).ok_or(Ignored::Undecryptable)?;
        let s: Signal = serde_json::from_slice(&plain).map_err(|_| Ignored::Malformed)?;
        if s.v != 1 || !device_ok(&s.from) || s.id.is_empty() || s.id.len() > 64 {
            return Err(Ignored::Malformed);
        }
        // `t` comes over the network: no overflow, whatever it holds
        if now_ms.checked_sub(s.t).is_none_or(|d| d.unsigned_abs() > MAX_AGE_MS.unsigned_abs()) {
            return Err(Ignored::Skew);
        }
        if self.seen.contains_key(&s.id) {
            return Err(Ignored::Replay);
        }
        if s.from == me {
            return Err(Ignored::Mine);
        }
        match &s.body {
            Body::Hello { .. } => {}
            Body::Offer { to, .. } if to != me => return Err(Ignored::NotForMe),
            Body::Answer { to, .. } if to != me => return Err(Ignored::NotForMe),
            Body::Answer { re, .. } => {
                if self.offers.get(re).is_none_or(|(to, _)| *to != s.from) {
                    return Err(Ignored::UnknownOffer);
                }
            }
            Body::Offer { .. } => {}
        }
        self.seen.insert(s.id.clone(), now_ms);
        Ok(s)
    }
}

/// An address the data may travel to (§5.3, §5.4): private (RFC 1918, 169.254/16, fe80::/10, fc00::/7) or loopback.
pub fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_link_local() || v.is_loopback(),
        IpAddr::V6(v) => v.is_loopback() || (v.segments()[0] & 0xfe00) == 0xfc00 || (v.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// The SDP with only `host` candidates on private addresses or mDNS `.local` names (§5.3). Line endings are kept.
pub fn host_only(sdp: &str) -> String {
    sdp.split_inclusive('\n')
        .filter(|l| {
            let t = l.trim_end();
            let Some(c) = t.strip_prefix("a=candidate:") else { return true };
            let f: Vec<&str> = c.split_whitespace().collect();
            let typ = f.iter().position(|x| *x == "typ").and_then(|i| f.get(i + 1)).copied();
            let addr = f.get(4).copied().unwrap_or("");
            typ == Some("host") && (addr.ends_with(".local") || addr.parse::<IpAddr>().is_ok_and(private))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const AMK: [u8; 32] = [7; 32];
    const ME: &str = "00000000000000000000000000000001";
    const PEER: &str = "00000000000000000000000000000002";
    const T: i64 = 1_795_000_000_000;

    fn sealed(d: &Day, s: &Signal) -> String {
        d.seal(&serde_json::to_vec(s).unwrap(), [1; 12])
    }

    fn sig(id: &str, from: &str, t: i64, body: Body) -> Signal {
        Signal { v: 1, t, id: id.into(), from: from.into(), body }
    }

    #[test]
    fn days_rotate_at_utc_midnight_with_overlap() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(951_782_400_000), "2000-02-29");
        let midnight = 1_795_046_400_000; // 2026-11-19T00:00Z
        assert_eq!(utc_day(midnight), "2026-11-19");
        assert_eq!(utc_day(midnight - 1), "2026-11-18");
        assert_eq!(days_at(midnight + 5 * 60_000), vec!["2026-11-19", "2026-11-18"]);
        assert_eq!(days_at(midnight - 60_000), vec!["2026-11-18", "2026-11-19"]);
        assert_eq!(days_at(midnight + 3_600_000), vec!["2026-11-19"]);
        let (a, b) = (Day::of(&AMK, "2026-11-18"), Day::of(&AMK, "2026-11-19"));
        assert_eq!(a.rid.len(), 26);
        assert!(a.rid.bytes().all(|c| c.is_ascii_lowercase() || (b'2'..=b'7').contains(&c)));
        assert_ne!(a.rid, b.rid);
        assert_ne!(*a.key, *b.key);
    }

    #[test]
    fn only_the_same_account_and_day_opens_a_message() {
        let d = Day::of(&AMK, "2026-11-18");
        let ct = d.seal(b"{}", [3; 12]);
        assert_eq!(d.open(&ct).unwrap(), b"{}");
        assert!(Day::of(&[8; 32], "2026-11-18").open(&ct).is_none());
        assert!(Day::of(&AMK, "2026-11-19").open(&ct).is_none());
    }

    #[test]
    fn checks_on_receipt() {
        let d = Day::of(&AMK, "2026-11-18");
        let mut inbox = Inbox::default();
        let hello = sig("h1", PEER, T, Body::Hello { name: "Mac".into(), proto: vec![1] });
        assert!(inbox.receive(&[&d], &sealed(&d, &hello), ME, T).is_ok());
        assert_eq!(inbox.receive(&[&d], &sealed(&d, &hello), ME, T), Err(Ignored::Replay));
        let old = sig("h2", PEER, T - 121_000, Body::Hello { name: String::new(), proto: vec![1] });
        assert_eq!(inbox.receive(&[&d], &sealed(&d, &old), ME, T), Err(Ignored::Skew));
        let wild = sig("h3", PEER, i64::MIN, Body::Hello { name: String::new(), proto: vec![1] });
        assert_eq!(inbox.receive(&[&d], &sealed(&d, &wild), ME, T), Err(Ignored::Skew));
        let mine = sig("h3", ME, T, Body::Hello { name: String::new(), proto: vec![1] });
        assert_eq!(inbox.receive(&[&d], &sealed(&d, &mine), ME, T), Err(Ignored::Mine));
        let other = sig("o1", PEER, T, Body::Offer { to: "f".repeat(32), sdp: String::new() });
        assert_eq!(inbox.receive(&[&d], &sealed(&d, &other), ME, T), Err(Ignored::NotForMe));
        // an answer only to an offer this device sent to that peer
        let ans = sig("a1", PEER, T, Body::Answer { to: ME.into(), re: "o9".into(), sdp: String::new() });
        assert_eq!(inbox.receive(&[&d], &sealed(&d, &ans), ME, T), Err(Ignored::UnknownOffer));
        inbox.sent_offer("o9", PEER, T);
        let ans = sig("a2", PEER, T, Body::Answer { to: ME.into(), re: "o9".into(), sdp: String::new() });
        assert!(inbox.receive(&[&d], &sealed(&d, &ans), ME, T).is_ok());
        assert_eq!(inbox.receive(&[&d], "not base64!", ME, T), Err(Ignored::Undecryptable));
    }

    #[test]
    fn only_private_host_candidates_are_kept() {
        let sdp = "v=0\r\na=candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host\r\n\
                   a=candidate:2 1 udp 2122260223 8.8.8.8 50001 typ host\r\n\
                   a=candidate:3 1 udp 1686052607 203.0.113.9 50002 typ srflx raddr 192.168.1.5 rport 50000\r\n\
                   a=candidate:4 1 udp 2122260223 0b1c2d3e-aaaa.local 50003 typ host\r\n\
                   a=candidate:5 1 udp 2122260223 fe80::1 50004 typ host\r\na=end\r\n";
        let kept = host_only(sdp);
        assert!(kept.contains("192.168.1.5 50000 typ host") && kept.contains(".local 50003") && kept.contains("fe80::1"));
        assert!(!kept.contains("8.8.8.8") && !kept.contains("srflx"));
        assert!(kept.starts_with("v=0\r\n") && kept.ends_with("a=end\r\n"));
    }
}
