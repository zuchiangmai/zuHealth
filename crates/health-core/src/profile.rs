//! A profile = one person = one directory (plan §3.2):
//!   id  health.db  blobs/  tmp/  lock  access.db  vault  sync
//! Writers hold `lock` and run crash recovery; readers open without it (WAL).

use crate::blob::Store;
use crate::db::Db;
use crate::error::{Error, Kind, Result};
use crate::keys::{KeyStore, derive, new_root};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

pub struct Profile {
    pub name: String,
    pub dir: PathBuf,
    pub id: String,
    pub db: Db,
    pub blobs: Store,
    /// Grants and audit (plan §5), kept apart from the health data
    pub access: crate::access::AccessDb,
    pub vault: crate::vault::Vault,
    /// What this device remembers about syncing (docs/lan-sync.md §9)
    pub sync: crate::syncstate::SyncStore,
    pub key_store: &'static str,
    /// Held while this process is the writer.
    _lock: Option<File>,
}

fn valid_name(n: &str) -> bool {
    (1..=32).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// Directory readable only by the owner.
pub fn create_private_dir(p: &Path) -> Result<()> {
    std::fs::create_dir_all(p)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// New file readable only by the owner (fails if it exists).
pub fn create_private(p: &Path) -> Result<File> {
    let mut o = OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    Ok(o.open(p)?)
}

fn chmod_private(p: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if p.exists() {
            let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
        }
    }
    #[cfg(not(unix))]
    let _ = p;
}

pub fn profile_dir(data_dir: &Path, name: &str) -> Result<PathBuf> {
    if !valid_name(name) {
        return Err(Error::new(Kind::Usage, "bad_profile", "profile names are 1-32 of a-z 0-9 - _"));
    }
    Ok(data_dir.join("profiles").join(name))
}

/// Everything in a profile directory but `lock` (a writer may be waiting on it).
fn clear_leftovers(dir: &Path) -> Result<()> {
    for e in std::fs::read_dir(dir)? {
        let e = e?;
        if e.file_name() == "lock" {
            continue;
        }
        if e.file_type()?.is_dir() { std::fs::remove_dir_all(e.path())? } else { std::fs::remove_file(e.path())? }
    }
    Ok(())
}

fn remove_if_there(p: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(p) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// The owner's "Clear data": deletes the profile so the next start is a fresh install. Returns the profile's id
/// (its root key is the caller's to forget), `None` when there was nothing to delete.
///
/// The database goes first: a profile whose database is gone just starts a new empty one under the same key,
/// but a database whose key is gone can never be opened again. When the database can't be deleted (another
/// process is writing, or on Windows still has it open) nothing is deleted. Needs no network and never opens
/// the database, so it also works when the database no longer opens.
pub fn wipe(data_dir: &Path, name: &str) -> Result<Option<String>> {
    let dir = profile_dir(data_dir, name)?;
    if !dir.exists() {
        return Ok(None);
    }
    let busy = || Error::conflict("busy", "another Health process is using this profile: quit it, then try again");
    let lock = OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("lock"))?;
    lock.try_lock().map_err(|_| busy())?;
    let id = std::fs::read_to_string(dir.join("id")).ok().map(|s| s.trim().to_string());
    remove_if_there(&dir.join("health.db")).map_err(|_| busy())?;
    for f in ["health.db-wal", "health.db-shm"] {
        remove_if_there(&dir.join(f))?;
    }
    clear_leftovers(&dir)?;
    drop(lock);
    let _ = std::fs::remove_dir_all(&dir); // the lock file (gone from Unix only once unlocked)
    Ok(id)
}

impl Profile {
    /// After a call that panicked: rolls back the transaction (and any savepoint) it left open, which would
    /// otherwise refuse every later write (`BEGIN IMMEDIATE` inside a transaction). Nothing it wrote is kept.
    pub fn recover(&self) {
        if !self.db.is_autocommit() {
            let _ = self.db.execute_batch("ROLLBACK");
        }
        self.access.recover();
    }

    /// Creates a profile: new root key in `keys`, empty database with the catalog.
    pub fn init(data_dir: &Path, name: &str, keys: &dyn KeyStore) -> Result<Profile> {
        let dir = profile_dir(data_dir, name)?;
        if dir.join("health.db").exists() {
            return Err(Error::conflict("exists", format!("profile {name} already exists")));
        }
        if !data_dir.exists() {
            create_private_dir(data_dir)?;
        }
        let fresh = !dir.exists();
        create_private_dir(&dir)?;
        // what an earlier profile left here is sealed under a key about to be replaced: it could never be opened
        if !fresh {
            clear_leftovers(&dir)?;
        }
        let id = hex::encode(crate::aead::random::<16>());
        if let Err(e) = keys.store(&id, &new_root()) {
            if fresh {
                let _ = std::fs::remove_dir_all(&dir);
            }
            return Err(e);
        }
        let _ = std::fs::remove_file(dir.join("id.tmp")); // left by an interrupted init
        std::io::Write::write_all(&mut create_private(&dir.join("id.tmp"))?, id.as_bytes())?;
        std::fs::rename(dir.join("id.tmp"), dir.join("id"))?;
        Self::open(data_dir, name, keys, true, 0)
    }

    /// Opens an existing profile. `write` takes the writer lock and recovers from a crash.
    pub fn open(data_dir: &Path, name: &str, keys: &dyn KeyStore, write: bool, now_ms: i64) -> Result<Profile> {
        let dir = profile_dir(data_dir, name)?;
        let id =
            std::fs::read_to_string(dir.join("id")).map_err(|_| Error::not_found("no_profile", format!("{name} (run `health init`)")))?;
        let id = id.trim().to_string();
        if !write && !dir.join("health.db").exists() {
            return Err(Error::not_found("no_profile", format!("{name} has no database (run a write command or `health init`)")));
        }
        let root = keys
            .load(&id)?
            .ok_or_else(|| Error::new(Kind::Locked, "no_key", format!("no key for profile {name} in the {} store", keys.kind())))?;
        let lock = if write {
            let f = OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("lock"))?;
            f.try_lock().map_err(|_| Error::conflict("busy", "another health process is writing to this profile"))?;
            Some(f)
        } else {
            None
        };
        for d in ["blobs", "tmp"] {
            create_private_dir(&dir.join(d))?;
        }
        let db = crate::db::open(&dir.join("health.db"), &derive(&root, "health/db"))?;
        for f in ["health.db", "health.db-wal", "health.db-shm", "lock", "id"] {
            chmod_private(&dir.join(f));
        }
        let blobs = Store::new(dir.join("blobs"), dir.join("tmp"), *derive(&root, "health/blob"));
        let access = crate::access::AccessDb::open(&dir.join("access.db"), &derive(&root, "health/access"))?;
        chmod_private(&dir.join("access.db"));
        let vault = crate::vault::Vault::new(dir.join("vault"), dir.join("tmp"), *derive(&root, "health/vault"));
        let sync = crate::syncstate::SyncStore::new(dir.join("sync"), dir.join("tmp"), *derive(&root, "health/sync"));
        let p = Profile { name: name.into(), dir, id, db, blobs, access, vault, sync, key_store: keys.kind(), _lock: lock };
        if write {
            p.on_writer_open(now_ms)?;
        }
        Ok(p)
    }

    pub fn is_writer(&self) -> bool {
        self._lock.is_some()
    }

    pub fn tmp(&self) -> PathBuf {
        self.dir.join("tmp")
    }

    /// Crash recovery, catalog top-up, leftover temp files.
    /// Blob files nothing references (a crash between COMMIT and deleting them) are removed too.
    /// One-time data upgrades (1: R3's legacy stamp; 2: R6b's `meta.file` and R10's span repair), counted in the
    /// database header's `application_id`, so the count can't be lost apart from the data it describes and lands in
    /// the same transaction. `user_version` is the schema's. Profiles that counted in the vault first are read too.
    fn upgrade(&self, now_ms: i64) -> Result<()> {
        let c = &self.db;
        let in_db: i64 = c.query_row("PRAGMA application_id", [], |r| r.get(0))?;
        let in_vault = self.vault.load().map(|s| s.upgraded as i64).unwrap_or(0);
        let done = in_db.max(in_vault);
        if done >= 2 && in_db >= 2 {
            return Ok(());
        }
        crate::db::tx(c, || {
            if done < 1 {
                crate::write::stamp_legacy_sources(c, now_ms)?;
            }
            if done < 2 {
                crate::write::upgrade_files_and_spans(c)?;
            }
            c.pragma_update(None, "application_id", 2)?;
            Ok(())
        })
    }

    fn on_writer_open(&self, now_ms: i64) -> Result<()> {
        let orphans = crate::db::recover_crashed(&self.db, now_ms)?;
        self.blobs.remove(&orphans);
        for sha in self.blobs.list() {
            if !crate::erase::referenced(&self.db, &sha)? {
                self.blobs.remove(&[sha]);
            }
        }
        crate::catalog::seed(&self.db)?;
        self.upgrade(now_ms)?;
        if let Ok(rd) = std::fs::read_dir(self.tmp()) {
            for e in rd.flatten() {
                let _ = std::fs::remove_file(e.path());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::MemoryStore;

    #[test]
    fn init_open_lock_and_wrong_key() {
        let d = tempfile::tempdir().unwrap();
        let keys = MemoryStore::default();
        let p = Profile::init(d.path(), "default", &keys).unwrap();
        assert!(p.is_writer());
        assert_eq!(Profile::open(d.path(), "default", &keys, true, 0).err().unwrap().code, "busy");
        let r = Profile::open(d.path(), "default", &keys, false, 0).unwrap();
        let n: i64 = r.db.query_row("SELECT count(*) FROM metric", [], |r| r.get(0)).unwrap();
        assert!(n > 900);
        drop((p, r));
        assert_eq!(Profile::init(d.path(), "default", &keys).err().unwrap().code, "exists");
        // a different key cannot read the file
        let other = MemoryStore::default();
        let id = std::fs::read_to_string(d.path().join("profiles/default/id")).unwrap();
        other.store(&id, &new_root()).unwrap();
        assert_eq!(Profile::open(d.path(), "default", &other, false, 0).err().unwrap().code, "bad_key");
        // the file on disk is not plain SQLite
        let head = std::fs::read(d.path().join("profiles/default/health.db")).unwrap();
        assert!(!head.starts_with(b"SQLite format 3"));
    }
}

#[cfg(test)]
mod passphrase_tests {
    use super::*;
    use crate::keys::{MemoryStore, PassphraseStore};

    #[test]
    fn a_passphrase_locked_profile_opens_only_with_the_passphrase() {
        let d = tempfile::tempdir().unwrap();
        let mem = MemoryStore::default();
        let p = Profile::init(d.path(), "default", &mem).unwrap();
        let root = mem.load(&p.id).unwrap().unwrap();
        let file = p.dir.join(crate::keys::KEYWRAP);
        drop(p);
        PassphraseStore::new(&file, "long passphrase").store("", &root).unwrap();
        assert!(Profile::open(d.path(), "default", &PassphraseStore::new(&file, "long passphrase"), false, 0).is_ok());
        let e = Profile::open(d.path(), "default", &PassphraseStore::new(&file, "nope"), false, 0).err().unwrap();
        assert_eq!((e.code, e.kind), ("bad_passphrase", Kind::Locked));
    }
}

#[cfg(test)]
mod recover_tests {
    use super::*;
    use crate::keys::MemoryStore;

    /// A call that panicked mid-write leaves its savepoint open; without `recover` the next write's
    /// `BEGIN IMMEDIATE` fails ("cannot start a transaction within a transaction") until the profile reopens
    #[test]
    fn a_write_left_open_is_rolled_back() {
        let d = tempfile::tempdir().unwrap();
        let p = Profile::init(d.path(), "default", &MemoryStore::default()).unwrap();
        p.db.execute_batch("SAVEPOINT h; INSERT INTO source (connector, external_id, name, priority) VALUES ('manual', 'x', 'X', 0);")
            .unwrap();
        assert!(p.db.execute_batch("BEGIN IMMEDIATE").is_err());
        p.recover();
        p.db.execute_batch("BEGIN IMMEDIATE; COMMIT").unwrap();
        let n: i64 = p.db.query_row("SELECT count(*) FROM source WHERE external_id = 'x'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "nothing the interrupted call wrote is kept");
    }
}
