//! Health data core: the personal health database and the rules around it (no network, no clock).

pub mod access;
pub mod aead;
pub mod apple;
pub mod backup;
pub mod batches;
pub mod blob;
pub mod catalog;
pub mod correction;
pub mod csv;
pub mod daily;
pub mod db;
pub mod derived;
pub mod erase;
pub mod error;
pub mod import;
pub mod keys;
pub mod labs;
pub mod manual;
pub mod merge;
pub mod ocr;
pub mod pack;
pub mod profile;
pub mod query;
pub mod result;
pub mod review;
pub mod scope;
pub mod sync;
pub mod syncstate;
pub mod units;
pub mod value;
pub mod vault;
pub mod whoop;
pub mod write;

pub use error::{Error, Kind, Result};
pub use value::Value;

pub use rusqlite;
