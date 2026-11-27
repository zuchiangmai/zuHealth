//! Lab self-service at a device that carries a QR code (`/health/s/<device>`), as the web has it
//! (seca-self-flow.ts, fd-self-flow.ts):
//! - `lab.device` asks the backend what the device is (seca mBCA Pro, VALD ForceDecks, or another lab device).
//! - seca: register an anonymous patient once (birth month, sex, ethnicity), check nobody is on the device,
//!   start (a ticket, valid 7 days), then poll for the sealed result.
//! - ForceDecks: register a profile per device (the device's screen then shows "<timestamp> <label>", and the
//!   person picks themselves there), start a lease, then read the result feed page by page.
//!
//! Results are sealed to this account's inbox key (HPKE, no lab signature: the app trusts its own backend, owner
//! 2026-11-17), checked to be for this device, and stored as the inbox stores lab results. What is kept between
//! visits is per-device app state in the vault (`LabSelf`), never synced.

use crate::account::{Net, account_or_make, backend_error, register, signed, state, update};
use health_core::error::{Error, Kind, Result};
use health_core::vault::{FdKept, LabSelf, SecaKept, SecaPdf, SecaTicket, State};
use health_proto::account::Account;
use health_proto::b64::b64u;
use health_proto::hpke;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};

const SECA_INFO: &[u8] = b"sibian-health-seca-1";
const FD_INFO: &[u8] = b"zu-health-fd-1";
/// Tickets, PDFs and results stay on the backend this long
const KEEP_MS: i64 = 7 * 86_400_000;
/// A seca measurement started less than this ago: check nobody is on the device first
const RECENT_MS: i64 = 60_000;
/// Feed pages read in one check at most
const MAX_PAGES: usize = 50;

fn valid_device(d: &str) -> Result<()> {
    let ok = (1..=64).contains(&d.len()) && d.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok { Ok(()) } else { Err(Error::invalid("bad_device", "a device id is 1–64 lower-case letters, digits or -")) }
}

fn gone() -> Error {
    Error::not_found("no_device", "that device doesn't exist or isn't open for self-service")
}

fn server() -> Error {
    backend_error("server".into())
}

fn matches(s: &str, len: std::ops::RangeInclusive<usize>, ok: impl Fn(u8) -> bool) -> bool {
    len.contains(&s.len()) && s.bytes().all(ok)
}

fn b64url_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

/// The account and its registered inbox key (registered now if it isn't).
fn keyed(net: &Net) -> Result<(Account, String)> {
    let a = account_or_make(net)?;
    let pk = b64u(&a.inbox_pub);
    if state(net)?.registered_pk.as_deref() != Some(pk.as_str()) {
        register(net, &a)?;
    }
    Ok((a, pk))
}

/// A signed POST; on "unknown" (the backend lost the key) registers again and retries once.
fn post(net: &Net, a: &Account, path: &str, typ: &str, body: &[(&str, Json)]) -> Result<Json> {
    let send = || net.backend.post(path, &signed(net, a, typ, body));
    let reply = match send() {
        Err(c) if c == "unknown" => {
            register(net, a)?;
            send()
        }
        r => r,
    };
    reply.map_err(|c| if c == "gone" { gone() } else { backend_error(c) })
}

/// The kept state, emptied if it was made for another account.
fn kept(s: &State, account: &str) -> LabSelf {
    if s.lab.account.as_deref() == Some(account) { s.lab.clone() } else { LabSelf { account: Some(account.into()), ..Default::default() } }
}

/// Changes the kept state for `account` (starting it afresh if it was another account's).
fn keep(net: &Net, account: &str, f: &mut dyn FnMut(&mut LabSelf)) -> Result<()> {
    update(net, &mut |s| {
        let mut l = kept(s, account);
        f(&mut l);
        s.lab = l;
    })
}

/// The account if there is one (polls and cancels never make one).
fn existing(net: &Net) -> Result<Option<Account>> {
    Ok(crate::account::amk_of(&state(net)?)?.map(|k| Account::of(&k)))
}

/// Birth month and sex into the profile through `profile.set` (checked, and stamped as the synced setting it is);
/// nothing when they are already so.
fn set_profile(net: &Net, birth: &str, gender: &str) -> Result<()> {
    let (b, g, _) = personal(&state(net)?);
    if b.as_deref() == Some(birth) && g.as_deref() == Some(gender) {
        return Ok(());
    }
    (net.locked)(&mut |ctx| crate::call(ctx, "profile.set", json!({ "birth": birth, "sex": gender })).map(|o| o.value)).map(|_| ())
}

fn personal(s: &State) -> (Option<String>, Option<String>, Option<String>) {
    let p = s.profile.clone().unwrap_or_default();
    (p.birth, p.gender, p.ethnicity)
}

/// A result taken: when it was measured, how it was stored, and the opened plaintext.
type Taken = (i64, health_core::result::Outcome, Map<String, Json>);

/// Opens a sealed result, checks it is for `device`, and stores it as a lab result. `Ok(None)`: not readable.
fn take(net: &Net, a: &Account, ct: &str, info: &[u8], device: &str) -> Result<Option<Taken>> {
    let Some(bytes) = health_proto::b64::unb64_loose(ct).filter(|b| b.len() > 32) else { return Ok(None) };
    let Some(plain) = hpke::open(&a.inbox_secret, &bytes, info, b"") else { return Ok(None) };
    let Ok(Json::Object(p)) = serde_json::from_slice::<Json>(&plain) else { return Ok(None) };
    let (Some(id), Some(at), Some(tz), Some(obs)) =
        (p.get("id").and_then(Json::as_str), p.get("at").and_then(Json::as_i64), p.get("tz").and_then(Json::as_i64), p.get("obs"))
    else {
        return Ok(None);
    };
    if p.get("v") != Some(&json!(1)) || p.get("device").and_then(Json::as_str) != Some(device) || !obs.is_array() {
        return Ok(None);
    }
    let mut doc = Map::new();
    doc.insert("v".into(), json!(1));
    doc.insert("id".into(), json!(id));
    doc.insert("uid".into(), json!(a.id));
    doc.insert("src".into(), json!(format!("lab:{device}")));
    doc.insert("at".into(), json!(at));
    doc.insert("tz".into(), json!(tz));
    doc.insert("obs".into(), obs.clone());
    let mut got = None;
    let r = (net.locked)(&mut |ctx| {
        if !ctx.profile.is_writer() {
            return Err(Error::other("not_writer", "write op on a read-only profile"));
        }
        let db = ctx.db();
        db.execute_batch("BEGIN IMMEDIATE")?;
        match health_core::result::ingest(db, &doc, net.now_ms) {
            Ok(i) => {
                db.execute_batch("COMMIT")?;
                got = Some(i.outcome);
                Ok(Json::Null)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    });
    match r {
        Ok(_) => Ok(got.map(|o| (at, o, p.clone()))),
        // a usable seal but not a usable result: retrying won't mend it
        Err(e) if e.code == "bad_result" => Ok(None),
        Err(e) => Err(e),
    }
}

// ---- what a device is -------------------------------------------------------------------------------------

#[derive(Deserialize, JsonSchema)]
pub struct DeviceReq {
    /// The device id, as in its QR code (`…/health/s/<device>`)
    pub device: String,
}

#[derive(Serialize, JsonSchema)]
pub struct DeviceKind {
    /// "seca", "forcedecks", or "lab" (a lab device without self-service)
    pub kind: String,
    pub name: String,
    /// ForceDecks only: "available", "in_use" or "unavailable"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// ForceDecks only: since when it is in that state (ms)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
}

pub(crate) fn device(net: &Net, req: DeviceReq) -> Result<DeviceKind> {
    valid_device(&req.device).map_err(|_| gone())?;
    let b = net
        .backend
        .get(&format!("/h/1/dev/{}", req.device))
        .map_err(|c| if c == "gone" || c == "bad" { gone() } else { backend_error(c) })?;
    let kind = b["kind"].as_str().filter(|k| matches!(*k, "seca" | "lab" | "forcedecks")).ok_or_else(server)?.to_string();
    let name = b["name"].as_str().unwrap_or(&req.device).to_string();
    let (state, since) = if kind == "forcedecks" {
        (b["state"].as_str().filter(|s| matches!(*s, "available" | "in_use" | "unavailable")).map(String::from), b["since"].as_i64())
    } else {
        (None, None)
    };
    Ok(DeviceKind { kind, name, state, since })
}

// ---- seca mBCA Pro ---------------------------------------------------------------------------------------

#[derive(Serialize, JsonSchema)]
pub struct SecaShown {
    /// Registered with the current profile: no need to ask birth month, sex and ethnicity
    pub registered: bool,
    /// A measurement started and not fetched yet
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<PendingSeca>,
    pub birth: Option<String>,
    pub gender: Option<String>,
    pub ethnicity: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct PendingSeca {
    pub device: String,
    pub at: i64,
}

fn seca_made_from(birth: &str, gender: &str, ethnicity: &str) -> String {
    format!("{birth}|{gender}|{ethnicity}")
}

/// The seca patient id, if it was registered with the current profile.
fn seca_idp(s: &State, account: &str) -> Option<String> {
    let (b, g, e) = personal(s);
    let from = seca_made_from(&b?, &g?, &e?);
    kept(s, account).seca.filter(|k| k.made_from == from).map(|k| k.idp)
}

pub(crate) fn seca_show(net: &Net, _: crate::account::Empty) -> Result<SecaShown> {
    let s = state(net)?;
    let account = crate::account::amk_of(&s)?.map(|k| Account::of(&k).id);
    let (birth, gender, ethnicity) = personal(&s);
    let lab = account.as_deref().map(|a| kept(&s, a)).unwrap_or_default();
    let pending = lab.seca_ticket.filter(|t| net.now_ms - t.at <= KEEP_MS).map(|t| PendingSeca { device: t.device, at: t.at });
    let registered = account.as_deref().is_some_and(|a| seca_idp(&s, a).is_some());
    Ok(SecaShown { registered, pending, birth, gender, ethnicity })
}

#[derive(Deserialize, JsonSchema)]
pub struct SecaRegister {
    /// YYYY-MM
    pub birth: String,
    /// "Male" or "Female"
    pub gender: String,
    /// One of seca's values (the web's profile-values.ts)
    pub ethnicity: String,
}

#[derive(Serialize, JsonSchema)]
pub struct SecaRegistered {
    pub idp: String,
}

/// Registers the anonymous seca patient and keeps birth month, sex and ethnicity in the profile.
pub(crate) fn seca_register(net: &Net, req: SecaRegister) -> Result<SecaRegistered> {
    let birth_ok =
        req.birth.len() == 7 && req.birth.as_bytes()[4] == b'-' && req.birth.bytes().enumerate().all(|(i, b)| i == 4 || b.is_ascii_digit());
    if !birth_ok || !matches!(req.gender.as_str(), "Male" | "Female") || req.ethnicity.trim().is_empty() {
        return Err(Error::invalid("bad_profile", "birth YYYY-MM, gender Male or Female, and an ethnicity"));
    }
    set_profile(net, &req.birth, &req.gender)?;
    let (a, _) = keyed(net)?;
    let r = post(
        net,
        &a,
        "/h/1/seca",
        "health-seca",
        &[("op", json!("patient")), ("birth", json!(req.birth)), ("gender", json!(req.gender)), ("ethnicity", json!(req.ethnicity))],
    )?;
    let idp = r["idp"].as_str().filter(|i| matches(i, 8..=64, |b| b.is_ascii_alphanumeric() || b == b'-')).ok_or_else(server)?.to_string();
    let made_from = seca_made_from(&req.birth, &req.gender, &req.ethnicity);
    // ethnicity is asked here only (not a profile.set field)
    update(net, &mut |s| s.profile.get_or_insert_with(Default::default).ethnicity = Some(req.ethnicity.clone()))?;
    keep(net, &a.id, &mut |l| l.seca = Some(SecaKept { idp: idp.clone(), made_from: made_from.clone() }))?;
    Ok(SecaRegistered { idp })
}

#[derive(Serialize, JsonSchema)]
pub struct SecaWarn {
    /// Ask the person to check nobody is on the device first (also when the backend didn't answer)
    pub warn: bool,
    /// People waiting before them
    pub queue: u64,
}

pub(crate) fn seca_state(net: &Net, _: crate::account::Empty) -> Result<SecaWarn> {
    let Ok(s) = net.backend.get("/h/1/seca/state") else { return Ok(SecaWarn { warn: true, queue: 0 }) };
    let Some(busy) = s["busy"].as_bool() else { return Ok(SecaWarn { warn: true, queue: 0 }) };
    let recent = s["last"].as_i64().is_some_and(|last| net.now_ms - last < RECENT_MS);
    Ok(SecaWarn { warn: busy || recent, queue: s["queue"].as_u64().unwrap_or(0) })
}

pub(crate) fn seca_start(net: &Net, req: DeviceReq) -> Result<Json> {
    valid_device(&req.device)?;
    let s = state(net)?;
    let (a, pk) = keyed(net)?;
    let idp = seca_idp(&s, &a.id).ok_or_else(|| Error::new(Kind::Usage, "noprofile", "register birth month, sex and ethnicity first"))?;
    let r = post(net, &a, "/h/1/seca", "health-seca", &[("op", json!("start")), ("idp", json!(idp)), ("pk", json!(pk))])?;
    let ticket = r["ticket"].as_str().filter(|t| matches(t, 43..=43, b64url_char)).ok_or_else(server)?.to_string();
    let t = SecaTicket { ticket, device: req.device.clone(), at: net.now_ms };
    keep(net, &a.id, &mut |l| l.seca_ticket = Some(t.clone()))?;
    Ok(json!({}))
}

/// Gives up the measurement waiting: the ticket is forgotten here whatever the backend says.
pub(crate) fn seca_cancel(net: &Net, _: crate::account::Empty) -> Result<Json> {
    let Some(a) = existing(net)? else { return Ok(json!({})) };
    let Some(t) = kept(&state(net)?, &a.id).seca_ticket else { return Ok(json!({})) };
    keep(net, &a.id, &mut |l| l.seca_ticket = None)?;
    let _ = post(net, &a, "/h/1/seca", "health-seca", &[("op", json!("cancel")), ("ticket", json!(t.ticket))]);
    Ok(json!({}))
}

#[derive(Serialize, JsonSchema)]
pub struct SecaPolled {
    /// "none", "waiting", "ready", "timeout", "replaced", "cancelled", "failed" or "error"
    pub state: String,
    /// ready: when it was measured (ms)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
}

/// Asks once for the result of the measurement waiting, and stores it when it is there.
pub(crate) fn seca_poll(net: &Net, _: crate::account::Empty) -> Result<SecaPolled> {
    let done = |state: &str| Ok(SecaPolled { state: state.into(), at: None });
    let Some(a) = existing(net)? else { return done("none") };
    let Some(t) = kept(&state(net)?, &a.id).seca_ticket else { return done("none") };
    let clear = || keep(net, &a.id, &mut |l| l.seca_ticket = None);
    if net.now_ms - t.at > KEEP_MS {
        clear()?;
        return done("none");
    }
    let Ok(r) = net.backend.get(&format!("/h/1/seca/result/{}", t.ticket)) else { return done("error") };
    match r["state"].as_str() {
        None => done("error"),
        Some("waiting") => done("waiting"),
        Some("ready") if r["ct"].is_string() => {
            let got = take(net, &a, r["ct"].as_str().unwrap_or_default(), SECA_INFO, &t.device)?;
            clear()?;
            let Some((at, _, p)) = got else { return done("failed") };
            // the report's PDF, while the backend keeps it
            let pdf = p
                .get("pdf")
                .and_then(Json::as_str)
                .filter(|u| u.strip_prefix("/h/1/seca/pdf/").is_some_and(|t| matches(t, 43..=43, b64url_char)));
            if let (Some(pdf), Some(until)) = (pdf, p.get("pdfUntil").and_then(Json::as_i64)) {
                let pdf = SecaPdf { url: format!("{}{pdf}", net.config.base), until };
                keep(net, &a.id, &mut |l| {
                    l.seca_pdf.retain(|_, v| v.until > net.now_ms);
                    l.seca_pdf.insert(format!("{}|{at}", t.device), pdf.clone());
                })?;
            }
            Ok(SecaPolled { state: "ready".into(), at: Some(at) })
        }
        Some(s @ ("timeout" | "replaced" | "cancelled")) => {
            clear()?;
            done(s)
        }
        Some(_) => {
            clear()?;
            done("failed")
        }
    }
}

#[derive(Deserialize, JsonSchema)]
pub struct PdfReq {
    pub device: String,
    /// When it was measured (ms)
    pub at: i64,
}

#[derive(Serialize, JsonSchema)]
pub struct PdfShown {
    /// The report's address while it is still kept
    pub url: Option<String>,
}

pub(crate) fn seca_pdf(net: &Net, req: PdfReq) -> Result<PdfShown> {
    let s = state(net)?;
    let Some(amk) = crate::account::amk_of(&s)? else { return Ok(PdfShown { url: None }) };
    let lab = kept(&s, &Account::of(&amk).id);
    let url = lab.seca_pdf.get(&format!("{}|{}", req.device, req.at)).filter(|p| p.until > net.now_ms).map(|p| p.url.clone());
    Ok(PdfShown { url })
}

// ---- VALD ForceDecks -------------------------------------------------------------------------------------

fn fd_made_from(birth: &str, gender: &str) -> String {
    format!("{birth}|{gender}")
}

/// The handle kept for `device`, if it was made from the current profile.
fn fd_saved(s: &State, account: &str, device: &str) -> Option<FdKept> {
    let (b, g, _) = personal(s);
    let from = fd_made_from(&b?, &g?);
    kept(s, account).fd.get(device).filter(|k| k.made_from == from).cloned()
}

#[derive(Serialize, JsonSchema)]
pub struct FdShown {
    /// The profile's 4-character label, when one is kept for this device and the current profile
    pub label: Option<String>,
    pub birth: Option<String>,
    pub gender: Option<String>,
}

pub(crate) fn fd_show(net: &Net, req: DeviceReq) -> Result<FdShown> {
    let s = state(net)?;
    let account = crate::account::amk_of(&s)?.map(|k| Account::of(&k).id);
    let label = account.as_deref().and_then(|a| fd_saved(&s, a, &req.device)).map(|k| k.label);
    let (birth, gender, _) = personal(&s);
    Ok(FdShown { label, birth, gender })
}

#[derive(Deserialize, JsonSchema)]
pub struct FdRegister {
    pub device: String,
    /// YYYY-MM; the profile's when absent
    pub birth: Option<String>,
    /// "Male" or "Female"; the profile's when absent
    pub gender: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct FdRegistered {
    pub label: String,
    /// "creating" or "ready"
    pub state: String,
}

pub(crate) fn fd_register(net: &Net, req: FdRegister) -> Result<FdRegistered> {
    valid_device(&req.device)?;
    let (pb, pg, _) = personal(&state(net)?);
    let (Some(birth), Some(gender)) = (req.birth.or(pb), req.gender.or(pg)) else {
        return Err(Error::new(Kind::Usage, "noprofile", "birth month and sex are needed"));
    };
    set_profile(net, &birth, &gender)?;
    let (a, pk) = keyed(net)?;
    let r = post(
        net,
        &a,
        "/h/1/fd",
        "health-fd",
        &[("op", json!("profile")), ("device", json!(req.device)), ("birth", json!(birth)), ("gender", json!(gender)), ("pk", json!(pk))],
    )?;
    let ext = r["ext"].as_str().filter(|e| e.len() == 36 && e.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')).ok_or_else(server)?;
    let feed = r["feed"].as_str().filter(|f| matches(f, 43..=43, b64url_char)).ok_or_else(server)?;
    let label = r["label"]
        .as_str()
        .filter(|l| matches(l, 4..=4, |b| b.is_ascii_uppercase() && !matches!(b, b'I' | b'O') || (b'2'..=b'9').contains(&b)))
        .ok_or_else(server)?;
    let st = r["state"].as_str().filter(|s| matches!(*s, "creating" | "ready")).ok_or_else(server)?;
    let made_from = fd_made_from(&birth, &gender);
    keep(net, &a.id, &mut |l| {
        // the same handle keeps its cursor and lease; a new feed for it reads the same results
        let e = match l.fd.get(&req.device) {
            Some(old) if old.ext == ext => FdKept { feed: feed.into(), label: label.into(), made_from: made_from.clone(), ..old.clone() },
            _ => FdKept {
                ext: ext.into(),
                feed: feed.into(),
                label: label.into(),
                made_from: made_from.clone(),
                cursor: 0,
                last_lease: None,
            },
        };
        l.fd.insert(req.device.clone(), e);
    })?;
    Ok(FdRegistered { label: label.into(), state: st.into() })
}

pub(crate) fn fd_start(net: &Net, req: DeviceReq) -> Result<Json> {
    valid_device(&req.device)?;
    let s = state(net)?;
    let (a, pk) = keyed(net)?;
    let h = fd_saved(&s, &a.id, &req.device).ok_or_else(|| Error::new(Kind::Usage, "noprofile", "make the ForceDecks profile first"))?;
    let r = post(
        net,
        &a,
        "/h/1/fd",
        "health-fd",
        &[("op", json!("start")), ("device", json!(req.device)), ("ext", json!(h.ext)), ("pk", json!(pk))],
    )?;
    if !matches!(r["state"].as_str(), Some("opening" | "open")) {
        return Err(server());
    }
    let now = net.now_ms;
    keep(net, &a.id, &mut |l| {
        if let Some(e) = l.fd.get_mut(&req.device) {
            e.last_lease = Some(now);
        }
    })?;
    Ok(json!({}))
}

#[derive(Serialize, JsonSchema)]
pub struct FdChecked {
    /// {state: creating|ready|failed, label, name (what the device's screen shows, once made), code}
    pub profile: Json,
    /// {state: opening|open|closed|failed, since, code} or null
    pub lease: Json,
    /// Results stored now
    pub taken: u32,
    /// Results that could never be read (skipped)
    pub bad: u32,
}

/// Asks once: the profile's and lease's state, and takes any new results.
pub(crate) fn fd_check(net: &Net, req: DeviceReq) -> Result<FdChecked> {
    valid_device(&req.device)?;
    let noprofile = || Error::new(Kind::Usage, "noprofile", "make the ForceDecks profile first");
    let a = existing(net)?.ok_or_else(noprofile)?;
    let mut h = fd_saved(&state(net)?, &a.id, &req.device).ok_or_else(noprofile)?;
    let (mut taken, mut bad, mut renewed) = (0, 0, false);
    for _ in 0..MAX_PAGES {
        let cursor = kept(&state(net)?, &a.id).fd.get(&req.device).map_or(0, |e| e.cursor);
        let b = match net.backend.get(&format!("/h/1/fd/{}?after={cursor}", h.feed)) {
            Ok(b) => b,
            // the feed went (too old, or replaced): ask for a new one with the same profile, once
            Err(c) if c == "unknown" && !renewed => {
                renewed = true;
                fd_register(net, FdRegister { device: req.device.clone(), birth: None, gender: None })?;
                h = fd_saved(&state(net)?, &a.id, &req.device).ok_or_else(noprofile)?;
                continue;
            }
            Err(c) => return Err(backend_error(c)),
        };
        let profile = b.get("profile").filter(|p| p.is_object()).cloned().ok_or_else(server)?;
        let lease = b.get("lease").cloned().unwrap_or(Json::Null);
        let mut next = cursor;
        let mut stuck = false;
        for it in b["items"].as_array().into_iter().flatten() {
            let Some(seq) = it["seq"].as_i64().filter(|s| *s > next) else { continue };
            match it["ct"].as_str() {
                Some(ct) => match take(net, &a, ct, FD_INFO, &req.device) {
                    Ok(Some((_, o, _))) => taken += u32::from(!matches!(o, health_core::result::Outcome::Seen)),
                    Ok(None) => bad += 1,
                    Err(_) => {
                        stuck = true;
                        break;
                    }
                },
                None => bad += 1,
            }
            next = seq;
        }
        let since = lease["since"].as_i64();
        let ext = h.ext.clone();
        keep(net, &a.id, &mut |l| {
            if let Some(e) = l.fd.get_mut(&req.device).filter(|e| e.ext == ext) {
                e.cursor = e.cursor.max(next);
                if let Some(s) = since {
                    e.last_lease = Some(e.last_lease.unwrap_or(0).max(s));
                }
            }
        })?;
        if stuck || b["more"] != true {
            return Ok(FdChecked { profile, lease, taken, bad });
        }
    }
    Err(server())
}

#[derive(Serialize, JsonSchema)]
pub struct FdCaughtUp {
    pub taken: u32,
}

/// On opening the app: one check for each device with a lease in the last 7 days.
pub(crate) fn fd_catch_up(net: &Net, _: crate::account::Empty) -> Result<FdCaughtUp> {
    let s = state(net)?;
    let Some(amk) = crate::account::amk_of(&s)? else { return Ok(FdCaughtUp { taken: 0 }) };
    let account = Account::of(&amk).id;
    let devices: Vec<String> = kept(&s, &account)
        .fd
        .iter()
        .filter(|(d, e)| e.last_lease.is_some_and(|l| net.now_ms - l <= KEEP_MS) && fd_saved(&s, &account, d).is_some())
        .map(|(d, _)| d.clone())
        .collect();
    let mut taken = 0;
    for device in devices {
        if let Ok(r) = fd_check(net, DeviceReq { device }) {
            taken += r.taken;
        }
    }
    Ok(FdCaughtUp { taken })
}
