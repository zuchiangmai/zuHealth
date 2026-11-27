//! The profile's `sync` file (docs/lan-sync.md §9): what this device remembers about syncing. Sealed like the vault
//! with its own key, kept apart from it because it changes often. Never synced, never in backups. Losing it costs
//! only a resend: the negative cache and resume points are rebuilt by the next sessions, `joined` asks again.

use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use zeroize::Zeroizing;

const AAD: &[u8] = b"health-sync-v1";

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SyncState {
    /// "Sync on this network" (lan-sync §11; on by default once linked, owner decision 2)
    #[serde(default = "yes")]
    pub enabled: bool,
    /// The person allowed this device's first sync (§10)
    #[serde(default)]
    pub joined: bool,
    /// "Not now" on a large erase: no sync until the person continues (§10)
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub peers: BTreeMap<String, Peer>,
    /// Negative cache (§6.4)
    #[serde(default)]
    pub skip: Vec<Skip>,
    /// Split imports received in part: uid → where the next part starts (§6.5)
    #[serde(default)]
    pub resume: BTreeMap<String, Cursor>,
}

impl Default for SyncState {
    fn default() -> Self {
        SyncState { enabled: true, joined: false, paused: false, peers: BTreeMap::new(), skip: vec![], resume: BTreeMap::new() }
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct Peer {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub last_seen: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_synced: Option<i64>,
    #[serde(default)]
    pub up_to_date: bool,
}

/// Something wanted from `peer` that a merge couldn't make equal: not wanted again while both sides stay as they were.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Skip {
    pub peer: String,
    /// `i <uid>`, `c`, `s`, `a` or `b <sha>`
    pub what: String,
    /// What this side held, and what the peer held (fingerprints, section hashes, the peer's digest for a file)
    pub local: String,
    pub remote: String,
    /// Retried after this time (ms): an hour for clock skew, a day otherwise
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
}

/// After the rows of metric `code` at `start_ms` (exclusive): the next part of a split import starts there.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Cursor {
    pub code: String,
    pub start_ms: i64,
}

pub struct SyncStore {
    path: PathBuf,
    tmp: PathBuf,
    key: Zeroizing<[u8; 32]>,
}

impl SyncStore {
    pub fn new(path: PathBuf, tmp: PathBuf, key: [u8; 32]) -> SyncStore {
        SyncStore { path, tmp, key: Zeroizing::new(key) }
    }

    pub fn load(&self) -> Result<SyncState> {
        crate::vault::load_sealed(&self.path, &self.key, AAD, "sync")
    }

    pub fn save(&self, s: &SyncState) -> Result<()> {
        crate::vault::save_sealed(&self.path, &self.tmp, &self.key, AAD, "sync", s)
    }

    /// A damaged file (another key, cut short) starts over: losing it costs only work (§9). The device asks to join
    /// again, which is the safe side.
    pub fn load_or_reset(&self) -> Result<SyncState> {
        match self.load() {
            Ok(s) => Ok(s),
            Err(e) if e.code == "sync" => {
                let s = SyncState::default();
                self.save(&s)?;
                Ok(s)
            }
            Err(e) => Err(e),
        }
    }

    pub fn update<T>(&self, f: impl FnOnce(&mut SyncState) -> Result<T>) -> Result<T> {
        let mut s = self.load_or_reset()?;
        let out = f(&mut s)?;
        self.save(&s)?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_is_enabled_and_not_joined_and_saved_state_reads_back() {
        let d = tempfile::tempdir().unwrap();
        let st = SyncStore::new(d.path().join("sync"), d.path().to_path_buf(), [7; 32]);
        let s = st.load().unwrap();
        assert!(s.enabled && !s.joined && !s.paused);
        st.update(|s| {
            s.joined = true;
            s.resume.insert("u".into(), Cursor { code: "loinc:1".into(), start_ms: 5 });
            Ok(())
        })
        .unwrap();
        assert_eq!(st.load().unwrap().resume["u"].start_ms, 5);
        // another key can't read it
        let other = SyncStore::new(d.path().join("sync"), d.path().to_path_buf(), [8; 32]);
        assert_eq!(other.load().err().unwrap().code, "sync");
    }
}
