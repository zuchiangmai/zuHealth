# Architecture (M0 + M1)

Implementation design for the first two milestones of `架構與實施計畫.md`. That plan and `健康數據庫設計.md` remain the specs; this file says how the code is laid out and where each rule lives. An independent review (2026-11-21) shaped this revision.

## Principles

- **Logic lives in libraries; binaries are shells.** Every rule is reachable without a process boundary, so mobile can later link the same crates.
- **One path per operation.** CLI, HTTP, MCP and FFI all call `health_api::call(ctx, op, json)`. No shell validates input or runs SQL on its own.
- **Deterministic core.** `health-core` never reads the clock, the timezone or OS services. `now_ms` and `tz_min` are arguments, and the key store is a trait.
- **Port, don't redesign.** Behaviour follows the web version (`W/src/client/lib/health/db/*` plus the rules in `W/src/client/db/handlers.ts`) rule for rule. Committed web fixtures prove the parity.
- **Only crates that exist today.** M0+M1 ship `health-core`, `health-api` and `health`. Each milestone creates its own crates.

## Workspace

```
crates/
  health-core/   data layer: no network, no clock, no OS services
    error.rs  value.rs  db.rs  catalog.rs  units.rs  write.rs  manual.rs  correction.rs
    daily.rs  erase.rs  review.rs  batches.rs  query.rs  merge.rs  aead.rs  pack.rs  blob.rs  keys.rs  profile.rs
    sync.rs                     LAN sync core: inventory (wire form, parser), fingerprints, digest, wants, synced settings (docs/lan-sync.md §6, §8)
    syncstate.rs                the profile's sealed `sync` file: joined, paused, peers, negative cache, resume cursors (§9)
    data/metrics.tsv            generated from the web catalog (catalog.data + body + lab)
    tests/fixtures/             web-made backup + expected results (scripts/web-fixture.ts)
    tests/fixtures/merge/       shared merge cases with the web, hand-derived (docs/merge-fixes.md §9)
  health-api/    operation table: OpDef registry, Ctx, Caller, call(), schemas
    sync.rs                     LAN sync session, sans-IO: framing, hello → inventories → wants → packs → done (lan-sync §6.3)
  health/        bin: clap CLI, OS keychain KeyStore, clock and timezone
```

`docs/health-schema.sql` is compiled in. Its tables match the web version's `schema.sql` exactly; its comments are the web's Chinese ones with English added under each (both sides compare schemas with comments ignored). Its PRAGMA lines are stripped before it runs inside the init transaction; `db.rs` sets those PRAGMAs per connection.

## Transactions and side effects

- Core functions nest with SAVEPOINTs. The outermost write runs as `BEGIN IMMEDIATE`, opened by `call()`.
- ATTACH and DETACH cannot run inside a transaction, so `backup.*` ops are `tx: Manual`: they attach outside the transaction and open it themselves.
- File effects happen only after COMMIT. That covers deleting orphan blobs and writing restored blobs. A crash in between leaves at worst an unreferenced file. A writer's open sweeps `blobs/` for unreferenced files (decision 19) and clears `tmp/`. M5 constraint: a blob must be stored and referenced in the same writer session, or the sweep removes it.
- `dry_run` is offered only by DB-only write ops. They roll back.

## Operation table

```rust
pub struct OpDef {
    pub name: &'static str, pub about: &'static str,
    pub write: bool,        // takes the writer lock; DB-only write ops support dry_run
    pub delegate: Delegate, // Never | Read | Propose | Derived (M2; deny by default)
    pub manual_tx: bool,    // op manages its own transaction (ATTACH)
    pub req: fn() -> Schema, pub resp: fn() -> Schema,
    pub run: fn(&mut Ctx, serde_json::Value) -> Result<serde_json::Value>,
}
```

- `call()` = authorize → audit (a delegate's write is logged first, so it never runs unlogged) → validate and execute. (Built in M1/M2 in that order; the op's input is validated inside its run.) A `macro_rules!` wraps typed `fn(&mut Ctx, Req) -> Result<Resp>`.
- `health schema [op]` prints JSON Schema. OpenAPI and the TS client come from the same registry when HTTP lands (decision 5).

| Op | W handler / module | CLI | Write |
| --- | --- | --- | --- |
| `status` | `status` | `status` | – |
| `metric.search`, `metric.show` | catalog | `metric search|show` | – |
| `manual.enter` | `enterManual` | `add` | ✓ |
| `manual.edit`, `manual.remove` | `editManual`, `removeManual` | `edit`, `rm` | ✓ |
| `obs.query`, `obs.latest` | `v_observation` reads | `obs query|latest` | – |
| `daily.query` | `v_daily` reads | `daily` | – |
| `daily.rebuild` | `rebuildAllDaily` | `daily rebuild` | ✓ |
| `correct` | `putCorrection` (no web handler) | `correct` | ✓ |
| `source.list`, `source.update` | `sources` | `source list|rename|priority` | –/✓ |
| `import.list`, `import.show`, `import.erase`, `import.erase_source` | `batches`, `previewBatch`, `eraseBatch`, `eraseConnector` | `import list|show|erase|erase-source` | –/–/✓/✓ |
| `review.list`, `review.confirm`, `review.discard` | `reviews`, `confirmReview` (strict), `discardReview` | `review list|confirm|discard` | –/✓/✓ |
| `import.ocr`, `import.seen`, `review.confirm_ocr` (M5) | `ingestOcr`, `blobSeen`, `confirmReview` (noOverwrite) | `ocr <file>`, `op …` | ✓/–/✓ |
| `report.search`, `report.show` | report_text | `report search|show` | – |
| `backup.export`, `backup.import` | `makeBackup`, `restoreBackup` | `backup export|import` | ✓ (manual tx) |

`correct` writes the correction layer for device, lab and lab-photo data. Manual points go through `edit`/`rm` (decision 7).

## Values and identities

- `Value::number(f64)` is the only way numbers enter storage. Integral values with |v| ≤ 2^53−1 are stored as INTEGER and everything else as REAL. Non-finite numbers and unsafe integers are rejected. This mirrors the web's `numKind` and `checkRow`.
- `import.uid` is opaque TEXT compared only in SQL. New uids are UUIDv7 for `now_ms`, floored above the largest UUID-shaped uid already present, so "newer import wins" holds with a pinned or backwards clock.
- An UPSERT that loses to a newer import counts as `kept` in the result. It is never counted as written.
- `correction.at` is an HLC: physical ms × 65536 plus a counter, seeded from `max(at)` on every write. Because it exceeds 2^53, JSON carries it as a decimal string. The winner is decided only by `CORRECTION_WINS` in SQL.

## Storage, keys, locking

```
<data dir>/                  0700
  profiles/<name>/           0700
    id                       random profile id (keychain account name)
    health.db (+wal, shm)    0600, SQLCipher raw key = HKDF(root, "health/db")
    blobs/<sha256>           0600, chunked AES-256-GCM, key = HKDF(root, "health/blob")
    lock                     writer lock (std File::try_lock)
    tmp/                     backup plain DBs and partial blobs; swept at open
    access.db                grants and audit (M2), key = HKDF(root, "health/access")
    keywrap                  passphrase mode only (M2): the root key under Argon2id
    serve.json               while `health serve` runs (M2): {port, pid, id[, token]}
```

- `KeyStore` is a trait in core. The bin implements it with the OS keychain (service `health`, account = profile id), or with `HEALTH_ROOT_KEY_FILE` (refused unless the file is mode 0600). That fallback covers tests, CI and headless hosts until the passphrase lock arrives in M2. `status` reports which store is in use. Key buffers are zeroized.
- The raw-key form of `PRAGMA key` skips SQLCipher's KDF. Reading `user_version` right after setting the key serves as the probe: failure maps to `bad_key`.
- Write ops take the lock and run crash recovery. Read ops open without the lock (WAL) and skip recovery. A second writer gets `busy`, since socket forwarding is M2.
- Schema gate: `user_version` greater than 1 gives `db_newer`. There is no migration framework yet. `vault` and `config.toml` are deferred to the milestones that need them; `access.db` arrived with M2.

## Backup (`zu-health-export` v1)

- Writer: header line `{"fmt","v":1,"kdf":"PBKDF2-SHA256","iter":600000,"salt","prefix","chunk":4194304}`. Each chunk is encrypted with AES-GCM: iv = prefix ‖ u32be(seq), aad = SHA-256(raw header bytes) ‖ u32be(seq) ‖ u8(last). Plaintext chunks are exactly `chunk` bytes except the last (1..chunk, or 0 for an empty stream), and `last` is detected at EOF. Inner frames carry ≤ 1 MiB data segments and names ≤ 512 bytes, with nothing after the end frame.
- Entries: `db.sqlite` first (a plain copy made via `ATTACH … KEY ''`), then `manifest.json` `{"fmt":"zu-health-backup","v":1,"at":now}`, then `blobs/<sha256>` unless `--no-blobs`.
- Reader: accepts the legacy fmt `sibian-health-export`, iter ≤ 10M and chunk ≤ 64 MiB. Errors are `format`, `auth`, `truncated` or `container`. Unknown entries and repeated names are refused or ignored (`backup_dup` for a repeat). A blob is restored when something references it, this device lacks it, and its hash verifies. `missing_blobs` lists every referenced blob still absent.
- The plain DB is untrusted. It is written under the profile's `tmp/` and attached read-only with `trusted_schema=OFF`. The schema must contain exactly the expected objects with the same definitions (comments and whitespace ignored), and `quick_check` must pass. Every exit path removes the file.
- Merge is a straight port of `merge.ts`: metrics by code (unit and agg must match, `sameUnit` for `x:ocr/`), sources by identity, imports by uid (done, erased and review). Remote tombstones erase local imports, a local erased import is never revived, larger uid wins for observations, `CORRECTION_WINS` decides corrections, and the affected daily rows are rebuilt.
- Passwords come from a TTY prompt or `--password-stdin`, never from argv. The minimum is 8 characters, as on the web.

## Blob file format

`"HBLOB1"` ‖ 8-byte nonce prefix ‖ chunks using the same AEAD as the pack (`aead.rs`). The file is named by the plaintext sha256, which readers verify. Streaming readers must discard their output on a hash mismatch. An empty file is one empty last chunk.

## Time

The API uses UTC ms, with `tz_min` on each item. The CLI resolves `tz_min` for each local date-time it parses through the system zone, so DST is handled, unless `HEALTH_TZ_MIN` pins it. `now` comes from `HEALTH_NOW` or the clock. Day math uses floor division.

## CLI contract

`--json` prints the response type, or `{"error":{"code","message"}}` on failure. Exit codes: 0 ok, 1 other, 2 usage, 3 invalid, 4 denied, 5 locked, 6 not found, 7 conflict. Global flags are `--data-dir` (`HEALTH_DATA_DIR`) and `--profile` (`HEALTH_PROFILE`, default `default`). `health op <name> '<json>'` reaches any op directly.

## Testing

| Layer | Where |
| --- | --- |
| The 24 spec checks (DB design §8, split into numbered assertions) | `health-core/tests/spec.rs` |
| Web parity (backup made by the web code → same `v_daily` and `v_observation`) | `health-core/tests/parity.rs` |
| Merge order independence, idempotent re-import, no rows left after erase | `health-core/tests/merge.rs` |
| Merge fixes R1–R8, G1–G3 and unit keys, the same cases the web runs | `health-core/tests/merge_fixtures.rs` |
| Sync convergence: three devices, random changes, subset exchange; erase-after-takeover; a review confirmed twice | `health-core/tests/sync.rs` |
| Inventory wire form and parser, synced settings; split imports and resume | `health-core/tests/sync_wire.rs`, `sync_part.rs` |
| Sync sessions: up to date, both ways, join and large-erase questions, resume, negative cache, files, settings, limits; random interleavings and cuts | `health-api/tests/sync_engine.rs`, `sync_random.rs` |
| Pack: round trip, tamper, truncation, legacy name | `pack.rs` tests |
| CLI `--json` and exit codes | `health/tests/cli.rs` |
| Scale: 1M rows, bytes/row, 30-day query, encrypted against plain on the same machine; sync at 1M rows | `health-core/tests/scale.rs` (`--ignored`, release) |

## CI and release (M0)

- `ci.yml` runs fmt, clippy `-D warnings` and the tests on five targets. It also runs `scripts/check-no-net.sh` and `cargo deny` licenses.
- `release.yml` runs on a `v*` tag: it builds binaries, generates SHA-256 sums and attaches both to a GitHub Release.

---

# M2: serve, access control, MCP

Revised after an independent review (2026-11-22).

## Modules

| Module | Interface | Hides |
| --- | --- | --- |
| `core::access` | `AccessDb::open(path, key)`; `create(spec, now) → (Grant, token)`; `list`; `revoke`; `resolve(token, now)`; `record(Audit)`; `audit(grant, limit)` | `access.db` (SQLCipher, key = HKDF(root, "health/access")); only SHA-256 of tokens is stored |
| `core::scope` | `Scope::all()`, `Scope::of(&grant, now)`; `allows(code)` decided from the code string alone, with no DB lookup, so there is no existence oracle | groups → metric ids, window → SQL |
| `core::query` | every read takes `&Scope`; delegates get `detail` whitelisted to comparator / ref / flag | the SQL conditions |
| `core::keys` | `wrap` / `unwrap` (Argon2id + AES-GCM, file `keywrap`) | KDF parameters |
| `health-api::call` | `call(ctx, op, json) → Outcome { value, withheld }` | deny-by-default authorization, audit (fail closed), delegate-safe errors |
| bin `serve` | `health serve [--port N] [--idle-lock MIN]` | `tiny_http` (sync, no tokio), over `health-runtime` (which holds the profile, `None` = locked), SSE |
| bin `client` | `forward(dir, op, json) → Option<Result>` | loopback HTTP over `std::net` |
| bin `mcp` | `handle(msg, run) → Option<reply>` | JSON-RPC 2.0, shared by stdio and `POST /mcp` |

## Authorization: one list, deny by default

`OpDef.delegate: Never | Read | Propose | Derived` replaces `owner_only` and defaults to `Never`. The MCP tools are exactly the ops with `delegate != Never`. The permission-matrix test loops over `ops()`, so a new op fails the test until it is classified.

| Delegate op | Level | Grant check |
| --- | --- | --- |
| `metric.search`, `metric.show` | Read | `x:ocr/` and `x:derived/` metrics are hidden unless their group is granted. Point counts stay inside the scope |
| `daily.query` | Read | metric in groups; days in window |
| `obs.query`, `obs.latest` | Read | as above, plus `detail = true` |
| `report.search`, `report.show` | Read | `reports = true` (default off); report time (import uid) in window. Group scope doesn't apply, which `grant create` states |
| `source.list` | Read | `id`, `connector` and `priority` of sources with daily data in the granted groups; name and device id blank |
| `whoami` | Read | the grant, its scope and expiry |
| `review.propose` | Propose | rows in groups; ≤ 10,000 rows per call; ≤ 20 pending proposals per grant |
| `derived.write` | Derived | see below |

`profile.get` is `Read`, gated by the grant's `profile` choice. Everything else is `Never`. That includes the batch list and detail, the review queue, manual entry, correct, source.update, daily.rebuild, grants, audit, backup and erase.

- A delegate whose scope hides a metric gets `denied / out_of_scope`, whether or not the metric exists.
- Every delegate call writes an audit row: op, metric codes, window, row count and denied flag, never values. Denials are audited too. Writes are audited before they run, reads after. If the audit write fails, the call fails and nothing commits.
- Delegate errors of kind `other` carry a generic message.

## Derived results and proposals

- `derived.write {algo, version, metric: {name, unit, agg}, inputs: [{metric, from_ms, to_ms}], rows, replace = true}`:
  - creates the metric `x:derived/<algo>/<name>` if it's missing, in group `derived` (sensitive; read access needs `derived` in the grant);
  - uses source `(derived, <algo>/<writer>)` (writer = `g` + 16 hex of the grant's token hash, decision 44) at priority 1000, so it never wins an election over measured data; the version is the parser, so a new version replaces the old run;
  - takes inputs inside the scope and resolves them server-side to import uids, stored in `meta.inputs`;
  - `replace` erases only earlier imports of this grant's own source that wrote the same metric, so the algorithm's other outputs stay.
- `review.propose {rows, note}` creates a review import with source `(agent, <writer>)` and candidates `{kind: "proposal", rows, note, by: <writer>}`. The rows stay invisible until the owner runs `review.confirm` (rows default to the proposal's own).

## Keys and passphrase mode

- `health passphrase set` wraps the current root key into `keywrap` and deletes the keychain entry. `health passphrase remove` reverses it.
- In passphrase mode, every key-needing command without serve asks for the passphrase. It reads from the TTY, or from stdin with `--passphrase-stdin`.
- Owner proof through serve:
  - In keychain mode, the owner token lives in `serve.json` (0600), as in plan §4.2.
  - In passphrase mode, `serve.json` holds only `{port, pid}`, and the owner token goes to stdout only (for the GUI). A forwarded CLI call proves the passphrase instead: it sends `SHA-256(KEK)` (KEK = Argon2id(passphrase, salt)), which serve compares with the value kept from unlock.
  - `POST /v1/unlock {passphrase}` needs no token. Attempts run one at a time with a 1 s backoff after each failure.
- Idle lock: only owner requests reset the timer. On lock, serve drops `health.db`, `access.db` and the key.

## serve

- Checks run in this order: `Origin` (any Origin is refused in M2, since the GUI comes in M4), then `Host` (`127.0.0.1:<port>` or `localhost:<port>`), then `Authorization: Bearer` (compared in constant time). No CORS headers are sent.
- Routes:
  - `POST /v1/op/<name>` returns `{value, withheld}`, where `withheld` is null for the owner. The owner adds `X-Health-Dry-Run: 1` for a dry run.
  - `GET /v1/events` (owner only, SSE). It is written straight to the socket and flushed per event, because tiny_http's `Response` buffers streamed bodies.
  - `GET /v1/meta`.
  - `POST /v1/unlock` and `POST /v1/lock`.
  - `POST /mcp` (Streamable HTTP, JSON responses).
  - `GET /mcp` returns 405.
- Status codes: 400 usage, 422 invalid, 403 denied, 423 locked, 404 not found, 409 conflict, 500 other.
- `serve.json` `{port, pid, id[, token]}` is written at start. The CLI forwards only when the pid is alive and `GET /v1/meta` answers with the same `id`, so no credential goes to a process that took over the port. A stale file is removed. File paths in requests (typed commands and `health op`) are made absolute before forwarding.
- `passphrase set` / `remove` are refused while serve runs: serve fixes its mode at start.

## MCP

- `health mcp` requires `HEALTH_TOKEN` or `HEALTH_TOKEN_FILE` (0600) and always runs as that grant. It never reads the owner token. It forwards to serve when one is running; otherwise it opens the profile itself (keychain mode only, and returns `locked` in passphrase mode). The token is resolved on every call.
- Protocol:
  - JSON-RPC 2.0 with `initialize` (echoes a supported client version, else answers `2025-06-18`), `ping`, `tools/list` and `tools/call`.
  - Unknown methods get `-32601` immediately, even before `initialize`. Notifications get no reply on stdio and `202` on HTTP.
  - Tool errors come back as `isError: true`; an unknown tool gets `-32602`.
  - Tool results are text content holding `{"items": …, "withheld": …}`.
  - Input schemas are inlined, with no `$ref` or `$schema`, and the root is always `type: object`. stdout carries JSON-RPC only.

## Tests

- Permission matrix: `ops()` × {owner, daily-only, detail, propose, derived, revoked, expired}, run through `call()`. Each denial must return `denied` and leave the DB unchanged, with the audit row written.
- serve over real HTTP: Origin, Host, token, a delegate calling a `Never` op, SSE, forwarding, and lock/unlock.
- MCP over stdio: initialize, tools/list schema shape, a tool call, and a notification getting no reply.
- Acceptance: an MCP session with a cardio-only, 90-day, derived-write grant reads the resting-HR trend, writes `x:derived/rhr-trend/slope`, and the owner sees both calls in `audit.list`.

---

# M3: importers and CSV export

| Module | Interface | Hides |
| --- | --- | --- |
| `core::apple` | `AppleParser::new()`, `.line(&str)`, `.finish() → (rows by source, stats)` | Record/sleep mapping, unit spellings, 15-min UTC slots for cumulative types (port of the web `import/apple.ts`) |
| `core::import` | `apple(c, zip: impl Read + Seek, now)`, `whoop(c, bundle, now)`, `rows(c, source, rows, now)` | zip central directory (main XML = largest `*/<name>.xml` that isn't `_cda`), one import per source, the whole file in one transaction (a failure leaves nothing) |
| `core::whoop` | `decode(&WhoopData, now) → Vec<ObsRow>` | the field map and anchoring rules of the web `whoop/decode.ts` |
| `core::csv` | `groups(c, from) → counts`, `build(c, opts) → String` | grading (`catalog::group_of`), the 12 columns, formula defusing, minutes for durations, never identifiers or `detail` beyond comparator, ref and flag |

Ops (all owner-only, `delegate: Never`):

| Op | CLI |
| --- | --- |
| `import.apple {path}` | `import apple <zip>` |
| `import.whoop {path}`: a saved bundle `{user_id, cycles, sleeps, recoveries, workouts, body, tz}` | `import whoop <json>` |
| `import.rows {path, source}`: JSON lines of `ObsRow` | `import rows <jsonl> --source <name>` |
| `export.groups {from_ms}` | `export groups` |
| `export.csv {path, from_ms, groups, date_only}` | `export csv <path> [--from] [--groups] [--date-only]` |

- The Apple raw file is not stored as a blob, as on the web: exports run to GBs, and re-importing the same export overwrites by key.
- Live WHOOP sync needs OAuth through the backend relay (protocol §6), i.e. the network. It moves to `health-connect` with M6 (decision 28). M3 imports the API's JSON shape and ports the decoder.
- CSV labels are English (the CLI has no UI language). Grading follows the backend repo's `docs/外部分析導出方案.md`: sensitive groups only when named, never identifiers, never printed text.
- Parity: `scripts/web-fixture-m3.ts` runs the web parser and decoder on synthetic inputs and commits the expected rows. `tests/import.rs` checks that Rust gives the same rows, and covers the §5.4 overlapping-export rule.

## M5: lab-report OCR

- **Crates.** `health-ocr` is a rule-for-rule port of the web `ocr/` modules: `det`/`rec`/`engine` (PP-OCRv5 through tract), `rows` (table reading), `date`, `lexicon`, `embed` (multilingual-e5 through tract + tokenizers), `matcher`, `input` (images via `image` with EXIF orientation, PDFs via hayro; 40 MB, 12 pages, 3200 px). `health-core::ocr` holds what touches the database: `ingest` (a review batch: no rows, the items in `meta.candidates`), `confirm` (the web review form's rules), `code_for` (common names → codes), new `x:ocr/` measures, and aliases learnt on confirm.
- **Process.** `health ocr <file>` (and serve, for `import.ocr` without a result) start `health ocr-worker`: one JSON request on stdin, one reply on stdout; no key, no database. serve checks `import.seen` first, drops the profile lock while the worker runs, then records the batch with `import.ocr`. A crash in the worker returns `ocr_crashed`; the writer is untouched.
- **Component.** `<data dir>/components/ocr/`: three required files (21 MB) and two for matching (135 MB), each pinned by size and SHA-256 (`health-ocr/src/components.rs`), checked again on every load. `health component install ocr [--from DIR] [--no-matching]`; downloads go through `health-connect`.
- **Parity.** Tests compare with the web version's own output on the owner's synthetic report pages (`tests/fixtures/*.web.json`, `web-ocr.json`, `web-match.json`; regenerate with `scripts/gen-ocr-data.ts`): same lines, boxes and scores; same tables and dates; same first candidate and preselection (decision 52).

## M6: health account, linking, inbox (design)

Specs: `B/docs/協議.md` §0.1–0.2, §1, §2, §3.1–3.3, §3.5 and §6. Web sources:
- `app-kit/src/health-{account,backend}.ts`;
- `W/src/client/{link-flow,account-keys,link.tsx,deps}.ts`, `lib/account.ts`, `lib/sig.ts`;
- `lib/health/{inbox,config}.ts`, `lib/health/proto/*`, `lib/health/db/ingest.ts`, `review-form.ts`.

An independent review (2026-11-22) shaped this revision.

- **`health-proto` (done).** Pure: random bytes and the time are arguments.
  - Contents: `b64`, `account` (AMK → id, Ed25519 key, inbox X25519 pair, JWS `sign`, payload in the web's key order), `sig` (JCS with ES number formatting and UTF-16 key order, did:key, Ed25519 with libsodium's rejection list then `verify_strict`), `hpke`, `codes` (SBH1, ZUHL1, check code), `result` (§2.3 steps 1–3 → `Ok | Drop(code) | Later`).
  - Tests: the protocol vectors, the 176 Ed25519 edge cases, and `web-account.json` (`scripts/gen-account-fixture.ts`: what W derives, signs and seals from one fixed AMK).
- **`vault` (profile file, `health-core::vault`).**
  - AES-256-GCM under `HKDF(root, "health/vault")`, rewritten via `tmp/` + rename.
  - Holds `{amk, registered_pk, cursors: {pk: seq}, drops: {pk: n}}`, keyed per pk as the web does, so re-linking the same account keeps its cursor. WHOOP credentials join it in the WHOOP step.
  - Not in `health.db` (frozen schema) and not in backups: identity moves only by linking.
- **No account, no request** (§1, web `nokey`): `account.show` and `inbox.poll` never make an AMK and never call the backend while `registered_pk` is null. An account is made only by `account.register` (showing the identity code), `self.code` or `link.give`. Tests use a mock that fails on any request.
- **Network outside the lock.**
  - Ops that use the backend have `net: true` and receive `&dyn Backend` and `&dyn Locked`. `Locked::with(f)` runs `f` with a `Ctx` under the profile lock: serve takes and releases its mutex per step, and the CLI runs `f` directly.
  - The op reads and writes the vault and DB in short locked steps and makes every HTTP call between them, as `import.ocr` does in M5.
  - An inbox page is fetched unlocked, then each item is decrypted, checked and ingested under the lock in its own transaction, and the cursor advances after COMMIT. A replay is caught by `import.uid`.
  - These ops are `write: true` (writer lock; dry run refused).
- **`health-connect` HTTP.**
  - JSON GET/POST to one allowed base, with no redirects, connect 15 s, request 60 s, and a body limit of 32 MiB (an inbox page is up to 16 MB of ciphertext, about 22 MB as JSON).
  - Errors are reduced to codes (`network`, `server`, or the backend's `{err}`). ureq's messages carry URLs with the channel or pk, so they're never shown or logged.
- **`--offline`** (decision 36): a global flag and `HEALTH_OFFLINE=1`; the `Backend` adapter then refuses every call with `offline`.
- **Config** (`health-api::account`):
  - The base is `https://api-dev-health.4seas.xyz` (the owner's rule: dev only), `aud` = host with port, the lab key `did:key:z6MkmpEv…` (`lab`), and the dev backend's attestation key.
  - Debug builds also take `HEALTH_BACKEND`, `HEALTH_LAB_KEYS` and `HEALTH_ATT_KEY`, so tests run against a loopback mock relay that can issue verifiable results.
- **Link session.**
  - It lives in serve's `State` (or the CLI process) and is handed to link ops. It holds the one-time X25519 secret, the channel and, once received, the AMK with its check code.
  - Never on disk, never in an op result (§3.5 rule 4). It is zeroized on `link.cancel`, adopt, expiry (10 min) and the passphrase lock.
  - After `received`, `link.poll` returns the kept state and never GETs again (the relay deletes on read).
- **Ops** (owner only; not in `OpDef.delegate`, so no MCP tool; a matrix test checks both):

  | op | does |
  |---|---|
  | `account.show` | `{account: null \| {id, registered, drops}}`: no AMK, no request |
  | `account.register` | makes the AMK if none, `POST /h/1/key` when `registered_pk` isn't this pk, returns the SBH1 text (§1: shown only once registered) |
  | `account.qr {text}` | an SVG of an SBH1/ZUHL1 text (on demand, not polled) |
  | `link.join` | new session; returns `{code, channel, expires_ms}` |
  | `link.poll` | one `GET /h/1/link/<ch>` → `waiting \| received {check, replaces} \| expired \| failed {code}` |
  | `link.adopt {channel, check}` | must match the session. If another account is here: poll its inbox once (failure ignored, as the web does). Write the AMK, clear `registered_pk` (re-registered lazily by `account.register`). |
  | `link.cancel` | forgets the session |
  | `link.give {code, confirmed: true}` | §3.5 rule 2: the caller has asked "this hands your health account to the device showing this code; continue only if it's yours". Makes an account if none, seals `{v:1, amk}`, posts; `busy` → "start again"; returns the check code |
  | `inbox.poll` | §3.2: cursor `after`; 8 MiB cap before HPKE; `check`; ingest; `bad_result` and failed opens are dropped and counted; any other ingest error stops without advancing; `unknown` re-registers once and resets the cursor; `later` stops (dropped after 24 h) |
  | `self.code {device}` | §3.3 `POST /h/1/self` → `{code, until}` |
  | `review.confirm_result {id, choices}` | the review form for `kind: "result"`: the app preselects measure and unit per line (`metric.show`, as `initLines`), the core applies the web's `lineReady`/`duplicateLines` rules |

- **Ingest (`health-core::result`, done).** A port of `ingest.ts`:
  - `seen` when the id is known;
  - an unknown code or unit, or a refused line, sends the whole result to review;
  - otherwise one import with `uid = id`, source `(lab|staff|room, device)`, parser `result@1`;
  - a bad id, src, at or tz gives `bad_result`.
  - As the web does, no plaintext blob is kept (§2.3 says to keep one; decision row). `meta.by` comes from `att.staff`.
- **CLI.** `health account [register]`, `health link join` (prints the code as a terminal QR, polls every 2 s, shows the check code and asks y/N), `health inbox`, `health self <device>`, `health link give <code>` (asks the rule-2 question).
- **GUI.**
  - An Account page: the identity code and QR, "Link this computer" (ZUHL1 QR, then the check code with Confirm/Cancel), and the drop count.
  - The inbox is polled when the app opens, every 5 min while it's open, and every 30 s for an hour after the identity code or a self-service code was shown. Nothing polls once an account exists but the app is closed.
- **WHOOP (§6, decision 67).** `health_api::whoop`, a port of W `whoop/sync.ts`.
  - Ops: `whoop.status` (vault only), `whoop.begin {client_id, client_secret, open?}`, `whoop.complete {query}`, `whoop.sync {force?}` and `whoop.disconnect`.
  - The client ID, secret and tokens live in the vault. A refresh token is saved before it is used.
  - The first sync fetches 30 days, later ones 7 (at most 90 after a gap), and a sync is skipped if the last was under an hour ago.
  - The sign-in returns to `http://localhost:47630/whoop`, caught by `health whoop connect` or, for the app, by serve (`open: true`), which then finishes and syncs and emits `whoop`.
- **Status.** Everything above is built and tested against stand-in backends.
- **Acceptance by hand** (the owner, dev backend):
  1. On the web app, open the identity code once.
  2. On the desktop, Account › Link this computer; scan the code with the web app's "link a new device"; compare the check codes; confirm.
  3. Both show the same SBH1 text.
  4. A result issued on dev to that account (the lab gateway holding `z6MkmpEv…`, or a desk entry with an attestation) appears on the desktop after "Check for results".
