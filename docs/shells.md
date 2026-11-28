# Shells and the runtime

How the one Tauri project runs the core on each platform. The core itself (op table, data rules, formats) is in
`architecture.md`.

```
crates/health-runtime   what the mobile shell embeds around health_api::call: owner, agent, unlock, lifecycle, status
crates/health           desktop CLI and `health serve` (the sidecar the desktop shell supervises)
gui/src-tauri           lib.rs (the contract), desktop.rs + clients.rs (sidecar host), mobile.rs (in-process host)
plugins/tauri-plugin-health-platform   native services for mobile (now: root keys in Keychain / Keystore), Rust API only
```

## The contract (`gui/src-tauri/src/lib.rs`, used by `gui/src/api.ts`)

- Commands: `op`, `unlock`, `init_profile`, `clear_data`, `core_path`, `agent_clients`, `connect_agent`, `ocr_status`,
  `ocr_install`, `set_language`, `open_link`, `shell_info`; for files on phones: `stage_file` (bytes the system
  picker or the camera gave, written to the app's cache, returned as a path the import ops take; `unstage_file` removes it once imported or put aside), `export_path`
  (where an export is written) and `share_file` (the system share sheet).
- Events: `health:status` (`{ up, locked?, need_init?, error? }`), `health:changed`, `health:locked`,
  `health:unlocked`, `health:sync`, `health:whoop`, `menu`.
- Desktop: the old desktop shell's behaviour: it supervises `health serve --exit-with-parent`, relays calls over
  loopback HTTP with the owner token and serve's SSE events, runs `health wipe` for Clear data.
- Mobile: the same commands over `health-runtime` in the app process (one runtime per process: Android can rebuild
  the activity), emitting the same event names. Agent connect (desktop agent apps' MCP configs) and the menu
  language do nothing; links open through the opener plugin, checked against the same allowlist in Rust.
- Native gates (biometrics before `unlock`, confirmation before ops that hand data over) belong in these Rust
  commands, never in web code.

## The runtime (`health-runtime`)

- `owner(name, req, opts)` alone reaches `runtime.status|init|wipe`, `sync.live` and `sync.answer`; `agent(token, ..)`
  resolves the grant itself (`access.resolve`); network ops are refused to agents (audited). Both return
  `Outcome { value, withheld }`.
- It owns what `health serve`'s State used to (plan P1a): the single writer, network ops (the profile is locked only
  for their short steps), `import.ocr` recognition outside the lock, LAN sync (`lan.rs`), the passphrase unlock with a
  one-off key store, idle (desktop) and background (mobile) locking, events. `health serve` is the HTTP layer.
- `Platform { data_dir, profile, keys: Box<dyn RootKeys>, now_ms, tz_min, lock_after_ms, offline, device_name,
  recognize }`. `RootKeys` = health-core's `KeyStore` plus `delete`. `recognize`: desktop runs the `ocr-worker`
  process (a crash can't touch the writer), mobile recognises in-process (iOS allows no child processes).
- The OCR component (models) installs through the runtime on both (`ocr::install`, downloads via health-connect).

## Phones (what the web app has and the desktop didn't)

- Lab self-service (`gui/src/lab.tsx`, `health-api` lab.rs): scan the device's QR (`…/health/s/<device>` or
  `…/health/d/<device>`, official barcode-scanner plugin) or type its id; `lab.device` says what it is:
  - seca mBCA Pro: register the anonymous patient once (birth month, sex, ethnicity), check nobody is on the
    device, start, follow the on-device steps, the sealed report arrives within 10 minutes (poll every 5 s);
  - VALD ForceDecks: a profile per device (the device's screen shows `<timestamp> <label>`, the person picks that
    name), start a lease, test on the device, results read from the feed (every 3 s while something moves);
  - other lab devices: the 6-digit code (`self.code`), the result through the inbox.
  Results are sealed to the account's inbox key and stored as lab results; the state kept between visits is in the
  vault (`LabSelf`), per device, never synced. On opening, ForceDecks results of the last 7 days and a waiting seca
  measurement are fetched. Device photos are bundled (`gui/src/devices`).
- Link a new device by scanning its `ZUHL1:` code (pasting still works, decision 65).
- Import (decision 106): the same choices everywhere: a lab report from the camera (touch screens), the photos or
  the files; an export or a backup from the files. Phones use the system's picker (the bytes are staged in the app's
  cache); the desktop uses the open dialog (the file is imported where it is) and takes a file dropped on the window.
  OCR runs on the device.
- Export (CSV, backup, decision 106): asked for first (password, choices), then saved where the person chooses: the
  desktop's save dialog; on a phone, written in the app's cache, then the system share sheet (save to Files, send).
- Plain copies in the cache (a staged file, an export) don't outlive their use: one staged file at a time, removed
  once imported; exports kept an hour (the receiving app reads later); both folders emptied at start and with the data.
- Look: Konsta UI on Tailwind (decision 103): iOS's on iPhone, iPad and desktop, Material's on Android.
- Layout (any narrow window, decisions 88, 97): under 760 px wide, a floating tab bar at the bottom (Dashboard, Add,
  More) instead of the side panel; every screen has an address and one way back at the top (decisions 105, 106). Wider (desktop, iPad) keeps the
  side panel. Safe areas for the notch and the home indicator; 16 px fields. Agent access (desktop agent apps) is
  hidden on phones.
- The camera permission text is in `Info.ios.plist` (merged by Tauri) and `gen/apple/project.yml`.

## Locking (mobile)

`lock_after_ms: Some(5 min)` on mobile, `None` on desktop. A cold start with a profile starts locked; `Suspended`
records the time (one atomic store); `Resumed` / `Focused(true)` clear it on a worker thread and close the profile
first if the grace period has passed; every call and LAN sync's use of the data check too. Past the grace period the
mark stays until `Resumed`: `unlock` is refused meanwhile, and the UI doesn't unlock while it's hidden. This gives "no access after expiry", not "key wiped at
expiry". Reopening runs the core's writer-open recovery, which sweeps `tmp/`: plan P1c changes that in the core.
The UI unlocks as soon as it sees the lock, behind a "Decrypting your data" wait (decision 90): nothing to tap.

## Data and keys

- Desktop: the `health` binary's defaults, i.e. `<OS data dir>/health` and the OS keychain: the same profile as the
  old desktop app. Use `HEALTH_DATA_DIR` and `HEALTH_ROOT_KEY_FILE` for anything that must not touch it.
- Mobile: the app's own data directory, keys through the platform plugin.

## Building from Xcode / Android Studio

Both IDEs build through the Tauri CLI, which must be running while they build. Start them from it:

```sh
cd gui && npx tauri ios dev --open
. scripts/mobile-env.sh && cd gui && npx tauri android dev --open
```

iOS doesn't use `tauri::mobile_entry_point` (decision 89: its stdout pipe deadlocks under Xcode). The Xcode "Build Rust Code" phase (`gen/apple/project.yml`) adds `~/.cargo/bin`, Homebrew and nvm to PATH itself;
after regenerating `gen/apple`, put those lines back and run `xcodegen generate` with an empty `Externals/`.
`tauri ios|android init` writes Tauri's default app icon into `gen/`: after regenerating, run
`python3 scripts/gen-icons.py`, which makes every icon from `icons/app-icon.svg` and writes them into `icons/` and
`gen/` (decision 92). `gen/android/gradle.properties` limits Android Studio builds to arm64 and x86_64. `buildSrc/.../RustPlugin.kt` makes ABI flavors for those only (Tauri's template makes all four, and Android Studio then picks `armDebug`, which has no library); put that back after regenerating. Deep links (a lab device's address `https://zuchiangmai.com/health/s|d/<id>` opened from the system camera): the deep-link plugin writes the associated domain into the iOS entitlements and an `autoVerify` intent filter between its `DEEP LINK PLUGIN` markers in `AndroidManifest.xml` at build time; `project.yml` carries the same associated domain so `xcodegen generate` keeps it; keep both. The site serves `/.well-known/apple-app-site-association` and `assetlinks.json` (the web repo). `AndroidManifest.xml` declares `<queries>` for `IMAGE_CAPTURE`: without it Android 11+ hides the camera app from the web view, and "Take a photo" opens the file picker; keep it too. An Android emulator on software graphics (logcat: `MESA Failed to open rendernode`) draws translucent cards over the backdrop with garbled glyph fragments; set the AVD's Graphics acceleration to Hardware and cold-boot it. `scripts/mobile-env.sh` points
`RANLIB_<target>` at the NDK's `llvm-ranlib` (vendored OpenSSL for SQLCipher).

## Verified (2026-11-27)

- Imported crates and UI equal the archive of health@6ba4ab1 apart from `tests/` (not ported, by the owner's choice).
- `clippy --workspace` (desktop) and `clippy` for the iOS target, `check-no-net.sh` (runtime, shell, plugin code) and
  `cargo deny check licenses` pass.
- `health serve` on the runtime, against scratch data: no-profile exit, CLI forwarding, SSE `changed`, a grant token
  refused on network ops, passphrase lock / wrong passphrase / unlock / lock.
- Against the dev backend (read-only): `lab.device` for seca-mbca-01 (seca), forcedecks-01 (forcedecks, available)
  and an unknown id (no_device); `seca.state`.
- UI in a browser through serve: desktop, and the phone layout (top bar, content from the top).
- iOS simulator build (Swift share sheet, barcode scanner) and the first-run page; Android: the Rust library for
  arm64 and the platform plugin's Kotlin compile. The Android emulator flows ran before the runtime move
  (first run, Keystore, SQLCipher, cold-start lock, unlock).

## Verified (2026-11-28)

- Against scratch profiles through `health serve`: background-marked calls don't put off a passphrase serve's idle
  lock (they did before), foreground ones do; lock and unlock again with the passphrase proof; `--offline` refuses a
  network op named with `health op`.
- The UI in a browser through serve (dev build, StrictMode): every address opens and going back retraces them; a
  choice sheet takes one history step; files chosen on Data sources and Restore don't come back.
- Recognition: the worker's output is byte-identical before and after drawing PDF pages one at a time (the old
  repo's cbc.pdf, cbc.png, chem-1.png).
- The shared merge cases (24, from the web version) pass through the old repo's harness, run temporarily.
- `clippy` for the desktop and the iOS target.

Never exercised yet: on a phone after the runtime move (Android blocked by a running `tauri android dev`); seca
register / start / result and every ForceDecks step after the lookup (they act on real lab devices); scanning, camera
capture and the share sheet; LAN sync after the move; OCR on a phone; Android network ops with the bundled roots.

Not done on phones: WHOOP sign-in (nothing opens the page or catches the redirect: plan D14), HEIC photos, backup
exclusion (D15; the OCR models are in app data too), biometrics before unlock, deep links from the system camera
(Universal Links / App Links), HealthKit / Health Connect, CI workflows (not brought over yet). The web code's
licence is the owner's to confirm.
