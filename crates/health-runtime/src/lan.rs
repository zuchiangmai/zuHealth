//! LAN sync, run by the runtime (docs/lan-sync.md §5, §6, §10, §11; S4). Two threads:
//! - `poll`: long-polls the day's rendezvous id at the backend relay and hands sealed items to the main loop;
//! - `main`: posts hellos, answers them (the device with the smaller id offers), runs each WebRTC connection
//!   (health-connect) and the sync session on it (health-api), locking the profile only for each session call.
//!
//! Sync runs only while serve runs, the profile is open, the device holds an account (AMK) and sync is on.

use health_api::sync::{Limits, Question, Session, Status};
use health_connect::lan::{Peer, PeerEvent, local_ips};
use health_core::Result;
use health_core::profile::Profile;
use health_proto::b64::{b64u, unb64u};
use health_proto::lan::{Body, Day, Ignored, Inbox, Signal, days_at, host_only};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::net::IpAddr;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const HELLO_EVERY: Duration = Duration::from_secs(300);
const HELLO_BACK: Duration = Duration::from_secs(30);
const CONNECT_WITHIN: Duration = Duration::from_secs(15);
const BACKOFF: Duration = Duration::from_secs(300);
const RETRY_AFTER: Duration = Duration::from_secs(300);
/// A pack that makes no progress this long is a stall (§5.4). Generous: a browser peer builds and merges packs in a
/// worker and may pause a pack meanwhile; a dead link is noticed by ICE itself.
const STALL: Duration = Duration::from_secs(60);
/// While the peer builds or merges packs it may send nothing for a while.
const PEER_WORK: Duration = Duration::from_secs(120);

/// What the profile gives the LAN loop, under serve's lock.
pub trait Host: Send + Sync + 'static {
    /// Runs `f` on the open profile; Err(locked) when serve is locked.
    fn with_profile(&self, f: &mut dyn FnMut(&Profile) -> Result<()>) -> Result<()>;
    fn emit(&self, event: &str, data: Value);
    fn get(&self, path: &str) -> std::result::Result<Value, String>;
    fn post(&self, path: &str, json: &str) -> std::result::Result<Value, String>;
    fn now_ms(&self) -> i64;
    /// The name other devices show for this one ("Health for Mac"; they translate it).
    fn device_name(&self) -> String;
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct PeerRow {
    pub device: String,
    pub name: String,
    /// connecting | syncing | up_to_date | partly | asking | cant_connect | ended
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wanted: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asking: Option<Question>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct Live {
    /// Why sync isn't running here: off, paused, locked, no_account, offline (absent: it is)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle: Option<String>,
    /// Several messages were too far from this clock (§5.3)
    pub clock_off: bool,
    pub peers: Vec<PeerRow>,
}

pub enum Cmd {
    Item(String),
    Changed,
    Answer { device: String, allow: bool },
}

pub struct Lan {
    pub tx: Sender<Cmd>,
    pub live: Arc<Mutex<Live>>,
}

struct Conn {
    peer: Peer,
    /// The offer this side sent, while waiting for the answer
    offer: Option<String>,
    started: Instant,
    session: Option<Session>,
    last_progress: Instant,
    row: PeerRow,
    retry_at: Option<Instant>,
    /// A frame the channel refused for back-pressure, sent before any other
    held: Option<Vec<u8>>,
    reported: bool,
    /// Bytes queued in the channel at the last look: going down is progress (the peer is reading)
    buffered: usize,
}

/// The name other devices show for this one (they translate it: "Health for Mac" → 「Mac 版 Health」).
pub fn me_name() -> String {
    match std::env::consts::OS {
        "macos" => "Health for Mac".into(),
        "windows" => "Health for Windows".into(),
        "linux" => "Health for Linux".into(),
        other => format!("Health for {other}"),
    }
}

fn loopback() -> bool {
    cfg!(debug_assertions) && std::env::var("HEALTH_LAN_LOOPBACK").is_ok()
}

fn limits() -> Limits {
    let mut l = Limits::default();
    if cfg!(debug_assertions)
        && let Some(n) = std::env::var("HEALTH_LAN_BATCH").ok().and_then(|v| v.parse().ok())
    {
        l.batch_rows = n;
    }
    l
}

/// Starts the loop. `offline`: nothing is started (the status says so).
pub fn start(host: Arc<dyn Host>, offline: bool) -> Lan {
    let (tx, rx) = channel();
    let live = Arc::new(Mutex::new(Live::default()));
    if offline {
        live.lock().unwrap().idle = Some("offline".into());
        return Lan { tx, live };
    }
    let rids: Arc<Mutex<Vec<String>>> = Arc::default();
    {
        let (host, rids, tx) = (host.clone(), rids.clone(), tx.clone());
        std::thread::spawn(move || poll(host.as_ref(), &rids, &tx));
    }
    {
        let live = live.clone();
        std::thread::spawn(move || Main::new(host, rids, live).run(rx));
    }
    Lan { tx, live }
}

/// Long-polls every current rid (§5.1): one request at a time, 30 s each (5 s while two days overlap).
fn poll(host: &dyn Host, rids: &Mutex<Vec<String>>, tx: &Sender<Cmd>) {
    let mut after: HashMap<String, i64> = HashMap::new();
    loop {
        let now: Vec<String> = rids.lock().unwrap().clone();
        if now.is_empty() {
            std::thread::sleep(Duration::from_secs(2));
            continue;
        }
        after.retain(|k, _| now.contains(k));
        let wait = if now.len() > 1 { 5 } else { 30 };
        for rid in &now {
            let a = *after.get(rid).unwrap_or(&0);
            match host.get(&format!("/h/1/lan/{rid}?after={a}&wait={wait}")) {
                Ok(v) => {
                    for it in v["items"].as_array().into_iter().flatten() {
                        if let (Some(seq), Some(ct)) = (it["seq"].as_i64(), it["ct"].as_str()) {
                            after.insert(rid.clone(), seq.max(a));
                            if tx.send(Cmd::Item(ct.to_string())).is_err() {
                                return;
                            }
                        }
                    }
                }
                Err(_) => std::thread::sleep(Duration::from_secs(10)),
            }
        }
    }
}

struct Main {
    host: Arc<dyn Host>,
    rids: Arc<Mutex<Vec<String>>>,
    live: Arc<Mutex<Live>>,
    inbox: Inbox,
    conns: BTreeMap<String, Conn>,
    backoff: HashMap<String, Instant>,
    hello_to: HashMap<String, Instant>,
    last_hello: Option<Instant>,
    ips: Vec<IpAddr>,
    dirty: bool,
    skews: u32,
    me: String,
}

impl Main {
    fn new(host: Arc<dyn Host>, rids: Arc<Mutex<Vec<String>>>, live: Arc<Mutex<Live>>) -> Main {
        Main {
            host,
            rids,
            live,
            inbox: Inbox::default(),
            conns: BTreeMap::new(),
            backoff: HashMap::new(),
            hello_to: HashMap::new(),
            last_hello: None,
            ips: vec![],
            dirty: false,
            skews: 0,
            me: String::new(),
        }
    }

    /// The account key and whether sync may run, read under the lock.
    fn account(&self) -> std::result::Result<([u8; 32], String), String> {
        let mut out = Err("locked".to_string());
        let _ = self.host.with_profile(&mut |p| {
            let st = p.sync.load_or_reset()?;
            let v = p.vault.load()?;
            out = if !st.enabled {
                Err("off".into())
            } else if st.paused {
                Err("paused".into())
            } else {
                match v.amk.as_deref().and_then(unb64u).and_then(|k| <[u8; 32]>::try_from(k).ok()) {
                    Some(amk) => Ok((amk, p.vault.device_id()?)),
                    None => Err("no_account".into()),
                }
            };
            Ok(())
        });
        out
    }

    fn run(mut self, rx: Receiver<Cmd>) {
        loop {
            let now = self.host.now_ms();
            let (amk, me) = match self.account() {
                Ok(x) => x,
                Err(why) => {
                    self.conns.clear();
                    self.rids.lock().unwrap().clear();
                    self.publish(Some(why));
                    // wait for a change (unlock, linking, sync turned on) or a little while
                    let _ = rx.recv_timeout(Duration::from_secs(2));
                    continue;
                }
            };
            self.me = me;
            let days: Vec<Day> = days_at(now).iter().map(|d| Day::of(&amk, d)).collect();
            *self.rids.lock().unwrap() = days.iter().map(|d| d.rid.clone()).collect();
            // a changed network: connections restart, a hello goes out (§5.4)
            let ips = local_ips(loopback());
            if ips != self.ips {
                self.ips = ips;
                self.conns.clear();
                self.last_hello = None;
            }
            if self.last_hello.is_none_or(|t| t.elapsed() >= HELLO_EVERY) {
                self.send(&days[0], Body::Hello { name: self.host.device_name(), proto: vec![health_api::sync::PROTO] }, now);
                self.last_hello = Some(Instant::now());
            }
            // commands: block a little when nothing is connected, else just drain
            let wait = if self.conns.is_empty() { Duration::from_millis(500) } else { Duration::from_millis(1) };
            let mut first = rx.recv_timeout(wait).ok();
            while let Some(cmd) = first.take().or_else(|| rx.try_recv().ok()) {
                match cmd {
                    Cmd::Item(ct) => self.item(&days, &ct, now),
                    Cmd::Changed => self.dirty = true,
                    Cmd::Answer { device, allow } => self.answer(&device, allow, now),
                }
            }
            self.drive(now);
            self.publish(None);
        }
    }

    fn send(&self, day: &Day, body: Body, now: i64) -> Option<String> {
        let id = b64u(&health_core::aead::random::<16>());
        let s = Signal { v: 1, t: now, id: id.clone(), from: self.me.clone(), body };
        let ct = day.seal(&serde_json::to_vec(&s).ok()?, health_core::aead::random::<12>());
        let body = json!({ "ct": ct }).to_string();
        self.host.post(&format!("/h/1/lan/{}", day.rid), &body).ok().map(|_| id)
    }

    fn item(&mut self, days: &[Day], ct: &str, now: i64) {
        let refs: Vec<&Day> = days.iter().collect();
        let s = match self.inbox.receive(&refs, ct, &self.me, now) {
            Ok(s) => s,
            Err(Ignored::Skew) => {
                self.skews += 1;
                return;
            }
            Err(_) => return,
        };
        self.skews = 0;
        let from = s.from.clone();
        match s.body {
            Body::Hello { proto, name } => {
                if !proto.contains(&health_api::sync::PROTO) || self.conns.contains_key(&from) {
                    return;
                }
                if self.backoff.get(&from).is_some_and(|t| t.elapsed() < BACKOFF) {
                    return;
                }
                if self.me < from {
                    // the smaller id offers (§5.2)
                    let Ok((peer, sdp)) = Peer::offer(&self.ips) else { return };
                    let Some(id) = self.send(&days[0], Body::Offer { to: from.clone(), sdp }, now) else { return };
                    self.inbox.sent_offer(&id, &from, now);
                    self.conns.insert(from.clone(), Conn::new(peer, Some(id), &from, &name));
                } else if self.hello_to.get(&from).is_none_or(|t| t.elapsed() >= HELLO_BACK) {
                    // so the smaller id hears this device now, not at its next periodic hello
                    self.hello_to.insert(from, Instant::now());
                    self.send(&days[0], Body::Hello { name: self.host.device_name(), proto: vec![health_api::sync::PROTO] }, now);
                }
            }
            Body::Offer { sdp, .. } => {
                if self.me < from {
                    return; // only the smaller id offers
                }
                let Ok((peer, answer)) = Peer::answer(&self.ips, &host_only(&sdp)) else { return };
                self.send(&days[0], Body::Answer { to: from.clone(), re: s.id, sdp: answer }, now);
                self.conns.insert(from.clone(), Conn::new(peer, None, &from, ""));
            }
            Body::Answer { re, sdp, .. } => {
                if let Some(c) = self.conns.get_mut(&from)
                    && c.offer.as_deref() == Some(re.as_str())
                {
                    c.offer = None;
                    if c.peer.accept(&host_only(&sdp)).is_err() {
                        self.conns.remove(&from);
                    }
                }
            }
        }
    }

    fn answer(&mut self, device: &str, allow: bool, now: i64) {
        let Some(c) = self.conns.get_mut(device) else { return };
        let Some(s) = c.session.as_mut() else { return };
        let host = self.host.clone();
        let _ = host.with_profile(&mut |p| s.answer(p, now, allow));
    }

    /// Runs every connection and its session for a moment.
    fn drive(&mut self, now: i64) {
        let host = self.host.clone();
        let mut gone = Vec::new();
        let dirty = std::mem::take(&mut self.dirty);
        for (dev, c) in self.conns.iter_mut() {
            if c.peer.is_closed() {
                // closed (by the peer, or here): gone, a hello soon, no backoff
                gone.push((dev.clone(), false));
                continue;
            }
            if !c.peer.is_open() && c.started.elapsed() > CONNECT_WITHIN {
                eprintln!("lan: no connection within 15 s");
                c.row.state = "cant_connect".into();
                gone.push((dev.clone(), true));
                continue;
            }
            for ev in c.peer.run(Duration::from_millis(2)) {
                match ev {
                    PeerEvent::Open => c.start(&host, now),
                    PeerEvent::Frame(f) => {
                        c.last_progress = Instant::now();
                        if c.session.as_ref().is_none_or(|s| s.is_finished()) {
                            // only a peer's hello starts a session; anything else is left over from an old one
                            if !is_hello(&f) {
                                continue;
                            }
                            c.start(&host, now);
                        }
                        if let Some(s) = c.session.as_mut()
                            && let Err(e) = host.with_profile(&mut |p| s.on_frame(p, now, &f).map(|_| ()))
                        {
                            // codes and fixed texts only: never values (CLAUDE.md)
                            eprintln!(
                                "lan: session ended: {} ({}), frame kind {}",
                                e.code,
                                e.detail,
                                f.first().map_or('?', |k| *k as char)
                            );
                        }
                        // the peer started over: a new session here, fed the hello that ended the old one
                        if c.session.as_ref().is_some_and(|s| s.restarted()) {
                            eprintln!("lan: the peer started over: a new session");
                            c.start(&host, now);
                            if let Some(s) = c.session.as_mut() {
                                let _ = host.with_profile(&mut |p| s.on_frame(p, now, &f).map(|_| ()));
                            }
                        }
                    }
                    PeerEvent::Closed(code) => {
                        eprintln!("lan: channel closed: {code}");
                        gone.push((dev.clone(), false))
                    }
                }
            }
            if !c.peer.is_open() {
                continue;
            }
            // frames out, within back-pressure; a held frame goes first
            c.flush_pending();
            if c.held.is_none()
                && let Some(s) = c.session.as_mut()
            {
                loop {
                    let mut frame = None;
                    let _ = host.with_profile(&mut |p| {
                        frame = s.poll(p, now)?;
                        Ok(())
                    });
                    let Some(f) = frame else { break };
                    match c.peer.send(&f) {
                        Ok(true) => c.last_progress = Instant::now(),
                        // back-pressure: str0m keeps it queued only if accepted; hold this one and retry later
                        Ok(false) => {
                            c.pending(f);
                            break;
                        }
                        Err(_) => break,
                    }
                }
            }
            // the peer reading what is queued is progress, even while it merges and sends nothing
            let b = c.peer.buffered();
            if b < c.buffered {
                c.last_progress = Instant::now();
            }
            c.buffered = b;
            c.update_row();
            // a stall is a pack that stops moving (10 s), or a peer silent for 2 minutes while this side waits for its
            // packs or its done; waiting for a person (here or at the peer) is neither
            let limit = c.session.as_ref().filter(|s| !s.is_finished()).and_then(|s| {
                if s.transferring() {
                    Some(STALL)
                } else if s.awaiting_peer() {
                    Some(PEER_WORK)
                } else {
                    None
                }
            });
            if limit.is_some_and(|l| c.last_progress.elapsed() > l) {
                let what = c.session.as_ref().map_or(String::new(), |s| s.stall_kind());
                eprintln!("lan: stall ({what}, buffered {}): closing the channel to reconnect", c.buffered);
                // a stall is real network silence: the channel goes, so no old frame can follow a new session; the
                // connection is made again from the next hello, and resumes from the last merged batch (§5.4)
                c.peer.close();
                gone.push((dev.clone(), false));
                continue;
            }
            let idle = c.session.as_ref().is_none_or(|s| s.is_finished());
            let due = c.retry_at.is_some_and(|t| t.elapsed() >= RETRY_AFTER);
            if idle && (dirty || due) {
                c.start(&host, now);
            }
            if c.session.as_ref().is_some_and(|s| s.is_finished()) && c.report_once() {
                host.emit("changed", json!({ "op": "sync" }));
            }
        }
        for (dev, back) in gone {
            self.conns.remove(&dev);
            if back {
                self.backoff.insert(dev, Instant::now());
            } else {
                self.last_hello = None; // reconnect soon
            }
        }
    }

    fn publish(&self, idle: Option<String>) {
        let mut rows: Vec<PeerRow> = self.conns.values().map(|c| c.row.clone()).collect();
        let _ = self.host.with_profile(&mut |p| {
            let st = p.sync.load_or_reset()?;
            for r in rows.iter_mut() {
                if let Some(x) = st.peers.get(&r.device) {
                    r.last_synced = x.last_synced;
                    if r.name.is_empty() {
                        r.name = x.name.clone();
                    }
                }
            }
            Ok(())
        });
        let next = Live { idle, clock_off: self.skews >= 3, peers: rows };
        let mut live = self.live.lock().unwrap();
        if *live != next {
            *live = next.clone();
            drop(live);
            self.host.emit("sync", serde_json::to_value(&next).unwrap_or(Value::Null));
        }
    }
}

impl Conn {
    fn new(peer: Peer, offer: Option<String>, device: &str, name: &str) -> Conn {
        Conn {
            peer,
            offer,
            started: Instant::now(),
            session: None,
            last_progress: Instant::now(),
            row: PeerRow { device: device.into(), name: name.chars().take(64).collect(), state: "connecting".into(), ..Default::default() },
            retry_at: None,
            held: None,
            reported: false,
            buffered: 0,
        }
    }

    fn start(&mut self, host: &Arc<dyn Host>, now: i64) {
        eprintln!("lan: session starts");
        let dev = self.row.device.clone();
        let mut made = None;
        let me = host.device_name();
        let _ = host.with_profile(&mut |p| {
            made = Some(Session::new(p, now, &me, Some(dev.clone()), limits())?);
            Ok(())
        });
        self.session = made;
        // nothing of an old session may reach the channel after the new one's hello
        self.held = None;
        self.retry_at = None;
        self.last_progress = Instant::now();
        self.reported = false;
    }

    fn pending(&mut self, f: Vec<u8>) {
        self.held = Some(f);
    }

    fn flush_pending(&mut self) {
        if let Some(f) = self.held.take()
            && !matches!(self.peer.send(&f), Ok(true))
        {
            self.held = Some(f);
        }
    }

    fn report_once(&mut self) -> bool {
        if self.reported {
            return false;
        }
        self.reported = true;
        let s = self.session.as_ref().expect("session");
        if !matches!(s.status(), Status::UpToDate) {
            self.retry_at = Some(Instant::now());
        }
        s.report().packs > 0 || s.report().settings
    }

    fn update_row(&mut self) {
        let Some(s) = &self.session else { return };
        let r = &mut self.row;
        (r.received, r.wanted, r.skipped, r.asking, r.code) = (None, None, None, None, None);
        r.state = match s.status() {
            Status::Starting => "connecting".into(),
            Status::Asking(q) => {
                r.asking = Some(q.clone());
                "asking".into()
            }
            Status::Syncing { received, wanted } => {
                (r.received, r.wanted) = (Some(*received), Some(*wanted));
                "syncing".into()
            }
            Status::UpToDate => "up_to_date".into(),
            Status::Partly { skipped } => {
                r.skipped = Some(*skipped);
                "partly".into()
            }
            Status::Ended { code } => {
                r.code = Some(code.clone());
                "ended".into()
            }
        };
    }
}

/// `health sync-pipe` (debug builds): one session over stdin/stdout, so another implementation (the web's Session)
/// can sync with this one without a network. Frames are a 4-byte big-endian length, then the bytes. Ends when the
/// session is finished or stdin closes; returns the status and report.
pub fn pipe(p: &Profile, now: i64, allow: bool, files: bool, batch_rows: Option<u64>) -> Result<Value> {
    use std::io::{Read, Write};
    let mut l = limits();
    l.files = files;
    if let Some(n) = batch_rows {
        l.batch_rows = n;
    }
    let mut s = Session::new(p, now, &me_name(), None, l)?;
    let (tx, rx) = channel::<Option<Vec<u8>>>();
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            let mut len = [0u8; 4];
            if input.read_exact(&mut len).is_err() {
                let _ = tx.send(None);
                return;
            }
            let mut f = vec![0u8; u32::from_be_bytes(len) as usize];
            if input.read_exact(&mut f).is_err() || tx.send(Some(f)).is_err() {
                let _ = tx.send(None);
                return;
            }
        }
    });
    let mut out = std::io::stdout().lock();
    let mut eof = false;
    loop {
        if allow && matches!(s.status(), Status::Asking(_)) {
            s.answer(p, now, true)?;
        }
        while let Some(f) = s.poll(p, now)? {
            out.write_all(&(f.len() as u32).to_be_bytes())?;
            out.write_all(&f)?;
        }
        out.flush()?;
        if s.is_finished() || eof {
            break;
        }
        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(Some(f)) => {
                let _ = s.on_frame(p, now, &f);
            }
            Ok(None) | Err(_) => eof = true,
        }
    }
    Ok(json!({ "status": s.status(), "report": s.report(), "digest": health_core::sync::of_profile(p)?.digest() }))
}

/// A whole control frame holding a `hello` (`[c, 1, {"t":"hello",…}]`).
fn is_hello(f: &[u8]) -> bool {
    f.len() > 2 && f[0] == b'c' && f[1] == 1 && serde_json::from_slice::<Value>(&f[2..]).is_ok_and(|v| v["t"] == "hello")
}
