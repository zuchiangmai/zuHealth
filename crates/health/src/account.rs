//! The health backend at the OS edge: the one allowed base (health-connect), `--offline`, and the CLI's link
//! flow. The ops themselves are `health_api::account`.

use health_api::account::{Backend, Config, Net, Session, call_net};
use health_api::{Caller, Ctx};
use health_core::profile::Profile;
use health_core::{Error, Kind, Result};
use serde_json::{Value, json};
use std::io::Write;
use std::sync::Mutex;

pub use health_runtime::backend::{backend, config};

/// A network op in this process (no serve running): each locked step opens the profile and closes it again.
pub fn direct(
    open: &dyn Fn() -> Result<Profile>,
    backend: &dyn Backend,
    c: &Config,
    session: &Mutex<Session>,
    name: &str,
    req: Value,
) -> Result<Value> {
    let locked = |f: &mut dyn FnMut(&mut Ctx) -> Result<Value>| -> Result<Value> {
        let profile = open()?;
        let mut ctx = Ctx::new(&profile, crate::time::now_ms(), Caller::Owner);
        f(&mut ctx)
    };
    let now = crate::time::now_ms();
    call_net(&Net { backend, config: c, session, locked: &locked, now_ms: now, tz_min: crate::time::tz_at(now) }, name, req)
}

fn ask(question: &str) -> Result<bool> {
    eprint!("{question} [y/N] ");
    std::io::stderr().flush()?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(matches!(line.trim(), "y" | "Y" | "yes"))
}

/// `health link join`: show the code, wait for the other device, compare the check codes, keep the account.
pub fn join(call: &mut dyn FnMut(&str, Value) -> Result<Value>) -> Result<Value> {
    let j = call("link.join", json!({}))?;
    let code = j["code"].as_str().unwrap_or_default();
    eprintln!("On your other device, open Health › Link a new device and scan this code:\n");
    if let Some(qr) = health_api::account::qr_text(code) {
        eprintln!("{qr}");
    }
    eprintln!("{code}\n\nWaiting (up to 10 minutes)…");
    loop {
        let s = call("link.poll", json!({}))?;
        match s["state"].as_str() {
            Some("waiting") => std::thread::sleep(std::time::Duration::from_secs(2)),
            Some("received") => {
                let check = s["check"].as_str().unwrap_or_default();
                eprintln!("\nCheck code: {check}");
                if s["replaces"] == true {
                    eprintln!("This device's identity code will change to the other device's; results not yet received here won't arrive.");
                }
                if !ask("Does the other device show the same check code?")? {
                    call("link.cancel", json!({}))?;
                    return Err(Error::new(Kind::Usage, "cancelled", "not linked: nothing was kept"));
                }
                // the channel this command started, not whatever the poll names
                return call("link.adopt", json!({ "channel": j["channel"], "check": check }));
            }
            Some("expired") => return Err(Error::new(Kind::Other, "expired", "the link expired: start again")),
            Some("failed") => {
                let c = s["code"].as_str().unwrap_or("failed");
                return Err(Error::new(Kind::Other, "link_failed", format!("the link failed ({c}): start again")));
            }
            _ => return Err(Error::new(Kind::Other, "link_failed", "no link in progress")),
        }
    }
}

/// `health link give <code>`: rule 2's question first.
pub fn give(code: &str, call: &mut dyn FnMut(&str, Value) -> Result<Value>) -> Result<Value> {
    if !ask("This hands your health account to the device showing this code. Continue only if it is your own device. Continue?")? {
        return Err(Error::new(Kind::Usage, "cancelled", "nothing was sent"));
    }
    let r = call("link.give", json!({ "code": code, "confirmed": true }))?;
    eprintln!("Check code: {} — the new device must show the same.", r["check"].as_str().unwrap_or_default());
    Ok(r)
}

/// Opens `url` in the default browser (WHOOP's sign-in page).
pub fn open_browser(url: &str) {
    // tests (debug builds) never open a real browser
    if cfg!(debug_assertions) && std::env::var_os("HEALTH_NO_BROWSER").is_some() {
        return;
    }
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url).status();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(url).status();
    let _ = r;
}

/// Waits (up to `wait`) for WHOOP's sign-in to come back to `http://localhost:<port>/whoop?…` and returns the
/// query. Listens on 127.0.0.1 and ::1 only; answers the browser with a short page.
pub fn wait_redirect(port: u16, wait: std::time::Duration) -> Result<String> {
    use std::io::{BufRead, BufReader};
    let listeners: Vec<std::net::TcpListener> =
        ["127.0.0.1", "[::1]"].iter().filter_map(|h| std::net::TcpListener::bind(format!("{h}:{port}")).ok()).collect();
    if listeners.is_empty() {
        return Err(Error::conflict("port_busy", format!("port {port} is in use: close what uses it and connect again")));
    }
    for l in &listeners {
        l.set_nonblocking(true)?;
    }
    let until = std::time::Instant::now() + wait;
    while std::time::Instant::now() < until {
        for l in &listeners {
            let Ok((s, _)) = l.accept() else { continue };
            s.set_nonblocking(false)?;
            s.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
            let mut first = String::new();
            let _ = BufReader::new(&s).read_line(&mut first);
            let target = first.split_whitespace().nth(1).unwrap_or("");
            let Some(q) = target.strip_prefix("/whoop?").or_else(|| (target == "/whoop").then_some("")) else {
                let _ = (&s).write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                continue;
            };
            let page = "<!doctype html><meta charset=utf-8><title>Health</title><body style=\"font:16px -apple-system,system-ui,sans-serif;margin:3em\"><p>WHOOP sign-in received. You can close this tab and return to Health.</p>";
            let _ = write!(
                &s,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
                page.len()
            );
            return Ok(q.to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(Error::new(Kind::Other, "expired", "the WHOOP sign-in didn't come back in time: connect again"))
}

/// `health whoop connect`: the person's own WHOOP developer app, sign-in in the browser, the first sync.
pub fn whoop_connect(client_id: &str, call: &mut dyn FnMut(&str, Value) -> Result<Value>) -> Result<Value> {
    let piped = !std::io::IsTerminal::is_terminal(&std::io::stdin());
    let secret = crate::keys::read_passphrase(piped, "WHOOP Client Secret: ")?;
    let b = call("whoop.begin", json!({ "client_id": client_id, "client_secret": secret }))?;
    eprintln!("In your WHOOP developer app, the redirect URL must be: {}", b["redirect"].as_str().unwrap_or_default());
    eprintln!("Opening WHOOP's sign-in page. If it doesn't open, visit:\n{}\n", b["url"].as_str().unwrap_or_default());
    open_browser(b["url"].as_str().unwrap_or_default());
    let q = wait_redirect(health_api::whoop::REDIRECT_PORT, std::time::Duration::from_secs(600))?;
    call("whoop.complete", json!({ "query": q }))?;
    call("whoop.sync", json!({ "force": true }))
}
