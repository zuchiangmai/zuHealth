# Merge fixes for LAN sync (R1–R8)

Status: **agreed v3, round 2 (§8b) agreed v5, v6 additions agreed** (2026-11-23). Implemented on the desktop;
the web implements each round after the owner's go. between the desktop (this repo) and the web (`W`, pre-pol session), after two
review rounds (§10). Not implemented; the web side waits for the owner's go. Context:
`docs/lan-sync.md` §6–§7. With sync, the backup merge runs continually between every pair of devices, so cases a
rare manual restore could ignore become permanent divergence. R1–R6 change shared behaviour and land in **both**
`crates/health-core/src/merge.rs` and W `src/client/lib/health/db/merge.ts` (W `a40f5bfa`), with shared fixtures
(§9). R7 and R8 are web-only fixes that bring the web in line with the desktop. G1–G4 (§8) are further rules both
sides adopt.

The target property: after any sequence of local operations on any number of devices, merging in any order and any
number of times leaves every device with identical contents in:

- `observation`, `genotype`, `report_text`, `correction`;
- `import` (uid, status, blob);
- `source` (name, priority, `meta.set_at`/`set_by`);
- `metric_alias` (G3).

`daily` must match what a rebuild computes.

Excluded from the target property:

- `import.meta` other than spans: `by`, `rejected`, `inputs` and candidates differ by device and don't affect data.
- `metric.name` and `metric.unit` spelling (G4).
- Corrections and imports refused by the clock-skew guards, until every device's clock has passed them (G1).

## R1 Equal-uid rows are decided by value

**Today.** The observation upsert (Rust `merge.rs` step 4; W `merge.ts:227`) applies an incoming row when
`uid(incoming import) >= uid(current import)`. With the same uid on both sides (one review confirmed differently
on two devices; the same signed result confirmed on two devices) each side takes the other's row: they swap.

**Change (merge only; `write.rs`/`write.ts` keep `>=`, where a later row of the same local import must still win):**

```sql
WHERE u_new > u_old
   OR (u_new = u_old AND (
        typeof(e.value) > typeof(o.value)
     OR (typeof(e.value) = typeof(o.value) AND (
          GT(e.value, o.value)
       OR (e.value IS o.value AND (
            GT(e.end_ms, o.end_ms)
         OR (e.end_ms IS o.end_ms AND (
              GT(e.tz_min, o.tz_min)
           OR (e.tz_min IS o.tz_min AND GT(e.detail, o.detail))))))))))
-- GT(a, b) := ((b IS NULL AND a IS NOT NULL) OR a > b)
-- e = excluded, o = observation; u_new / u_old as today (SELECT uid FROM import WHERE id = …)
```

- A plain row-value comparison `(a, b) > (c, d)` yields NULL when a deciding component is NULL. NULL `end_ms`,
  NULL `detail` and NULL `value` are common, so it is spelled out.
- `typeof` first: SQLite compares 5 and 5.0 as equal, and the sync fingerprint encodes them differently. `typeof`
  returns the type name, so the order is the names' byte order: `blob` < `integer` < `null` < `real` < `text`.
- Both sides store integral numbers as INTEGER (Rust `Value::number`, the web's binding of integral JS numbers), so
  the same signed result ingested on two devices has the same types.
- `detail` is JSON text, and serde and JS serialise the same object differently (key order). Equal-uid rows from
  different implementations therefore often differ only in `detail`; the byte-larger string wins. That is expected
  on a first merge between implementations, not an edge case.
- Two confirmations of the same review that differ in which measures were kept end as the **union** of both row
  sets: different measures are different keys, and spans unite. Only rows at the same key are decided by this rule.
- Equal rows (all components `IS`) don't update: idempotent.
- **Genotypes**: today `INSERT OR IGNORE`. The primary key includes `import_id`, so a conflict means the same
  import. Change to `ON CONFLICT (import_id, chrom, pos) DO UPDATE SET genotype = excluded.genotype,
  rsid = excluded.rsid WHERE GT(excluded.genotype, genotype) OR (excluded.genotype IS genotype AND
  GT(excluded.rsid, rsid))`.
- **Same import, `report_text`**: today copied only for new imports. For `done`/`done` with the same uid, insert it
  when missing locally. When both have one, the larger text wins (`>` on TEXT, byte order). It is an FTS5 table, so
  a win is DELETE then INSERT of that rowid, not UPDATE.
- **Same import, `meta`**: spans unite, as today. Other keys stay local and are outside the target property.

## R2 A confirmed review reaches devices still holding it as review

**Today.** Local `review` meeting remote `done` is left alone (Rust `Some(_) => {}`; W `merge.ts:213`, "对方没擦除的
review：不碰"). The confirmation never reaches the other device (a known gap).

**Change.** Local `review` and remote `done` with the same uid: the local import becomes the remote one.

1. `UPDATE import SET status = 'done', parser = remote.parser, meta = <remote meta, spans translated>,
   id = (SELECT max(id) + 1 FROM import) WHERE id = local.id`. The import is renumbered as `review::confirm`
   (Rust `review.rs:81`, W `review.ts:44`) does, so an id cursor sees it as new.
2. Blob: the remote one, under the R6 rule. The duplicate-blob check excludes this import itself, or it would drop
   its own file.
3. Map `remote id → local id` in `merge_import`, so the rows, genotypes and report text arrive as for a new import.
   Add the spans to the rebuilt scopes.

Other combinations, all explicit:

| local | remote | result |
|---|---|---|
| absent | review | copied as a new review import (today's behaviour on both sides) |
| review | review | unchanged. The same uid comes from the same signed result or an earlier merge. Candidates serialise differently in Rust and JS, so `meta` isn't compared. |
| erased | done | stays erased (a tombstone always wins) |
| review | done, remote blob NULL | the local blob stays (a remote NULL never clears a local file); R6 decides only between two non-NULL holders |

## R3 Source name and priority converge

**Today.** A source known on both sides keeps its local name and priority (Rust `merge.rs` step 2; W
`merge.ts:108-120`). An edit never propagates, so `v_daily`, which elects by priority at read time, differs
between devices.

**Change.**

- Every edit of a source's name or priority also writes `meta.set_at` and `meta.set_by`, in the same UPDATE, so it
  is atomic and travels in backups. Only the desktop edits sources (Rust `source_update`, `query.rs:338`); the web
  has no source edit anywhere, so on the web this is merge-only.
  - `set_at` is an HLC, as for corrections (`(ms << 16) | counter`, from `next_at`). It exceeds 2^53, so it is
    stored as a **decimal string** (as correction `at` is in JSON) and compared as an integer, never as a JSON
    number.
  - `set_by` is the device id, a string; `""` until sync exists.
- Merge, for a source on both sides: the remote name and priority win when `(r.set_at, r.set_by, r.priority,
  r.name) > (l.set_at, l.set_by, l.priority, l.name)`. An absent `set_at` counts as 0 and an absent `set_by` as
  `""`. On a win, copy `name`, `priority`, `set_at` and `set_by`; other `meta` keys stay local.
- A future `set_at` (beyond `MAX_SKEW_MS`) is ignored, as for corrections, also for a source **new** to this side:
  it is inserted without `set_at`/`set_by`, so this device's HLC can't be pushed ahead (fixture 12, added after S1
  review).
- The HLC reads `set_at` only from valid JSON (`json_valid`) and ignores values beyond `now + MAX_SKEW_MS`. A
  source's `meta` comes from backups, and an unparsable one must not make every correction and source edit fail.
- **Upgrade.** Once, when the version with R3 first opens a profile, every source whose priority differs from its
  connector's default gets `set_at` = now. Both sides use the same default table: `manual` 0, `derived` 1000, others
  100. The web needs the `derived` entry too, although it never creates such a source. A priority chosen before
  sync existed then isn't reverted by another device's unstamped default. Names aren't stamped: neither app renames
  sources (confirmed for the web).
- **Unstamped on both sides**, the `(priority, name)` tail decides. Default names differ between the implementations
  for the same `(connector, external_id)` (the web names lab sources by device id, OCR "OCR", WHOOP "WHOOP"), so a
  name may change on the first sync to the byte-larger one. Accepted.

## R4 Metric conflicts are reported, identically

**Today and unchanged.** A metric whose `unit` or `agg` differs is skipped (Rust `skipped_metrics`, W
`skippedMetrics`). Its import is still inserted as `done`, without those rows.

**Required.** Both implementations apply the same rule. Skip a metric when `agg` differs, or when `unit` differs,
unless the code starts with `x:ocr/` and `same_unit(local, remote)`. Confirmed identical on both sides today.

- Both report the codes **sorted** (byte order). The web reports them in remote id order today.
- `same_unit` is `unit_key` equality, and `unit_key` must be byte-identical in Rust and W `ocr/unit.ts`: NFKC,
  lowercase, whitespace stripped, µ/μ→u, ^→*, `[]{}_` dropped, a leading x/×/* dropped, OCR "lu/"→"iu/", then the
  alias table. A shared fixture of unit pairs (same / not same) pins it (§9).

## R5 Merged corrections rebuild daily

**Today.** Step 7 rebuilds only the scopes of touched imports. A correction merged for a point whose import isn't
touched leaves `daily` stale (Known gaps).

**Change.** After the correction upsert, rebuild a scope for every incoming correction that applied:

```sql
SELECT l.metric_id, l.source_id, l.start_ms
  FROM plain.correction c
  JOIN merge_metric mm ON mm.p = c.metric_id
  JOIN merge_source ms ON ms.p = c.source_id
  JOIN correction l ON l.metric_id = mm.l AND l.source_id = ms.l AND l.start_ms = c.start_ms
 WHERE l.at = c.at AND l.value IS c.value
```

Each row becomes a scope `{metric_id, source_id, from: start_ms, to: start_ms}` added to step 7. A correction that
was already there identically also matches. That rebuilds once more than needed, but the result is the same.

## R6 One owner per file

**Today.** The unique index `import_blob` allows one import per file. A new import whose blob another local import
holds gets `blob = NULL` (Rust `merge.rs` step 3, `dropped_blobs`; W `merge.ts:169`). Which import holds the file
then depends on arrival order. Erasing the holder deletes the file on one device but not on another.

**Change.**

- **The owner is the non-erased import with the smallest uid** among those that brought the file.
- **New import** whose blob another local import L holds:
  - new uid < L.uid: `UPDATE import SET blob = NULL WHERE id = L.id`, then insert the new import with the blob.
    That order satisfies the unique index.
  - Otherwise: NULL, as today.
- **`done`/`done`**: local NULL, remote non-NULL. The local import takes the blob under the same rule. If another
  local import holds it with a smaller uid, it stays NULL.
- **R2**: the duplicate check excludes the import itself.
- `needed_blobs` lists the blob in each case where an import here now references it.

Erasing the owner keeps today's behaviour: the file goes when no other import references it. Every device agrees
on the owner, so they agree on whether the file is gone. When a device that saw only the non-owner merges, the
`done`/`done` rule re-attaches the file and lists it in `needed_blobs`, so it converges (walked through by the web
side).

A review import whose blob is NULL because another import owns the file must still show its photo. The review
screen reads the file by the sha in the import's candidates and blob history, not only through `import.blob`:
**desktop and web both check this** before R6 lands.

## R7 (web only) Emptied manual imports are erased

The desktop erases a manual import once an edit or a new entry at the same time leaves it with no rows (decisions
16 and 42). The web keeps it `done` and empty. With sync, an edit followed by a remove on the web brings the
removed value back from any device that still holds the original import, because the empty import's rows are
"missing" and get healed.

Change: the web runs an erase-if-empty check after every manual write for each import that lost a row there. That
covers both cases, the edit (decision 16) and a new entry at a time that already has one (decision 42); on the web
both go through `enterManual`'s upsert.

**One row per manual import, on both sides.** R7 is enough only because every manual import holds a single row. A
multi-row manual import with one row superseded and then removed keeps its claim on that key and resurrects it on
merge.

- The web UI saves one entry per import. The desktop UI and CLI do too. The desktop's `manual.enter` op still
  accepts several entries in one call (owner only, through `health op` or the local API). It changes to write
  **one import per entry**; the op's interface is unchanged.
- Multi-row manual imports already in someone's data, or in old backups, keep the residual risk. That is accepted:
  neither UI ever made them.

## R8 (web only) Local spans aren't translated

In `done`/`done`, W `merge.ts:206` runs the **local** span through the remote→local metric map (`translate
(local.meta).span`). Where metric ids differ between devices that corrupts the local span (decision 41). Spans then
miss rows in erase and in sync's split exports. Change: use the local span as is (Rust `merge.rs`).

## 8. Further rules (G1–G4)

- **G1 Correction clock guard on both sides.** The desktop's merge refuses corrections with `at` beyond `now +
  MAX_SKEW_MS` (1 day). The web applies them, which is permanent divergence. Change: the web adds the same guard,
  with the same constant, to its correction upsert. The result then depends on time: convergence holds once every
  device's clock has passed the `at`. Sync's negative cache therefore expires entries refused for skew after 1 hour,
  so they are retried (`docs/lan-sync.md` §6.4).
- **G2 The HLC observes merged corrections.** The desktop's `next_at` takes `max(at)` over the whole correction table,
  merged rows included, so a local edit after a merge always gets a larger `at`. The web creates no corrections
  today. If it ever does, it uses the same rule.
- **G3 `metric_alias` converges.** Local writes replace (`INSERT OR REPLACE`, W `review.ts:14`); merge ignores
  (`INSERT OR IGNORE`, W `merge.ts:104`, Rust step 1). So two devices mapping the same `(alias, unit)` to different
  measures never converge, and their future automatic mappings differ. Change, in both merges:
  `ON CONFLICT (alias, unit) DO UPDATE SET metric_id = excluded.metric_id WHERE (SELECT code FROM metric WHERE id =
  excluded.metric_id) < (SELECT code FROM metric WHERE id = metric_alias.metric_id)`. The smaller metric code wins.
  A person's later local choice can be overridden by another device's mapping. Accepted, since only suggestions
  change. Sync carries the alias table (`docs/lan-sync.md` §6.1).
- **G4 Metric spelling is outside the target property.** For `x:ocr/` metrics matched through `same_unit`, each device
  keeps its own `metric.unit` and `name` strings. Values are canonical per unit, so data is unaffected. Fingerprints
  use the metric code only.

### Web parity fixes found during implementation (P1–P4, no rule change)

The web side found these while reading `merge.rs` and adopts them as they are (2026-11-23):

- **P1 `plausible_uid`.** A remote import whose uid isn't known locally is refused (counted in `refused_imports`)
  unless it is one of two kinds:
  - a UUIDv7 of exactly 36 lower-case characters whose time is at most `now + MAX_SKEW_MS`;
  - any other uid on a `lab`, `staff` or `room` source.

  The check runs after the source mapping and before the status cases.

  `uuid_time` is Rust's `uuid::Uuid::parse_str` followed by version nibble = 7, giving the top 48 bits as ms.
  `parse_str` also accepts the simple (32 hex), braced and `urn:uuid:` forms, in any case. For `uuid_time` alone
  (a batch's time) the web should accept those too. In `plausible_uid` the length-36 lowercase check rules them out.
  The variant bits aren't checked.
- **P2** The orphans that `erase` finds in step 3 are re-checked with `referenced()` after step 7 and deduplicated, so
  a file referenced again in the same merge is kept.
- **P3** `needed_blobs` is sorted and deduplicated. Waveform pointers count only when the value passes `is_sha`: 64
  characters, `0-9a-f`, lower case only.
- **P4** The report carries `refused_imports` and `refused_corrections`.

R5's scope query joins through the local row with `l.at = c.at`, so corrections refused by G1 (`c.at > (now +
MAX_SKEW_MS) << 16`) never match. No extra condition is needed.

## 8b. Round 2: fixes from the S1 review (v5, agreed with the web side)

An independent review of the desktop's S1 ran the three-device property test with more seeds and wrote probe tests.
Each item below failed on the desktop as of 7486d39, and by reading the web code probably fails there too.

- **R6b A pending review keeps its file.**
  1. Every import that brings a file records it in `meta.file` (the sha). It is set when the import is created and
     kept when R6 moves `blob` to another import.
  2. When the holder of a file is erased, the file passes to the non-erased import with the smallest uid whose
     `meta.file` names it, instead of being deleted.
  3. `review`/`review`: a local NULL blob and a remote non-NULL one takes the file under R6, as `done`/`done` does.
  4. Sync wants a `review` whose `blob` differs (the sync layer).
  5. **How `meta.file` merges.** A new import copies the remote meta, as today. In `done`/`done` and
     `review`/`review`, `meta.file` is set from the remote when the local import has none. R2 takes the remote meta,
     then keeps the local `meta.file` if the remote has none. `meta.file` is part of the target property.
     - **(v6)** Wherever the merge handles a remote import whose `blob` is a sha (new import, R2, `done`/`done`,
       `review`/`review`), the local `meta.file` is set to that blob when it has none, also when R6 leaves the local
       `blob` NULL. Packs from backups made before R6b, and from peers not yet upgraded, carry files without
       `meta.file`. Without this rule a pending review's photo can still be deleted (fixture 21).
     - **(v6)** A remote `meta.file` that isn't a sha is dropped from any meta copied from the remote, on every path.
       Otherwise a pack could name any file and keep it alive.
     - **(v6) Precedence**, for the file a remote import names:
       1. its `meta.file` when that is a sha;
       2. otherwise its `blob` when that is a sha;
       3. otherwise nothing.

       A local `meta.file` is never overwritten.
     - `meta.file` isn't in the inventory, which is accepted. Two devices with equal digests can differ in
       `meta.file` only when one of them lost it before upgrade 2. They then pick different heirs on erase, and
       the blob difference heals it afterwards.
  6. **The heir** is chosen among imports with status `done` or `review` (not `running` or `failed`, as R6c). Only
     a `meta` that passes `json_valid` is read, and uids are compared in byte order (SQLite BINARY).
  7. **Existing data, once.** Every import with a non-NULL `blob` and no `meta.file` gets `meta.file = blob`. An
     import whose blob R6 had already dropped has lost that information, which is accepted.
     - The web runs this in its `user_version` 1→2 upgrade.
     - The desktop can't use `user_version` (it holds the schema version), so it keeps a one-time flag in the
       profile's vault, as for R3's upgrade stamp.

  Without this, the review's blob never converges: seed 263 of the property test, where every `wants` is empty and
  the digests still differ. A pending review's photo also gets deleted when the owner is erased.
- **R6c A running import keeps its file.** `take_blob` never takes a file from a `running` import. Its file
  reference must not change while it is being written. The owner rule applies again once it is `done`.
- **R7b A merge that empties a manual import erases it.** After the observation upsert, every local `manual` import
  that held rows before the merge and holds none after is erased, as R7 does for local writes.

  The case: a value is superseded on another device, then removed. A third device that still holds the old import
  would bring the old value back. With R7b the tombstone travels instead. Fixture 13.
- **R9 A row belongs to its import's source.** Step 4 (observations) takes a row only when its source maps to the
  same local source as its import: `AND ms.l = (SELECT source_id FROM import WHERE id = mi.l)` in the upsert's
  SELECT. Step 6 isn't affected: genotypes and report text carry no source. (v4 said "steps 4 and 6"; step 4 only.)

  Without it, a pack can put rows of any source under an import on a `lab` source with a non-UUID uid. `plausible_uid`
  trusts the uid there, and the uid (`zzzz`) then sorts above every UUIDv7 and owns those rows for good.
- **R10 Spans cover the rows merged.** After step 4, each merged import's local span widens to the min and max
  `start_ms` per metric of the **incoming** rows, including rows that lost the upsert:
  `SELECT mi.l, mm.l, min(o.start_ms), max(o.start_ms) FROM plain.observation o JOIN merge_metric mm ON mm.p =
  o.metric_id JOIN merge_import mi ON mi.p = o.import_id GROUP BY 1, 2`. The span may then be a superset, which is
  harmless, and no local table is scanned by `import_id` (no index there).

  The merged rows' days are rebuilt over the widened range: each `(import, metric)` range from that query joins the
  step-7 scopes under the import's local source. Fixture 16 found the web missing this.

  **Existing data, once:** every import's span is recomputed as the union of the stored span with `SELECT import_id,
  metric_id, min(start_ms), max(start_ms) FROM observation GROUP BY 1, 2`. Web data written under the R8 bug already
  holds rows outside their span, and erase fails on them today. This runs in the same one-time upgrade as R6b on
  both sides; the desktop runs it too, since it costs one pass. A row outside its import's span can't be exported by span,
  can't be erased by span, and makes erase fail on its foreign key.

  Rows can arrive like that from an attacker, and also from existing web data written under the R8 bug.
- **R11 Text must be valid UTF-8.** A pack whose text values aren't valid UTF-8 is refused whole (`backup_db`).
  Rust can't read such text back: it breaks the inventory and any read of that row. JS would decode it to U+FFFD and
  so store different data.

  Columns checked: every value whose `typeof` is `text` in every column of `metric`, `metric_alias`, `source`
  (`meta` included), `import` (`uid`, `parser`, `blob`, `meta`), `observation` (`value` when text, `detail`),
  `correction` (`value` when text), `genotype` and `report_text`. The check runs before the merge transaction.
- **R12 Equal `at` corrections are decided by type too, and zero has one encoding.**
  - `CORRECTION_WINS` gains a last tie-break: `OR (excluded.at = correction.at AND excluded.value IS
    correction.value AND typeof(excluded.value) > typeof(correction.value))`. Local writes share the constant on
    both sides, so they get it too.
  - The inventory and fingerprints write a REAL zero (`-0.0` or `0.0`) as `0.0`'s bits, since SQLite treats them as
    equal.

  Only a foreign writer stores 5.0 or -0.0, since both sides bind integral numbers as INTEGER. It still mustn't
  stall sync.
- **P5 Identifiers are plain.** An import's uid must be 1–64 bytes in 0x21–0x7E, or the import is refused
  (`refused_imports`). A `blob` that isn't a sha (`is_sha`) arrives as NULL.

  Without it a uid with a space or newline forges inventory lines, and a bad blob sits in `lacks` for ever.

  - The check runs first in `plausible_uid`, before the known-uid pass, so a bad uid already stored locally can't
    pass either.
  - The non-sha blob rule applies on every path that takes a remote blob: new import, R2, `done`/`done`,
    `review`/`review`.
  - Local writers refuse such uids too (`write::begin`, result ingest), so nothing un-syncable is created.
- **R13 (v6) Times within bounds, one bound everywhere.** `MAX_TIME_MS` = 253402041600000 (9999-12-29T00:00:00Z).
  - A pack row (observation or correction) is skipped when its `start_ms`, or a non-NULL `end_ms`, is outside
    `0..=MAX_TIME_MS`. The skipped rows are counted (`refused_rows`).
  - The local writers apply the same bound (desktop `write::check_row`, web `checkRow`). A writer that kept a row its
    peers skip would diverge for good.
  - Why this bound: `to` plus the daily padding (14 h and 1 day) stays inside year 9999 for SQLite's strftime,
    JS `Date` (which `toISOString` throws beyond ±8.64e15) and chrono. A row near i64::MAX also overflowed the
    desktop's daily arithmetic, which now saturates as well.
  - Fixture 22 has a row at exactly `MAX_TIME_MS` (taken), one at `MAX_TIME_MS + 1` (skipped), and a valid start
    with `end_ms` beyond the bound (skipped).
- **G5 `set_at` grammar.** `set_at` is a JSON string matching `^(0|[1-9][0-9]*)$` that fits in i64 (at most
  9223372036854775807). Anything else
  counts as 0: a number, `"+5"`, `"007"`, `" 5"`, `""`. This applies to the merge's comparison and to the HLC alike.

New shared fixtures:

| Fixture | Covers |
|---|---|
| 13 | R7b |
| 14 | R6b, review/review blob |
| 15 | R9 |
| 16 | R10 |
| 17 | R12 |
| 18 | P5 |
| 19 | R3 stamps of different digit counts (`9` vs `10`, so a string comparison fails) |
| 20 | R3 names whose UTF-8 order differs from UTF-16 order (U+FF01 vs U+1F600) |
| 21 | (v6) a remote file without `meta.file` gets one |
| 22 | (v6) R13 |

The loader also checks idempotence both ways (b ← a again, too).

Notes for implementers (no rule change):

- **Order and length by UTF-8 bytes.** Every comparison and sort of text uses UTF-8 byte order: inventory lines,
  uids, R3 names and `set_by`, report text, `skipped_metrics`. JS `<` and `sort()` compare UTF-16 units and differ
  for astral characters. Text length in the inventory is in UTF-8 bytes.
- **Large integers.** `at` and `set_at` exceed 2^53: read them as text or BigInt.
- **Encoding.** The inventory joins fields with single spaces after a one-letter tag (§6.1 of `docs/lan-sync.md`;
  the reference is `crates/health-core/src/sync.rs`).
- **The fingerprint sum.** Its modulus is 2^256. Someone who can craft rows could search for a collision
  (generalised birthday). Only a device holding the account key can send rows at all, and it can already change
  them outright. Accepted.

## 9. Shared fixtures

The fixtures live in this repo under `crates/health-core/tests/fixtures/merge/`. CI never reads W, so the web copies
or reads them by path, as with the web fixtures today.

- The web's CI can't read this repo. It keeps a copy under `market/health/test/fixtures/merge/`, with the source commit
  recorded in a README. A web test compares the copy with `../health/crates/health-core/tests/fixtures/merge` when that
  path exists, and skips otherwise.
- Values carry their type, since JSON can't tell 5 from 5.0: `{"t": "integer", "v": 5}`, `{"t": "real", "v": 5}`,
  `{"t": "text", "v": "…"}`, `{"t": "null"}`. HLC values (`at`, `set_at`) are decimal strings.
- Each case is a JSON file `{name, a: <rows>, b: <rows>, expect: <rows>}`. `<rows>` lists table contents by
  identity, not local ids:
  - imports by uid, with status and blob;
  - sources by `(connector, external_id)`, with name, priority and `meta.set_at`/`set_by`;
  - observations by `(metric code, connector, external_id, start_ms)`, with uid, end_ms, tz_min, value (with
    type) and detail;
  - corrections, genotypes and report text.
- A test builds two databases from `a` and `b`, merges `a ← b` and `b ← a`, and requires both to equal `expect`,
  ignoring `daily`, which is checked by comparing it with a full rebuild. It then merges again and requires no
  change.
- Plus `units.json`: pairs of printed units with `same: true/false`, for `unit_key` (R4).
- Cases, at least:
  - R1: equal uid with different values, with NULL `end_ms`/`detail`, and 5 vs 5.0; genotypes; report text; one
    unit conversion (glucose mmol/L → mg/dL) ingested on each side, to see whether both convert bit for bit. They
    may differ by one ulp, since each evaluates `a·f/g` in its own order. R1 then decides, and the case records it.
  - G1: a future correction; G3: one alias mapped to two measures.
  - R2: confirm on A, review on B.
  - R3: an edit on each side; unstamped vs stamped.
  - R5: a correction on a point whose import isn't in the merge.
  - R6: the same file under two uids, in both arrival orders, then erase the owner.
  - R7: edit then remove on one side.
  - R8: metric ids differing between the two databases.

## 10. Agreement log

| Round | From | Outcome |
|---|---|---|
| v1 → v2 | web (pre-pol) | R1–R8 agreed with changes, all taken; one correction declined (§11); G1–G4 added |
| v2 → v3 | web (pre-pol) | **R1–R8, G1–G4 and §9 agreed explicitly.** The decline in §11 was accepted; notes added (§11, the R1 conversion fixture) |
| v3 + P1–P4 | web (pre-pol) | four desktop behaviours the web lacked, adopted on the web as parity fixes; agreed |
| v4 → v5 (§8b) | web (pre-pol) | R6c, R7b, R9, R11, R12, P5 and G5 agreed. R6b and R10 agreed with changes, all taken: `meta.file` merging, heirs, one-time upgrades. R9 narrowed to step 4 |
| v6 | web (pre-pol) | meta.file from a remote blob, and R13, agreed with changes, all taken: the precedence written out, a non-sha `meta.file` dropped from copied meta, one `MAX_TIME_MS` for writers and merges, skipped rows counted. Fixtures 02, 03, 05 and 11 now record `meta.file`, as data after upgrade 2 does; 21 and 22 added |
| v5 agreed | web (pre-pol) | **All of §8b and fixtures 13–20 agreed explicitly.** The desktop implements them with the probes from the review as regression tests (`tests/sync_review.rs`). Fixtures 13–18 fail on the code before round 2; 19 and 20 pass there and guard a JS implementation (integer `set_at`, UTF-8 order) |

Implementation order on the web, once the owner says go: R8, R7, R4 sort, G1, R1, R2, R3 (merge only), R5, R6
(after checking the review photo, R6), G3, then the fixture copy and its compare test. The desktop implements the
same rules in S1 (`docs/lan-sync.md` §15).

## 11. Points declined

- The web's review said Rust binds whole numbers from signed results as REAL. It doesn't: `result.rs` converts JSON
  numbers through `Value::number`, which stores integral values as INTEGER, as the web does (CLAUDE.md invariant). The
  typeof-first rule stays; it is needed for genuinely mixed types. The web side checked: W `engine.ts:92` and
  `wasm.ts:91` bind integral numbers as INTEGER too.

Notes from the agreement, no rule change:

- Integers between 2^53 and 2^63 bind as INTEGER on the web and as REAL in Rust (`Value::number`). Harmless: both
  refuse non-safe integers before they reach `observation` or `correction` (W `checkRow`/`putCorrection`; Rust
  `write.rs:222-227`, `correction.rs:38-39`).
- Same-uid rows with different REAL values can come from unit conversion, if the two implementations differ by one
  ulp. R1 decides them, and the R1 conversion fixture shows whether it happens.
- G3: a local choice of a larger metric code is reverted at the next merge with a device that holds the smaller
  one. That is the accepted cost.
