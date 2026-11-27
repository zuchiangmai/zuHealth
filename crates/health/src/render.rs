//! Human-readable output: arrays of objects become tables, objects become `key: value` lines.

use serde_json::Value;

fn cell(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

pub fn print(v: &Value) {
    match v {
        Value::Array(rows) if rows.is_empty() => println!("(none)"),
        Value::Array(rows) if rows.iter().all(Value::is_object) => table(rows),
        Value::Object(o) => {
            let w = o.keys().map(|k| k.len()).max().unwrap_or(0);
            for (k, v) in o {
                match v {
                    Value::Array(a) if !a.is_empty() && a.iter().all(Value::is_object) => {
                        println!("{k}:");
                        table(a);
                    }
                    _ => println!("{k:w$}  {}", cell(v)),
                }
            }
        }
        other => println!("{}", cell(other)),
    }
}

fn table(rows: &[Value]) {
    let mut cols: Vec<String> = Vec::new();
    for r in rows {
        for k in r.as_object().unwrap().keys() {
            if !cols.contains(k) {
                cols.push(k.clone());
            }
        }
    }
    let cells: Vec<Vec<String>> =
        rows.iter().map(|r| cols.iter().map(|c| cell(r.get(c).unwrap_or(&Value::Null)).replace('\n', " ")).collect()).collect();
    let width: Vec<usize> =
        cols.iter().enumerate().map(|(i, c)| cells.iter().map(|r| r[i].chars().count()).max().unwrap_or(0).max(c.len()).min(60)).collect();
    let line = |vals: Vec<&str>| {
        let parts: Vec<String> = vals
            .iter()
            .zip(&width)
            .map(|(v, w)| {
                let v: String = v.chars().take(*w).collect();
                format!("{v:w$}")
            })
            .collect();
        println!("{}", parts.join("  ").trim_end());
    };
    line(cols.iter().map(String::as_str).collect());
    for r in &cells {
        line(r.iter().map(String::as_str).collect());
    }
}
