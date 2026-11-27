//! Sync core (docs/lan-sync.md §6): a device's inventory, the per-import fingerprints, the digest, and what one
//! side wants from the other. Pure data: no network, no clock. The transport and the session live elsewhere.
//!
//! Every value is written exactly so Rust and JS agree byte for byte: integers in decimal, reals as the 16 hex
//! digits of their IEEE-754 bits, text as `<byte length>:<bytes>`, null as `n`.

use crate::db::Db;
use crate::error::Result;
use crate::value::Value;
use crate::write::parse_meta;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// One import as the inventory lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportLine {
    pub status: String,
    pub blob: Option<String>,
    /// `<rows>:<sum of row hashes>` for done imports, else None (`-`)
    pub fp: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Inventory {
    /// uid → line, for done, review and erased imports
    pub imports: BTreeMap<String, ImportLine>,
    /// Section lines, each sorted bytewise
    pub corrections: Vec<String>,
    pub settings: Vec<String>,
    pub aliases: Vec<String>,
    /// Files referenced here and missing here: import files and waveform pointers (section 5)
    pub lacks: BTreeSet<String>,
    /// Imports being written here: never wanted (§6.4), and not sent
    pub running: BTreeSet<String>,
}

pub fn text(s: &str) -> String {
    format!("{}:{s}", s.len())
}

fn opt_text(s: &Option<String>) -> String {
    s.as_deref().map_or("n".into(), text)
}

fn opt_int(i: Option<i64>) -> String {
    i.map_or("n".into(), |i| i.to_string())
}

/// `<typeof> <value>`, typeof as SQLite names it.
pub fn typed(v: &Value) -> String {
    match v {
        Value::Int(i) => format!("integer {i}"),
        // -0.0 and 0.0 are equal to SQLite: one encoding (merge-fixes R12)
        Value::Real(r) => format!("real {:016x}", if *r == 0.0 { 0u64 } else { r.to_bits() }),
        Value::Text(s) => format!("text {}", text(s)),
        Value::Null => "null n".into(),
    }
}

/// Sum modulo 2^256 of SHA-256 digests (big-endian): order-free, so rows need no sort.
fn add256(acc: &mut [u8; 32], h: &[u8]) {
    let mut carry = 0u16;
    for i in (0..32).rev() {
        let s = acc[i] as u16 + h[i] as u16 + carry;
        acc[i] = s as u8;
        carry = s >> 8;
    }
}

/// Fingerprints of every done import, from one scan of each table (§6.2).
pub fn fingerprints(c: &Db) -> Result<HashMap<i64, String>> {
    let mut acc: HashMap<i64, (u64, [u8; 32])> = HashMap::new();
    let mut add = |id: i64, row: String| {
        let e = acc.entry(id).or_insert((0, [0; 32]));
        e.0 += 1;
        add256(&mut e.1, &Sha256::digest(row.as_bytes()));
    };
    let mut st = c.prepare(
        "SELECT o.import_id, m.code, s.connector, s.external_id, o.start_ms, o.end_ms, o.tz_min, o.value, o.detail
           FROM observation o JOIN metric m ON m.id = o.metric_id JOIN source s ON s.id = o.source_id",
    )?;
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        let row = format!(
            "o {} {} {} {} {} {} {} {}",
            text(&r.get::<_, String>(1)?),
            text(&r.get::<_, String>(2)?),
            text(&r.get::<_, String>(3)?),
            r.get::<_, i64>(4)?,
            opt_int(r.get(5)?),
            r.get::<_, i64>(6)?,
            typed(&r.get::<_, Value>(7)?),
            opt_text(&r.get(8)?)
        );
        add(r.get(0)?, row);
    }
    let mut st = c.prepare("SELECT import_id, chrom, pos, rsid, genotype FROM genotype")?;
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        let row =
            format!("g {} {} {} {}", text(&r.get::<_, String>(1)?), r.get::<_, i64>(2)?, opt_int(r.get(3)?), text(&r.get::<_, String>(4)?));
        add(r.get(0)?, row);
    }
    let mut st = c.prepare("SELECT rowid, text FROM report_text")?;
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        add(r.get(0)?, format!("t {}", text(&r.get::<_, String>(1)?)));
    }
    Ok(acc.into_iter().map(|(id, (n, h))| (id, format!("{n}:{}", hex::encode(h)))).collect())
}

/// This device's inventory. `has_blob` says whether a file is present here.
pub fn inventory(c: &Db, has_blob: &dyn Fn(&str) -> bool) -> Result<Inventory> {
    let fps = fingerprints(c)?;
    let mut inv = Inventory::default();
    let mut st = c.prepare("SELECT id, uid, status, blob FROM import WHERE status IN ('done', 'review', 'erased')")?;
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        let (id, uid, status, blob): (i64, String, String, Option<String>) = (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?);
        // a done import that owns nothing now still has a fingerprint: zero rows
        let fp = (status == "done").then(|| fps.get(&id).cloned().unwrap_or_else(|| format!("0:{}", "0".repeat(64))));
        if let Some(b) = &blob
            && status != "erased"
            && !has_blob(b)
        {
            inv.lacks.insert(b.clone());
        }
        inv.imports.insert(uid, ImportLine { status, blob, fp });
    }
    let mut st = c.prepare("SELECT uid FROM import WHERE status = 'running'")?;
    inv.running = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    // waveform pointers (agg 'none' values naming a file), as backup.rs finds them
    let mut st = c.prepare(
        "SELECT DISTINCT value FROM observation WHERE metric_id IN (SELECT id FROM metric WHERE agg = 'none') AND typeof(value) = 'text'",
    )?;
    let ptrs: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    inv.lacks.extend(ptrs.into_iter().filter(|s| crate::blob::is_sha(s) && !has_blob(s)));
    let mut st = c.prepare(
        "SELECT m.code, s.connector, s.external_id, k.start_ms, k.at, k.value
           FROM correction k JOIN metric m ON m.id = k.metric_id JOIN source s ON s.id = k.source_id",
    )?;
    inv.corrections = st
        .query_map([], |r| {
            Ok(format!(
                "c {} {} {} {} {} {}",
                text(&r.get::<_, String>(0)?),
                text(&r.get::<_, String>(1)?),
                text(&r.get::<_, String>(2)?),
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                typed(&r.get::<_, Value>(5)?)
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut st = c.prepare("SELECT connector, external_id, name, priority, meta FROM source")?;
    inv.settings = st
        .query_map([], |r| {
            let m = parse_meta(r.get(4)?);
            let at = m.get("set_at").and_then(|v| v.as_str()).and_then(crate::merge::set_at_value).unwrap_or(0);
            let by = m.get("set_by").and_then(|v| v.as_str()).unwrap_or("").to_string();
            Ok(format!(
                "s source {} {} {at} {} {} {}",
                text(&r.get::<_, String>(0)?),
                text(&r.get::<_, String>(1)?),
                text(&by),
                r.get::<_, i64>(3)?,
                text(&r.get::<_, String>(2)?)
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut st = c.prepare("SELECT a.alias, a.unit, m.code FROM metric_alias a JOIN metric m ON m.id = a.metric_id")?;
    inv.aliases = st
        .query_map([], |r| {
            Ok(format!("a {} {} {}", text(&r.get::<_, String>(0)?), text(&r.get::<_, String>(1)?), text(&r.get::<_, String>(2)?)))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for v in [&mut inv.corrections, &mut inv.settings, &mut inv.aliases] {
        v.sort();
    }
    Ok(inv)
}

impl Inventory {
    /// The inventory text, sections in order (imports, corrections, settings, aliases), each line ending in `\n`.
    /// Missing files (`b` lines) are left out: they are wants, not data.
    pub fn text(&self) -> String {
        let mut out = String::new();
        for (uid, l) in &self.imports {
            out.push_str(&format!("i {uid} {} {} {}\n", l.status, l.blob.as_deref().unwrap_or("-"), l.fp.as_deref().unwrap_or("-")));
        }
        for l in self.corrections.iter().chain(&self.settings).chain(&self.aliases) {
            out.push_str(l);
            out.push('\n');
        }
        out
    }

    pub fn digest(&self) -> String {
        hex::encode(Sha256::digest(self.text().as_bytes()))
    }
}

/// At most this many lines in an inventory from the other side (§6.5).
pub const MAX_LINES: usize = 500_000;

impl Inventory {
    /// What goes over the channel: `text()`, then a `b <sha>` line per missing file.
    pub fn wire(&self) -> String {
        let mut out = self.text();
        for b in &self.lacks {
            out.push_str("b ");
            out.push_str(b);
            out.push('\n');
        }
        out
    }

    /// Reads the other side's inventory (untrusted): every line by its grammar, sections in order, each sorted
    /// bytewise without repeats. Text fields are read by their byte length, so a newline inside one can't forge a line.
    pub fn parse(s: &str) -> Result<Inventory> {
        let bad = |why: &str| crate::error::Error::invalid("bad_inventory", why.to_string());
        let mut p = Cur { s: s.as_bytes(), i: 0 };
        let mut inv = Inventory::default();
        let mut section = 0u8;
        let mut last: Option<&[u8]> = None;
        let mut lines = 0usize;
        while p.i < p.s.len() {
            lines += 1;
            if lines > MAX_LINES {
                return Err(crate::error::Error::invalid("inventory_large", format!("over {MAX_LINES} lines")));
            }
            let start = p.i;
            let tag = p.word().ok_or_else(|| bad("tag"))?;
            let sec = match tag {
                b"i" => 1,
                b"c" => 2,
                b"s" => 3,
                b"a" => 4,
                b"b" => 5,
                _ => return Err(bad("tag")),
            };
            if sec < section {
                return Err(bad("order"));
            }
            if sec > section {
                last = None;
                section = sec;
            }
            let ok = match sec {
                1 => p.import_line(&mut inv),
                2 => (|| {
                    p.text()?;
                    p.text()?;
                    p.text()?;
                    p.int()?;
                    p.int()?;
                    p.typed()
                })(),
                3 => match p.word() {
                    Some(b"source") => (|| {
                        p.text()?;
                        p.text()?;
                        p.int()?;
                        p.text()?;
                        p.int()?;
                        p.text()
                    })(),
                    Some(b"profile") => (|| {
                        p.int()?;
                        p.text()?;
                        p.text()?;
                        p.text()?;
                        p.text()
                    })(),
                    Some(b"whoop/stopped") => (|| {
                        p.int()?;
                        p.text()?;
                        p.int()
                    })(),
                    _ => None,
                },
                4 => (|| {
                    p.text()?;
                    p.text()?;
                    p.text()
                })(),
                _ => p.word().filter(|w| crate::blob::is_sha(std::str::from_utf8(w).unwrap_or(""))).map(|w| {
                    inv.lacks.insert(String::from_utf8_lossy(w).into_owned());
                }),
            };
            if ok.is_none() || p.s.get(p.i) != Some(&b'\n') {
                return Err(bad("syntax"));
            }
            let line = &p.s[start..p.i];
            p.i += 1;
            // sorted for the compares to mean anything; import lines are sorted by uid, which their bytes follow
            if last.is_some_and(|l| l >= line) {
                return Err(bad("order"));
            }
            last = Some(line);
            let owned = std::str::from_utf8(line).map_err(|_| bad("utf8"))?.to_string();
            match sec {
                2 => inv.corrections.push(owned),
                3 => inv.settings.push(owned),
                4 => inv.aliases.push(owned),
                _ => {}
            }
        }
        Ok(inv)
    }
}

/// A cursor over an inventory's bytes. Each read consumes one field and the single space before it (none before
/// the line's tag).
struct Cur<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Cur<'a> {
    /// The next space-free word; a leading space is consumed unless at the line start.
    fn word(&mut self) -> Option<&'a [u8]> {
        if self.i > 0 && self.s[self.i - 1] != b'\n' {
            if self.s.get(self.i) != Some(&b' ') {
                return None;
            }
            self.i += 1;
        }
        let start = self.i;
        while self.i < self.s.len() && self.s[self.i] != b' ' && self.s[self.i] != b'\n' {
            self.i += 1;
        }
        (self.i > start).then(|| &self.s[start..self.i])
    }

    fn int(&mut self) -> Option<()> {
        let w = self.word()?;
        let digits = w.strip_prefix(b"-").unwrap_or(w);
        (!digits.is_empty() && digits.len() <= 19 && digits.iter().all(u8::is_ascii_digit)).then_some(())
    }

    /// `<byte length>:<bytes>`
    fn text(&mut self) -> Option<()> {
        if self.s.get(self.i) != Some(&b' ') {
            return None;
        }
        self.i += 1;
        let start = self.i;
        while self.i < self.s.len() && self.s[self.i].is_ascii_digit() && self.i - start < 10 {
            self.i += 1;
        }
        let n: usize = std::str::from_utf8(&self.s[start..self.i]).ok()?.parse().ok()?;
        if self.s.get(self.i) != Some(&b':') || self.i == start {
            return None;
        }
        self.i += 1;
        let end = self.i.checked_add(n)?;
        if end > self.s.len() {
            return None;
        }
        std::str::from_utf8(&self.s[self.i..end]).ok()?;
        self.i = end;
        Some(())
    }

    fn typed(&mut self) -> Option<()> {
        match self.word()? {
            b"integer" => self.int(),
            b"real" => self.word().filter(|w| w.len() == 16 && w.iter().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))).map(|_| ()),
            b"text" => self.text(),
            b"null" => self.word().filter(|w| *w == b"n").map(|_| ()),
            _ => None,
        }
    }

    /// `i <uid> <status> <blob or -> <fp or ->`
    fn import_line(&mut self, inv: &mut Inventory) -> Option<()> {
        let uid = self.word()?;
        // merge-fixes P5: 1-64 bytes of printable ASCII
        if uid.len() > 64 || !uid.iter().all(|b| (0x21..=0x7e).contains(b)) {
            return None;
        }
        let status = self.word()?;
        let blob = self.word()?;
        let fp = self.word()?;
        let blob = match blob {
            b"-" => None,
            b => Some(std::str::from_utf8(b).ok().filter(|s| crate::blob::is_sha(s))?.to_string()),
        };
        let status = match status {
            b"done" | b"review" | b"erased" => std::str::from_utf8(status).ok()?.to_string(),
            _ => return None,
        };
        let fp = match (fp, status.as_str()) {
            (b"-", "review" | "erased") => None,
            (f, "done") => {
                let (n, h) = std::str::from_utf8(f).ok()?.split_once(':')?;
                let ok = !n.is_empty()
                    && n.len() <= 19
                    && n.bytes().all(|b| b.is_ascii_digit())
                    && h.len() == 64
                    && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'));
                Some(ok.then(|| format!("{n}:{h}"))?)
            }
            _ => return None,
        };
        let uid = String::from_utf8(uid.to_vec()).ok()?;
        if inv.imports.contains_key(&uid) {
            return None;
        }
        inv.imports.insert(uid, ImportLine { status, blob, fp });
        Some(())
    }
}

/// What this side asks the other for (§6.4).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Want {
    pub imports: Vec<String>,
    pub corrections: bool,
    pub settings: bool,
    pub aliases: bool,
    pub blobs: Vec<String>,
}

impl Want {
    pub fn is_empty(&self) -> bool {
        self.imports.is_empty() && !self.corrections && !self.settings && !self.aliases && self.blobs.is_empty()
    }
}

/// Compares this side's inventory with the other's. `skip` holds uids a negative cache keeps out (§6.4).
pub fn wants(local: &Inventory, remote: &Inventory, skip: &dyn Fn(&str) -> bool) -> Want {
    let mut w = Want::default();
    for (uid, r) in &remote.imports {
        if local.running.contains(uid) {
            continue; // being written here: its own writer finishes it (§6.4)
        }
        let want = match local.imports.get(uid) {
            None => true,
            Some(l) => match (l.status.as_str(), r.status.as_str()) {
                (_, "erased") => l.status != "erased",
                ("done", "done") => l.fp != r.fp || l.blob != r.blob,
                ("review", "done") => true,
                // the same review on both sides: only its file can differ (merge-fixes R6b)
                ("review", "review") => l.blob != r.blob,
                _ => false,
            },
        };
        if want && !skip(uid) {
            w.imports.push(uid.clone());
        }
    }
    w.corrections = local.corrections != remote.corrections;
    w.settings = local.settings != remote.settings;
    w.aliases = local.aliases != remote.aliases;
    // a file missing here and not missing there. Waveform pointers aren't listed, so the other side may simply not
    // reference it: it sends what it has, and the session's negative cache keeps the rest out (§6.4)
    w.blobs = local.lacks.iter().filter(|b| !remote.lacks.contains(*b)).cloned().collect();
    w
}

// ---- synced settings kept in the vault (§8) ------------------------------------------------------------------

use crate::vault::{Personal, Stamp, State, Stopped};
use serde::{Deserialize, Serialize};

pub const ETHNICITIES: &[&str] = &["Asian", "Caucasian", "AfroAmerican", "Hispanic", "Japanese", "Other"];

/// The vault's synced settings as inventory lines (section 3), field by field so Rust and JS write the same bytes:
///   `s profile <set_at> T(set_by) T(birth) T(gender) T(ethnicity)` (absent fields as empty text)
///   `s whoop/stopped <set_at> T(set_by) <at>`
/// Both lines are always present: an unset setting is `0`, empty text and `0`.
pub fn vault_settings(s: &State) -> Vec<String> {
    let st = s.profile_stamp.clone().unwrap_or_default();
    let p = s.profile.clone().unwrap_or_default();
    let f = |v: &Option<String>| text(v.as_deref().unwrap_or(""));
    let w = s.whoop_stopped.clone().unwrap_or_default();
    vec![
        format!("s profile {} {} {} {} {}", st.set_at, text(&st.set_by), f(&p.birth), f(&p.gender), f(&p.ethnicity)),
        format!("s whoop/stopped {} {} {}", w.stamp.set_at, text(&w.stamp.set_by), w.at),
    ]
}

/// The next stamp for a vault setting: above every HLC this device has seen (corrections, sources, the vault).
pub fn next_stamp(c: &Db, s: &State, now_ms: i64) -> Result<i64> {
    let db = crate::correction::next_at(c, now_ms)?;
    let vault = [s.profile_stamp.as_ref().map(|x| x.set_at), s.whoop_stopped.as_ref().map(|x| x.stamp.set_at)]
        .into_iter()
        .flatten()
        .max()
        .unwrap_or(0);
    Ok(db.max(vault.saturating_add(1)))
}

/// The `settings` message (§6.3): the vault's synced settings with their stamps.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<ProfileSetting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub whoop_stopped: Option<Stopped>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProfileSetting {
    #[serde(flatten)]
    pub stamp: Stamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub birth: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ethnicity: Option<String>,
}

pub fn settings_of(s: &State) -> Settings {
    let p = s.profile.clone().unwrap_or_default();
    Settings {
        // an unstamped profile (set before sync existed) travels too, at set_at 0, so two of them still converge
        profile: (s.profile.is_some() || s.profile_stamp.is_some()).then(|| ProfileSetting {
            stamp: s.profile_stamp.clone().unwrap_or_default(),
            birth: p.birth,
            gender: p.gender,
            ethnicity: p.ethnicity,
        }),
        whoop_stopped: s.whoop_stopped.clone(),
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SettingsApplied {
    pub profile: bool,
    pub whoop_stopped: bool,
    /// WHOOP was connected here before the other device stopped it: disconnected here too
    pub whoop_disconnected: bool,
    /// Refused: a stamp from the future or a malformed value (the caller's negative cache keeps it out)
    pub refused: bool,
}

fn stamp_ok(s: &Stamp, now_ms: i64) -> Option<bool> {
    // unstamped (0, "") or a real stamp: set_by is a device id, printable ASCII
    let by = s.set_by.len() <= 64 && s.set_by.bytes().all(|b| (0x21..=0x7e).contains(&b)) && (s.set_at == 0) == s.set_by.is_empty();
    let ok = s.set_at >= 0 && by;
    if !ok {
        return None;
    }
    // a stamp more than a day ahead is refused (merge-fixes G1); Some(false): retry later
    Some(s.set_at <= (now_ms.max(0) + crate::merge::MAX_SKEW_MS) << crate::correction::HLC_SHIFT)
}

/// The web's `^(19|20)\d{2}-(0[1-9]|1[0-2])$`, ASCII digits only (no sign), so both sides accept the same set.
pub fn birth_ok(b: &str) -> bool {
    let d = b.as_bytes();
    d.len() == 7
        && d[4] == b'-'
        && d.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit())
        && (b.starts_with("19") || b.starts_with("20"))
        && matches!(&b[5..], "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12")
}

/// Takes each incoming setting whose `(set_at, set_by, value)` is larger than the one here (§6.4). Untrusted input:
/// every field is checked, and a stamp from the future is refused.
pub fn apply_settings(s: &mut State, incoming: &Settings, now_ms: i64) -> SettingsApplied {
    let mut out = SettingsApplied::default();
    if let Some(p) = &incoming.profile {
        let valid = p.birth.as_deref().is_none_or(birth_ok)
            && p.gender.as_deref().is_none_or(|g| g == "Male" || g == "Female")
            && p.ethnicity.as_deref().is_none_or(|e| ETHNICITIES.contains(&e));
        match stamp_ok(&p.stamp, now_ms) {
            Some(true) if valid => {
                let here = s.profile.clone().unwrap_or_default();
                let mine = s.profile_stamp.clone().unwrap_or_default();
                let key = |st: &Stamp, p: &Personal| {
                    (st.set_at, st.set_by.clone(), [&p.birth, &p.gender, &p.ethnicity].map(|v| v.clone().unwrap_or_default()))
                };
                let theirs = Personal { birth: p.birth.clone(), gender: p.gender.clone(), ethnicity: p.ethnicity.clone() };
                if key(&p.stamp, &theirs) > key(&mine, &here) {
                    s.profile = Some(theirs);
                    s.profile_stamp = Some(p.stamp.clone());
                    out.profile = true;
                }
            }
            _ => out.refused = true,
        }
    }
    if let Some(w) = &incoming.whoop_stopped {
        match stamp_ok(&w.stamp, now_ms) {
            Some(true) if w.at >= 0 && w.at <= now_ms.saturating_add(crate::merge::MAX_SKEW_MS) => {
                let mine = s.whoop_stopped.clone().unwrap_or_default();
                if (w.stamp.set_at, &w.stamp.set_by, w.at) > (mine.stamp.set_at, &mine.stamp.set_by, mine.at) {
                    s.whoop_stopped = Some(w.clone());
                    out.whoop_stopped = true;
                    if s.whoop.as_ref().is_some_and(|x| x.connected_at.is_none_or(|c| c < w.at)) {
                        s.whoop = None;
                        out.whoop_disconnected = true;
                    }
                }
            }
            _ => out.refused = true,
        }
    }
    out
}

/// A profile's whole inventory: the database's, plus the vault's synced settings, with its files checked on disk.
pub fn of_profile(p: &crate::profile::Profile) -> Result<Inventory> {
    let mut inv = inventory(&p.db, &|s| p.blobs.has(s))?;
    inv.settings.extend(vault_settings(&p.vault.load()?));
    inv.settings.sort();
    Ok(inv)
}

/// WHOOP stopped on this device (disconnected, or its data deleted): forget the connection and stamp the stop, so
/// other devices still connected stop too (§8).
pub fn stop_whoop(c: &Db, s: &mut State, device: &str, now_ms: i64) -> Result<()> {
    let set_at = next_stamp(c, s, now_ms)?;
    s.whoop = None;
    s.whoop_stopped = Some(Stopped { at: now_ms, stamp: Stamp { set_at, set_by: device.to_string() } });
    Ok(())
}
