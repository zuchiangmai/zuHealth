//! `health` CLI: parses arguments into an operation request and calls health_api. No rules live here.

mod account;
mod client;
mod keys;
mod mcp;
mod ocr;
mod render;
mod serve;
mod time;

use clap::{Args, Parser, Subcommand};
use health_api::{Caller, Ctx};
use health_core::keys::KeyStore;
use health_core::profile::Profile;
use health_core::{Error, Kind, Result};
use serde_json::{Value, json};
use std::io::Read;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "health", version, about = "Private, local-first personal health data")]
struct Cli {
    /// Data directory (default: the platform's app data dir)
    #[arg(long, global = true, env = "HEALTH_DATA_DIR")]
    data_dir: Option<PathBuf>,
    #[arg(long, global = true, env = "HEALTH_PROFILE", default_value = "default")]
    profile: String,
    /// Print the operation's response (or error) as JSON
    #[arg(long, global = true)]
    json: bool,
    /// Run a write and roll it back, reporting what would change
    #[arg(long, global = true)]
    dry_run: bool,
    /// Passphrase-locked profile: read the passphrase from stdin's first line
    #[arg(long, global = true)]
    passphrase_stdin: bool,
    /// Never contact the health service or download anything (also HEALTH_OFFLINE=1)
    #[arg(long, global = true, env = "HEALTH_OFFLINE", value_parser = clap::builder::FalseyValueParser::new())]
    offline: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create the profile (new key in the keychain, empty encrypted database)
    Init,
    /// Delete this profile and its key ("Clear data"): every record, the health account, links and settings.
    /// Quit the app (or stop `health serve`) first. The next `init` starts fresh.
    Wipe {
        /// Type DELETE to confirm
        #[arg(long)]
        confirm: String,
    },
    /// Profile and database summary
    Status,
    /// List operations, or print one operation's request and response JSON Schema
    Schema { op: Option<String> },
    /// Call any operation with a JSON request ("-" reads stdin)
    Op {
        name: String,
        #[arg(default_value = "{}")]
        request: String,
    },
    #[command(subcommand)]
    Metric(MetricCmd),
    /// Enter a value by hand. Multi-unit metrics need --unit
    Add(AddArgs),
    /// Replace a manual entry (identified by metric and time)
    Edit {
        metric: String,
        /// Time of the entry to replace (as entered)
        at: String,
        /// New value (omit for a span metric)
        #[arg(allow_negative_numbers = true)]
        value: Option<String>,
        #[arg(long)]
        unit: Option<String>,
        /// Move the entry to this time (default: keep it where it is)
        #[arg(long)]
        new_at: Option<String>,
        #[arg(long)]
        end: Option<String>,
    },
    /// Delete a manual entry
    Rm { metric: String, at: String },
    #[command(subcommand)]
    Obs(ObsCmd),
    /// Daily summaries of a metric, one elected source per day
    Daily {
        metric: Option<String>,
        #[arg(long)]
        from: Option<String>,
        #[arg(long)]
        to: Option<String>,
        /// Rebuild every daily summary instead
        #[arg(long, conflicts_with = "metric")]
        rebuild: bool,
    },
    /// Correct (or --delete) a point from a device or lab; values are in the metric's canonical unit
    Correct {
        metric: String,
        source: i64,
        at: String,
        #[arg(required_unless_present = "delete", allow_negative_numbers = true)]
        value: Option<String>,
        #[arg(long)]
        delete: bool,
    },
    #[command(subcommand)]
    Source(SourceCmd),
    #[command(subcommand)]
    Import(ImportCmd),
    #[command(subcommand)]
    Review(ReviewCmd),
    #[command(subcommand)]
    Report(ReportCmd),
    #[command(subcommand)]
    Backup(BackupCmd),
    /// Read a lab report (photo or PDF) into a batch waiting for your review (needs the OCR component)
    Ocr {
        /// The image (JPEG, PNG, …) or PDF
        file: PathBuf,
    },
    /// Optional parts that don't ship in the binary (the OCR models)
    #[command(subcommand)]
    Component(ComponentCmd),
    /// Your health account on this computer: its id and identity code
    Account {
        #[command(subcommand)]
        cmd: Option<AccountCmd>,
    },
    /// Link this computer to your health account on another device, or hand it to a new one
    #[command(subcommand)]
    Link(LinkCmd),
    /// Fetch results sent to your account (labs, desks) and store them
    Inbox,
    /// Your profile: birth month and sex (height and weight are your latest readings)
    Profile {
        /// YYYY-MM
        #[arg(long)]
        birth: Option<String>,
        /// male | female
        #[arg(long)]
        sex: Option<String>,
    },
    /// A self-service code for a lab device (the id beside its QR)
    #[command(name = "self")]
    SelfService { device: String },
    /// WHOOP sync with your own WHOOP developer app
    #[command(subcommand)]
    Whoop(WhoopCmd),
    /// LAN sync with this account's other devices (runs while `health serve` runs)
    #[command(subcommand)]
    Sync(SyncCmd),
    /// Internal: the OCR process `health ocr` and serve start (one request on stdin)
    #[command(hide = true)]
    OcrWorker,
    /// Debug builds: a LAN sync session over stdin/stdout (frames as a 4-byte big-endian length, then the bytes), for
    /// testing another implementation against this one. The result goes to stderr as one JSON line.
    #[command(hide = true)]
    SyncPipe {
        /// Answer the join and large-erase questions with yes
        #[arg(long)]
        allow: bool,
        /// Act as a side that keeps no files (as the web)
        #[arg(long)]
        no_files: bool,
        /// Rows per batch and per part of a split import
        #[arg(long)]
        batch_rows: Option<u64>,
    },
    /// Passphrase lock: keep the root key out of the keychain (plan §3.3)
    #[command(subcommand)]
    Passphrase(PassphraseCmd),
    /// Run the single writer on 127.0.0.1 (for the GUI, agents and forwarded CLI calls)
    Serve {
        /// Fixed port (default: random)
        #[arg(long, default_value_t = 0)]
        port: u16,
        /// Passphrase mode: lock again after this many idle minutes
        #[arg(long, default_value_t = 15)]
        idle_lock: u64,
        /// Exit when stdin closes, i.e. when the process that started this one exits (the GUI shell uses it).
        /// Not for launchd, nohup or `</dev/null`: a closed stdin means exit at once
        #[arg(long)]
        exit_with_parent: bool,
    },
    /// MCP over stdio for an agent; needs HEALTH_TOKEN or HEALTH_TOKEN_FILE (a grant token)
    Mcp,
    /// Unlock a running serve (passphrase mode)
    Unlock,
    /// Lock a running serve now (passphrase mode)
    Lock,
    /// Grants for agents
    #[command(subcommand)]
    Grant(GrantCmd),
    /// Unencrypted export for external analysis
    #[command(subcommand)]
    Export(ExportCmd),
    /// Who read what, when (no values)
    Audit {
        #[arg(long)]
        grant: Option<i64>,
        #[arg(long, default_value_t = 50)]
        limit: i64,
    },
}

#[derive(Subcommand)]
enum AccountCmd {
    /// Make the account if there is none, register it, and show the identity code (contacts the service)
    Register,
}

#[derive(Subcommand)]
enum SyncCmd {
    /// On or off, paused, the devices synced with; with serve running, each device's live state too
    Status,
    /// Turn sync on this network on
    On,
    /// Turn it off
    Off,
    /// Continue after a pause ("Not now" on a large erase)
    Continue,
}

#[derive(Subcommand)]
enum WhoopCmd {
    /// Whether WHOOP is connected
    Status,
    /// Connect: asks for the Client Secret, opens WHOOP's sign-in, then syncs
    Connect {
        #[arg(long)]
        client_id: String,
    },
    /// Fetch recent data now
    Sync,
    /// Forget the connection (readings stay)
    Disconnect,
}

#[derive(Subcommand)]
enum LinkCmd {
    /// Show a code for your other device to scan, then confirm the check code
    Join,
    /// Hand this computer's account to the new device showing `code` (ZUHL1:…)
    Give { code: String },
    /// The links this computer completed, newest first (a local record only)
    List,
}

#[derive(Subcommand)]
enum ExportCmd {
    /// Rows per data group
    Groups {
        #[arg(long)]
        from: Option<String>,
    },
    /// Write a CSV of the chosen groups (default: the normal ones)
    Csv {
        path: PathBuf,
        #[arg(long)]
        from: Option<String>,
        #[arg(long, value_delimiter = ',', default_value = "body,sleep,cardio,activity,lab")]
        groups: Vec<String>,
        #[arg(long)]
        date_only: bool,
    },
}

#[derive(Subcommand)]
enum GrantCmd {
    /// Create a grant; prints its token once
    Create {
        /// Shown to you, e.g. "Claude Desktop"
        #[arg(long)]
        name: String,
        /// Comma-separated: body,sleep,cardio,activity,lab (normal); infectious,tumor,repro,custom,lab_other,other,derived (sensitive)
        #[arg(long, value_delimiter = ',')]
        groups: Vec<String>,
        /// Allow individual points (default: daily summaries only)
        #[arg(long)]
        detail: bool,
        /// Allow full report text (not limited by groups: a lab sheet shows every item on it)
        #[arg(long)]
        reports: bool,
        /// Only the last N days (default: everything)
        #[arg(long)]
        days: Option<i64>,
        /// none | propose | derived
        #[arg(long, default_value = "none")]
        write: String,
        /// Expires after N days
        #[arg(long, default_value_t = 30)]
        expires_days: i64,
        /// Allow age (whole years) and sex from your profile (never the birth month)
        #[arg(long)]
        age_sex: bool,
    },
    List,
    Revoke {
        id: i64,
    },
}

#[derive(Subcommand)]
enum PassphraseCmd {
    /// Wrap the root key with a passphrase and delete it from the keychain
    Set,
    /// Move the root key back into the keychain
    Remove,
}

#[derive(Subcommand)]
enum ComponentCmd {
    /// What is installed
    List,
    /// Install a component: `ocr` (about 21 MB, plus 135 MB for measure matching)
    Install {
        name: String,
        /// Install from a folder holding the files instead of downloading them
        #[arg(long)]
        from: Option<PathBuf>,
        /// Skip the measure-matching model (you then pick each measure yourself)
        #[arg(long)]
        no_matching: bool,
    },
}

#[derive(Args)]
struct AddArgs {
    metric: String,
    /// The value; omit for a span metric (e.g. deep sleep with --end)
    #[arg(allow_negative_numbers = true)]
    value: Option<String>,
    #[arg(long)]
    unit: Option<String>,
    /// YYYY-MM-DD (date only), local YYYY-MM-DDTHH:MM, RFC 3339, or epoch ms (default: now)
    #[arg(long)]
    at: Option<String>,
    /// End of a span (e.g. a sleep period)
    #[arg(long)]
    end: Option<String>,
}

#[derive(Subcommand)]
enum MetricCmd {
    Search {
        q: String,
        #[arg(long, default_value_t = 20)]
        limit: i64,
    },
    Show {
        code: String,
    },
}

#[derive(Subcommand)]
enum ObsCmd {
    Query {
        metric: String,
        #[arg(long)]
        from: Option<String>,
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        source: Option<i64>,
        #[arg(long, default_value_t = 1000)]
        limit: i64,
    },
    Latest {
        metric: Option<String>,
    },
}

#[derive(Subcommand)]
enum SourceCmd {
    List,
    Rename {
        id: i64,
        name: String,
    },
    /// Smaller wins the daily election
    Priority {
        id: i64,
        priority: i64,
    },
}

#[derive(Subcommand)]
enum ImportCmd {
    /// Apple Health "Export All Health Data" zip
    Apple {
        path: PathBuf,
    },
    /// A saved WHOOP API bundle (JSON)
    Whoop {
        path: PathBuf,
    },
    /// JSON lines of rows from one source
    Rows {
        path: PathBuf,
        #[arg(long)]
        source: String,
    },
    List {
        #[arg(long)]
        connector: Option<String>,
    },
    Show {
        id: i64,
        #[arg(long, default_value_t = 50)]
        limit: i64,
    },
    Erase {
        id: i64,
    },
    /// Every batch of one kind of source (manual, ocr, apple_health, whoop, lab, …)
    EraseSource {
        connector: String,
    },
}

#[derive(Subcommand)]
enum ReviewCmd {
    List,
    /// Confirm: an agent's proposal as proposed, or with a JSON array of rows (file or "-")
    Confirm {
        id: i64,
        rows: Option<String>,
        #[arg(long)]
        text: Option<String>,
    },
    Discard {
        id: i64,
    },
}

#[derive(Subcommand)]
enum ReportCmd {
    Search {
        q: String,
        #[arg(long, default_value_t = 20)]
        limit: i64,
    },
    Show {
        id: i64,
    },
}

#[derive(Subcommand)]
enum BackupCmd {
    Export {
        path: PathBuf,
        #[arg(long)]
        no_blobs: bool,
        /// Read the password from stdin instead of prompting
        #[arg(long)]
        password_stdin: bool,
    },
    Import {
        path: PathBuf,
        #[arg(long)]
        password_stdin: bool,
    },
}

fn usage(code: &'static str, msg: impl Into<String>) -> Error {
    Error::new(Kind::Usage, code, msg)
}

fn read_arg(s: &str) -> Result<String> {
    if s == "-" {
        let mut b = String::new();
        std::io::stdin().read_to_string(&mut b)?;
        Ok(b)
    } else if s.trim_start().starts_with(['{', '[']) {
        Ok(s.to_string())
    } else {
        std::fs::read_to_string(s).map_err(|_| usage("bad_arg", format!("{s}: not JSON and not a readable file")))
    }
}

/// Integer, finite number, or text (never NaN/inf: JSON would turn those into null, which deletes).
fn value_of(s: &str) -> Value {
    if let Ok(i) = s.parse::<i64>() {
        return Value::from(i);
    }
    match s.parse::<f64>() {
        Ok(f) if f.is_finite() => Value::from(f),
        _ => Value::from(s),
    }
}

fn entry(metric: &str, value: Option<&str>, unit: Option<&str>, at: &str, end: Option<&str>) -> Result<Value> {
    let at = time::parse(at)?;
    let at_json = match (&at.date, end) {
        (Some(d), None) => json!({ "date": d, "tz_min": at.tz_min }),
        (_, end) => {
            let end = end.map(time::parse).transpose()?.map(|e| e.ms);
            json!({ "ms": at.ms, "end_ms": end, "tz_min": at.tz_min })
        }
    };
    let mut e = json!({ "metric": metric, "value": value.map_or(Value::Null, value_of), "at": at_json });
    if let Some(u) = unit {
        e["unit"] = json!(u);
    }
    Ok(e)
}

fn password(from_stdin: bool, confirm: bool) -> Result<String> {
    if from_stdin {
        let mut s = String::new();
        std::io::stdin().read_line(&mut s)?;
        return Ok(s.trim_end_matches(['\r', '\n']).to_string());
    }
    let p = rpassword::prompt_password("Backup password: ")?;
    if confirm && rpassword::prompt_password("Repeat: ")? != p {
        return Err(usage("password_mismatch", "passwords differ"));
    }
    Ok(p)
}

/// Turns a command into (operation, request).
fn request(cmd: &Cmd, now: i64) -> Result<(String, Value)> {
    let day = |s: &Option<String>| -> Result<Option<i64>> { s.as_deref().map(|s| time::parse(s).map(|w| w.ms)).transpose() };
    Ok(match cmd {
        Cmd::Init
        | Cmd::Wipe { .. }
        | Cmd::Schema { .. }
        | Cmd::Passphrase(_)
        | Cmd::Serve { .. }
        | Cmd::Mcp
        | Cmd::Unlock
        | Cmd::Lock
        | Cmd::Component(_)
        | Cmd::SyncPipe { .. }
        | Cmd::OcrWorker => {
            unreachable!("handled before")
        }
        Cmd::Grant(GrantCmd::Create { name, groups, detail, reports, days, write, expires_days, age_sex }) => (
            "grant.create".into(),
            json!({
                "name": name, "groups": groups, "detail": detail, "reports": reports, "profile": age_sex,
                "window": days.map_or(json!("all"), |d| json!({ "last_days": d })),
                "write": write,
                "expires_ms": expires_days.checked_mul(86_400_000).and_then(|d| now.checked_add(d)).ok_or_else(|| usage("bad_expiry", "too far ahead"))?,
            }),
        ),
        Cmd::Grant(GrantCmd::List) => ("grant.list".into(), json!({})),
        Cmd::Grant(GrantCmd::Revoke { id }) => ("grant.revoke".into(), json!({ "id": id })),
        Cmd::Audit { grant, limit } => ("audit.list".into(), json!({ "grant_id": grant, "limit": limit })),
        Cmd::Status => ("status".into(), json!({})),
        Cmd::Op { name, request } => {
            let mut req: Value = serde_json::from_str(&read_arg(request)?).map_err(|e| usage("bad_json", e.to_string()))?;
            // absolute, as the typed commands do: a forwarded call runs in serve's working directory
            if let Some(p) = req.get("path").and_then(Value::as_str).filter(|p| !p.is_empty()).map(std::path::PathBuf::from) {
                req["path"] = json!(std::path::absolute(p)?);
            }
            (name.clone(), req)
        }
        Cmd::Metric(MetricCmd::Search { q, limit }) => ("metric.search".into(), json!({ "q": q, "limit": limit })),
        Cmd::Metric(MetricCmd::Show { code }) => ("metric.show".into(), json!({ "code": code })),
        Cmd::Add(a) => {
            let at = a.at.clone().unwrap_or_else(|| now.to_string());
            let e = entry(&a.metric, a.value.as_deref(), a.unit.as_deref(), &at, a.end.as_deref())?;
            ("manual.enter".into(), json!({ "entries": [e] }))
        }
        Cmd::Edit { metric, at, value, unit, new_at, end } => {
            let e = entry(metric, value.as_deref(), unit.as_deref(), new_at.as_deref().unwrap_or(at), end.as_deref())?;
            ("manual.edit".into(), json!({ "code": metric, "start_ms": time::parse(at)?.ms, "entry": e }))
        }
        Cmd::Rm { metric, at } => ("manual.remove".into(), json!({ "code": metric, "start_ms": time::parse(at)?.ms })),
        Cmd::Obs(ObsCmd::Query { metric, from, to, source, limit }) => {
            ("obs.query".into(), json!({ "metric": metric, "from_ms": day(from)?, "to_ms": day(to)?, "source_id": source, "limit": limit }))
        }
        Cmd::Obs(ObsCmd::Latest { metric }) => ("obs.latest".into(), json!({ "metric": metric })),
        Cmd::Daily { rebuild: true, .. } => ("daily.rebuild".into(), json!({})),
        Cmd::Daily { metric: None, .. } => return Err(usage("bad_arg", "give a metric, or --rebuild")),
        Cmd::Daily { metric: Some(m), from, to, .. } => ("daily.query".into(), json!({ "metric": m, "from": from, "to": to })),
        Cmd::Correct { metric, source, at, value, delete } => {
            let v = if *delete { Value::Null } else { value_of(value.as_deref().unwrap_or_default()) };
            ("correct".into(), json!({ "metric": metric, "source_id": source, "start_ms": time::parse(at)?.ms, "value": v }))
        }
        Cmd::Source(SourceCmd::List) => ("source.list".into(), json!({})),
        Cmd::Source(SourceCmd::Rename { id, name }) => ("source.update".into(), json!({ "id": id, "name": name })),
        Cmd::Source(SourceCmd::Priority { id, priority }) => ("source.update".into(), json!({ "id": id, "priority": priority })),
        Cmd::Import(ImportCmd::Apple { path }) => ("import.apple".into(), json!({ "path": std::path::absolute(path)? })),
        Cmd::Import(ImportCmd::Whoop { path }) => ("import.whoop".into(), json!({ "path": std::path::absolute(path)? })),
        Cmd::Import(ImportCmd::Rows { path, source }) => {
            ("import.rows".into(), json!({ "path": std::path::absolute(path)?, "source": source }))
        }
        Cmd::Export(ExportCmd::Groups { from }) => ("export.groups".into(), json!({ "from_ms": day(from)? })),
        Cmd::Export(ExportCmd::Csv { path, from, groups, date_only }) => (
            "export.csv".into(),
            json!({ "path": std::path::absolute(path)?, "from_ms": day(from)?, "groups": groups, "date_only": date_only }),
        ),
        Cmd::Import(ImportCmd::List { connector }) => ("import.list".into(), json!({ "connector": connector })),
        Cmd::Import(ImportCmd::Show { id, limit }) => ("import.show".into(), json!({ "id": id, "limit": limit })),
        Cmd::Import(ImportCmd::Erase { id }) => ("import.erase".into(), json!({ "id": id })),
        Cmd::Import(ImportCmd::EraseSource { connector }) => ("import.erase_source".into(), json!({ "connector": connector })),
        Cmd::Review(ReviewCmd::List) => ("review.list".into(), json!({})),
        Cmd::Review(ReviewCmd::Confirm { id, rows, text }) => {
            let rows: Value = match rows {
                Some(r) => serde_json::from_str(&read_arg(r)?).map_err(|e| usage("bad_json", e.to_string()))?,
                None => Value::Null,
            };
            ("review.confirm".into(), json!({ "id": id, "rows": rows, "text": text }))
        }
        Cmd::Review(ReviewCmd::Discard { id }) => ("review.discard".into(), json!({ "id": id })),
        // the OCR worker fills in `recognized` (see run)
        Cmd::Account { cmd: None } => ("account.show".into(), json!({})),
        Cmd::Account { cmd: Some(AccountCmd::Register) } => ("account.register".into(), json!({})),
        Cmd::Inbox => ("inbox.poll".into(), json!({})),
        Cmd::Profile { birth: None, sex: None } => ("profile.get".into(), json!({})),
        Cmd::Profile { birth, sex } => {
            let mut req = json!({});
            if let Some(b) = birth {
                req["birth"] = json!(b);
            }
            if let Some(s) = sex {
                req["sex"] = json!(match s.to_ascii_lowercase().as_str() {
                    "male" | "m" => "Male",
                    "female" | "f" => "Female",
                    _ => return Err(usage("bad_sex", "male or female")),
                });
            }
            ("profile.set".into(), req)
        }
        Cmd::SelfService { device } => ("self.code".into(), json!({ "device": device })),
        Cmd::Link(LinkCmd::List) => ("link.devices".into(), json!({})),
        Cmd::Link(_) => return Err(usage("interactive", "link runs interactively")),
        Cmd::Whoop(WhoopCmd::Status) => ("whoop.status".into(), json!({})),
        Cmd::Sync(SyncCmd::Status) => ("sync.state".into(), json!({})),
        Cmd::Sync(SyncCmd::On) => ("sync.set".into(), json!({ "enabled": true })),
        Cmd::Sync(SyncCmd::Off) => ("sync.set".into(), json!({ "enabled": false })),
        Cmd::Sync(SyncCmd::Continue) => ("sync.set".into(), json!({ "paused": false })),
        Cmd::Whoop(WhoopCmd::Sync) => ("whoop.sync".into(), json!({ "force": true })),
        Cmd::Whoop(WhoopCmd::Disconnect) => ("whoop.disconnect".into(), json!({})),
        Cmd::Whoop(WhoopCmd::Connect { .. }) => return Err(usage("interactive", "whoop connect runs interactively")),
        Cmd::Ocr { file } => {
            ("import.ocr".into(), json!({ "path": std::path::absolute(file)?, "tz_min": time::parse(&now.to_string())?.tz_min }))
        }
        Cmd::Report(ReportCmd::Search { q, limit }) => ("report.search".into(), json!({ "q": q, "limit": limit })),
        Cmd::Report(ReportCmd::Show { id }) => ("report.show".into(), json!({ "id": id })),
        // absolute: a forwarded call runs in serve's working directory
        Cmd::Backup(BackupCmd::Export { path, no_blobs, password_stdin }) => (
            "backup.export".into(),
            json!({ "path": std::path::absolute(path)?, "no_blobs": no_blobs, "password": password(*password_stdin, true)? }),
        ),
        Cmd::Backup(BackupCmd::Import { path, password_stdin }) => {
            ("backup.import".into(), json!({ "path": std::path::absolute(path)?, "password": password(*password_stdin, false)? }))
        }
    })
}

/// "Clear data": the profile's files (the database first, see `profile::wipe`), then its root key. No network.
fn wipe(cli: &Cli, dir: &std::path::Path, pdir: &std::path::Path, confirm: &str) -> Result<Value> {
    if !confirm.trim().eq_ignore_ascii_case("DELETE") {
        return Err(usage("not_confirmed", "type --confirm DELETE"));
    }
    if cli.dry_run {
        return Err(usage("no_dry_run", "wipe"));
    }
    if client::probe(pdir).is_some() {
        return Err(Error::conflict("busy", "Health is running (the app or `health serve`): quit it, then try again"));
    }
    let Some(id) = health_core::profile::wipe(dir, &cli.profile)? else {
        return Ok(json!({ "cleared": false }));
    };
    // the key last: without its database it opens nothing, and a key file left behind would stop the next init
    let keys = keys::from_env();
    match keys.kind() {
        "keychain" => keys::keychain_delete(&id)?,
        "file" => keys::forget_file()?,
        _ => {}
    }
    Ok(json!({ "cleared": true }))
}

fn data_dir(cli: &Cli) -> Result<PathBuf> {
    cli.data_dir.clone().or_else(|| dirs::data_dir().map(|d| d.join("health"))).ok_or_else(|| usage("no_data_dir", "set --data-dir"))
}

fn passphrase_cmd(cli: &Cli, dir: &std::path::Path, cmd: &PassphraseCmd) -> Result<Value> {
    let pdir = health_core::profile::profile_dir(dir, &cli.profile)?;
    let id = std::fs::read_to_string(pdir.join("id")).map_err(|_| Error::not_found("no_profile", cli.profile.clone()))?;
    let id = id.trim();
    let file = pdir.join(health_core::keys::KEYWRAP);
    // a running serve fixed its mode at start: it would keep the profile open, or lose its key file
    if matches!(cmd, PassphraseCmd::Set | PassphraseCmd::Remove) && client::probe(&pdir).is_some() {
        return Err(Error::conflict("serve_running", "stop `health serve` (quit the app) first, then try again"));
    }
    match cmd {
        PassphraseCmd::Set => {
            if file.exists() {
                return Err(Error::conflict("exists", "a passphrase is already set"));
            }
            let current = keys::from_env();
            let root = current.load(id)?.ok_or_else(|| Error::new(Kind::Locked, "no_key", "no key to wrap"))?;
            let p = keys::read_passphrase(cli.passphrase_stdin, "New passphrase: ")?;
            if !cli.passphrase_stdin && keys::read_passphrase(false, "Repeat: ")? != p {
                return Err(usage("passphrase_mismatch", "passphrases differ"));
            }
            let store = health_core::keys::PassphraseStore::new(&file, &p);
            store.store(id, &root)?;
            if store.load(id)?.as_deref() != Some(&*root) {
                let _ = std::fs::remove_file(&file);
                return Err(Error::other("keywrap", "verification failed; nothing changed"));
            }
            let note = if current.kind() == "keychain" {
                keys::keychain_delete(id)?;
                "root key removed from the keychain".to_string()
            } else {
                "the key file still holds the root key: delete it yourself once you have checked the passphrase".to_string()
            };
            Ok(json!({ "key_store": "passphrase", "note": note }))
        }
        PassphraseCmd::Remove => {
            let p = keys::read_passphrase(cli.passphrase_stdin, "Passphrase: ")?;
            let root = health_core::keys::PassphraseStore::new(&file, &p).load(id)?.ok_or_else(|| Error::not_found("no_passphrase", ""))?;
            let target = keys::from_env();
            if target.load(id)?.as_deref() != Some(&*root) {
                target.store(id, &root)?;
            }
            std::fs::remove_file(&file)?;
            Ok(json!({ "key_store": target.kind() }))
        }
    }
}

/// How the owner proves itself to a running serve: its token (keychain mode) or the passphrase proof.
fn owner_auth(cli: &Cli, pdir: &std::path::Path, s: &client::Serve) -> Result<(&'static str, String)> {
    if let Some(t) = &s.token {
        return Ok(("Authorization", format!("Bearer {t}")));
    }
    let p = keys::read_passphrase(cli.passphrase_stdin, "Passphrase: ")?;
    Ok(("X-Health-Proof", health_core::keys::PassphraseStore::new(&pdir.join(health_core::keys::KEYWRAP), &p).proof()?))
}

/// The grant token for `health mcp`: HEALTH_TOKEN, or HEALTH_TOKEN_FILE readable by its owner only.
fn agent_token() -> Result<String> {
    if let Ok(t) = std::env::var("HEALTH_TOKEN") {
        return Ok(t.trim().to_string());
    }
    let f = std::env::var_os("HEALTH_TOKEN_FILE")
        .ok_or_else(|| Error::new(Kind::Denied, "no_token", "set HEALTH_TOKEN or HEALTH_TOKEN_FILE"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(&f)?.permissions().mode() & 0o077 != 0 {
            return Err(Error::new(Kind::Denied, "no_token", "HEALTH_TOKEN_FILE must be mode 0600"));
        }
    }
    Ok(std::fs::read_to_string(f)?.trim().to_string())
}

/// MCP over stdio: one JSON-RPC message per line; stdout carries nothing else.
fn mcp_stdio(dir: &std::path::Path, profile: &str) -> Result<()> {
    use std::io::{BufRead, Write};
    let token = agent_token()?;
    let pdir = health_core::profile::profile_dir(dir, profile)?;
    let mut run = |op: &str, args: Value| -> Result<health_api::Outcome> {
        if let Some(s) = client::probe(&pdir) {
            let (value, withheld) = s.op(("Authorization", format!("Bearer {token}")), op, &args, false)?;
            return Ok(health_api::Outcome { value, withheld: withheld.and_then(|w| serde_json::from_value(w).ok()) });
        }
        if pdir.join(health_core::keys::KEYWRAP).exists() {
            return Err(Error::new(Kind::Locked, "locked", "passphrase-locked: start and unlock `health serve`"));
        }
        let now = time::now_ms();
        let write = health_api::find(op)?.write;
        let p = Profile::open(dir, profile, keys::from_env().as_ref(), write, now)?;
        let grant = p.access.resolve(&token, now)?;
        let mut ctx = Ctx::new(&p, now, Caller::Delegate(grant));
        health_api::call(&mut ctx, op, args)
    };
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => mcp::handle(&msg, &mut run),
            Err(_) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } })),
        };
        if let Some(r) = reply {
            writeln!(out, "{r}")?;
            out.flush()?;
        }
    }
    Ok(())
}

fn run(cli: &Cli) -> Result<Value> {
    let now = time::now_ms();
    let dir = data_dir(cli)?;
    let pdir = health_core::profile::profile_dir(&dir, &cli.profile)?;
    match &cli.cmd {
        Cmd::Passphrase(cmd) => return passphrase_cmd(cli, &dir, cmd),
        Cmd::Wipe { confirm } => return wipe(cli, &dir, &pdir, confirm),
        Cmd::Component(ComponentCmd::List) => return Ok(ocr::status(&dir)),
        Cmd::Component(ComponentCmd::Install { name, from, no_matching }) => {
            if name != "ocr" {
                return Err(Error::not_found("no_component", name));
            }
            if cli.offline && from.is_none() {
                return Err(usage("offline", "offline: install from local files with --from"));
            }
            return ocr::install(&dir, from.as_deref(), !no_matching);
        }
        Cmd::Serve { port, idle_lock, exit_with_parent } => {
            if *exit_with_parent {
                // The shell holds our stdin pipe; when it exits (or crashes) the pipe closes. Works on every OS.
                std::thread::spawn(|| {
                    let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
                    std::process::exit(0);
                });
            }
            serve::run(serve::Opts {
                data_dir: dir,
                profile: cli.profile.clone(),
                port: *port,
                idle_lock: std::time::Duration::from_secs((*idle_lock).max(1) * 60),
                offline: cli.offline,
            })?;
            return Ok(Value::Null);
        }
        Cmd::Mcp => {
            mcp_stdio(&dir, &cli.profile)?;
            return Ok(Value::Null);
        }
        Cmd::SyncPipe { allow, no_files, batch_rows } => {
            if !cfg!(debug_assertions) {
                return Err(usage("debug_only", "sync-pipe is for tests (debug builds)"));
            }
            let keys = keys::for_profile(&pdir, cli.passphrase_stdin)?;
            let p = Profile::open(&dir, &cli.profile, keys.as_ref(), true, now)?;
            let out = health_runtime::lan::pipe(&p, now, *allow, !*no_files, *batch_rows)?;
            eprintln!("{out}");
            return Ok(Value::Null);
        }
        Cmd::Unlock | Cmd::Lock => {
            let s = client::probe(&pdir).ok_or_else(|| Error::not_found("no_serve", "no serve is running for this profile"))?;
            let (path, body, headers) = if matches!(cli.cmd, Cmd::Unlock) {
                let p = keys::read_passphrase(cli.passphrase_stdin, "Passphrase: ")?;
                ("/v1/unlock", json!({ "passphrase": p }).to_string(), vec![])
            } else {
                ("/v1/lock", String::new(), vec![owner_auth(cli, &pdir, &s)?])
            };
            let (status, b) = s.call("POST", path, &headers, body.as_bytes())?;
            let v: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
            if status != 200 {
                let code = v["error"]["code"].as_str().unwrap_or("serve").to_string();
                return Err(Error::new(
                    client::kind_of(status),
                    Box::leak(code.into_boxed_str()),
                    v["error"]["message"].as_str().unwrap_or("").to_string(),
                ));
            }
            return Ok(v);
        }
        Cmd::Init | Cmd::Schema { .. } => {}
        Cmd::Link(LinkCmd::Join | LinkCmd::Give { .. }) | Cmd::Account { cmd: Some(_) } | Cmd::Inbox | Cmd::SelfService { .. } => {
            return net_cmd(cli, &dir, &pdir, now);
        }
        Cmd::Whoop(c) if !matches!(c, WhoopCmd::Status) => return net_cmd(cli, &dir, &pdir, now),
        _ => {
            if let Some(s) = client::probe(&pdir) {
                // the passphrase first, as on the direct path, so stdin lines mean the same either way
                let auth = owner_auth(cli, &pdir, &s)?;
                let (name, mut req) = request(&cli.cmd, now)?;
                if name == "import.ocr" {
                    ocr::fill(&dir, &mut req, time::year(now))?;
                }
                if matches!(cli.cmd, Cmd::Sync(SyncCmd::Status)) {
                    let mut v = s.op(auth.clone(), &name, &req, false)?.0;
                    v["live"] = s.op(auth, "sync.live", &json!({}), false)?.0;
                    return Ok(v);
                }
                return Ok(s.op(auth, &name, &req, cli.dry_run)?.0);
            }
        }
    }
    let keys = match &cli.cmd {
        Cmd::Init | Cmd::Schema { .. } => keys::from_env(),
        _ => keys::for_profile(&health_core::profile::profile_dir(&dir, &cli.profile)?, cli.passphrase_stdin)?,
    };
    match &cli.cmd {
        Cmd::Init if cli.dry_run => return Err(usage("no_dry_run", "init")),
        Cmd::Init => {
            let p = Profile::init(&dir, &cli.profile, keys.as_ref())?;
            return Ok(json!({ "profile": p.name, "dir": p.dir, "key_store": p.key_store }));
        }
        Cmd::Schema { op: None } => {
            let mut all: Vec<Value> = health_api::ops()
                .iter()
                .map(
                    |o| json!({ "op": o.name, "write": o.write, "delegate": format!("{:?}", o.delegate).to_lowercase(), "about": o.about }),
                )
                .collect();
            // the ops that contact the health service: owner only, never a tool
            all.extend(
                health_api::account::NET_OPS
                    .iter()
                    .map(|o| json!({ "op": o.name, "write": true, "delegate": "never", "network": true, "about": o.about })),
            );
            return Ok(Value::Array(all));
        }
        Cmd::Schema { op: Some(name) } if health_api::account::find_net(name).is_some() => {
            let o = health_api::account::find_net(name).expect("found");
            return Ok(json!({ "op": o.name, "about": o.about, "network": true, "request": (o.req)(), "response": (o.resp)() }));
        }
        Cmd::Schema { op: Some(name) } => {
            let o = health_api::find(name)?;
            return Ok(json!({ "op": o.name, "about": o.about, "request": (o.req)(), "response": (o.resp)() }));
        }
        _ => {}
    }
    let (name, mut req) = request(&cli.cmd, now)?;
    if name == "import.ocr" {
        ocr::fill(&dir, &mut req, time::year(now))?;
    }
    let op = health_api::find(&name)?;
    let profile = Profile::open(&dir, &cli.profile, keys.as_ref(), op.write, now)?;
    let mut ctx = Ctx::new(&profile, now, Caller::Owner);
    ctx.dry_run = cli.dry_run;
    Ok(health_api::call(&mut ctx, &name, req)?.value)
}

/// The commands that talk to the health backend: through a running serve (its link session and its
/// `--offline`), or on this process's own profile.
fn net_cmd(cli: &Cli, dir: &std::path::Path, pdir: &std::path::Path, now: i64) -> Result<Value> {
    if cli.dry_run {
        return Err(usage("no_dry_run", "contacts the health service"));
    }
    // refused here, before a running serve (started without --offline) could send it
    if cli.offline {
        return Err(usage("offline", "offline: nothing is sent to the health service"));
    }
    let serve = client::probe(pdir);
    let auth = match &serve {
        Some(s) => Some(owner_auth(cli, pdir, s)?),
        None => None,
    };
    let config = account::config();
    let backend = account::backend(cli.offline, &config);
    let session = std::sync::Mutex::new(health_api::account::Session::default());
    let keys = if serve.is_none() { Some(keys::for_profile(pdir, cli.passphrase_stdin)?) } else { None };
    // without serve, the profile is opened for each short step only: a link waiting 10 minutes doesn't hold
    // the writer lock (the app or another command can still write meanwhile)
    let open = || Profile::open(dir, &cli.profile, keys.as_deref().expect("direct"), true, time::now_ms());
    let mut call = |name: &str, req: Value| -> Result<Value> {
        if let (Some(s), Some(a)) = (&serve, &auth) {
            return Ok(s.op(a.clone(), name, &req, false)?.0);
        }
        if health_api::account::find_net(name).is_some() {
            return account::direct(&open, backend.as_ref(), &config, &session, name, req);
        }
        let p = open()?;
        let mut ctx = Ctx::new(&p, now, Caller::Owner);
        Ok(health_api::call(&mut ctx, name, req)?.value)
    };
    match &cli.cmd {
        Cmd::Link(LinkCmd::Join) => account::join(&mut call),
        Cmd::Link(LinkCmd::Give { code }) => account::give(code, &mut call),
        Cmd::Whoop(WhoopCmd::Connect { client_id }) => account::whoop_connect(client_id, &mut call),
        cmd => {
            let (name, req) = request(cmd, now)?;
            call(&name, req)
        }
    }
}

fn main() {
    #[cfg(unix)]
    // Every file this process creates is private (database, WAL, blobs, backups).
    unsafe {
        libc::umask(0o077);
    }
    let cli = Cli::parse();
    if matches!(cli.cmd, Cmd::OcrWorker) {
        std::process::exit(ocr::worker_main());
    }
    match run(&cli) {
        Ok(Value::Null) => {} // serve / mcp: stdout is theirs
        Ok(v) => {
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&v).expect("json"));
            } else {
                render::print(&v);
            }
        }
        Err(e) => {
            if cli.json {
                println!("{}", json!({ "error": { "code": e.code, "message": e.detail } }));
            } else {
                eprintln!("error: {e}");
            }
            std::process::exit(e.kind.exit_code());
        }
    }
}
