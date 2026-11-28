//! The LAN sync session (docs/lan-sync.md §6, §9, §10): one exchange between this device and one peer over a
//! reliable, ordered channel. Sans-IO: the caller moves frames between `poll` and the peer's `on_frame`, and holds the
//! profile's lock only for each call. No network, no clock (`now_ms` is an argument), no threads.
//!
//! A session runs once: hello → inventories → wants → packs → done. The caller starts a new one when either side has
//! changed since (serve's change event, S4). Owner only, like the account's network ops.
//!
//! Framing: every frame is `[kind, last, payload…]`, at most `MAX_FRAME` bytes. `kind` is `c` (a control message,
//! JSON), `i` (the inventory, text) or `p` (pack bytes). `last` is 1 on a message's final frame. A message's frames
//! are never interleaved with another's.

use health_core::backup;
use health_core::error::{Error, Kind, Result};
use health_core::pack;
use health_core::profile::Profile;
use health_core::sync::{self, Inventory, Settings, Want};
use health_core::syncstate::{Cursor, Skip, SyncState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;

pub const PROTO: u32 = 1;
pub use health_core::syncstate::MAX_PEERS;
const WEB_MAX_PACK: u64 = 256 << 20;

fn web_max_pack() -> u64 {
    WEB_MAX_PACK
}

fn yes() -> bool {
    true
}
pub const MAX_FRAME: usize = 16 * 1024;
/// A peer's refusal for clock skew is retried after this long (§6.4).
pub const SKEW_RETRY_MS: i64 = 3_600_000;
/// Every other negative cache entry is retried after a day: what it depends on isn't all in the inventory (a
/// metric's unit, R4), so a conflict fixed elsewhere (an app update) is noticed.
pub const SKIP_RETRY_MS: i64 = 86_400_000;

/// Bounds on what a peer may send, and how large a batch is (§6.5, §12).
#[derive(Debug, Clone)]
pub struct Limits {
    pub control: usize,
    pub inventory: usize,
    pub pack: u64,
    /// Rows per batch, and per part of a split import
    pub batch_rows: u64,
    /// This side keeps files (the web doesn't yet: lan-sync §6.4)
    pub files: bool,
}

impl Default for Limits {
    fn default() -> Self {
        // a first sync's want lists every import (about 40 bytes each)
        Limits { control: 32 << 20, inventory: 64 << 20, pack: 2 << 30, batch_rows: 50_000, files: true }
    }
}

/// Control messages (frame kind `c`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case", deny_unknown_fields)]
pub enum Msg {
    Hello {
        proto: u32,
        device: String,
        #[serde(default)]
        name: String,
        digest: String,
        lacks: u64,
        /// The largest pack this side takes (absent: 256 MiB, the web's)
        #[serde(default = "web_max_pack")]
        max_pack: u64,
        /// This side keeps files (absent: true)
        #[serde(default = "yes")]
        files: bool,
    },
    Want {
        #[serde(default)]
        imports: Vec<String>,
        /// Split imports received in part here: where to go on
        #[serde(default)]
        after: BTreeMap<String, Cursor>,
        #[serde(default)]
        corrections: bool,
        #[serde(default)]
        settings: bool,
        #[serde(default)]
        aliases: bool,
        #[serde(default)]
        blobs: Vec<String>,
    },
    /// Followed by `bytes` of pack frames
    Pack {
        bytes: u64,
        password: String,
        /// How many wanted imports it holds (progress)
        imports: u64,
        /// One part of a split import, and where the next starts (None: the last)
        #[serde(default, skip_serializing_if = "Option::is_none")]
        part: Option<Part>,
    },
    Settings(Settings),
    /// Everything the peer wanted has been sent
    Served,
    Done {
        digest: String,
        /// Files still missing here after the merges
        #[serde(default)]
        lacks: u64,
    },
    /// The session ends early: `paused`, `off`, `declined`, `proto`, or an error code
    Bye {
        code: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Part {
    pub uid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<Cursor>,
}

/// What the person is asked before this session goes on (§10).
#[derive(Debug, Clone, Serialize, PartialEq, schemars::JsonSchema)]
#[serde(tag = "ask", rename_all = "snake_case")]
pub enum Question {
    /// This device's first sync ever
    Join { imports: u64 },
    /// The peer's tombstones would delete this much here
    Erase { imports: u64, rows: u64 },
}

#[derive(Debug, Clone, Serialize, PartialEq, schemars::JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Status {
    Starting,
    Asking(Question),
    Syncing {
        received: u64,
        wanted: u64,
    },
    /// Both sides hold the same data
    UpToDate,
    /// Finished, but some things the merge refused differ (`skipped`: negative cache entries for this peer)
    Partly {
        skipped: u64,
    },
    /// Ended early; `code` says why (here or at the peer)
    Ended {
        code: String,
    },
}

#[derive(Debug, Default, Clone, Serialize, PartialEq, schemars::JsonSchema)]
pub struct Report {
    pub packs: u64,
    pub imports: u64,
    pub erased: u64,
    pub settings: bool,
    pub whoop_disconnected: bool,
    pub blobs: u64,
    /// Packs too large for the peer, left out
    pub oversize: u64,
}

enum Job {
    Subset { uids: Vec<String>, corrections: bool, blobs: Vec<String> },
    Part { uid: String, after: Option<Cursor> },
}

struct Outgoing {
    file: std::fs::File,
    path: PathBuf,
    left: u64,
}

struct Incoming {
    file: std::fs::File,
    path: PathBuf,
    left: u64,
    password: String,
    part: Option<Part>,
}

/// One message being reassembled.
struct Assembly {
    kind: u8,
    buf: Vec<u8>,
}

pub struct Session {
    device: String,
    name: String,
    expect: Option<String>,
    limits: Limits,
    status: Status,
    out: VecDeque<Vec<u8>>,
    /// Control messages sent while a pack streams: they follow it, never split it
    held: VecDeque<Vec<u8>>,
    mine: Option<Inventory>,
    hello_sent: bool,
    peer: Option<String>,
    peer_hello: Option<(String, u64)>,
    /// From the peer's hello
    peer_max_pack: u64,
    peer_files: bool,
    settings_got: bool,
    my_lacks_after: u64,
    peer_inv: Option<Inventory>,
    pending_want: Option<Want>,
    my_want: Option<Want>,
    sent_inventory: bool,
    // serving the peer
    jobs: VecDeque<Job>,
    sending: Option<Outgoing>,
    serving: bool,
    settings_out: Option<Settings>,
    served_sent: bool,
    // receiving
    asm: Option<Assembly>,
    incoming: Option<Incoming>,
    received_imports: u64,
    /// Split imports whose transfer started from a cursor this session
    resumed: BTreeSet<String>,
    /// Split imports still incomplete when the peer said it had served everything
    split_open: BTreeSet<String>,
    settings_refused: bool,
    refused_imports: u64,
    refused_corrections: u64,
    peer_served: bool,
    done_sent: Option<String>,
    peer_done: Option<(String, u64)>,
    finished: bool,
    report: Report,
}

fn ended(code: &str) -> Status {
    Status::Ended { code: code.into() }
}

fn bad(code: &'static str, msg: &str) -> Error {
    Error::new(Kind::Invalid, code, msg.to_string())
}

fn frames(kind: u8, data: &[u8], out: &mut VecDeque<Vec<u8>>) {
    let room = MAX_FRAME - 2;
    if data.is_empty() {
        out.push_back(vec![kind, 1]);
        return;
    }
    let n = data.len().div_ceil(room);
    for (i, c) in data.chunks(room).enumerate() {
        let mut f = Vec::with_capacity(c.len() + 2);
        f.push(kind);
        f.push((i + 1 == n) as u8);
        f.extend_from_slice(c);
        out.push_back(f);
    }
}

fn hash_lines(lines: &[String]) -> String {
    let mut h = Sha256::new();
    for l in lines {
        h.update(l.as_bytes());
        h.update(b"\n");
    }
    hex::encode(h.finalize())
}

fn import_text(inv: &Inventory, uid: &str) -> String {
    inv.imports
        .get(uid)
        .map_or("-".into(), |l| format!("{} {} {}", l.status, l.blob.as_deref().unwrap_or("-"), l.fp.as_deref().unwrap_or("-")))
}

fn rows_of(fp: Option<&str>) -> u64 {
    fp.and_then(|f| f.split_once(':')).and_then(|(n, _)| n.parse().ok()).unwrap_or(0)
}

impl Session {
    /// Starts a session with a peer. `expect`: the device id signalling authenticated, when known.
    pub fn new(p: &Profile, now_ms: i64, name: &str, expect: Option<String>, limits: Limits) -> Result<Session> {
        let device = p.vault.device_id()?;
        let st = p.sync.load_or_reset()?;
        let mut s = Session {
            device,
            name: name.into(),
            expect,
            limits,
            status: Status::Starting,
            out: VecDeque::new(),
            held: VecDeque::new(),
            mine: None,
            hello_sent: false,
            peer: None,
            peer_hello: None,
            peer_max_pack: WEB_MAX_PACK,
            peer_files: true,
            settings_got: false,
            my_lacks_after: 0,
            peer_inv: None,
            pending_want: None,
            my_want: None,
            sent_inventory: false,
            jobs: VecDeque::new(),
            sending: None,
            serving: false,
            settings_out: None,
            served_sent: false,
            asm: None,
            incoming: None,
            received_imports: 0,
            resumed: BTreeSet::new(),
            split_open: BTreeSet::new(),
            settings_refused: false,
            refused_imports: 0,
            refused_corrections: 0,
            peer_served: false,
            done_sent: None,
            peer_done: None,
            finished: false,
            report: Report::default(),
        };
        if !st.enabled {
            s.end("off");
        } else if st.paused {
            s.end("paused");
        } else if !st.joined {
            let n: i64 = p.db.query_row("SELECT count(*) FROM import WHERE status IN ('done', 'review')", [], |r| r.get(0))?;
            s.status = Status::Asking(Question::Join { imports: n as u64 });
        } else {
            s.send_hello(p)?;
        }
        let _ = now_ms;
        Ok(s)
    }

    pub fn status(&self) -> &Status {
        &self.status
    }

    pub fn report(&self) -> &Report {
        &self.report
    }

    /// The peer's device id, once its hello arrived.
    pub fn peer(&self) -> Option<&str> {
        self.peer.as_deref()
    }

    /// A pack is being sent or received: the only time a session waits on the network rather than on a person
    /// (a question here or at the peer). Stalls are timed only then.
    pub fn transferring(&self) -> bool {
        self.sending.is_some() || self.incoming.is_some() || !self.jobs.is_empty()
    }

    /// Waiting for the peer's work: packs after a want (until `served`), or its `done` after this side's. Network
    /// wait, timed with a longer limit than a pack in flight, since the peer may build or merge a large pack.
    pub fn awaiting_peer(&self) -> bool {
        (self.my_want.is_some() && !self.peer_served) || (self.done_sent.is_some() && self.peer_done.is_none())
    }

    /// What the session waits on, for a log line: codes only.
    pub fn stall_kind(&self) -> String {
        format!(
            "sending {} incoming {} jobs {} want {} served {}",
            self.sending.is_some(),
            self.incoming.is_some(),
            self.jobs.len(),
            self.my_want.is_some(),
            self.peer_served
        )
    }

    /// The peer started a new session: start one here and give it the frame that ended this one.
    pub fn restarted(&self) -> bool {
        matches!(&self.status, Status::Ended { code } if code == "restart")
    }

    /// Nothing more to send or receive.
    pub fn is_finished(&self) -> bool {
        self.finished && self.out.is_empty() && self.held.is_empty()
    }

    fn end(&mut self, code: &str) {
        if !self.finished {
            // a pack being streamed is abandoned: the bye goes right after the frames already out
            if let Some(o) = self.sending.take() {
                let _ = std::fs::remove_file(&o.path);
                self.out.retain(|f| f[0] != b'p');
                self.held.clear();
            }
            self.send(&Msg::Bye { code: code.into() });
            self.status = ended(code);
            self.finished = true;
        }
        self.drop_files();
    }

    fn drop_files(&mut self) {
        self.jobs.clear();
        if let Some(o) = self.sending.take() {
            let _ = std::fs::remove_file(&o.path);
        }
        if let Some(i) = self.incoming.take() {
            let _ = std::fs::remove_file(&i.path);
        }
    }

    fn send(&mut self, m: &Msg) {
        let q = if self.sending.is_some() { &mut self.held } else { &mut self.out };
        frames(b'c', serde_json::to_string(m).expect("json").as_bytes(), q);
    }

    fn send_hello(&mut self, p: &Profile) -> Result<()> {
        let inv = sync::of_profile(p)?;
        let m = Msg::Hello {
            proto: PROTO,
            device: self.device.clone(),
            name: self.name.clone(),
            digest: inv.digest(),
            lacks: if self.limits.files { inv.lacks.len() as u64 } else { 0 },
            max_pack: self.limits.pack,
            files: self.limits.files,
        };
        self.mine = Some(inv);
        self.send(&m);
        self.hello_sent = true;
        self.status = Status::Syncing { received: 0, wanted: 0 };
        Ok(())
    }

    /// The person's answer to `Status::Asking`.
    pub fn answer(&mut self, p: &Profile, now_ms: i64, allow: bool) -> Result<()> {
        let Status::Asking(q) = self.status.clone() else {
            return Err(Error::conflict("not_asking", "nothing is being asked"));
        };
        match (q, allow) {
            (Question::Join { .. }, true) => {
                p.sync.update(|s| {
                    s.joined = true;
                    Ok(())
                })?;
                self.send_hello(p)?;
                if self.peer_hello.is_some() {
                    self.after_hellos(p, now_ms)?;
                }
            }
            (Question::Join { .. }, false) => self.end("declined"),
            (Question::Erase { .. }, true) => {
                let w = self.pending_want.take().expect("held");
                self.status = Status::Syncing { received: 0, wanted: w.imports.len() as u64 };
                self.send_want(p, w)?;
            }
            (Question::Erase { .. }, false) => {
                // tombstones can't be declined one by one: "Not now" pauses sync here (§10)
                p.sync.update(|s| {
                    s.paused = true;
                    Ok(())
                })?;
                self.end("paused");
            }
        }
        Ok(())
    }

    /// The next frame to send, building the next pack when the last one has gone.
    pub fn poll(&mut self, p: &Profile, now_ms: i64) -> Result<Option<Vec<u8>>> {
        if let Some(f) = self.out.pop_front() {
            return Ok(Some(f));
        }
        if self.finished {
            return Ok(None);
        }
        // a pack left out (too large) queues nothing: go on until something is queued or nothing is left to do
        while self.out.is_empty() && !self.finished {
            let idle = self.sending.is_none() && self.jobs.is_empty() && self.settings_out.is_none() && (self.served_sent || !self.serving);
            if idle {
                break;
            }
            let r = self.pump(p, now_ms);
            if let Err(e) = &r {
                self.end(e.code);
            }
            r?;
        }
        Ok(self.out.pop_front())
    }

    fn pump(&mut self, p: &Profile, now_ms: i64) -> Result<()> {
        if let Some(o) = &mut self.sending {
            let mut buf = vec![0u8; (MAX_FRAME - 2).min(o.left as usize)];
            o.file.read_exact(&mut buf)?;
            o.left -= buf.len() as u64;
            let last = o.left == 0;
            let mut f = vec![b'p', last as u8];
            f.extend_from_slice(&buf);
            self.out.push_back(f);
            if last {
                let o = self.sending.take().expect("sending");
                let _ = std::fs::remove_file(&o.path);
                self.out.append(&mut self.held);
            }
            return Ok(());
        }
        if !self.serving {
            return Ok(());
        }
        if let Some(job) = self.jobs.pop_front() {
            return self.build(p, now_ms, job);
        }
        if let Some(s) = self.settings_out.take() {
            self.send(&Msg::Settings(s));
            return Ok(());
        }
        if !self.served_sent {
            self.served_sent = true;
            self.send(&Msg::Served);
            self.maybe_finish(p, now_ms)?;
        }
        Ok(())
    }

    fn tmp(p: &Profile, what: &str) -> PathBuf {
        p.tmp().join(format!("sync-{what}-{}", hex::encode(health_core::aead::random::<8>())))
    }

    /// Writes one pack for the peer into tmp/ and queues it.
    fn build(&mut self, p: &Profile, now_ms: i64, job: Job) -> Result<()> {
        // a split import erased (or otherwise changed) since it was queued goes as it is now, whole: a tombstone
        let job = match job {
            Job::Part { uid, after } => {
                let done: bool = p.db.query_row("SELECT status = 'done' FROM import WHERE uid = ?", [&uid], |r| r.get(0)).unwrap_or(false);
                if done { Job::Part { uid, after } } else { Job::Subset { uids: vec![uid], corrections: false, blobs: vec![] } }
            }
            j => j,
        };
        let plain = Self::tmp(p, "plain");
        let packed = Self::tmp(p, "pack");
        let password = hex::encode(health_core::aead::random::<32>());
        let r = (|| {
            let (imports, blobs, part) = match &job {
                Job::Subset { uids, corrections, blobs } => {
                    health_core::merge::export_subset(&p.db, uids, *corrections, &plain)?;
                    (uids.len() as u64, blobs.clone(), None)
                }
                Job::Part { uid, after } => {
                    let next = health_core::merge::export_part(&p.db, uid, after.as_ref(), self.limits.batch_rows, &plain)?;
                    if let Some(n) = &next {
                        self.jobs.push_front(Job::Part { uid: uid.clone(), after: Some(n.clone()) });
                    }
                    (next.is_none() as u64, vec![], Some(Part { uid: uid.clone(), next }))
                }
            };
            backup::pack_plain(p, &plain, &packed, &password, &blobs, now_ms, pack::Options { iter: 1, ..Default::default() })?;
            Ok::<_, Error>((imports, part))
        })();
        let _ = std::fs::remove_file(&plain);
        let (imports, part) = match r {
            Ok(x) => x,
            Err(e) => {
                let _ = std::fs::remove_file(&packed);
                return Err(e);
            }
        };
        let bytes = std::fs::metadata(&packed)?.len();
        if bytes > self.peer_max_pack.min(self.limits.pack) {
            // too large for the peer: halve the batch, or drop the files, or (one import alone) leave it out, which
            // the peer's negative cache then keeps from being asked again. Never ends the session.
            let _ = std::fs::remove_file(&packed);
            match job {
                Job::Subset { uids, corrections, blobs } if uids.len() > 1 => {
                    let (a, b) = uids.split_at(uids.len() / 2);
                    let (x, y) = blobs.split_at(blobs.len() / 2);
                    self.jobs.push_front(Job::Subset { uids: b.to_vec(), corrections: false, blobs: y.to_vec() });
                    self.jobs.push_front(Job::Subset { uids: a.to_vec(), corrections, blobs: x.to_vec() });
                }
                Job::Subset { uids, corrections, blobs } if blobs.len() > 1 => {
                    let (x, y) = blobs.split_at(blobs.len() / 2);
                    self.jobs.push_front(Job::Subset { uids: vec![], corrections: false, blobs: y.to_vec() });
                    self.jobs.push_front(Job::Subset { uids, corrections, blobs: x.to_vec() });
                }
                Job::Subset { uids, corrections, blobs } if !blobs.is_empty() && !uids.is_empty() => {
                    self.jobs.push_front(Job::Subset { uids, corrections, blobs: vec![] });
                }
                Job::Part { .. } => {
                    // the rest of a split import is dropped with this part
                    self.jobs.retain(|j| !matches!(j, Job::Part { .. }));
                }
                _ => {}
            }
            self.report.oversize += 1;
            return Ok(());
        }
        self.send(&Msg::Pack { bytes, password, imports, part });
        self.sending = Some(Outgoing { file: std::fs::File::open(&packed)?, path: packed, left: bytes });
        Ok(())
    }

    /// One frame from the peer. An error ends the session (a `bye` goes out first).
    pub fn on_frame(&mut self, p: &Profile, now_ms: i64, f: &[u8]) -> Result<()> {
        if self.finished {
            return Ok(());
        }
        let r = self.frame(p, now_ms, f);
        if let Err(e) = &r {
            self.end(e.code);
        }
        r
    }

    fn frame(&mut self, p: &Profile, now_ms: i64, f: &[u8]) -> Result<()> {
        if f.len() < 2 || f.len() > MAX_FRAME || f[1] > 1 {
            return Err(bad("sync_frame", "a malformed frame"));
        }
        let (kind, last, data) = (f[0], f[1] == 1, &f[2..]);
        if kind == b'p' {
            return self.pack_bytes(p, now_ms, data, last);
        }
        let cap = match kind {
            b'c' => self.limits.control,
            b'i' => self.limits.inventory,
            _ => return Err(bad("sync_frame", "an unknown frame kind")),
        };
        let a = self.asm.get_or_insert_with(|| Assembly { kind, buf: Vec::new() });
        if a.kind != kind {
            return Err(bad("sync_frame", "interleaved messages"));
        }
        if a.buf.len() + data.len() > cap {
            return Err(bad("sync_large", "a message over the limit"));
        }
        a.buf.extend_from_slice(data);
        if !last {
            return Ok(());
        }
        let a = self.asm.take().expect("assembly");
        if kind == b'i' {
            if self.incoming.is_some() {
                return Err(bad("sync_frame", "an inventory inside a pack"));
            }
            let text = String::from_utf8(a.buf).map_err(|_| bad("bad_inventory", "not UTF-8"))?;
            return self.on_inventory(p, now_ms, Inventory::parse(&text)?);
        }
        let m: Msg = serde_json::from_slice(&a.buf).map_err(|_| bad("sync_message", "an unreadable message"))?;
        // only a bye may cut a pack short
        if self.incoming.is_some() && !matches!(m, Msg::Bye { .. }) {
            return Err(bad("sync_frame", "a message inside a pack"));
        }
        self.on_msg(p, now_ms, m)
    }

    fn on_msg(&mut self, p: &Profile, now_ms: i64, m: Msg) -> Result<()> {
        match m {
            Msg::Hello { proto, device, name, digest, lacks, max_pack, files } => {
                if proto != PROTO {
                    return Err(bad("sync_proto", "the other device speaks another sync version"));
                }
                let ok_id = device.len() == 32 && device.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
                if ok_id && self.peer.as_deref() == Some(device.as_str()) && self.peer_hello.is_some() {
                    // the peer started over (its session ended, e.g. a stall on its side): this one ends without a
                    // bye, and the caller starts a new one with this hello (lan-sync §6.3)
                    self.status = ended("restart");
                    self.finished = true;
                    self.drop_files();
                    self.out.clear();
                    self.held.clear();
                    return Ok(());
                }
                if !ok_id || device == self.device || self.expect.as_ref().is_some_and(|e| *e != device) || self.peer_hello.is_some() {
                    return Err(bad("sync_peer", "an unexpected device"));
                }
                p.sync.update(|s| {
                    let e = s.peers.entry(device.clone()).or_default();
                    e.last_seen = now_ms;
                    e.name = name.chars().take(64).collect();
                    Ok(())
                })?;
                self.peer = Some(device);
                self.peer_hello = Some((digest, lacks));
                // a pack must hold an import's rows: under 1 MiB is no limit to honour
                self.peer_max_pack = max_pack.clamp(1 << 20, self.limits.pack.max(1 << 20));
                self.peer_files = files;
                if self.hello_sent {
                    self.after_hellos(p, now_ms)?;
                }
            }
            Msg::Want { imports, after, corrections, settings, aliases, blobs } => {
                if !self.sent_inventory {
                    return Err(bad("sync_order", "a want before the inventories"));
                }
                self.serve(p, Want { imports, corrections, settings, aliases, blobs }, after)?;
            }
            Msg::Pack { bytes, password, imports, part } => {
                if bytes > self.limits.pack || bytes == 0 {
                    return Err(bad("sync_large", "a pack over the limit"));
                }
                if self.my_want.is_none() || self.peer_served || password.len() > 128 {
                    return Err(bad("sync_order", "an unasked pack"));
                }
                if let Some(pt) = &part {
                    let wanted = self.my_want.as_ref().is_some_and(|w| w.imports.contains(&pt.uid));
                    let sane = pt.next.as_ref().is_none_or(|c| {
                        !c.code.is_empty() && c.code.len() <= 256 && (0..=health_core::write::MAX_TIME_MS).contains(&c.start_ms)
                    });
                    if !wanted || !sane {
                        return Err(bad("sync_pack", "a part of an import nobody asked for"));
                    }
                }
                let path = Self::tmp(p, "in");
                let file = health_core::profile::create_private(&path)?;
                self.received_imports = self.received_imports.saturating_add(imports);
                self.incoming = Some(Incoming { file, path, left: bytes, password, part });
            }
            Msg::Settings(s) => {
                if !self.my_want.as_ref().is_some_and(|w| w.settings) || self.settings_got || self.peer_served {
                    return Err(bad("sync_order", "unasked settings"));
                }
                self.settings_got = true;
                // the vault is written only when something applies (it holds the AMK: rarely rewritten)
                let mut st = p.vault.load()?;
                let applied = sync::apply_settings(&mut st, &s, now_ms);
                if applied.profile || applied.whoop_stopped {
                    p.vault.save(&st)?;
                }
                self.settings_refused |= applied.refused;
                self.report.settings |= applied.profile || applied.whoop_stopped;
                self.report.whoop_disconnected |= applied.whoop_disconnected;
            }
            Msg::Served => {
                if self.my_want.is_none() || self.peer_served {
                    return Err(bad("sync_order", "served before a want"));
                }
                self.peer_served = true;
                self.finish_receiving(p, now_ms)?;
            }
            Msg::Done { digest, lacks } => {
                self.peer_done = Some((digest, lacks));
                self.maybe_finish(p, now_ms)?;
            }
            Msg::Bye { code } => {
                self.status = ended(&code.chars().take(32).collect::<String>());
                self.finished = true;
                self.drop_files();
                self.out.clear();
                self.held.clear();
            }
        }
        Ok(())
    }

    fn after_hellos(&mut self, p: &Profile, now_ms: i64) -> Result<()> {
        let (digest, lacks) = self.peer_hello.clone().expect("hello");
        let mine = self.mine.as_ref().expect("mine");
        let my_lacks = if self.limits.files { mine.lacks.len() as u64 } else { 0 };
        if digest == mine.digest() && self.files_settled(my_lacks, lacks) {
            self.status = Status::UpToDate;
            self.finished = true;
            let peer = self.peer.clone().expect("peer");
            p.sync.update(|s| {
                // equal: nothing differs, so nothing cached for this peer still means anything (files aside)
                s.skip.retain(|k| k.peer != peer || k.what.starts_with("b "));
                let e = s.peers.entry(peer).or_default();
                e.last_synced = Some(now_ms);
                e.up_to_date = true;
                Ok(())
            })?;
            return Ok(());
        }
        let wire = mine.wire();
        frames(b'i', wire.as_bytes(), &mut self.out);
        self.sent_inventory = true;
        if self.peer_inv.is_some() {
            self.plan(p, now_ms)?;
        }
        Ok(())
    }

    /// Missing files count only when both sides keep files (lan-sync §6.4): a fileless peer can't send or keep one.
    fn files_settled(&self, mine: u64, theirs: u64) -> bool {
        !(self.limits.files && self.peer_files) || (mine == 0 && theirs == 0)
    }

    fn on_inventory(&mut self, p: &Profile, now_ms: i64, inv: Inventory) -> Result<()> {
        if self.peer_hello.is_none() || self.peer_inv.is_some() {
            return Err(bad("sync_order", "an inventory out of turn"));
        }
        self.peer_inv = Some(inv);
        if self.sent_inventory {
            self.plan(p, now_ms)?;
        }
        Ok(())
    }

    /// Works out what to ask the peer for, minus the negative cache, and asks first if it would erase a lot here.
    fn plan(&mut self, p: &Profile, now_ms: i64) -> Result<()> {
        let peer = self.peer.clone().expect("peer");
        let (mine, theirs) = (self.mine.as_ref().expect("mine"), self.peer_inv.as_ref().expect("inv"));
        let mut st = p.sync.load_or_reset()?;
        // entries that no longer match either side, or have expired (any peer's), go
        let keys = Keys::of(mine, theirs);
        let keep = |k: &Skip| -> bool {
            if k.until.is_some_and(|u| u <= now_ms) {
                return false;
            }
            k.peer != peer || keys.current(mine, theirs, &k.what).is_some_and(|(l, r)| l == k.local && r == k.remote)
        };
        st.skip.retain(keep);
        // cursors of imports no longer done here belong to nothing
        st.resume.retain(|uid, _| mine.imports.get(uid).is_some_and(|l| l.status == "done"));
        // devices not seen for long are forgotten, with their entries
        st.forget_old_peers();
        let skipped: BTreeSet<String> = st.skip.iter().filter(|k| k.peer == peer).map(|k| k.what.clone()).collect();
        let mut w = sync::wants(mine, theirs, &|uid| skipped.contains(&format!("i {uid}")));
        w.corrections &= !skipped.contains("c");
        w.settings &= !skipped.contains("s");
        w.aliases &= !skipped.contains("a");
        w.blobs.retain(|b| !skipped.contains(&format!("b {b}")));
        if !(self.limits.files && self.peer_files) {
            w.blobs.clear();
        }
        p.sync.save(&st)?;
        // a large erase asks first (§10): tombstones of imports that hold rows here
        let total: u64 = mine.imports.values().filter(|l| l.status == "done").map(|l| rows_of(l.fp.as_deref())).sum();
        let (mut n, mut rows) = (0u64, 0u64);
        for uid in &w.imports {
            if theirs.imports.get(uid).is_some_and(|l| l.status == "erased")
                && let Some(l) = mine.imports.get(uid)
            {
                let r = rows_of(l.fp.as_deref());
                if r > 0 {
                    n += 1;
                    rows += r;
                }
            }
        }
        if n > 20 || rows * 10 > total {
            self.status = Status::Asking(Question::Erase { imports: n, rows });
            self.pending_want = Some(w);
            return Ok(());
        }
        self.status = Status::Syncing { received: 0, wanted: w.imports.len() as u64 };
        self.send_want(p, w)
    }

    fn send_want(&mut self, p: &Profile, w: Want) -> Result<()> {
        let resume = p.sync.load_or_reset()?.resume;
        let after: BTreeMap<String, Cursor> = w.imports.iter().filter_map(|u| resume.get(u).map(|c| (u.clone(), c.clone()))).collect();
        self.resumed = after.keys().cloned().collect();
        self.send(&Msg::Want {
            imports: w.imports.clone(),
            after,
            corrections: w.corrections,
            settings: w.settings,
            aliases: w.aliases,
            blobs: w.blobs.clone(),
        });
        self.my_want = Some(w);
        Ok(())
    }

    /// Queues the packs for what the peer wants (§6.3): tombstones with the tables first, then imports in uid order
    /// in batches of about `batch_rows` rows, a larger import alone in parts, then the files, then the settings.
    fn serve(&mut self, p: &Profile, w: Want, after: BTreeMap<String, Cursor>) -> Result<()> {
        if self.serving {
            return Err(bad("sync_order", "a second want"));
        }
        let mine = self.mine.as_ref().expect("mine");
        let mut st = p.db.prepare("SELECT status FROM import WHERE uid = ?")?;
        let mut tombs = Vec::new();
        let mut live: Vec<(String, u64)> = Vec::new();
        let wanted: BTreeSet<&String> = w.imports.iter().collect();
        if wanted.len() > 2 * health_core::sync::MAX_LINES {
            return Err(bad("sync_large", "too many imports wanted"));
        }
        for uid in wanted {
            // only what is settled here now: a running import is never sent
            let now: Option<String> = st.query_row([uid], |r| r.get(0)).ok();
            match now.as_deref() {
                Some("erased") => tombs.push(uid.clone()),
                Some("done") => live.push((uid.clone(), mine.imports.get(uid).map_or(0, |l| rows_of(l.fp.as_deref())))),
                Some("review") => live.push((uid.clone(), 0)),
                _ => {}
            }
        }
        drop(st);
        let first = !tombs.is_empty() || w.corrections || w.settings || w.aliases;
        if first {
            self.jobs.push_back(Job::Subset { uids: tombs, corrections: w.corrections, blobs: vec![] });
        }
        // an import's file travels in the same pack as the import (those present here), when both sides keep files
        let files_ok = self.limits.files && self.peer_files;
        let file = |uid: &str| mine.imports.get(uid).and_then(|l| l.blob.clone()).filter(|b| files_ok && !mine.lacks.contains(b));
        let mut batch: Vec<String> = Vec::new();
        let mut files: Vec<String> = Vec::new();
        let mut rows = 0u64;
        for (uid, n) in live {
            if n > self.limits.batch_rows {
                // a split import's file goes with the files at the end
                self.jobs.push_back(Job::Part { uid: uid.clone(), after: after.get(&uid).cloned() });
                continue;
            }
            if rows + n > self.limits.batch_rows && !batch.is_empty() {
                self.jobs.push_back(Job::Subset {
                    uids: std::mem::take(&mut batch),
                    corrections: false,
                    blobs: std::mem::take(&mut files),
                });
                rows = 0;
            }
            files.extend(file(&uid));
            batch.push(uid);
            rows += n;
        }
        if !batch.is_empty() {
            self.jobs.push_back(Job::Subset { uids: batch, corrections: false, blobs: files });
        }
        let sent: BTreeSet<String> = self
            .jobs
            .iter()
            .flat_map(|j| match j {
                Job::Subset { blobs, .. } => blobs.clone(),
                Job::Part { .. } => vec![],
            })
            .collect();
        let asked = w.blobs.iter().filter(|_| files_ok).cloned();
        let rest: BTreeSet<String> = asked.chain(w.imports.iter().filter_map(|u| file(u))).collect();
        let rest: Vec<String> = rest.into_iter().filter(|b| !sent.contains(b) && p.blobs.has(b)).collect();
        if !rest.is_empty() {
            self.jobs.push_back(Job::Subset { uids: vec![], corrections: false, blobs: rest });
        }
        if w.settings {
            self.settings_out = Some(sync::settings_of(&p.vault.load()?));
        }
        self.serving = true;
        Ok(())
    }

    fn pack_bytes(&mut self, p: &Profile, now_ms: i64, data: &[u8], last: bool) -> Result<()> {
        let inc = self.incoming.as_mut().ok_or_else(|| bad("sync_order", "pack bytes without a pack"))?;
        if data.len() as u64 > inc.left || (last != (data.len() as u64 == inc.left)) {
            return Err(bad("sync_frame", "pack bytes don't match its size"));
        }
        inc.file.write_all(data)?;
        inc.left -= data.len() as u64;
        if !last {
            return Ok(());
        }
        let inc = self.incoming.take().expect("incoming");
        inc.file.sync_all()?;
        drop(inc.file);
        let want: BTreeSet<&String> = self.my_want.as_ref().expect("want").imports.iter().collect();
        let theirs = self.peer_inv.as_ref().expect("inv");
        let part_uid = inc.part.as_ref().map(|pt| pt.uid.as_str());
        let check = |c: &health_core::db::Db| pack_within_want(c, &want, theirs, part_uid);
        let r = backup::import_checked(p, &inc.path, &inc.password, now_ms, &check);
        let _ = std::fs::remove_file(&inc.path);
        let got = r?;
        self.report.packs += 1;
        self.report.erased += got.merge.erased_imports;
        self.report.imports += got.merge.added_imports + got.merge.confirmed_reviews;
        self.report.blobs += got.restored_blobs as u64;
        self.refused_imports += got.merge.refused_imports;
        self.refused_corrections += got.merge.refused_corrections;
        // merged first, then the cursor (a crash in between resends a part, never skips one)
        if let Some(part) = inc.part {
            p.sync.update(|s| {
                match &part.next {
                    Some(n) => {
                        s.resume.insert(part.uid.clone(), n.clone());
                    }
                    None => {
                        s.resume.remove(&part.uid);
                    }
                }
                Ok(())
            })?;
            if part.next.is_some() {
                self.split_open.insert(part.uid);
            } else {
                self.split_open.remove(&part.uid);
            }
        }
        if let Status::Syncing { wanted, .. } = self.status {
            self.status = Status::Syncing { received: self.received_imports.min(wanted), wanted };
        }
        Ok(())
    }

    /// Everything asked for has arrived: what still differs and the merge left as it was goes into the negative cache
    /// (§6.4), then `done`. "As it was": the peer's inventory is from before it merged what this side sent, so a
    /// difference alone may be stale; a merge that changed nothing here is the sign it can't. A real conflict is thus
    /// cached one round later, never a converging one.
    fn finish_receiving(&mut self, p: &Profile, now_ms: i64) -> Result<()> {
        let peer = self.peer.clone().expect("peer");
        let w = self.my_want.clone().expect("want");
        let now = sync::of_profile(p)?;
        let before = self.mine.take().expect("mine");
        let theirs = self.peer_inv.as_ref().expect("inv");
        let still = sync::wants(&now, theirs, &|_| false);
        let still_imports: BTreeSet<&String> = still.imports.iter().collect();
        let skew = |refused: bool| Some(now_ms + if refused { SKEW_RETRY_MS } else { SKIP_RETRY_MS });
        let (kn, kb) = (Keys::of(&now, theirs), Keys::of(&before, theirs));
        let mut add: Vec<Skip> = Vec::new();
        let mut clear: Vec<String> = Vec::new();
        for uid in &w.imports {
            if self.split_open.contains(uid) {
                continue;
            }
            if !still_imports.contains(uid) || now.imports.get(uid).is_none_or(|l| l.status != "done") {
                // equal now, or no longer a done import here: no part of it is pending
                clear.push(uid.clone());
                continue;
            }
            if self.resumed.contains(uid) {
                // a transfer resumed from a cursor that still differs: once more from the start, not cached
                clear.push(uid.clone());
                continue;
            }
            let what = format!("i {uid}");
            let (local, remote) = kn.current(&now, theirs, &what).expect("import");
            if kb.current(&before, theirs, &what).expect("import").0 != local {
                continue;
            }
            // absent here after the merge: refused (a uid from the future, perhaps), so retried later
            let refused = !now.imports.contains_key(uid) && self.refused_imports > 0;
            add.push(Skip { peer: peer.clone(), what, local, remote, until: skew(refused) });
        }
        for (flag, again, what, refused) in [
            (w.corrections, still.corrections, "c", self.refused_corrections > 0),
            (w.settings, still.settings, "s", self.settings_refused),
            (w.aliases, still.aliases, "a", false),
        ] {
            if flag && again {
                let (local, remote) = kn.current(&now, theirs, what).expect("section");
                if kb.current(&before, theirs, what).expect("section").0 != local {
                    continue;
                }
                add.push(Skip { peer: peer.clone(), what: what.into(), local, remote, until: skew(refused) });
            }
        }
        for b in &w.blobs {
            if now.lacks.contains(b) {
                let what = format!("b {b}");
                let (local, remote) = kn.current(&now, theirs, &what).expect("blob");
                add.push(Skip { peer: peer.clone(), what, local, remote, until: Some(now_ms + SKIP_RETRY_MS) });
            }
        }
        p.sync.update(|s: &mut SyncState| {
            for uid in &clear {
                s.resume.remove(uid);
            }
            let replaced: BTreeSet<&String> = add.iter().map(|a| &a.what).collect();
            s.skip.retain(|k| !(k.peer == peer && replaced.contains(&k.what)));
            s.skip.extend(add.iter().cloned());
            Ok(())
        })?;
        let digest = now.digest();
        let lacks = if self.limits.files { now.lacks.len() as u64 } else { 0 };
        self.send(&Msg::Done { digest: digest.clone(), lacks });
        self.my_lacks_after = lacks;
        self.done_sent = Some(digest);
        self.mine = Some(now);
        self.maybe_finish(p, now_ms)
    }

    fn maybe_finish(&mut self, p: &Profile, now_ms: i64) -> Result<()> {
        let (Some(mine), Some((theirs, their_lacks))) = (&self.done_sent, &self.peer_done) else {
            return Ok(());
        };
        if !self.served_sent {
            return Ok(());
        }
        let peer = self.peer.clone().expect("peer");
        // the peer's done came after it merged what this side sent; this side's digest is from after its own merge
        let same = mine == theirs;
        let equal = same && self.files_settled(self.my_lacks_after, *their_lacks);
        let st = p.sync.update(|s| {
            if same {
                s.skip.retain(|k| k.peer != peer || k.what.starts_with("b "));
            }
            let e = s.peers.entry(peer.clone()).or_default();
            e.last_synced = Some(now_ms);
            e.up_to_date = equal;
            Ok(s.skip.iter().filter(|k| k.peer == peer).count() as u64)
        })?;
        self.status = if equal { Status::UpToDate } else { Status::Partly { skipped: st } };
        self.finished = true;
        Ok(())
    }
}

/// A pack holds only imports this side asked for (a part: exactly its import), and erases rows here only for
/// imports the peer's inventory showed erased, which the large-erase question counted (§10). The peer may erase an
/// import during the session without any change of its own (its merge of this side's packs empties a manual import,
/// merge-fixes R7b): such a tombstone is taken when the import owns no rows here **now** (earlier packs of this
/// session count). Otherwise the session ends (`sync_changed`) and the next one sees the tombstone and asks if it
/// must. Runs inside the merge's transaction, after the pack passed the schema checks (`plain` attached).
fn pack_within_want(c: &health_core::db::Db, want: &BTreeSet<&String>, theirs: &Inventory, part: Option<&str>) -> Result<()> {
    let mut st = c.prepare("SELECT uid, status FROM plain.import")?;
    let rows: Vec<(String, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
    if let Some(u) = part
        && (rows.len() != 1 || rows[0].0 != u)
    {
        return Err(bad("sync_pack", "a part holding another import"));
    }
    for (uid, status) in rows {
        if !want.contains(&uid) {
            return Err(bad("sync_pack", "a pack with an import nobody asked for"));
        }
        let shown = theirs.imports.get(&uid).is_some_and(|l| l.status == "erased");
        if status == "erased" && !shown {
            let owned: i64 = c
                .query_row(
                    "SELECT (SELECT count(*) FROM main.observation WHERE import_id = i.id)
                      + (SELECT count(*) FROM main.genotype WHERE import_id = i.id)
                   FROM main.import i WHERE i.uid = ?",
                    [&uid],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if owned > 0 {
                return Err(Error::new(Kind::Conflict, "sync_changed", "the other device changed during the session".to_string()));
            }
        }
    }
    Ok(())
}

/// What a negative cache key compares, with the per-inventory parts computed once.
struct Keys {
    erased: usize,
    their_digest: String,
}

impl Keys {
    fn of(mine: &Inventory, theirs: &Inventory) -> Keys {
        Keys { erased: mine.imports.values().filter(|l| l.status == "erased").count(), their_digest: theirs.digest() }
    }

    /// This side's and the peer's line(s) for a cache key.
    fn current(&self, mine: &Inventory, theirs: &Inventory, what: &str) -> Option<(String, String)> {
        if let Some(uid) = what.strip_prefix("i ") {
            // what an import owns here also depends on the others: erasing one that took rows over gives them back
            // to older ones, without changing the older import's line. Any erase here makes the entry stale.
            return Some((format!("{} e{}", import_text(mine, uid), self.erased), import_text(theirs, uid)));
        }
        if what.starts_with("b ") {
            // a file the peer didn't send: kept out until the peer's data changes
            return Some((String::new(), self.their_digest.clone()));
        }
        let pick = |i: &Inventory| match what {
            "c" => Some(hash_lines(&i.corrections)),
            "s" => Some(hash_lines(&i.settings)),
            "a" => Some(hash_lines(&i.aliases)),
            _ => None,
        };
        Some((pick(mine)?, pick(theirs)?))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.drop_files();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use health_core::keys::MemoryStore;
    use health_core::write::{Begin, ObsRow, SourceSpec, begin, finish, write};

    const T0: i64 = 1_795_000_000_000;

    fn import(p: &Profile, uid: &str, v: i64) -> i64 {
        let src = SourceSpec::new("whoop", "u1");
        let (id, _) = begin(&p.db, Begin { source: &src, parser: "t", blob: None, uid: Some(uid.into()), candidates: None }, T0).unwrap();
        let rows: Vec<ObsRow> = (0..30)
            .map(|i| ObsRow {
                metric: "loinc:40443-4".into(),
                start_ms: T0 - 86_400_000 + i * 60_000,
                end_ms: None,
                tz_min: 480,
                value: health_core::Value::Int(v),
                unit: None,
                detail: None,
            })
            .collect();
        write(&p.db, id, &rows).unwrap();
        finish(&p.db, id, T0).unwrap();
        id
    }

    fn rows(p: &Profile) -> i64 {
        p.db.query_row("SELECT count(*) FROM v_observation", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_pack_cant_erase_rows_an_earlier_pack_of_the_session_moved_to_an_import_shown_done() {
        // review finding: X arrives done (newer uid: it takes over the rows here), then a second pack erases X.
        // X wasn't shown erased, and it owns rows here now: refused.
        let d = tempfile::tempdir().unwrap();
        let keys = MemoryStore::default();
        let (a, b) = (Profile::init(d.path(), "a", &keys).unwrap(), Profile::init(d.path(), "b", &keys).unwrap());
        let old = "0190a000-0000-7000-8000-000000000001";
        let x = "0190a000-0000-7000-8000-000000000002";
        import(&a, old, 60);
        import(&b, old, 60);
        let xid = import(&a, x, 70);
        let theirs = sync::of_profile(&a).unwrap(); // the inventory b saw: X done
        let want: BTreeSet<&String> = theirs.imports.keys().collect();
        let f1 = d.path().join("p1.db");
        health_core::merge::export_subset(&a.db, &[x.into()], false, &f1).unwrap();
        let check = |c: &health_core::db::Db| pack_within_want(c, &want, &theirs, None);
        health_core::merge::merge_from_checked(&b.db, &f1, T0, &check).unwrap();
        assert_eq!(rows(&b), 30);
        health_core::erase::erase(&a.db, xid, T0).unwrap();
        let f2 = d.path().join("p2.db");
        health_core::merge::export_subset(&a.db, &[x.into()], false, &f2).unwrap();
        let e = health_core::merge::merge_from_checked(&b.db, &f2, T0, &check).unwrap_err();
        assert_eq!(e.code, "sync_changed");
        assert_eq!(rows(&b), 30, "nothing erased");
    }
}
