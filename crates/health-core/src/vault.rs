//! The profile's `vault` (plan §3.2): the health account's AMK and the state tied to it, sealed with a key
//! derived from the root key. Not in `health.db` (its schema is fixed) and not in backups: an account moves
//! between devices only by linking (protocol 3.5).

use crate::error::{Error, Result};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use zeroize::Zeroizing;

const AAD: &[u8] = b"health-vault-v1";

/// No Debug: it holds the account key.
#[derive(Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct State {
    /// base64url of the 32-byte AMK
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amk: Option<String>,
    /// The inbox key registered with the backend (base64url); the identity code is shown only for it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registered_pk: Option<String>,
    /// Per inbox key: the last `seq` handled
    #[serde(default)]
    pub cursors: BTreeMap<String, i64>,
    /// Per inbox key: results discarded (shown to the person, protocol 2.3)
    #[serde(default)]
    pub drops: BTreeMap<String, i64>,
    /// The personal profile (web `profile.ts`): kept here, on this device only, as the web keeps it outside its
    /// export. Height and weight aren't here: they are the latest readings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<Personal>,
    /// Link history (owner, 2026-11-22: a local record only, as the web's link-log): per account id, every link
    /// this device completed. After an adopt replaces the account, the old account's entries stay here, not
    /// shown and not deletable: on purpose (the record is of this device, not of the current account).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub links: BTreeMap<String, Vec<LinkEntry>>,
    /// The WHOOP connection (the person's own developer app and its tokens)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub whoop: Option<Whoop>,
    /// Where early builds counted one-time data upgrades; read once to migrate, now kept in the database header's
    /// `application_id` (profile.rs)
    #[serde(default, skip_serializing_if = "is_zero")]
    pub upgraded: u32,
    /// This installation's id for sync (docs/lan-sync.md §4): 16 random bytes, hex. Never synced, never in backups.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    /// When and by which device `profile` was last set (a synced setting, lan-sync §8)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_stamp: Option<Stamp>,
    /// When WHOOP was last disconnected or its data deleted on any device (a synced setting, lan-sync §8)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub whoop_stopped: Option<Stopped>,
    /// Lab self-service on this device (seca mBCA Pro, VALD ForceDecks): app state for this device only, never synced
    /// or backed up (the web keeps it in its page scratch)
    #[serde(default, skip_serializing_if = "LabSelf::is_empty")]
    pub lab: LabSelf,
}

/// What lab self-service keeps between visits. Each handle records the account and the profile it was made from:
/// another account or a changed profile makes it stale (registered again), as the web's `gen` counter does.
#[derive(Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct LabSelf {
    /// The account id these were made for
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seca: Option<SecaKept>,
    /// A seca measurement started and not yet fetched (valid 7 days)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seca_ticket: Option<SecaTicket>,
    /// The PDF report of a seca measurement, per "<device>|<at>", until it expires
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub seca_pdf: BTreeMap<String, SecaPdf>,
    /// Per ForceDecks device
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fd: BTreeMap<String, FdKept>,
}

impl LabSelf {
    fn is_empty(&self) -> bool {
        *self == LabSelf::default()
    }
}

#[derive(Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct SecaKept {
    /// The anonymous seca patient id
    pub idp: String,
    /// "<birth>|<gender>|<ethnicity>" it was registered with
    pub made_from: String,
}

#[derive(Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct SecaTicket {
    pub ticket: String,
    pub device: String,
    pub at: i64,
}

#[derive(Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct SecaPdf {
    pub url: String,
    pub until: i64,
}

#[derive(Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdKept {
    /// The person's ForceDecks handle (a UUID)
    pub ext: String,
    /// Token to read results by
    pub feed: String,
    /// 4 characters, the family name the device's screen shows
    pub label: String,
    /// "<birth>|<gender>" it was registered with
    pub made_from: String,
    /// The last result seq taken
    #[serde(default)]
    pub cursor: i64,
    /// When a lease was last seen (ms): results are fetched once more within 7 days of it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_lease: Option<i64>,
}

/// A synced setting's clock: `set_at` is an HLC (`(ms << 16) | counter`), `set_by` a device id.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct Stamp {
    /// A decimal string in JSON (merge-fixes G5's grammar): an HLC is above 2^53, which JS numbers can't hold
    #[serde(with = "hlc_text")]
    pub set_at: i64,
    pub set_by: String,
}

/// An HLC as JSON text `^(0|[1-9][0-9]*)$` within i64. A number is still read, as early vault files wrote it.
mod hlc_text {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    pub fn serialize<S: Serializer>(v: &i64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Raw {
        Text(String),
        Num(i64),
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
        match Raw::deserialize(d)? {
            Raw::Num(n) if n >= 0 => Ok(n),
            Raw::Text(t)
                if t == "0"
                    || (t.len() <= 19 && t.starts_with(|c: char| ('1'..='9').contains(&c)) && t.bytes().all(|b| b.is_ascii_digit())) =>
            {
                t.parse().map_err(D::Error::custom)
            }
            _ => Err(D::Error::custom("set_at is a decimal string")),
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct Stopped {
    /// When it stopped (ms)
    pub at: i64,
    #[serde(flatten)]
    pub stamp: Stamp,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// One completed link (web `link-log.ts` LinkEntry).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct LinkEntry {
    /// 8 random bytes, base64url
    pub id: String,
    /// "gave" (this device handed the account over) | "got" (this device took it)
    pub dir: String,
    /// When (ms)
    pub at: i64,
    /// The check code both devices showed ("1234 5678")
    pub check: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct Personal {
    /// YYYY-MM
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub birth: Option<String>,
    /// "Male" | "Female"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    /// For seca self-service only (asked there, not in the profile page)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ethnicity: Option<String>,
}

#[derive(Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct Whoop {
    pub client_id: String,
    pub client_secret: String,
    /// The `state` of a sign-in not yet back
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<String>,
    /// When the access token expires (ms)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<i64>,
    /// The refresh token stopped working: sign in again
    #[serde(default)]
    pub reauth: bool,
    /// When this device connected (ms): a newer `whoop_stopped` from another device disconnects it here
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected_at: Option<i64>,
}

/// Reads a JSON value sealed with AES-256-GCM (nonce ‖ ciphertext); a missing file is the default value.
pub(crate) fn load_sealed<T: serde::de::DeserializeOwned + Default>(
    path: &std::path::Path,
    key: &[u8; 32],
    aad: &[u8],
    what: &'static str,
) -> Result<T> {
    let raw = match std::fs::read(path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
        Err(e) => return Err(e.into()),
    };
    if raw.len() < 12 + 16 {
        return Err(Error::other(what, format!("the {what} file is damaged")));
    }
    let cipher = Aes256Gcm::new(key.into());
    let nonce: [u8; 12] = raw[..12].try_into().expect("12");
    let plain = Zeroizing::new(
        cipher
            .decrypt(&Nonce::from(nonce), Payload { msg: &raw[12..], aad })
            .map_err(|_| Error::other(what, format!("the {what} file is damaged or from another key")))?,
    );
    serde_json::from_slice(&plain).map_err(|_| Error::other(what, format!("the {what} file is damaged")))
}

/// Seals `v` into a temp file, then renames it into place.
pub(crate) fn save_sealed<T: Serialize>(
    path: &std::path::Path,
    tmp: &std::path::Path,
    key: &[u8; 32],
    aad: &[u8],
    what: &str,
    v: &T,
) -> Result<()> {
    let plain = Zeroizing::new(serde_json::to_vec(v)?);
    let nonce = crate::aead::random::<12>();
    let cipher = Aes256Gcm::new(key.into());
    let sealed = cipher.encrypt(&Nonce::from(nonce), Payload { msg: &plain, aad }).expect("AES-GCM encrypt");
    let t = tmp.join(format!("{what}-{}", hex::encode(crate::aead::random::<8>())));
    {
        use std::io::Write;
        let mut f = crate::profile::create_private(&t)?;
        f.write_all(&nonce)?;
        f.write_all(&sealed)?;
        f.sync_all()?;
    }
    std::fs::rename(&t, path)?;
    Ok(())
}

pub struct Vault {
    path: PathBuf,
    tmp: PathBuf,
    key: Zeroizing<[u8; 32]>,
}

impl Vault {
    pub fn new(path: PathBuf, tmp: PathBuf, key: [u8; 32]) -> Vault {
        Vault { path, tmp, key: Zeroizing::new(key) }
    }

    pub fn load(&self) -> Result<State> {
        load_sealed(&self.path, &self.key, AAD, "vault")
    }

    pub fn save(&self, s: &State) -> Result<()> {
        save_sealed(&self.path, &self.tmp, &self.key, AAD, "vault", s)
    }

    /// Loads, changes and saves the state.
    pub fn update<T>(&self, f: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        let mut s = self.load()?;
        let out = f(&mut s)?;
        self.save(&s)?;
        Ok(out)
    }

    /// This installation's device id, made and saved on first use.
    pub fn device_id(&self) -> Result<String> {
        if let Some(d) = self.load()?.device {
            return Ok(d);
        }
        self.update(|s| Ok(s.device.get_or_insert_with(|| hex::encode(crate::aead::random::<16>())).clone()))
    }
}
