//! One error type for the whole core. `code` is stable and machine-readable; `kind` picks the exit code.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Other,
    Usage,
    Invalid,
    Denied,
    Locked,
    NotFound,
    Conflict,
}

impl Kind {
    /// CLI exit code (plan §4.1).
    pub fn exit_code(self) -> i32 {
        match self {
            Kind::Other => 1,
            Kind::Usage => 2,
            Kind::Invalid => 3,
            Kind::Denied => 4,
            Kind::Locked => 5,
            Kind::NotFound => 6,
            Kind::Conflict => 7,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Error {
    pub kind: Kind,
    pub code: &'static str,
    pub detail: String,
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn new(kind: Kind, code: &'static str, detail: impl Into<String>) -> Self {
        Error { kind, code, detail: detail.into() }
    }
    pub fn invalid(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(Kind::Invalid, code, detail)
    }
    pub fn not_found(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(Kind::NotFound, code, detail)
    }
    pub fn conflict(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(Kind::Conflict, code, detail)
    }
    pub fn other(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(Kind::Other, code, detail)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.detail.is_empty() { f.write_str(self.code) } else { write!(f, "{}: {}", self.code, self.detail) }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        // A wrong key surfaces as "file is not a database" on first read.
        if let rusqlite::Error::SqliteFailure(f, _) = &e {
            if f.code == rusqlite::ErrorCode::NotADatabase {
                return Error::new(Kind::Locked, "bad_key", "database cannot be decrypted");
            }
            if f.code == rusqlite::ErrorCode::DatabaseBusy {
                return Error::conflict("busy", e.to_string());
            }
        }
        Error::other("sqlite", e.to_string())
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::other("io", e.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::invalid("bad_json", e.to_string())
    }
}
