//! SQLite dynamic value as stored in `observation.value` / `correction.value`.
//! JSON integers stay INTEGER and other numbers become REAL, the same rule as the web engine.

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
}

impl Value {
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
    pub fn as_f64(&self) -> Option<f64> {
        match *self {
            Value::Int(i) => Some(i as f64),
            Value::Real(r) => Some(r),
            _ => None,
        }
    }
    /// A finite number as stored: integral values within ±2^53 become INTEGER.
    pub fn number(v: f64) -> Value {
        if v.fract() == 0.0 && v.abs() <= MAX_SAFE { Value::Int(v as i64) } else { Value::Real(v) }
    }
}

/// Largest integer a JSON number (f64) carries exactly; larger INTEGERs overflow sum() in daily.
pub const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

impl ToSql for Value {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(match self {
            Value::Null => ToSqlOutput::Borrowed(ValueRef::Null),
            Value::Int(i) => ToSqlOutput::Borrowed(ValueRef::Integer(*i)),
            Value::Real(r) => ToSqlOutput::Borrowed(ValueRef::Real(*r)),
            Value::Text(s) => ToSqlOutput::Borrowed(ValueRef::Text(s.as_bytes())),
        })
    }
}

impl FromSql for Value {
    fn column_result(v: ValueRef<'_>) -> FromSqlResult<Self> {
        Ok(match v {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(i) => Value::Int(i),
            ValueRef::Real(r) => Value::Real(r),
            ValueRef::Text(t) => Value::Text(String::from_utf8(t.to_vec()).map_err(|e| FromSqlError::Other(e.into()))?),
            ValueRef::Blob(_) => return Err(FromSqlError::InvalidType),
        })
    }
}

impl Serialize for Value {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Value::Null => s.serialize_none(),
            Value::Int(i) => s.serialize_i64(*i),
            Value::Real(r) => s.serialize_f64(*r),
            Value::Text(t) => s.serialize_str(t),
        }
    }
}

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(match serde_json::Value::deserialize(d)? {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::String(s) => Value::Text(s),
            serde_json::Value::Number(n) => match n.as_i64() {
                Some(i) => Value::Int(i),
                None => Value::Real(n.as_f64().ok_or_else(|| serde::de::Error::custom("number out of range"))?),
            },
            _ => return Err(serde::de::Error::custom("value must be a number, a string or null")),
        })
    }
}

impl schemars::JsonSchema for Value {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Value".into()
    }
    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({ "type": ["number", "string", "null"] })
    }
}
