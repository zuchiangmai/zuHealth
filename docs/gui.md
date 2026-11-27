# GUI (M4)

Tauri 2 shell plus a React + TypeScript UI. The shell starts the bundled `health serve`, keeps it alive and relays calls to it. The UI only draws: no database, no keys, no validation beyond input hints (plan §6).

## Shape

- `gui/` holds the Vite + React UI. `gui/src-tauri/` holds the shell, which sits outside the cargo workspace so core CI doesn't need WebKit.
- Transport, one interface with two adapters:
  - `invoke("op", {name, req})` in Tauri. The shell holds the owner token and talks to serve over loopback. The webview never sees the token and never makes a cross-origin request, so serve keeps refusing every `Origin`.
  - In the browser (dev and Playwright), `fetch("/v1/op/…")` through the Vite proxy, which strips `Origin` and adds the token from the environment.
- Events: the shell subscribes to `/v1/events` and re-emits them as Tauri events. In the browser, the UI polls.
- Supervision:
  - If serve exits, the shell restarts it with a backoff (1 s, doubling to 30 s) and the UI shows a starting state. Serve runs with `--exit-with-parent`, so it never outlives the shell.
  - The handshake checks `GET /v1/meta` for `api == 1`.
  - Passphrase mode: the UI shows an unlock screen and calls the shell's `unlock`.
- No tray or menu-bar icon: Health is opened and closed like any app, and closing the window quits it (decision 48). Agents reach the data without it. Notifications and auto-update are M7.
- Pages:
  - New-built rather than copied from the web, because the web pages depend on the monorepo's internal UI kit (decision 31).
  - Same set: readings, history, manual entry, sources and imports, review queue, backup.
  - New: agent access and the access log.

## Design

- Subject: a personal health logbook on your own computer, built as an index of readings, not a card dashboard.
- Light palette: Paper `#EEF1EC`, Ink `#1C2A33`, Graphite `#5D6B72`, Pulse `#0A7397` (charts, links), Signal `#B5700C` (only for what waits on you), Rule `#D3D9D2`.
- Dark palette: Paper `#141B1F`, Surface `#1B252A`, Ink `#E3E9E6`, Graphite `#93A1A6`, Pulse `#1F9AB8`, Signal `#C4861A`. Chart colors were checked with the dataviz validator against both surfaces (lightness band, chroma floor, CVD separation, contrast).
- Native macOS feel, modelled on Home.app (owner request, 2026-11-22). Base colours are Home's (owner request): window `#F2F2F7`, sidebar `#F9F9FB`, cards white; dark: `#1C1C1E`, `#232325`, `#2C2C2E` (Pulse checked with the dataviz validator against both card colours). Layers, back to front: the window, a floating sidebar inset 8 px with the traffic lights inside it, glass tiles and grouped panels, then sheets (History opens as a `<dialog>` sheet over the page; Esc or ⌘[ closes it). Radii follow the layer: panel 18, sheet 22, tile 16, group 12, control 8, pills round. On macOS the window carries an empty unified NSToolbar, so it has the system's toolbar-window shape (larger corners, traffic lights centred in a taller title area); the sidebar sits 9 px in with a 20 px radius so its corner nests in the window's. Text uses Apple's label colours (`#1D1D1F` / `#6E6E73`, dark `#F5F5F7` / `#98989D`); sidebar symbols are monochrome as in Home, and the category tints stay on content headings and pills. Sections (2026-11-22 review): Readings; Your data (Data sources, Backup); Me (Profile, Health account); Sharing (Agent access). Data sources, Backup, Profile and the account's devices are inset grouped rows (icon, name, a line under it, a live status, a chevron) whose steps open in a sheet; every page but Readings is one centred 46rem column. The sidebar marks the category scrolled into view on Readings.
- Readings: status pills (one headline number per everyday category), then one section per category with its symbol and a grid of tiles (name, value in SF Pro Rounded, month trend or date). A category shows one full row (two for large ones); "Show all N" opens the rest.
- Category tints (icons only, never text): body violet, heart red, sleep indigo, activity orange, lab blue, infectious green, tumour rose.
- One motion system: 140 ms for hover/press, 240 ms for views and sheets; ease-out `cubic-bezier(.22,1,.36,1)`, sheets with a slight spring. Motion answers an action only (switching section, opening a sheet, pressing a tile); `prefers-reduced-motion` turns it all off.
- Type: system faces (offline, no bundled fonts), tabular figures, large values set light with the unit small in graphite. Scale 13/15/19/26/40.
- Layout: a left index rail and one left-aligned main column. Rows are separated by rules within groups, and text runs at most 72ch.
- Signature: an ink-trace sparkline beside every reading, with the last point dotted. It is the only decorative element.
- Copy: sentence case, plain verbs. Agent pages say plainly what an agent will see.
