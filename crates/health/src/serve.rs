//! `health serve`: the runtime over HTTP on 127.0.0.1 only (plan §2.1, §4.2), thread per request. The runtime
//! (health-runtime) owns the profile, the single writer, network ops, OCR, LAN sync and locking; this file is the
//! HTTP layer: checks, in order, no Origin (no browser page may call it), Host = 127.0.0.1/localhost:<port>, then
//! the caller: owner token (keychain mode: also in serve.json, 0600) or passphrase proof (passphrase mode), or a
//! grant token.

use crate::mcp;
use health_core::keys::{KEYWRAP, PassphraseStore};
use health_core::profile::create_private;
use health_core::{Error, Kind, Result};
use health_runtime::{Opts as Call, Platform, Runtime, State as RtState};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct Opts {
    pub data_dir: PathBuf,
    pub profile: String,
    pub port: u16,
    pub idle_lock: Duration,
    pub offline: bool,
}

type Listeners = Arc<Mutex<Vec<Sender<String>>>>;

struct State {
    rt: Arc<Runtime>,
    data_dir: PathBuf,
    name: String,
    port: u16,
    id: String,
    owner_token: String,
    passphrase_mode: bool,
    /// Passphrase mode: proof of the passphrase the profile was unlocked with (cleared on lock)
    proof: Arc<Mutex<Option<String>>>,
    events: Listeners,
    unlock_gate: Mutex<()>,
}

/// Who is calling.
enum Who {
    Owner,
    Agent(String),
}

fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn status_of(k: Kind) -> u16 {
    match k {
        Kind::Usage => 400,
        Kind::Invalid => 422,
        Kind::Denied => 403,
        Kind::Locked => 423,
        Kind::NotFound => 404,
        Kind::Conflict => 409,
        Kind::Other => 500,
    }
}

type Reply = (u16, Body);
enum Body {
    Json(Value),
    Empty,
    Events(Receiver<String>),
}

fn err(e: &Error) -> Reply {
    (status_of(e.kind), Body::Json(json!({ "error": { "code": e.code, "message": e.detail } })))
}

fn locked() -> Error {
    Error::new(Kind::Locked, "locked", "serve is locked")
}

impl State {
    fn caller(&self, headers: &[(String, String)]) -> Result<Who> {
        let get = |k: &str| headers.iter().find(|(h, _)| h.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str());
        if let Some(p) = get("X-Health-Proof") {
            if self.rt.status().state != RtState::Ready {
                return Err(Error::new(Kind::Locked, "locked", "serve is locked: run `health unlock`"));
            }
            if self.proof.lock().unwrap().as_deref().is_some_and(|x| ct_eq(x, p)) {
                return Ok(Who::Owner);
            }
            return Err(Error::new(Kind::Denied, "denied", "bad passphrase proof"));
        }
        let token =
            get("Authorization").and_then(|v| v.strip_prefix("Bearer ")).ok_or_else(|| Error::new(Kind::Denied, "denied", "no token"))?;
        if ct_eq(token, &self.owner_token) {
            return Ok(Who::Owner);
        }
        if self.rt.status().state != RtState::Ready {
            return Err(locked());
        }
        self.rt.check_agent(token)?;
        Ok(Who::Agent(token.to_string()))
    }

    fn handle(self: &Arc<Self>, method: &str, url: &str, headers: &[(String, String)], body: &[u8]) -> Reply {
        let get = |k: &str| headers.iter().find(|(h, _)| h.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str());
        if get("Origin").is_some() {
            return err(&Error::new(Kind::Denied, "origin", "browser origins are refused"));
        }
        let host_ok = get("Host").is_some_and(|h| h == format!("127.0.0.1:{}", self.port) || h == format!("localhost:{}", self.port));
        if !host_ok {
            return err(&Error::new(Kind::Denied, "host", "wrong Host"));
        }
        let path = url.split('?').next().unwrap_or("");
        match (method, path) {
            ("GET", "/v1/meta") => {
                return (200, Body::Json(json!({ "core": env!("CARGO_PKG_VERSION"), "api": 1, "schema": 1, "id": self.id })));
            }
            ("POST", "/v1/unlock") => return self.unlock(body),
            ("GET", "/mcp") => return (405, Body::Empty),
            _ => {}
        }
        let who = match self.caller(headers) {
            Ok(w) => w,
            Err(e) => return err(&e),
        };
        match (method, path, &who) {
            ("POST", "/v1/lock", Who::Owner) => {
                if !self.passphrase_mode {
                    return err(&Error::conflict("no_passphrase", "only a passphrase-locked profile can be locked"));
                }
                self.rt.lock();
                (200, Body::Json(json!({ "locked": true })))
            }
            ("GET", "/v1/events", Who::Owner) => {
                let (tx, rx) = channel();
                let _ = tx.send(": connected\n\n".into());
                self.events.lock().unwrap().push(tx);
                (200, Body::Events(rx))
            }
            ("POST", "/mcp", Who::Agent(token)) => {
                let Ok(msg) = serde_json::from_slice::<Value>(body) else { return err(&Error::new(Kind::Usage, "bad_json", "")) };
                let mut run = |op: &str, args: Value| {
                    let o = self.rt.agent(token, op, &args)?;
                    let withheld = o.withheld.and_then(|w| serde_json::from_value(w).ok());
                    Ok(health_api::Outcome { value: o.value, withheld })
                };
                match mcp::handle(&msg, &mut run) {
                    Some(r) => (200, Body::Json(r)),
                    None => (202, Body::Empty),
                }
            }
            ("POST", p, _) if p.starts_with("/v1/op/") => {
                let name = &p["/v1/op/".len()..];
                // the runtime's own calls (init, wipe) are the shell's and the CLI's, never over HTTP
                if name.starts_with("runtime.") {
                    return err(&Error::new(Kind::Usage, "no_op", name.to_string()));
                }
                let req = if body.is_empty() { Ok(json!({})) } else { serde_json::from_slice::<Value>(body) };
                let Ok(req) = req else { return err(&Error::new(Kind::Usage, "bad_json", "")) };
                let res = match &who {
                    Who::Owner => self.rt.owner(name, &req, Call { dry_run: get("X-Health-Dry-Run") == Some("1") }),
                    Who::Agent(token) => self.rt.agent(token, name, &req),
                };
                match res {
                    Ok(o) => {
                        if matches!(who, Who::Owner) && name == "whoop.begin" && req["open"] == true {
                            self.whoop_sign_in(o.value["url"].as_str().unwrap_or_default());
                        }
                        (200, Body::Json(json!({ "value": o.value, "withheld": o.withheld })))
                    }
                    Err(e) => err(&e),
                }
            }
            _ => err(&Error::new(Kind::NotFound, "not_found", path.to_string())),
        }
    }

    /// The app's WHOOP sign-in: open the page, catch the redirect, finish and sync, then tell the app.
    fn whoop_sign_in(self: &Arc<Self>, url: &str) {
        crate::account::open_browser(url);
        let s = self.clone();
        std::thread::spawn(move || {
            let call = |name: &str, req: Value| s.rt.owner(name, &req, Call::default()).map(|o| o.value);
            let done = crate::account::wait_redirect(health_api::whoop::REDIRECT_PORT, Duration::from_secs(600))
                .and_then(|q| call("whoop.complete", json!({ "query": q })))
                .and_then(|_| call("whoop.sync", json!({ "force": true })));
            match done {
                Ok(v) => s.rt.emit("whoop", json!({ "ok": true, "written": v["written"] })),
                Err(e) => s.rt.emit("whoop", json!({ "ok": false, "code": e.code })),
            }
            s.rt.emit("changed", json!({ "op": "whoop.sync" }));
        });
    }

    fn unlock(&self, body: &[u8]) -> Reply {
        if !self.passphrase_mode {
            return err(&Error::conflict("not_locked", "this profile has no passphrase"));
        }
        let _one_at_a_time = self.unlock_gate.lock().unwrap();
        let p = serde_json::from_slice::<Value>(body).ok().and_then(|v| v["passphrase"].as_str().map(String::from)).unwrap_or_default();
        let dir = match health_core::profile::profile_dir(&self.data_dir, &self.name) {
            Ok(d) => d,
            Err(e) => return err(&e),
        };
        let store = PassphraseStore::new(&dir.join(KEYWRAP), &p);
        let fail = |e: Error| {
            std::thread::sleep(Duration::from_secs(1));
            err(&e)
        };
        // One key derivation, before opening anything, so other requests never wait on it.
        let proof = match store.proof() {
            Ok(p) => p,
            Err(e) => return fail(e),
        };
        if self.rt.status().state == RtState::Ready {
            // Already unlocked: only the same passphrase gives the same proof; nothing changes on a miss.
            let same = self.proof.lock().unwrap().as_deref().is_some_and(|cur| ct_eq(cur, &proof));
            if !same {
                return fail(Error::new(Kind::Locked, "bad_passphrase", ""));
            }
        } else {
            // the proof is stored before the profile opens, so a request never sees one without the other
            *self.proof.lock().unwrap() = Some(proof);
            if let Err(e) = self.rt.unlock(Some(&store)) {
                *self.proof.lock().unwrap() = None;
                return fail(e);
            }
        }
        (200, Body::Json(json!({ "locked": false })))
    }
}

pub fn run(o: Opts) -> Result<()> {
    let dir = health_core::profile::profile_dir(&o.data_dir, &o.profile)?;
    if crate::client::probe(&dir).is_some() {
        return Err(Error::conflict("running", "a serve is already running for this profile"));
    }
    let passphrase_mode = dir.join(KEYWRAP).exists();
    if !dir.join("id").exists() {
        return Err(Error::not_found("no_profile", format!("{} (run `health init`)", o.profile)));
    }
    let server = tiny_http::Server::http(("127.0.0.1", o.port)).map_err(|e| Error::other("listen", e.to_string()))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or_else(|| Error::other("listen", "no port"))?;

    let events: Listeners = Arc::default();
    let proof: Arc<Mutex<Option<String>>> = Arc::default();
    let on_event = {
        let (events, proof) = (events.clone(), proof.clone());
        move |event: &str, data: Value| {
            if event == "locked" {
                *proof.lock().unwrap() = None;
            }
            // the shell tracks the core's state itself; `status` is the runtime's own
            if event != "status" {
                let msg = format!("event: {event}\ndata: {data}\n\n");
                events.lock().unwrap().retain(|tx| tx.send(msg.clone()).is_ok());
            }
        }
    };
    let mut platform = Platform::system(o.data_dir.clone(), crate::keys::root_keys(), None);
    platform.profile = o.profile.clone();
    platform.now_ms = Box::new(crate::time::now_ms);
    platform.tz_min = Box::new(crate::time::tz_at);
    platform.offline = o.offline;
    let data_dir = o.data_dir.clone();
    platform.recognize = Box::new(move |path, year| crate::ocr::recognize(&data_dir, path, year));
    let rt = Runtime::new(platform, on_event);
    if !passphrase_mode && let Some(e) = rt.open_error() {
        return Err(e);
    }
    let state = Arc::new(State {
        rt,
        data_dir: o.data_dir.clone(),
        name: o.profile.clone(),
        port,
        id: hex::encode(health_core::aead::random::<16>()),
        owner_token: hex::encode(health_core::aead::random::<32>()),
        passphrase_mode,
        proof,
        events,
        unlock_gate: Mutex::new(()),
    });
    // serve.json: how the CLI finds us. In passphrase mode it never holds the owner token (plan §3.3).
    let file = dir.join("serve.json");
    let _ = std::fs::remove_file(&file);
    let mut info = json!({ "port": port, "pid": std::process::id(), "id": state.id });
    if !passphrase_mode {
        info["token"] = json!(state.owner_token);
    }
    std::io::Write::write_all(&mut create_private(&file)?, info.to_string().as_bytes())?;
    println!("{}", json!({ "port": port, "token": state.owner_token, "id": state.id, "locked": passphrase_mode }));
    let _ = std::io::Write::flush(&mut std::io::stdout());

    if passphrase_mode {
        let (rt, idle) = (state.rt.clone(), o.idle_lock);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(5).min(idle));
                rt.lock_if_idle(idle);
            }
        });
    }
    for mut rq in server.incoming_requests() {
        let s = state.clone();
        std::thread::spawn(move || {
            let headers: Vec<(String, String)> = rq.headers().iter().map(|h| (h.field.to_string(), h.value.to_string())).collect();
            let mut body = Vec::new();
            let _ = std::io::Read::take(rq.as_reader(), 64 * 1024 * 1024).read_to_end(&mut body);
            let (status, b) = s.handle(rq.method().as_str(), rq.url(), &headers, &body);
            let ct = |v: &str| tiny_http::Header::from_bytes("Content-Type", v).unwrap();
            let _ = match b {
                Body::Json(v) => {
                    rq.respond(tiny_http::Response::from_string(v.to_string()).with_status_code(status).with_header(ct("application/json")))
                }
                Body::Empty => rq.respond(tiny_http::Response::empty(status)),
                // Straight to the socket, flushed per event: tiny_http's Response would buffer a streamed body.
                Body::Events(rx) => {
                    let mut w = rq.into_writer();
                    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
                    let mut ok = w.write_all(head.as_bytes()).and_then(|_| w.flush()).is_ok();
                    while ok {
                        let msg = rx.recv_timeout(Duration::from_secs(15)).unwrap_or_else(|_| ": ping\n\n".into());
                        ok = w.write_all(msg.as_bytes()).and_then(|_| w.flush()).is_ok();
                    }
                    Ok(())
                }
            };
        });
    }
    let _ = std::fs::remove_file(&file);
    Ok(())
}

use std::io::{Read as _, Write as _};
