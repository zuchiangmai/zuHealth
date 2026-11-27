//! The health backend protocol (`B/docs/協議.md`), rule for rule as the web app has it. Pure: random bytes and
//! the time are always handed in; nothing here opens a connection.

pub mod account;
pub mod b64;
pub mod codes;
pub mod hpke;
pub mod lan;
pub mod result;
pub mod sig;
