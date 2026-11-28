//! The runtime every shell embeds around the op table: `health serve` on desktop, the app process on mobile.
//!
//! Interface: `Runtime::new(platform, on_event)`, then `owner(..)` for the person using the app, `agent(token, ..)`
//! for agents, `unlock(..)`, `lock()`, `lock_if_idle(..)`, `lifecycle(..)` and `status()`. Inside: the single
//! writer, network ops (the profile is locked only for their short steps), lab report recognition outside the lock,
//! LAN sync, locking, panic containment and events.

pub mod backend;
pub mod lan;
pub mod ocr;

pub use health_core::keys::{Key, KeyStore};
pub use health_core::{Error, Kind, Result};

use health_api::account::{Backend, Config, Net, Session};
use health_api::{Caller, Ctx};
use health_core::profile::{Profile, profile_dir};
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// The profile every shell opens (the CLI's `--profile` default).
pub const PROFILE: &str = "default";

/// A root-key store that can also forget a key (after a wipe). Shells implement it over the OS store.
pub trait RootKeys: KeyStore + Send + Sync {
    fn delete(&self, id: &str) -> Result<()>;
}

/// What a shell provides: the OS edges the core must not touch itself.
pub struct Platform {
    /// App data directory; the profile lives in `profiles/<name>` below it.
    pub data_dir: PathBuf,
    pub profile: String,
    pub keys: Box<dyn RootKeys>,
    pub now_ms: Box<dyn Fn() -> i64 + Send + Sync>,
    /// UTC offset in minutes at an instant (DST-aware).
    pub tz_min: Box<dyn Fn(i64) -> i64 + Send + Sync>,
    /// None: stays open (desktop). Some(grace): starts locked and locks after `grace` ms in the background (mobile).
    pub lock_after_ms: Option<i64>,
    /// No request leaves the device (no network ops, no LAN sync).
    pub offline: bool,
    /// The name other devices show for this one ("Health for Mac").
    pub device_name: String,
    /// How lab reports are read for `import.ocr`.
    pub recognize: ocr::Recognize,
}

impl Platform {
    /// The system clock and time zone, the default profile, online, OCR in this process.
    pub fn system(data_dir: PathBuf, keys: Box<dyn RootKeys>, lock_after_ms: Option<i64>) -> Platform {
        Platform {
            recognize: ocr::in_process(&data_dir, |_, _| {}),
            data_dir,
            profile: PROFILE.into(),
            keys,
            now_ms: Box::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)),
            tz_min: Box::new(|ms| {
                use chrono::TimeZone;
                chrono::Local.timestamp_millis_opt(ms).single().map_or(0, |t| (t.offset().local_minus_utc() / 60) as i64)
            }),
            lock_after_ms,
            offline: false,
            device_name: lan::me_name(),
        }
    }
}

/// Per-call options.
#[derive(Debug, Clone, Copy, Default)]
pub struct Opts {
    /// Run a write op and roll it back.
    pub dry_run: bool,
    /// The app's own call (a poll, a reload after an event), not the person using it: it doesn't put off the idle
    /// lock.
    pub background: bool,
}

pub struct Outcome {
    pub value: Value,
    /// Agents only: what their grant hides.
    pub withheld: Option<Value>,
}

/// An error as the UI and serve show it: `{ code, message }`.
pub fn error_json(e: &Error) -> Value {
    json!({ "code": e.code, "message": e.detail })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    NoProfile,
    /// A profile exists but is closed until `unlock`.
    Locked,
    Ready,
    /// The profile could not be opened (missing key, busy, ...); see `Status::error`.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    pub state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    Foreground,
    Background,
}

const IN_FOREGROUND: i64 = i64::MIN;

/// Events pushed to the shell (`on_event(name, data)`): `status` ({state, error?}), `changed` ({op}), `locked`,
/// `unlocked`, `sync` (LAN sync's live state) and `whoop` (a sign-in finished).
pub type OnEvent = Box<dyn Fn(&str, Value) + Send + Sync>;

pub struct Runtime {
    platform: Platform,
    on_event: OnEvent,
    /// The single writer: every op runs under this lock.
    profile: Mutex<Option<Profile>>,
    /// Separate from `profile`, so status never waits for a running op.
    status: Mutex<Status>,
    /// When the app went to the background, or IN_FOREGROUND.
    background_since: AtomicI64,
    /// The owner's last call that wasn't a background poll (idle lock).
    last_owner: Mutex<Instant>,
    /// A link in progress (memory only; cleared on lock).
    session: Mutex<Session>,
    config: Config,
    backend: Box<dyn Backend>,
    lan: OnceLock<lan::Lan>,
    /// Why the profile didn't open at start, for shells that report it (serve exits with it).
    open_error: Mutex<Option<Error>>,
    /// How many times the profile has been locked: the `locked` event carries it, so a shell can tell a lock that
    /// came before its unlock from one after.
    locks: std::sync::atomic::AtomicU64,
}

/// Polls the app makes on its own: they must not count as the person using it.
fn background(name: &str) -> bool {
    matches!(name, "inbox.poll" | "whoop.sync" | "seca.poll" | "fd.check" | "fd.catch_up" | "lab.device")
}

impl Runtime {
    /// Opens the profile unless it needs unlocking first (mobile, or a passphrase), then starts LAN sync.
    /// `on_event` must not block.
    pub fn new(platform: Platform, on_event: impl Fn(&str, Value) + Send + Sync + 'static) -> Arc<Runtime> {
        let config = backend::config();
        let rt = Arc::new(Runtime {
            backend: backend::backend(platform.offline, &config),
            config,
            platform,
            on_event: Box::new(on_event),
            profile: Mutex::new(None),
            status: Mutex::new(Status { state: State::NoProfile, error: None }),
            background_since: AtomicI64::new(IN_FOREGROUND),
            last_owner: Mutex::new(Instant::now()),
            session: Mutex::new(Session::default()),
            lan: OnceLock::new(),
            open_error: Mutex::new(None),
            locks: std::sync::atomic::AtomicU64::new(0),
        });
        let dir = rt.dir();
        if !dir.as_ref().is_some_and(|d| d.join("id").exists()) {
            rt.set_status(State::NoProfile, None);
        } else if rt.platform.lock_after_ms.is_some() || rt.passphrase_mode() {
            rt.set_status(State::Locked, None);
        } else {
            let mut p = rt.lock_profile();
            rt.open(&mut p, None);
        }
        let host: Arc<dyn lan::Host> = rt.clone();
        let _ = rt.lan.set(lan::start(host, rt.platform.offline));
        rt
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Why the profile didn't open (at start or the last unlock), if it didn't.
    pub fn open_error(&self) -> Option<Error> {
        self.open_error.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Checks an agent's token without calling anything (MCP's handshake needs a valid grant first).
    pub fn check_agent(&self, token: &str) -> Result<()> {
        let p = self.lock_profile();
        let profile = p.as_ref().ok_or_else(|| self.closed_error())?;
        profile.access.resolve(token, (self.platform.now_ms)()).map(|_| ())
    }

    /// The app's data directory (components live under it, beside the profiles).
    pub fn data_dir(&self) -> &Path {
        &self.platform.data_dir
    }

    /// The profile's directory (None if the profile name is not valid).
    pub fn dir(&self) -> Option<PathBuf> {
        profile_dir(&self.platform.data_dir, &self.platform.profile).ok()
    }

    /// The root key is wrapped by a passphrase (`keywrap`): unlocking takes a passphrase store.
    pub fn passphrase_mode(&self) -> bool {
        self.dir().is_some_and(|d| d.join(health_core::keys::KEYWRAP).exists())
    }

    /// A call by the person using the app. `runtime.*` names are handled here and reach no one else.
    pub fn owner(&self, name: &str, req: &Value, opts: Opts) -> Result<Outcome> {
        self.expire(false);
        let quiet = opts.background || background(name);
        if !quiet {
            self.touch();
        }
        let value = match name {
            "runtime.status" => {
                let now = (self.platform.now_ms)();
                json!({ "status": self.status(), "key_store": self.platform.keys.kind(), "tz_min": (self.platform.tz_min)(now) })
            }
            "runtime.init" => self.init()?,
            "runtime.wipe" => self.wipe(req)?,
            "sync.live" => {
                let live = self.lan.get().map(|l| l.live.lock().unwrap_or_else(|e| e.into_inner()).clone()).unwrap_or_default();
                serde_json::to_value(live)?
            }
            "sync.answer" => {
                let (Some(device), Some(allow)) = (req["device"].as_str(), req["allow"].as_bool()) else {
                    return Err(Error::invalid("bad_request", "device and allow are required"));
                };
                if let Some(l) = self.lan.get() {
                    let _ = l.tx.send(lan::Cmd::Answer { device: device.into(), allow });
                }
                json!({})
            }
            _ if health_api::account::find_net(name).is_some() => {
                if opts.dry_run {
                    return Err(Error::new(Kind::Usage, "no_dry_run", name.to_string()));
                }
                self.net(name, req.clone())?
            }
            "import.ocr" if req.get("recognized").is_none_or(Value::is_null) => {
                let req = self.recognize(req)?;
                return self.run(Caller::Owner, name, &req, opts);
            }
            _ => return self.run(Caller::Owner, name, req, opts),
        };
        if !quiet {
            self.touch(); // idle time counts from the end of the owner's call
        }
        Ok(Outcome { value, withheld: None })
    }

    /// A call by an agent. The token is resolved here; the op table decides what the grant may call. Network ops
    /// are never available to agents (refused and audited).
    pub fn agent(&self, token: &str, name: &str, req: &Value) -> Result<Outcome> {
        self.expire(false);
        let grant = {
            let p = self.lock_profile();
            let profile = p.as_ref().ok_or_else(|| self.closed_error())?;
            let grant = profile.access.resolve(token, (self.platform.now_ms)())?;
            if health_api::account::find_net(name).is_some() {
                let a = health_core::access::Audit {
                    at: (self.platform.now_ms)(),
                    grant_id: grant.id,
                    op: name.into(),
                    metrics: vec![],
                    from_ms: None,
                    to_ms: None,
                    rows: 0,
                    denied: true,
                };
                profile.access.record(&a)?;
                return Err(Error::new(Kind::Denied, "denied", "not available to delegates"));
            }
            grant
        };
        self.run(Caller::Delegate(grant), name, req, Opts::default())
    }

    /// Opens a locked profile. Shells call this after their own gate (biometrics, a passphrase); `keys` overrides
    /// the platform's store for this unlock (a passphrase store).
    pub fn unlock(&self, keys: Option<&dyn KeyStore>) -> Result<()> {
        if self.past_grace(self.background_since.load(Ordering::SeqCst)) {
            return Err(Error::new(Kind::Locked, "locked", "the app is in the background"));
        }
        let mut p = self.lock_profile();
        if p.is_some() {
            return Ok(());
        }
        if !self.dir().is_some_and(|d| d.join("id").exists()) {
            return Err(Error::not_found("no_profile", self.platform.profile.clone()));
        }
        let keys = keys.unwrap_or(self.platform.keys.as_ref());
        let profile = Profile::open(&self.platform.data_dir, &self.platform.profile, keys, true, (self.platform.now_ms)())?;
        *p = Some(profile);
        drop(p);
        self.touch();
        self.set_status(State::Ready, None);
        self.emit("unlocked", json!({}));
        Ok(())
    }

    /// Closes the profile (the key goes with it) and forgets a link in progress.
    pub fn lock(&self) {
        let mut p = self.lock_profile();
        if p.take().is_none() {
            return;
        }
        let n = self.locks.fetch_add(1, Ordering::SeqCst) + 1;
        self.session.lock().unwrap_or_else(|e| e.into_inner()).clear();
        drop(p);
        self.set_status(State::Locked, None);
        self.emit("locked", json!({ "n": n }));
    }

    /// Locks so far (see `locks`): read before an unlock, it names the last lock that unlock follows.
    pub fn locks(&self) -> u64 {
        self.locks.load(Ordering::SeqCst)
    }

    /// Locks once the owner has made no call for `idle` (desktop passphrase mode).
    pub fn lock_if_idle(&self, idle: Duration) {
        let open = self.lock_profile().is_some();
        if open && self.last_owner.lock().unwrap_or_else(|e| e.into_inner()).elapsed() >= idle {
            self.lock();
        }
    }

    /// Shells report the app going to the background and coming back (mobile only). Background is a single atomic
    /// store; Foreground may close the profile, so call it off the UI thread.
    pub fn lifecycle(&self, l: Lifecycle) {
        match l {
            Lifecycle::Background => {
                let now = (self.platform.now_ms)();
                let _ = self.background_since.compare_exchange(IN_FOREGROUND, now, Ordering::SeqCst, Ordering::SeqCst);
            }
            Lifecycle::Foreground => self.expire(true),
        }
    }

    /// Locks the profile once the app has been in the background past the grace period. `returning`: the app is
    /// in the foreground again, so the background mark is cleared either way. Otherwise the mark stays until then:
    /// nothing in the background (the UI's own timers, LAN sync) can open the profile again.
    fn expire(&self, returning: bool) {
        let since = if returning {
            self.background_since.swap(IN_FOREGROUND, Ordering::SeqCst)
        } else {
            self.background_since.load(Ordering::SeqCst)
        };
        if self.past_grace(since) {
            self.lock();
        }
    }

    /// In the background (since `since`) longer than the grace period.
    fn past_grace(&self, since: i64) -> bool {
        self.platform.lock_after_ms.is_some_and(|grace| since != IN_FOREGROUND && (self.platform.now_ms)() - since >= grace)
    }

    fn touch(&self) {
        *self.last_owner.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }

    fn init(&self) -> Result<Value> {
        let mut p = self.lock_profile();
        let keys: &dyn KeyStore = self.platform.keys.as_ref();
        *p = Some(Profile::init(&self.platform.data_dir, &self.platform.profile, keys)?);
        drop(p);
        self.set_status(State::Ready, None);
        Ok(Value::Null)
    }

    /// Clear data: close, delete the profile, then forget its key. Needs `{"confirm": "DELETE"}`.
    fn wipe(&self, req: &Value) -> Result<Value> {
        if !req["confirm"].as_str().is_some_and(|c| c.trim().eq_ignore_ascii_case("DELETE")) {
            return Err(Error::new(Kind::Usage, "not_confirmed", "type DELETE"));
        }
        let mut p = self.lock_profile();
        p.take();
        self.session.lock().unwrap_or_else(|e| e.into_inner()).clear();
        let wiped = health_core::profile::wipe(&self.platform.data_dir, &self.platform.profile);
        drop(p);
        // whatever happened, the status says what is on disk now: never "ready" with nothing open
        let left = self.dir().is_some_and(|d| d.join("id").exists());
        self.set_status(if left { State::Locked } else { State::NoProfile }, None);
        // the key last: without its database it opens nothing
        let cleared = match wiped? {
            Some(id) => {
                self.platform.keys.delete(&id).map_err(|e| Error::other("key_not_deleted", e.to_string()))?;
                true
            }
            None => false,
        };
        Ok(json!({ "cleared": cleared }))
    }

    /// A lab report: hash and check it without the lock, recognise it without the lock, then return the request
    /// with `recognized` filled in.
    fn recognize(&self, req: &Value) -> Result<Value> {
        let path = req["path"].as_str().ok_or_else(|| Error::invalid("bad_request", "path"))?.to_string();
        let sha = ocr::file_sha(&path)?;
        // already imported? say so before seconds of recognition
        {
            let p = self.lock_profile();
            let profile = p.as_ref().ok_or_else(|| self.closed_error())?;
            let mut ctx = Ctx::new(profile, (self.platform.now_ms)(), Caller::Owner);
            if health_api::call(&mut ctx, "import.seen", json!({ "sha": sha })).is_ok_and(|o| o.value["seen"] == true) {
                return Err(Error::conflict("blob_dup", sha));
            }
        }
        let now = (self.platform.now_ms)();
        let (_, rec) = (self.platform.recognize)(Path::new(&path), self.year(now))?;
        let mut req = req.clone();
        req["recognized"] = serde_json::to_value(rec)?;
        Ok(req)
    }

    fn year(&self, now: i64) -> i32 {
        use chrono::Datelike;
        let local = now + (self.platform.tz_min)(now) * 60_000;
        chrono::DateTime::from_timestamp_millis(local).map_or(2026, |d| d.year())
    }

    /// A network op: the profile is locked only for its short steps, never across a request to the backend.
    fn net(&self, name: &str, req: Value) -> Result<Value> {
        let now = (self.platform.now_ms)();
        let locked = |f: &mut dyn FnMut(&mut Ctx) -> Result<Value>| -> Result<Value> {
            let p = self.lock_profile();
            let profile = p.as_ref().ok_or_else(|| self.closed_error())?;
            f(&mut Ctx::new(profile, now, Caller::Owner))
        };
        let net = Net {
            backend: self.backend.as_ref(),
            config: &self.config,
            session: &self.session,
            locked: &locked,
            now_ms: now,
            tz_min: (self.platform.tz_min)(now),
        };
        let v =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| health_api::account::call_net(&net, name, req))).map_err(|_| {
                if let Some(p) = self.lock_profile().as_ref() {
                    p.recover();
                }
                Error::other("internal", format!("{name} failed unexpectedly"))
            })??;
        let changed = match name {
            "inbox.poll" => ["saved", "review"].iter().any(|k| v[*k].as_u64().unwrap_or(0) > 0),
            "link.adopt" | "account.register" => true,
            "seca.poll" => v["state"] == "ready",
            "fd.check" | "fd.catch_up" => v["taken"].as_u64().unwrap_or(0) > 0,
            "whoop.sync" => v["written"].as_u64().unwrap_or(0) > 0,
            _ => false,
        };
        if changed {
            self.emit("changed", json!({ "op": name }));
        }
        Ok(v)
    }

    fn run(&self, caller: Caller, name: &str, req: &Value, opts: Opts) -> Result<Outcome> {
        let write = health_api::find(name)?.write;
        let owner = matches!(caller, Caller::Owner);
        let p = self.lock_profile();
        let profile = p.as_ref().ok_or_else(|| self.closed_error())?;
        let mut ctx = Ctx::new(profile, (self.platform.now_ms)(), caller);
        ctx.dry_run = owner && opts.dry_run;
        let dry = ctx.dry_run;
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| health_api::call(&mut ctx, name, req.clone()))).map_err(|_| {
                profile.recover(); // else every later write fails until the profile is opened again
                Error::other("internal", format!("{name} failed unexpectedly"))
            })??;
        drop(p);
        if owner && !opts.background && !background(name) {
            self.touch(); // idle time counts from the end of the owner's op
        }
        if write && !dry {
            self.emit("changed", json!({ "op": name }));
        }
        Ok(Outcome { value: outcome.value, withheld: outcome.withheld.map(|w| serde_json::to_value(w).unwrap_or(Value::Null)) })
    }

    fn open(&self, p: &mut Option<Profile>, keys: Option<&dyn KeyStore>) {
        let keys = keys.unwrap_or(self.platform.keys.as_ref());
        match Profile::open(&self.platform.data_dir, &self.platform.profile, keys, true, (self.platform.now_ms)()) {
            Ok(profile) => {
                *p = Some(profile);
                self.set_status(State::Ready, None);
            }
            Err(e) => {
                self.set_status(State::Unavailable, Some(error_json(&e)));
                *self.open_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(e);
            }
        }
    }

    fn closed_error(&self) -> Error {
        match self.status().state {
            State::Locked => Error::new(Kind::Locked, "locked", "the profile is locked"),
            State::NoProfile => Error::not_found("no_profile", self.platform.profile.clone()),
            _ => Error::new(Kind::Locked, "unavailable", "no open profile"),
        }
    }

    /// Every event goes out through here: a local change also starts a LAN sync with the connected devices.
    /// Shells use it for their own events too (e.g. `whoop` when a sign-in they ran finishes).
    pub fn emit(&self, event: &str, data: Value) {
        if event == "changed"
            && data["op"] != "sync"
            && let Some(l) = self.lan.get()
        {
            let _ = l.tx.send(lan::Cmd::Changed);
        }
        (self.on_event)(event, data);
    }

    fn set_status(&self, state: State, error: Option<Value>) {
        let s = Status { state, error };
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = s.clone();
        self.emit("status", serde_json::to_value(s).unwrap_or(Value::Null));
    }

    /// Ops run under catch_unwind, so the lock is not normally poisoned; recover if it ever is.
    fn lock_profile(&self) -> MutexGuard<'_, Option<Profile>> {
        self.profile.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl lan::Host for Runtime {
    fn with_profile(&self, f: &mut dyn FnMut(&Profile) -> Result<()>) -> Result<()> {
        self.expire(false); // LAN sync too uses the data only within the grace period
        let p = self.lock_profile();
        let profile = p.as_ref().ok_or_else(|| self.closed_error())?;
        f(profile)
    }
    fn emit(&self, event: &str, data: Value) {
        Runtime::emit(self, event, data);
    }
    fn get(&self, path: &str) -> std::result::Result<Value, String> {
        self.backend.get(path)
    }
    fn post(&self, path: &str, json: &str) -> std::result::Result<Value, String> {
        self.backend.post(path, json)
    }
    fn now_ms(&self) -> i64 {
        (self.platform.now_ms)()
    }
    fn device_name(&self) -> String {
        self.platform.device_name.clone()
    }
}
