//! Root key stores: the OS keychain (default) or a key file named by HEALTH_ROOT_KEY_FILE (tests, CI, headless hosts).

use health_core::keys::{Key, KeyStore};
use health_core::{Error, Kind, Result};
use std::path::PathBuf;

const SERVICE: &str = "health";

/// The store for a profile: passphrase mode when `keywrap` exists, else the configured one.
/// The passphrase comes from stdin (`--passphrase-stdin`) or a TTY prompt.
pub fn for_profile(profile_dir: &std::path::Path, passphrase_stdin: bool) -> Result<Box<dyn KeyStore>> {
    let file = profile_dir.join(health_core::keys::KEYWRAP);
    if !file.exists() {
        return Ok(from_env());
    }
    let p = read_passphrase(passphrase_stdin, "Passphrase: ")?;
    Ok(Box::new(health_core::keys::PassphraseStore::new(&file, &p)))
}

pub fn read_passphrase(stdin: bool, prompt: &str) -> Result<String> {
    if stdin {
        let mut s = String::new();
        std::io::stdin().read_line(&mut s)?;
        return Ok(s.trim_end_matches(['\r', '\n']).to_string());
    }
    if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        return Err(Error::new(Kind::Locked, "locked", "this profile is passphrase-locked: use --passphrase-stdin or a terminal"));
    }
    Ok(rpassword::prompt_password(prompt)?)
}

/// Removes the keychain entry (after the key moved into `keywrap`).
pub fn keychain_delete(id: &str) -> Result<()> {
    match keyring::Entry::new(SERVICE, id).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(store_err(e)),
    }
}

pub fn from_env() -> Box<dyn KeyStore> {
    match std::env::var_os("HEALTH_ROOT_KEY_FILE") {
        Some(p) if !p.is_empty() => Box::new(FileStore(PathBuf::from(p))),
        _ => Box::new(Keychain),
    }
}

/// Deletes the key file named by HEALTH_ROOT_KEY_FILE (after its profile was cleared).
pub fn forget_file() -> Result<()> {
    match std::env::var_os("HEALTH_ROOT_KEY_FILE") {
        Some(p) if !p.is_empty() => match std::fs::remove_file(p) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        },
        _ => Ok(()),
    }
}

fn store_err(e: impl std::fmt::Display) -> Error {
    Error::new(Kind::Locked, "keystore", e.to_string())
}

pub struct Keychain;

impl KeyStore for Keychain {
    fn kind(&self) -> &'static str {
        "keychain"
    }
    fn load(&self, id: &str) -> Result<Option<Key>> {
        let entry = keyring::Entry::new(SERVICE, id).map_err(store_err)?;
        match entry.get_secret() {
            Ok(s) => {
                let s = zeroize::Zeroizing::new(s);
                let k: [u8; 32] = s.as_slice().try_into().map_err(|_| store_err("keychain entry is not a 32-byte key"))?;
                Ok(Some(Key::new(k)))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(store_err(e)),
        }
    }
    fn store(&self, id: &str, key: &Key) -> Result<()> {
        keyring::Entry::new(SERVICE, id).and_then(|e| e.set_secret(&key[..])).map_err(store_err)
    }
}

/// One key per file: 64 hex characters. The file must be readable by its owner only.
pub struct FileStore(pub PathBuf);

impl KeyStore for FileStore {
    fn kind(&self) -> &'static str {
        "file"
    }
    fn load(&self, _id: &str) -> Result<Option<Key>> {
        if !self.0.exists() {
            return Ok(None);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&self.0)?.permissions().mode();
            if mode & 0o077 != 0 {
                return Err(store_err(format!("{} must be mode 0600", self.0.display())));
            }
        }
        let text = zeroize::Zeroizing::new(std::fs::read_to_string(&self.0)?);
        let mut k = Key::new([0u8; 32]);
        hex::decode_to_slice(text.trim(), &mut k[..]).map_err(|_| store_err("key file must hold 64 hex characters"))?;
        Ok(Some(k))
    }
    fn store(&self, _id: &str, key: &Key) -> Result<()> {
        if self.0.exists() {
            return Err(Error::conflict("key_file_exists", self.0.display().to_string()));
        }
        let mut f = health_core::profile::create_private(&self.0)?;
        std::io::Write::write_all(&mut f, zeroize::Zeroizing::new(hex::encode(&key[..])).as_bytes())?;
        Ok(())
    }
}

impl health_runtime::RootKeys for Keychain {
    fn delete(&self, id: &str) -> Result<()> {
        keychain_delete(id)
    }
}

impl health_runtime::RootKeys for FileStore {
    fn delete(&self, _id: &str) -> Result<()> {
        match std::fs::remove_file(&self.0) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}

/// The configured store for the runtime (`health serve`): a key file named by HEALTH_ROOT_KEY_FILE, else the keychain.
pub fn root_keys() -> Box<dyn health_runtime::RootKeys> {
    match std::env::var_os("HEALTH_ROOT_KEY_FILE") {
        Some(p) if !p.is_empty() => Box::new(FileStore(PathBuf::from(p))),
        _ => Box::new(Keychain),
    }
}
