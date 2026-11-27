//! MCP (JSON-RPC 2.0), shared by stdio (`health mcp`) and `POST /mcp`. Tools are exactly the ops
//! delegates may call; every call runs as the grant behind the token.

use health_api::{Delegate, Outcome, ops};
use health_core::Result;
use serde_json::{Value, json};

const VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_VERSION: &str = "2025-06-18";

fn tool_name(op: &str) -> String {
    op.replace('.', "_")
}

fn tools() -> Vec<Value> {
    ops()
        .iter()
        .filter(|o| o.delegate != Delegate::Never)
        .map(|o| json!({ "name": tool_name(o.name), "description": o.about, "inputSchema": (o.req)() }))
        .collect()
}

fn reply(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// One message in, at most one reply out (notifications get none).
pub fn handle(msg: &Value, run: &mut dyn FnMut(&str, Value) -> Result<Outcome>) -> Option<Value> {
    if msg.is_array() {
        return Some(error(&Value::Null, -32600, "batches are not supported"));
    }
    let id = msg.get("id")?.clone(); // no id: a notification
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    Some(match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(DEFAULT_VERSION);
            reply(
                &id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "health", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "Personal health data, limited to what this token's grant allows. Call whoami first. \
                        `withheld` in each result says what the grant hides: hidden is not the same as none. \
                        Writes are proposals the person confirms, or derived results under x:derived/."
                }),
            )
        }
        "ping" => reply(&id, json!({})),
        "tools/list" => reply(&id, json!({ "tools": tools() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            // an op agents may not call still goes through call(), which refuses it and audits the attempt
            let Some(op) = ops().iter().find(|o| tool_name(o.name) == name) else {
                return Some(error(&id, -32602, &format!("unknown tool {name}")));
            };
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let (text, is_error) = match run(op.name, args) {
                Ok(o) => (json!({ "items": o.value, "withheld": o.withheld }).to_string(), false),
                Err(e) => (json!({ "error": { "code": e.code, "message": e.detail } }).to_string(), true),
            };
            reply(&id, json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
        }
        _ => error(&id, -32601, &format!("method not found: {method}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none(_: &str, _: Value) -> Result<Outcome> {
        Ok(Outcome { value: json!([1, 2]), withheld: None })
    }

    #[test]
    fn speaks_the_basics() {
        let r = handle(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}), &mut none)
            .unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        let r = handle(&json!({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "2099-01-01"}}), &mut none)
            .unwrap();
        assert_eq!(r["result"]["protocolVersion"], DEFAULT_VERSION);
        assert!(handle(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}), &mut none).is_none());
        assert_eq!(handle(&json!({"jsonrpc": "2.0", "id": 3, "method": "server/discover"}), &mut none).unwrap()["error"]["code"], -32601);
    }

    #[test]
    fn lists_only_delegate_ops_and_calls_them() {
        let r = handle(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}), &mut none).unwrap();
        let names: Vec<&str> = r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"daily_query") && names.contains(&"derived_write"));
        assert!(!names.iter().any(|n| n.starts_with("backup") || n.starts_with("grant") || n.contains("erase")));
        let r = handle(
            &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "daily_query", "arguments": {}}}),
            &mut none,
        )
        .unwrap();
        assert_eq!(r["result"]["isError"], false);
        let text: Value = serde_json::from_str(r["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(text["items"], json!([1, 2]));
        // an op agents may not call is unlisted, but reaches call() so the refusal is audited
        let mut asked = Vec::new();
        let mut spy = |op: &str, _: Value| -> Result<Outcome> {
            asked.push(op.to_string());
            Err(health_core::Error::new(health_core::Kind::Denied, "denied", "not for agents"))
        };
        let r = handle(&json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "backup_export"}}), &mut spy).unwrap();
        assert_eq!(asked, ["backup.export"]);
        assert_eq!(r["result"]["isError"], true);
        let r = handle(&json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "no_such_tool"}}), &mut none).unwrap();
        assert_eq!(r["error"]["code"], -32602);
        let r = handle(&json!([{"jsonrpc": "2.0", "id": 5, "method": "ping"}]), &mut none).unwrap();
        assert_eq!(r["error"]["code"], -32600);
    }
}
