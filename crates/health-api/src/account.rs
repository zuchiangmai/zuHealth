//! The health account, linking and the inbox (M6; protocol 0.1–0.2, 1, 2.3, 3.1–3.3, 3.5). These ops talk to the
//! health backend, so they don't run inside `call()`: `call_net` gives them the backend and a way to reach the
//! profile in short locked steps, and every HTTP request happens between those steps (no lock is held over the
//! network). Owner only: none is in `OpDef.delegate`, so no grant and no MCP tool reaches them.

use crate::{Ctx, bad_request};
use health_core::error::{Error, Kind, Result};
use health_core::vault::{LinkEntry, State};
use health_proto::account::{Account, payload};
use health_proto::b64::{b64u, unb64u};
use health_proto::result::{self, LabKey, Verdict};
use health_proto::{codes, hpke};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::sync::Mutex;
use zeroize::Zeroizing;

/// The backend's reply: its JSON object, or a code (`{err}` codes, `network`, `server`, `offline`).
pub type Reply = std::result::Result<Json, String>;

/// The health backend, as the bin reaches it (health-connect), or a test's mock.
pub trait Backend: Send + Sync {
    fn get(&self, path: &str) -> Reply;
    fn post(&self, path: &str, json: &str) -> Reply;
    /// Any status, for the WHOOP relay (protocol 6), whose replies are WHOOP's own: `(status, JSON or null)`;
    /// Err only when nothing came back (`network`, `offline`).
    fn raw(&self, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> std::result::Result<(u16, Json), String>;
}

/// What the app has built in for the backend it talks to (W `lib/health/config.ts`).
#[derive(Debug, Clone)]
pub struct Config {
    /// No trailing slash
    pub base: String,
    /// The base's host (with port): signed into every request
    pub aud: String,
    pub lab_keys: Vec<LabKey>,
    /// The backend's attestation key (manual results); None: not configured, such results wait
    pub att_key: Option<[u8; 32]>,
}

/// The only backend this app talks to (owner: the development backend; never production).
pub const DEV_BACKEND: &str = "https://api-dev-health.4seas.xyz";

impl Config {
    pub fn builtin() -> Config {
        Config::new(
            DEV_BACKEND,
            vec![LabKey { key: "did:key:z6MkmpEvQWbkRbSWwtJyRbKK1qH4jCneVsuFt9knU8ZCdDsq".into(), may: vec!["lab".into()] }],
            unb64u("GINjzDzOICjkQN-zkNbkJrrgiwKfSJS2QWQVyOw9VKw").and_then(|k| k.try_into().ok()),
        )
    }
    pub fn new(base: &str, lab_keys: Vec<LabKey>, att_key: Option<[u8; 32]>) -> Config {
        let base = base.trim_end_matches('/').to_string();
        let aud = base.split_once("://").map_or(base.as_str(), |(_, rest)| rest).split('/').next().unwrap_or_default().to_string();
        Config { base, aud, lab_keys, att_key }
    }
}

/// A link in progress on this device (the new one). Kept in memory only (protocol 3.5 rule 4): serve's state or
/// one CLI process. Nothing here is ever written to disk or returned by an op.
#[derive(Default)]
pub struct Session {
    link: Option<Link>,
}

struct Link {
    sk: Zeroizing<[u8; 32]>,
    pk: [u8; 32],
    channel: String,
    expires_ms: i64,
    received: Option<Received>,
}

struct Received {
    amk: Zeroizing<[u8; 32]>,
    account: String,
    check: String,
    replaces: bool,
}

impl Session {
    /// Forgets any link in progress (cancel, adopt, the passphrase lock).
    pub fn clear(&mut self) {
        self.link = None;
    }
}

/// Runs `f` with the profile under its lock: serve takes its mutex for the call, the CLI runs it directly.
pub type Locked<'a> = &'a dyn Fn(&mut dyn FnMut(&mut Ctx) -> Result<Json>) -> Result<Json>;

pub struct Net<'a> {
    pub backend: &'a dyn Backend,
    pub config: &'a Config,
    pub session: &'a Mutex<Session>,
    pub locked: Locked<'a>,
    pub now_ms: i64,
    /// The local UTC offset (minutes): WHOOP body data is anchored at local midnight
    pub tz_min: i64,
}

/// A link stays at the relay at most 10 minutes (protocol 3.5).
pub const LINK_MS: i64 = 10 * 60_000;
/// A result that can't be checked yet holds the inbox at most a day (W `inbox.ts` LATER_MS).
pub const LATER_MS: i64 = 24 * 3_600_000;
const MAX_CT: usize = 8 * 1024 * 1024;
/// Pages one poll reads at most: a backend that always says `more` can't hold the poll (and its lock) for good.
/// The next poll goes on from the cursor.
const MAX_PAGES: usize = 50;
const LINK_INFO: &[u8] = b"health-link-1";
const RESULT_INFO: &[u8] = b"sibian-health-1";

pub(crate) fn backend_error(code: String) -> Error {
    let (kind, msg) = match code.as_str() {
        "network" => (Kind::Other, "couldn't reach the health service: check the connection and try again"),
        "offline" => (Kind::Usage, "Health is offline (--offline)"),
        "slow" => (Kind::Other, "the health service asks to wait a little before trying again"),
        "clock" => (Kind::Invalid, "this computer's clock is off by more than 2 minutes"),
        "busy" => (Kind::Conflict, "busy"),
        "unknown" => (Kind::NotFound, "not known to the health service"),
        "gone" => (Kind::NotFound, "no longer exists"),
        "auth" => (Kind::Denied, "the health service refused the signature"),
        "bad" => (Kind::Invalid, "the health service refused the request"),
        "upstream" => (Kind::Other, "the health service's partner is briefly unavailable"),
        _ => (Kind::Other, "the health service gave an unexpected answer"),
    };
    let code: &'static str = match code.as_str() {
        "network" => "network",
        "offline" => "offline",
        "slow" => "slow",
        "clock" => "clock",
        "busy" => "busy",
        "unknown" => "unknown",
        "gone" => "gone",
        "auth" => "auth",
        "bad" => "bad",
        "upstream" => "upstream",
        _ => "server",
    };
    Error::new(kind, code, msg.to_string())
}

pub(crate) fn amk_of(s: &State) -> Result<Option<Zeroizing<[u8; 32]>>> {
    let Some(text) = &s.amk else { return Ok(None) };
    let bytes = unb64u(text).filter(|b| b.len() == 32).ok_or_else(|| Error::other("vault", "the account key is damaged"))?;
    Ok(Some(Zeroizing::new(bytes.try_into().expect("32"))))
}

fn random<const N: usize>() -> [u8; N] {
    health_core::aead::random::<N>()
}

/// Reads the vault under the lock.
pub(crate) fn state(net: &Net) -> Result<State> {
    let mut out = None;
    (net.locked)(&mut |ctx| {
        out = Some(ctx.profile.vault.load()?);
        Ok(Json::Null)
    })?;
    Ok(out.expect("ran"))
}

pub(crate) fn update(net: &Net, f: &mut dyn FnMut(&mut State)) -> Result<()> {
    (net.locked)(&mut |ctx| {
        if !ctx.profile.is_writer() {
            return Err(Error::other("not_writer", "write op on a read-only profile"));
        }
        ctx.profile.vault.update(|s| {
            f(s);
            Ok(())
        })?;
        Ok(Json::Null)
    })
    .map(|_| ())
}

/// The account, made now if there is none (the first time the person needs one).
pub(crate) fn account_or_make(net: &Net) -> Result<Account> {
    if let Some(amk) = amk_of(&state(net)?)? {
        return Ok(Account::of(&amk));
    }
    let amk = Zeroizing::new(random::<32>());
    let text = b64u(&*amk);
    let mut made = None;
    // two first uses at once must not make two accounts: keep the one already there
    update(net, &mut |s| {
        if s.amk.is_none() {
            s.amk = Some(text.clone());
        }
        made = s.amk.clone();
    })?;
    let amk: Zeroizing<[u8; 32]> = Zeroizing::new(unb64u(&made.expect("set")).expect("b64").try_into().expect("32"));
    Ok(Account::of(&amk))
}

/// A signed request (protocol 0.1): `{"jws": …}` for `typ` over `body` (key, value) pairs in order.
pub(crate) fn signed(net: &Net, a: &Account, typ: &str, body: &[(&str, Json)]) -> String {
    let p = payload(body, &net.config.aud, net.now_ms, &random::<16>());
    json!({ "jws": a.sign(typ, &p) }).to_string()
}

/// Registers the inbox key (protocol 3.1) and records it; returns its base64url.
pub(crate) fn register(net: &Net, a: &Account) -> Result<String> {
    let pk = b64u(&a.inbox_pub);
    let r = net.backend.post("/h/1/key", &signed(net, a, "health-key", &[("pk", json!(pk))])).map_err(backend_error)?;
    if r.as_object().is_none_or(|o| !o.is_empty()) {
        return Err(backend_error("server".into()));
    }
    let id = a.id.clone();
    let pk2 = pk.clone();
    update(net, &mut |s| {
        // only if the account is still the one registered (a link may have replaced it meanwhile)
        if amk_of(s).ok().flatten().is_some_and(|k| Account::of(&k).id == id) {
            s.registered_pk = Some(pk2.clone());
        }
    })?;
    Ok(pk)
}

// ---- ops -------------------------------------------------------------------------------------------------

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

#[derive(Serialize, JsonSchema)]
pub struct AccountShown {
    /// null: no account on this device yet
    pub account: Option<AccountInfo>,
}

#[derive(Serialize, JsonSchema)]
pub struct AccountInfo {
    pub id: String,
    pub registered: bool,
    /// The identity code (SBH1), once the inbox key is registered (protocol 1)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    /// Results discarded because they failed a check
    pub drops: i64,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum LinkHistory {
    /// This account's links, newest first (none without an account)
    Ok { entries: Vec<LinkEntry> },
    /// The vault couldn't be read: nothing is shown, and nothing written over it
    Unreadable,
}

/// `link.devices`: this device's link history for the current account; no request is sent.
pub(crate) fn link_devices(ctx: &mut Ctx, _: Empty) -> Result<LinkHistory> {
    let Ok(s) = ctx.profile.vault.load() else { return Ok(LinkHistory::Unreadable) };
    let Ok(amk) = amk_of(&s) else { return Ok(LinkHistory::Unreadable) };
    let mut entries = amk.and_then(|k| s.links.get(&Account::of(&k).id).cloned()).unwrap_or_default();
    entries.sort_by_key(|e| std::cmp::Reverse(e.at));
    Ok(LinkHistory::Ok { entries })
}

/// `account.show`: reads the vault only; makes no account and sends nothing.
pub(crate) fn account_show(ctx: &mut Ctx, _: Empty) -> Result<AccountShown> {
    let s = ctx.profile.vault.load()?;
    let Some(amk) = amk_of(&s)? else { return Ok(AccountShown { account: None }) };
    let a = Account::of(&amk);
    let pk = b64u(&a.inbox_pub);
    let registered = s.registered_pk.as_deref() == Some(pk.as_str());
    Ok(AccountShown {
        account: Some(AccountInfo {
            identity: registered.then(|| codes::identity(&a.id, &a.inbox_pub)),
            drops: s.drops.get(&pk).copied().unwrap_or(0),
            id: a.id,
            registered,
        }),
    })
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct QrReq {
    /// An identity (SBH1) or link (ZUHL1) code
    pub text: String,
}

#[derive(Serialize, JsonSchema)]
pub struct Qr {
    pub svg: String,
}

#[derive(Serialize, JsonSchema)]
pub struct Registered {
    pub id: String,
    /// The identity code (SBH1)
    pub identity: String,
}

fn account_register(net: &Net, _: Empty) -> Result<Registered> {
    let a = account_or_make(net)?;
    let s = state(net)?;
    if s.registered_pk.as_deref() != Some(b64u(&a.inbox_pub).as_str()) {
        register(net, &a)?;
    }
    Ok(Registered { identity: codes::identity(&a.id, &a.inbox_pub), id: a.id })
}

#[derive(Serialize, JsonSchema)]
pub struct Joined {
    /// The text the QR shows (ZUHL1)
    pub code: String,
    pub channel: String,
    pub expires_ms: i64,
}

fn link_join(net: &Net, _: Empty) -> Result<Joined> {
    let sk = Zeroizing::new(random::<32>());
    let pk = x25519_pub(&sk);
    let channel = health_proto::b64::base32(&random::<16>());
    let code = codes::link(&channel, &pk);
    let expires_ms = net.now_ms + LINK_MS;
    net.session.lock().unwrap().link = Some(Link { sk, pk, channel: channel.clone(), expires_ms, received: None });
    Ok(Joined { code, channel, expires_ms })
}

fn x25519_pub(sk: &[u8; 32]) -> [u8; 32] {
    // the inbox pair's derivation does the same; one place for the curve
    health_proto::account::x25519_public(sk)
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum LinkState {
    /// No link in progress
    None,
    Waiting {
        channel: String,
        expires_ms: i64,
    },
    /// Compare `check` with the other device, then `link.adopt`; `replaces`: this device has another account
    Received {
        channel: String,
        check: String,
        account: String,
        replaces: bool,
    },
    Expired,
    Failed {
        code: String,
    },
}

fn link_poll(net: &Net, _: Empty) -> Result<LinkState> {
    let (channel, sk, pk) = {
        let mut g = net.session.lock().unwrap();
        let Some(l) = g.link.as_ref() else { return Ok(LinkState::None) };
        // a link, received or not, lives 10 minutes: then the one-time secret and any account key go
        if net.now_ms >= l.expires_ms {
            g.clear();
            return Ok(LinkState::Expired);
        }
        if let Some(r) = &l.received {
            return Ok(LinkState::Received {
                channel: l.channel.clone(),
                check: r.check.clone(),
                account: r.account.clone(),
                replaces: r.replaces,
            });
        }
        (l.channel.clone(), l.sk.clone(), l.pk)
    };
    let reply = net.backend.get(&format!("/h/1/link/{channel}"));
    let fail = |code: &str| {
        let mut g = net.session.lock().unwrap();
        if g.link.as_ref().is_some_and(|l| l.channel == channel) {
            g.clear();
        }
        Ok(LinkState::Failed { code: code.into() })
    };
    let body = match reply {
        Ok(b) => b,
        Err(c) if c == "unknown" => {
            let g = net.session.lock().unwrap();
            let exp = g.link.as_ref().map_or(0, |l| l.expires_ms);
            return Ok(LinkState::Waiting { channel, expires_ms: exp });
        }
        // a dropped connection or a busy relay (rate-limited, briefly failing): keep waiting, as the web's loop does;
        // only a gone or refused channel ends the link
        Err(c) if matches!(c.as_str(), "network" | "slow" | "busy" | "upstream" | "server") => {
            let g = net.session.lock().unwrap();
            let exp = g.link.as_ref().map_or(0, |l| l.expires_ms);
            return Ok(LinkState::Waiting { channel, expires_ms: exp });
        }
        Err(c) => return fail(&c),
    };
    let Some(sealed) = body.get("ct").and_then(Json::as_str).and_then(unb64u).filter(|r| r.len() > 32) else { return fail("invalid") };
    let Some(plain) = hpke::open(&sk, &sealed, LINK_INFO, channel.as_bytes()).map(Zeroizing::new) else { return fail("invalid") };
    let amk = serde_json::from_slice::<Json>(&plain)
        .ok()
        .filter(|v| v.get("v").and_then(Json::as_f64) == Some(1.0))
        .and_then(|v| v.get("amk").and_then(Json::as_str).and_then(unb64u))
        .filter(|a| a.len() == 32);
    let Some(amk) = amk else { return fail("invalid") };
    let amk: Zeroizing<[u8; 32]> = Zeroizing::new(amk.try_into().expect("32"));
    let account = Account::of(&amk).id;
    let check = codes::link_check(&channel, &pk, &account);
    // nothing may fail from here on: the relay has handed the key over once, and an error would lose it with the
    // screen still waiting. Unreadable state here counts as another account (the warning shows).
    let replaces = match state(net).and_then(|s| amk_of(&s)) {
        Ok(k) => k.is_some_and(|k| Account::of(&k).id != account),
        Err(_) => true,
    };
    let mut g = net.session.lock().unwrap();
    let Some(l) = g.link.as_mut().filter(|l| l.channel == channel) else { return Ok(LinkState::None) };
    l.received = Some(Received { amk, account: account.clone(), check: check.clone(), replaces });
    Ok(LinkState::Received { channel, check, account, replaces })
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Adopt {
    /// The link shown (so a second `link.join` elsewhere can't swap it)
    pub channel: String,
    /// The check code the person compared with the other device
    pub check: String,
}

#[derive(Serialize, JsonSchema)]
pub struct Adopted {
    pub id: String,
    /// The link recorded in this device's link history
    pub entry: LinkEntry,
}

fn link_adopt(net: &Net, req: Adopt) -> Result<Adopted> {
    let changed = || Error::conflict("link_changed", "this link is no longer the one shown: start again");
    let (amk, account, replaces) = {
        let mut g = net.session.lock().unwrap();
        if g.link.as_ref().is_some_and(|l| net.now_ms >= l.expires_ms) {
            g.clear();
            return Err(changed());
        }
        let r = g.link.as_ref().filter(|l| l.channel == req.channel).and_then(|l| l.received.as_ref());
        let Some(r) = r.filter(|r| r.check == req.check) else { return Err(changed()) };
        (r.amk.clone(), r.account.clone(), r.replaces)
    };
    // an account made here since the warning was shown (identity code, self-service): ask again
    let now_replaces = amk_of(&state(net)?)?.is_some_and(|k| Account::of(&k).id != account);
    if now_replaces != replaces {
        let mut g = net.session.lock().unwrap();
        if g.link.as_ref().is_some_and(|l| l.channel == req.channel) {
            g.clear();
        }
        return Err(changed());
    }
    if replaces {
        // the old account's last results first; a failure doesn't stop the link (as the web does)
        let _ = inbox_poll(net, Empty {});
    }
    let text = Zeroizing::new(b64u(&*amk));
    let new_pk = b64u(&Account::of(&amk).inbox_pub);
    // recorded with the key, in one write: the history and the account can't disagree
    let got = entry("got", net.now_ms, &req.check);
    update(net, &mut |s| {
        s.links.entry(account.clone()).or_default().push(got.clone());
        s.amk = Some(text.to_string());
        // the same account again keeps its registration; another one is registered when its code is shown
        if s.registered_pk.as_deref() != Some(new_pk.as_str()) {
            s.registered_pk = None;
        }
    })?;
    let mut g = net.session.lock().unwrap();
    if g.link.as_ref().is_some_and(|l| l.channel == req.channel) {
        g.clear();
    }
    Ok(Adopted { id: account, entry: got })
}

fn link_cancel(net: &Net, _: Empty) -> Result<Json> {
    net.session.lock().unwrap().clear();
    Ok(json!({}))
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Give {
    /// The ZUHL1 code the new device shows
    pub code: String,
    /// The person was asked: "this hands your health account to the device showing this code; continue only
    /// if it is your own device" (protocol 3.5 rule 2)
    pub confirmed: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct Given {
    /// Show it; the new device must show the same
    pub check: String,
    /// The link recorded in this device's link history; null when recording it failed (the link itself
    /// went through)
    pub entry: Option<LinkEntry>,
}

fn entry(dir: &str, at: i64, check: &str) -> LinkEntry {
    LinkEntry { id: b64u(&random::<8>()), dir: dir.into(), at, check: check.into() }
}

fn link_give(net: &Net, req: Give) -> Result<Given> {
    if !req.confirmed {
        return Err(Error::new(Kind::Usage, "confirm", "ask the person first: this hands their health account to that device"));
    }
    let (channel, pk) = codes::read_link(&req.code).ok_or_else(|| Error::invalid("not_link_code", "that isn't a link code (ZUHL1)"))?;
    account_or_make(net)?;
    let amk = amk_of(&state(net)?)?.ok_or_else(|| Error::other("vault", "no account"))?;
    // the account id and the check code come from the very key sealed, never from a cached account
    let a = Account::of(&amk);
    let plain = Zeroizing::new(json!({ "v": 1, "amk": b64u(&*amk) }).to_string());
    let sealed = hpke::seal(&pk, plain.as_bytes(), LINK_INFO, channel.as_bytes(), &random::<32>())
        .ok_or_else(|| Error::invalid("not_link_code", "that link code's key is unusable"))?;
    match net.backend.post(&format!("/h/1/link/{channel}"), &json!({ "ct": b64u(&sealed) }).to_string()) {
        Ok(_) => {
            let check = codes::link_check(&channel, &pk, &a.id);
            let e = entry("gave", net.now_ms, &check);
            // a record that can't be written (or a history that can't be read) doesn't undo the link
            let id = a.id.clone();
            let e2 = e.clone();
            let kept = update(net, &mut |s| s.links.entry(id.clone()).or_default().push(e2.clone())).is_ok();
            Ok(Given { check, entry: kept.then_some(e) })
        }
        Err(c) if c == "busy" => Err(Error::conflict("link_busy", "the link failed: start again on the new device")),
        Err(c) => Err(backend_error(c)),
    }
}

#[derive(Serialize, JsonSchema, Default)]
pub struct Polled {
    /// done; stalled (stopped before a result that can't be checked yet); nokey (no registered account:
    /// nothing was sent); unconfigured (no lab keys built in)
    pub status: String,
    pub saved: u64,
    /// Waiting for review (unknown measure or unit)
    pub review: u64,
    pub seen: u64,
    pub dropped: u64,
    /// status `error` (something was stored before it): what stopped the poll
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// One poll at a time in this process (the app's timer, its button, a forwarded CLI call, an adopt).
static POLLING: Mutex<()> = Mutex::new(());

fn inbox_poll(net: &Net, _: Empty) -> Result<Polled> {
    let _one = POLLING.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = Polled { status: "done".into(), ..Default::default() };
    match poll_into(net, &mut out) {
        Ok(()) => Ok(out),
        // what was stored stays stored: report it with the error (as the web does)
        Err(e) if out.saved + out.review + out.seen + out.dropped > 0 => {
            out.status = "error".into();
            out.code = Some(e.code.to_string());
            Ok(out)
        }
        Err(e) => Err(e),
    }
}

fn poll_into(net: &Net, out: &mut Polled) -> Result<()> {
    if net.config.lab_keys.is_empty() {
        out.status = "unconfigured".into();
        return Ok(());
    }
    let s = state(net)?;
    let (Some(amk), Some(pk)) = (amk_of(&s)?, s.registered_pk.clone()) else {
        out.status = "nokey".into();
        return Ok(());
    };
    let a = Account::of(&amk);
    if b64u(&a.inbox_pub) != pk {
        out.status = "nokey".into();
        return Ok(());
    }
    let ctx = result::Context { me: &a.id, lab_keys: &net.config.lab_keys, att_key: net.config.att_key, iss: &net.config.aud };
    let mut reregistered = false;
    for _ in 0..MAX_PAGES {
        let after = state(net)?.cursors.get(&pk).copied();
        let path = match after {
            Some(a) => format!("/h/1/inbox/{pk}?after={a}"),
            None => format!("/h/1/inbox/{pk}"),
        };
        let body = match net.backend.get(&path) {
            Ok(b) => b,
            // the backend doesn't know this key: register again, from the start (protocol 3.2); once per poll
            Err(c) if c == "unknown" && !reregistered => {
                reregistered = true;
                register(net, &a)?;
                let pk2 = pk.clone();
                update(net, &mut |s| {
                    s.cursors.remove(&pk2);
                })?;
                continue;
            }
            Err(c) => return Err(backend_error(c)),
        };
        let items = body.get("items").and_then(Json::as_array).ok_or_else(|| backend_error("server".into()))?;
        for item in items {
            let seq = item.get("seq").and_then(Json::as_i64).ok_or_else(|| backend_error("server".into()))?;
            let plain = item
                .get("ct")
                .and_then(Json::as_str)
                .and_then(health_proto::b64::unb64_loose)
                .filter(|b| b.len() <= MAX_CT)
                .and_then(|b| hpke::open(&a.inbox_secret, &b, RESULT_INFO, b""));
            let Some(plain) = plain else {
                drop_one(net, &pk, seq, out)?;
                continue;
            };
            let doc = match result::check(&plain, &ctx) {
                Verdict::Ok(doc) => doc,
                Verdict::Drop(_) => {
                    drop_one(net, &pk, seq, out)?;
                    continue;
                }
                Verdict::Later => {
                    // seq is the backend's milliseconds × 1000 (protocol 0)
                    if net.now_ms - seq / 1000 < LATER_MS {
                        out.status = "stalled".into();
                        return Ok(());
                    }
                    drop_one(net, &pk, seq, out)?;
                    continue;
                }
            };
            // stored and the cursor moved in one locked step: the ingest commits first, so a crash between
            // the two only brings the same result again, which its id makes `seen`
            let pk2 = pk.clone();
            let mut got = None;
            let r = (net.locked)(&mut |ctx| {
                if !ctx.profile.is_writer() {
                    return Err(Error::other("not_writer", "write op on a read-only profile"));
                }
                let db = ctx.db();
                db.execute_batch("BEGIN IMMEDIATE")?;
                match health_core::result::ingest(db, &doc, net.now_ms) {
                    Ok(i) => {
                        // a failed commit (disk full) must not leave the transaction open for every later write
                        if let Err(e) = db.execute_batch("COMMIT") {
                            let _ = db.execute_batch("ROLLBACK");
                            return Err(e.into());
                        }
                        got = Some(i.outcome);
                    }
                    Err(e) => {
                        let _ = db.execute_batch("ROLLBACK");
                        return Err(e);
                    }
                }
                ctx.profile.vault.update(|s| {
                    // forward only: an old item sent again can't move the cursor back
                    let c = s.cursors.entry(pk2.clone()).or_insert(seq);
                    *c = (*c).max(seq);
                    Ok(())
                })?;
                Ok(Json::Null)
            });
            match r {
                Ok(_) => match got.expect("set") {
                    health_core::result::Outcome::Saved => out.saved += 1,
                    health_core::result::Outcome::Review => out.review += 1,
                    health_core::result::Outcome::Seen => out.seen += 1,
                },
                // signed and sealed, but not a usable result file: retrying won't mend it
                Err(e) if e.code == "bad_result" => drop_one(net, &pk, seq, out)?,
                Err(e) => return Err(e),
            }
        }
        if !body.get("more").and_then(Json::as_bool).unwrap_or(false) {
            return Ok(());
        }
    }
    Ok(())
}

fn drop_one(net: &Net, pk: &str, seq: i64, out: &mut Polled) -> Result<()> {
    out.dropped += 1;
    update(net, &mut |s| {
        // counted once, however many polls met it
        if s.cursors.get(pk).is_none_or(|c| seq > *c) {
            *s.drops.entry(pk.to_string()).or_insert(0) += 1;
            s.cursors.insert(pk.to_string(), seq);
        }
    })
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SelfReq {
    /// The device id beside the QR (`https://<site>/health/d/<device>`)
    pub device: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct SelfCode {
    /// Six digits to type on the device
    pub code: String,
    pub until: i64,
}

fn self_code(net: &Net, req: SelfReq) -> Result<SelfCode> {
    let ok = (1..=64).contains(&req.device.len()) && req.device.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !ok {
        return Err(Error::invalid("bad_device", "a device id is 1–64 lower-case letters, digits or -"));
    }
    let a = account_or_make(net)?;
    let pk = b64u(&a.inbox_pub);
    if state(net)?.registered_pk.as_deref() != Some(pk.as_str()) {
        register(net, &a)?;
    }
    let send = || net.backend.post("/h/1/self", &signed(net, &a, "health-self", &[("device", json!(req.device)), ("pk", json!(pk))]));
    let reply = match send() {
        // the backend lost the key: register again, then once more (W account-keys.ts)
        Err(c) if c == "unknown" => {
            register(net, &a)?;
            send()
        }
        r => r,
    };
    let v = reply.map_err(|c| {
        if c == "gone" {
            Error::not_found("no_device", "that device doesn't exist or isn't open for self-service")
        } else {
            backend_error(c)
        }
    })?;
    serde_json::from_value(v).map_err(|_| backend_error("server".into()))
}

// ---- the table ---------------------------------------------------------------------------------------------

pub struct NetOp {
    pub name: &'static str,
    pub about: &'static str,
    pub req: fn() -> schemars::Schema,
    pub resp: fn() -> schemars::Schema,
    pub run: fn(&Net, Json) -> Result<Json>,
}

macro_rules! net_op {
    ($name:literal, $about:literal, $f:path, $req:ty, $resp:ty) => {
        NetOp {
            name: $name,
            about: $about,
            req: crate::schema_of::<$req>,
            resp: crate::schema_of::<$resp>,
            run: |net, v| {
                let req: $req = serde_json::from_value(v).map_err(bad_request)?;
                let resp: $resp = $f(net, req)?;
                Ok(serde_json::to_value(resp)?)
            },
        }
    };
}

pub static NET_OPS: &[NetOp] = &[
    net_op!(
        "account.register",
        "Make this device's health account if there is none and register its inbox key; the identity code",
        account_register,
        Empty,
        Registered
    ),
    net_op!("link.join", "Start linking this device to an account on another device: the code to show", link_join, Empty, Joined),
    net_op!("link.poll", "Check once whether the other device has handed over the account", link_poll, Empty, LinkState),
    net_op!("link.adopt", "Keep the handed-over account (after comparing the check code)", link_adopt, Adopt, Adopted),
    net_op!("link.cancel", "Abandon the link in progress", link_cancel, Empty, Json),
    net_op!("link.give", "Hand this device's account to a new device showing a link code", link_give, Give, Given),
    net_op!("inbox.poll", "Fetch, check and store results sent to this account", inbox_poll, Empty, Polled),
    net_op!("self.code", "A self-service code for a lab device", self_code, SelfReq, SelfCode),
    net_op!(
        "whoop.begin",
        "Start connecting WHOOP with your own WHOOP developer app: the sign-in page to open",
        crate::whoop::begin,
        crate::whoop::Begin,
        crate::whoop::Begun
    ),
    net_op!(
        "whoop.complete",
        "Finish connecting WHOOP with what its sign-in page sent back",
        crate::whoop::complete,
        crate::whoop::Complete,
        crate::whoop::Connected
    ),
    net_op!("whoop.sync", "Fetch recent WHOOP data and store it", crate::whoop::sync, crate::whoop::SyncReq, crate::whoop::Synced),
    net_op!("whoop.disconnect", "Forget the WHOOP connection (its readings stay)", crate::whoop::disconnect, Empty, Json),
    net_op!(
        "lab.device",
        "What a self-service lab device is (seca, forcedecks or another lab device)",
        crate::lab::device,
        crate::lab::DeviceReq,
        crate::lab::DeviceKind
    ),
    net_op!(
        "seca.show",
        "seca self-service on this device: registered, a measurement waiting, the profile it needs",
        crate::lab::seca_show,
        Empty,
        crate::lab::SecaShown
    ),
    net_op!(
        "seca.register",
        "Register the anonymous seca patient (birth month, sex, ethnicity)",
        crate::lab::seca_register,
        crate::lab::SecaRegister,
        crate::lab::SecaRegistered
    ),
    net_op!(
        "seca.state",
        "Whether to check nobody is on the seca device first, and how many wait",
        crate::lab::seca_state,
        Empty,
        crate::lab::SecaWarn
    ),
    net_op!("seca.start", "Start a seca measurement at a device", crate::lab::seca_start, crate::lab::DeviceReq, Json),
    net_op!("seca.cancel", "Give up the seca measurement waiting", crate::lab::seca_cancel, Empty, Json),
    net_op!("seca.poll", "Ask once for the seca result waiting, and store it", crate::lab::seca_poll, Empty, crate::lab::SecaPolled),
    net_op!(
        "seca.pdf",
        "The PDF report of a seca measurement, while it is kept",
        crate::lab::seca_pdf,
        crate::lab::PdfReq,
        crate::lab::PdfShown
    ),
    net_op!(
        "fd.show",
        "ForceDecks self-service at a device: the profile label kept, the birth month and sex",
        crate::lab::fd_show,
        crate::lab::DeviceReq,
        crate::lab::FdShown
    ),
    net_op!(
        "fd.register",
        "Make the ForceDecks profile for a device (birth month, sex)",
        crate::lab::fd_register,
        crate::lab::FdRegister,
        crate::lab::FdRegistered
    ),
    net_op!("fd.start", "Start a ForceDecks session (a lease on the device)", crate::lab::fd_start, crate::lab::DeviceReq, Json),
    net_op!(
        "fd.check",
        "Ask once for the ForceDecks profile, lease and new results, and store them",
        crate::lab::fd_check,
        crate::lab::DeviceReq,
        crate::lab::FdChecked
    ),
    net_op!(
        "fd.catch_up",
        "Fetch ForceDecks results for devices used in the last 7 days",
        crate::lab::fd_catch_up,
        Empty,
        crate::lab::FdCaughtUp
    ),
];

pub fn find_net(name: &str) -> Option<&'static NetOp> {
    NET_OPS.iter().find(|o| o.name == name)
}

/// Runs a network op for the owner.
pub fn call_net(net: &Net, name: &str, req: Json) -> Result<Json> {
    let op = find_net(name).ok_or_else(|| Error::new(Kind::Usage, "no_op", name.to_string()))?;
    (op.run)(net, req)
}

/// `account.qr`: an identity or link code drawn as a QR (SVG), so the UI parses and draws nothing itself.
pub(crate) fn account_qr(_: &mut Ctx, req: QrReq) -> Result<Qr> {
    let ok = codes::read_identity(&req.text).is_some() || codes::read_link(&req.text).is_some_and(|_| req.text.trim() == req.text);
    if !ok {
        return Err(Error::invalid("not_a_code", "only identity (SBH1) and link (ZUHL1) codes are drawn"));
    }
    let code = qrcode::QrCode::with_error_correction_level(req.text.as_bytes(), qrcode::EcLevel::M)
        .map_err(|e| Error::other("qr", e.to_string()))?;
    let svg = code.render::<qrcode::render::svg::Color>().min_dimensions(256, 256).quiet_zone(true).build();
    Ok(Qr { svg })
}

/// The same code for a terminal: two rows per line, in block characters.
pub fn qr_text(text: &str) -> Option<String> {
    let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M).ok()?;
    Some(
        code.render::<qrcode::render::unicode::Dense1x2>()
            .dark_color(qrcode::render::unicode::Dense1x2::Light)
            .light_color(qrcode::render::unicode::Dense1x2::Dark)
            .quiet_zone(true)
            .build(),
    )
}
