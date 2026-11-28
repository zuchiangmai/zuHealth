//! WHOOP sync (requirements 5.3, protocol 6; W `lib/health/whoop/sync.ts`). The person brings their own WHOOP
//! developer app (Client ID and Secret). Sign-in goes through WHOOP's own page, which returns to a loopback
//! address on this computer (decision 67); tokens and data go through the backend's WHOOP relay, which keeps
//! nothing. A refresh token works once: the new one is saved before it is used.

use crate::account::{Net, backend_error, state, update};
use health_core::error::{Error, Kind, Result};
use health_core::vault::Whoop;
use health_core::whoop::WhoopData;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};

pub const AUTH_URL: &str = "https://api.prod.whoop.com/oauth/oauth2/auth";
pub const SCOPE: &str = "offline read:recovery read:sleep read:cycles read:workout read:body_measurement read:profile";
/// Where WHOOP's sign-in returns (registered once in the person's WHOOP developer app)
pub const REDIRECT_PORT: u16 = 47630;
pub fn redirect() -> String {
    format!("http://localhost:{REDIRECT_PORT}/whoop")
}
const DAY: i64 = 86_400_000;
const FIRST_DAYS: i64 = 30;
const AGAIN_DAYS: i64 = 7;
const GAP_DAYS: i64 = 90;
const EVERY_MS: i64 = 3_600_000;
const SKEW_MS: i64 = 60_000;
const MAX_PAGES: usize = 40;

fn stop(code: &'static str) -> Error {
    let msg = match code {
        "reauth" => "WHOOP needs you to sign in again",
        "client" => "WHOOP refused the Client ID or Secret",
        "denied" => "the WHOOP sign-in was declined",
        "state" => "this WHOOP sign-in isn't the one Health started: connect again",
        "none" => "WHOOP isn't connected",
        "slow" => "WHOOP asks to wait a little before trying again",
        _ => "WHOOP gave an unexpected answer",
    };
    let code: &'static str = match code {
        "reauth" => "whoop_reauth",
        "client" => "whoop_client",
        "denied" => "whoop_denied",
        "state" => "whoop_state",
        "none" => "whoop_none",
        "slow" => "slow",
        _ => "whoop_server",
    };
    Error::new(if code == "whoop_none" { Kind::NotFound } else { Kind::Other }, code, msg.to_string())
}

fn form(pairs: &[(&str, &str)]) -> String {
    let enc = |s: &str| -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                b' ' => "+".into(),
                _ => format!("%{b:02X}"),
            })
            .collect()
    };
    pairs.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

fn query(pairs: &[(&str, &str)]) -> String {
    form(pairs).replace('+', "%20")
}

struct Tokens {
    access: String,
    refresh: String,
    expires: i64,
}

fn token(net: &Net, pairs: &[(&str, &str)]) -> Result<Tokens> {
    let (status, j) = net
        .backend
        .raw("POST", "/h/1/whoop/token", &[("content-type", "application/x-www-form-urlencoded")], &form(pairs))
        .map_err(backend_error)?;
    // only WHOOP's own OAuth errors mean the grant is gone; the relay's own `{err}` doesn't
    if (status == 400 || status == 401) && j.get("error").is_some_and(Json::is_string) {
        return Err(stop(if j["error"] == "invalid_client" { "client" } else { "reauth" }));
    }
    if status == 429 {
        return Err(stop("slow"));
    }
    match (status / 100 == 2, j.get("access_token").and_then(Json::as_str), j.get("refresh_token").and_then(Json::as_str)) {
        (true, Some(a), Some(r)) => {
            // from the network: within a day, whatever it says (a token lasts an hour)
            let ttl = j.get("expires_in").and_then(Json::as_f64).map_or(3_600_000, |s| (s * 1000.0).clamp(0.0, 86_400_000.0) as i64);
            Ok(Tokens { access: a.into(), refresh: r.into(), expires: net.now_ms.saturating_add(ttl) })
        }
        _ => Err(stop("server")),
    }
}

/// A WHOOP API path through the relay; None on 401 (refresh, then try again).
fn get(net: &Net, access: &str, path: &str, q: &str) -> Result<Option<Json>> {
    let full = if q.is_empty() { format!("/h/1/whoop/{path}") } else { format!("/h/1/whoop/{path}?{q}") };
    let auth = format!("Bearer {access}");
    let (status, j) = net.backend.raw("GET", &full, &[("authorization", &auth)], "").map_err(backend_error)?;
    match status {
        401 => Ok(None),
        429 => Err(stop("slow")),
        s if s / 100 == 2 && j.is_object() => Ok(Some(j)),
        _ => Err(stop("server")),
    }
}

/// Tokens a sync got but couldn't save (the profile locked during the exchange: the old refresh token is spent
/// already), kept in memory and saved at the next chance, so the person needn't sign in again
static UNSAVED: std::sync::Mutex<Option<Whoop>> = std::sync::Mutex::new(None);

fn load(net: &Net) -> Result<Option<Whoop>> {
    let saved = state(net)?.whoop;
    let pending = UNSAVED.lock().unwrap_or_else(|e| e.into_inner()).take();
    match pending {
        // still the same connection (no disconnect or new sign-in meanwhile): the newer tokens win
        Some(p) if saved.as_ref().is_some_and(|cur| cur.refresh.is_some() && cur.connected_at == p.connected_at) => {
            keep_synced(net, &p)?;
            Ok(Some(p))
        }
        _ => Ok(saved),
    }
}

fn keep(net: &Net, w: &Whoop) -> Result<()> {
    let w = w.clone();
    update(net, &mut |s| s.whoop = Some(w.clone()))
}

/// What a sync learned (new tokens, reauth, the last sync), kept only if the connection it ran on is still the one
/// here: a disconnect or a new sign-in meanwhile wins, and a stale sync never writes "connected" back.
fn keep_synced(net: &Net, w: &Whoop) -> Result<()> {
    let kept = w.clone();
    update(net, &mut |s| {
        if s.whoop.as_ref().is_some_and(|cur| cur.refresh.is_some() && cur.connected_at == kept.connected_at) {
            s.whoop = Some(kept.clone());
        }
    })
    .inspect_err(|_| *UNSAVED.lock().unwrap_or_else(|e| e.into_inner()) = Some(w.clone()))
}

/// One sync at a time in this process: two at once would both spend the same refresh token, and WHOOP would ask
/// the person to sign in again.
static SYNCING: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Serialize, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Status {
    None,
    /// Sign-in started, not back yet
    Pending,
    Reauth,
    Connected {
        last_sync: Option<i64>,
    },
}

/// `whoop.status`: reads the vault only.
pub(crate) fn status(ctx: &mut crate::Ctx, _: crate::account::Empty) -> Result<Status> {
    Ok(match ctx.profile.vault.load()?.whoop {
        None => Status::None,
        Some(w) if w.reauth => Status::Reauth,
        Some(w) if w.refresh.is_some() && w.user_id.is_some() => Status::Connected { last_sync: w.last_sync },
        Some(w) if w.pending.is_some() => Status::Pending,
        Some(_) => Status::None,
    })
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Begin {
    pub client_id: String,
    pub client_secret: String,
    /// Through serve (the app): serve opens the sign-in page and catches the redirect itself
    #[serde(default)]
    pub open: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct Begun {
    /// WHOOP's sign-in page, to open in the browser
    pub url: String,
    /// The redirect URL to register in the WHOOP developer app
    pub redirect: String,
}

pub(crate) fn begin(net: &Net, r: Begin) -> Result<Begun> {
    let (id, secret) = (r.client_id.trim().to_string(), r.client_secret.trim().to_string());
    if id.is_empty() || secret.is_empty() || id.len() > 200 || secret.len() > 200 {
        return Err(Error::invalid("bad_request", "the Client ID and Secret from your WHOOP developer app"));
    }
    let st = health_proto::b64::b64u(&health_core::aead::random::<12>());
    let prev = load(net)?;
    // connecting again keeps the last sync time and user: then only 7 days are fetched
    let w = Whoop {
        client_id: id.clone(),
        client_secret: secret,
        pending: Some(st.clone()),
        user_id: prev.as_ref().and_then(|p| p.user_id.clone()),
        last_sync: prev.as_ref().and_then(|p| p.last_sync),
        ..Default::default()
    };
    keep(net, &w)?;
    let url = format!(
        "{AUTH_URL}?{}",
        query(&[("response_type", "code"), ("client_id", &id), ("redirect_uri", &redirect()), ("scope", SCOPE), ("state", &st)])
    );
    Ok(Begun { url, redirect: redirect() })
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Complete {
    /// The query string WHOOP's page returned with (`code=…&state=…`, or `error=…`)
    pub query: String,
}

#[derive(Serialize, JsonSchema)]
pub struct Connected {
    pub connected: bool,
}

fn param(q: &str, key: &str) -> Option<String> {
    q.trim_start_matches('?').split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == key).then(|| {
            let v = v.replace('+', " ");
            let b = v.as_bytes();
            let mut out = Vec::new();
            let mut i = 0;
            while i < b.len() {
                // bytes, not str slices: a multi-byte character after % must not split
                if b[i] == b'%'
                    && i + 2 < b.len()
                    && let Some(x) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok())
                {
                    out.push(x);
                    i += 3;
                    continue;
                }
                out.push(b[i]);
                i += 1;
            }
            String::from_utf8_lossy(&out).into_owned()
        })
    })
}

pub(crate) fn complete(net: &Net, r: Complete) -> Result<Connected> {
    let s = load(net)?;
    if param(&r.query, "error").is_some() {
        return Err(stop("denied"));
    }
    let code = param(&r.query, "code");
    let (Some(s), Some(code)) = (s, code) else { return Err(stop("state")) };
    if s.pending.is_none() || param(&r.query, "state") != s.pending {
        return Err(stop("state"));
    }
    let t = token(
        net,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("client_id", &s.client_id),
            ("client_secret", &s.client_secret),
            ("redirect_uri", &redirect()),
        ],
    )
    .map_err(|e| if e.code == "whoop_reauth" { stop("state") } else { e })?;
    let p = get(net, &t.access, "v2/user/profile/basic", "")?.ok_or_else(|| stop("server"))?;
    let uid = match &p["user_id"] {
        Json::Number(n) => n.to_string(),
        Json::String(s) => s.clone(),
        _ => return Err(stop("server")),
    };
    // the same WHOOP account again: carry on from the last sync; another account starts at 30 days
    let same = s.user_id.as_deref() == Some(uid.as_str());
    keep(
        net,
        &Whoop {
            client_id: s.client_id,
            client_secret: s.client_secret,
            access: Some(t.access),
            refresh: Some(t.refresh),
            expires: Some(t.expires),
            user_id: Some(uid),
            last_sync: if same { s.last_sync } else { None },
            connected_at: Some(net.now_ms),
            ..Default::default()
        },
    )?;
    Ok(Connected { connected: true })
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SyncReq {
    /// Sync even if the last one was under an hour ago
    #[serde(default)]
    pub force: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct Synced {
    /// Skipped: the last sync was under an hour ago, or another one is running
    pub skipped: bool,
    pub written: u64,
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map_or_else(String::new, |d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

pub(crate) fn sync(net: &Net, r: SyncReq) -> Result<Synced> {
    let _one = match SYNCING.try_lock() {
        Ok(g) => g,
        Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return Ok(Synced { skipped: true, written: 0 }),
    };
    let mut s = match load(net)? {
        Some(s) if s.refresh.is_some() && s.user_id.is_some() => s,
        _ => return Err(stop("none")),
    };
    if s.reauth {
        return Err(stop("reauth"));
    }
    let now = net.now_ms;
    if !r.force && s.last_sync.is_some_and(|l| now - l < EVERY_MS) {
        return Ok(Synced { skipped: true, written: 0 });
    }
    let refresh = |s: &mut Whoop| -> Result<()> {
        let rt = s.refresh.clone().unwrap_or_default();
        match token(
            net,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &rt),
                ("client_id", &s.client_id),
                ("client_secret", &s.client_secret),
                ("scope", SCOPE),
            ],
        ) {
            Ok(t) => {
                s.access = Some(t.access);
                s.refresh = Some(t.refresh);
                s.expires = Some(t.expires);
                // the old refresh token is spent: save the new one before using it
                keep_synced(net, s)
            }
            Err(e) => {
                if e.code == "whoop_reauth" || e.code == "whoop_client" {
                    s.reauth = true;
                    keep_synced(net, s)?;
                    return Err(stop("reauth"));
                }
                Err(e)
            }
        }
    };
    if s.access.is_none() || s.expires.unwrap_or(0) - now < SKEW_MS {
        refresh(&mut s)?;
    }
    let authed = |s: &mut Whoop, path: &str, q: &str| -> Result<Json> {
        if let Some(j) = get(net, s.access.as_deref().unwrap_or_default(), path, q)? {
            return Ok(j);
        }
        refresh(s)?;
        get(net, s.access.as_deref().unwrap_or_default(), path, q)?.ok_or_else(|| stop("server"))
    };
    // later syncs fetch the last 7 days again (scores come late); after a long gap, from 7 days before the
    // last sync, at most 90 days back
    let from = match s.last_sync {
        Some(l) => (now - GAP_DAYS * DAY).max(now.min(l) - AGAIN_DAYS * DAY),
        None => now - FIRST_DAYS * DAY,
    };
    let all = |s: &mut Whoop, path: &str, start: i64| -> Result<Vec<Json>> {
        let mut out = Vec::new();
        let mut next: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let (a, b) = (iso(start), iso(now));
            let mut pairs = vec![("start", a.as_str()), ("end", b.as_str()), ("limit", "25")];
            if let Some(n) = &next {
                pairs.push(("nextToken", n.as_str()));
            }
            let j = authed(s, path, &query(&pairs))?;
            if let Some(r) = j.get("records").and_then(Json::as_array) {
                out.extend(r.iter().cloned());
            }
            next = j.get("next_token").and_then(Json::as_str).filter(|t| !t.is_empty()).map(String::from);
            if next.is_none() {
                break;
            }
        }
        Ok(out)
    };
    let cycles = all(&mut s, "v2/cycle", from)?;
    // a day more of sleep: the first recovery in the window finds its sleep
    let sleeps = all(&mut s, "v2/activity/sleep", from - DAY)?;
    let recoveries = all(&mut s, "v2/recovery", from)?;
    let workouts = all(&mut s, "v2/activity/workout", from)?;
    let body = authed(&mut s, "v2/user/measurement/body", "")?;
    // disconnected while fetching: write nothing
    if load(net)?.and_then(|w| w.refresh).is_none() {
        return Err(stop("none"));
    }
    let data = WhoopData {
        user_id: s.user_id.clone().unwrap_or_default(),
        cycles,
        sleeps,
        recoveries,
        workouts,
        body: Some(body),
        tz: Some(net.tz_min),
    };
    let mut written = 0;
    (net.locked)(&mut |ctx| {
        if !ctx.profile.is_writer() {
            return Err(Error::other("not_writer", "write op on a read-only profile"));
        }
        let db = ctx.db();
        db.execute_batch("BEGIN IMMEDIATE")?;
        match health_core::import::whoop(db, &data, now) {
            Ok(r) => {
                // a failed commit (disk full) must not leave the transaction open for every later write
                if let Err(e) = db.execute_batch("COMMIT") {
                    let _ = db.execute_batch("ROLLBACK");
                    return Err(e.into());
                }
                written = r.added.max(0) as u64;
                Ok(Json::Null)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })?;
    s.last_sync = Some(now);
    keep_synced(net, &s)?;
    Ok(Synced { skipped: false, written })
}

pub(crate) fn disconnect(net: &Net, _: crate::account::Empty) -> Result<Json> {
    (net.locked)(&mut |ctx| {
        if !ctx.profile.is_writer() {
            return Err(Error::other("not_writer", "write op on a read-only profile"));
        }
        let device = ctx.profile.vault.device_id()?;
        ctx.profile.vault.update(|st| health_core::sync::stop_whoop(ctx.db(), st, &device, net.now_ms))?;
        Ok(Json::Null)
    })?;
    Ok(json!({}))
}
