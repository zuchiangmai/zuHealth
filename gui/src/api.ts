// The only way the UI reaches data: one call per operation of the core's op table.
// Tauri: `invoke("op")` (the shell holds the token and talks to serve). Browser (dev, tests): the Vite proxy.
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

export interface ApiError {
  code: string;
  message: string;
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
/** The iPhone, iPad or Android app: files come from the system's picker or the camera, exports go to the share sheet,
 *  and codes can be scanned. (iPadOS reports itself as a Mac with a touch screen.) */
export const isMobile = inTauri && (/Android|iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1));
/** Desktop app: native file dialogs and drag and drop exist; in the browser preview, paths are typed. */
export const isDesktop = inTauri && !isMobile;
export const isAndroid = isMobile && /Android/.test(ua);

export class OpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message || code);
  }
}

let quiet = false;

/** Runs `f`; the ops it starts right away are the app's own (a poll, a reload after an event), not the person using
 *  it: they don't put off the idle lock. */
export function inBackground<T>(f: () => T): T {
  const was = quiet;
  quiet = true;
  try {
    return f();
  } finally {
    quiet = was;
  }
}

/** Whether the code running now is inside `inBackground`. */
export const inBackgroundNow = () => quiet;

export async function op<T>(name: string, req: object = {}): Promise<T> {
  const background = quiet;
  if (inTauri) {
    try {
      return await invoke<T>("op", { name, req, background });
    } catch (e) {
      const err = e as ApiError;
      throw new OpError(err.code ?? "error", err.message ?? String(e));
    }
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (background) headers["x-health-background"] = "1";
  const r = await fetch(`/v1/op/${name}`, { method: "POST", headers, body: JSON.stringify(req) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new OpError(body?.error?.code ?? `http_${r.status}`, body?.error?.message ?? "");
  return body.value as T;
}

/** Passphrase mode: unlock the running core. */
export async function unlock(passphrase: string): Promise<void> {
  if (inTauri) {
    try {
      await invoke("unlock", { passphrase });
      return;
    } catch (e) {
      const err = e as ApiError;
      throw new OpError(err.code ?? "error", err.message ?? String(e));
    }
  }
  const r = await fetch("/v1/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase }) });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new OpError(body?.error?.code ?? `http_${r.status}`, body?.error?.message ?? "");
  }
}

/** The core's state as the shell sees it (Tauri only): up, or (re)starting. */
export interface CoreStatus {
  up: boolean;
  locked?: boolean;
  error?: string;
  need_init?: boolean;
}

/** Subscribes to Tauri events; safe to stop before the subscription has resolved. */
function listenAll(events: string[], fn: (payload: unknown) => void): () => void {
  let stopped = false;
  let unlisten: (() => void)[] = [];
  import("@tauri-apps/api/event").then(({ listen }) =>
    Promise.all(events.map((ev) => listen(ev, (e) => fn(e.payload)))).then((us) => {
      if (stopped) us.forEach((u) => u());
      else unlisten = us;
    }),
  );
  return () => {
    stopped = true;
    unlisten.forEach((u) => u());
  };
}

export function onStatus(fn: (s: CoreStatus) => void): () => void {
  return inTauri ? listenAll(["health:status"], (p) => fn(p as CoreStatus)) : () => {};
}

/** First launch: create the encrypted store (Tauri only). */
export async function initProfile(): Promise<void> {
  try {
    await invoke("init_profile");
  } catch (e) {
    const err = e as ApiError;
    throw new OpError(err.code ?? "error", err.message ?? String(e));
  }
}

/** "Clear data" (Tauri: the shell stops the core and runs `health wipe`); in the browser, the dev page's stand-in. */
export async function clearData(confirm: string): Promise<void> {
  if (inTauri) {
    try {
      await invoke("clear_data", { confirm });
    } catch (e) {
      const err = e as ApiError;
      throw new OpError(err.code ?? "clear_failed", err.message ?? String(e));
    }
    return;
  }
  const r = await fetch("/shell/clear-data", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm }) });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new OpError(body?.error?.code ?? "clear_failed", body?.error?.message ?? "");
  }
}

/** The core binary's path, for an agent's MCP config ("health" when it is on PATH, as in the browser). */
export async function corePath(): Promise<string> {
  return inTauri ? invoke<string>("core_path") : "health";
}

/** LAN sync's live state changed (Tauri); in the browser, every 2 s. */
export function onSync(fn: () => void): () => void {
  const quietly = () => inBackground(fn);
  if (inTauri) return listenAll(["health:sync", "health:changed"], quietly);
  const t = setInterval(quietly, 2000);
  return () => clearInterval(t);
}

/** Calls `fn` after every committed write (SSE through the shell in Tauri; polling in the browser). */
export function onChange(fn: () => void): () => void {
  const quietly = () => inBackground(fn);
  if (inTauri) return listenAll(["health:changed", "health:unlocked", "health:locked", "health:status"], quietly);
  const t = setInterval(quietly, 5000);
  return () => clearInterval(t);
}

// Response shapes (from `health schema <op>`)
export interface Point {
  metric: string;
  name: string;
  unit: string;
  agg: string;
  group: string;
  /** Where the home page shows it (group, or force for VALD ForceDecks) */
  category: string;
  start_ms: number;
  end_ms?: number;
  tz_min: number;
  value: number | string | null;
  comparator?: string;
  source_id: number;
  import_id: number;
  corrected: boolean;
  detail?: Record<string, unknown>;
}
export interface Day {
  day: string;
  source_id: number;
  n: number;
  sum: number | null;
  min: number | null;
  max: number | null;
  seconds: number | null;
  mean?: number;
}
export interface Metric {
  code: string;
  name: string;
  unit: string;
  agg: string;
}
export interface MetricInfo extends Metric {
  units: string[];
  points: number;
}
export interface Source {
  id: number;
  connector: string;
  external_id: string;
  name: string;
  priority: number;
}
export interface Batch {
  import_id: number;
  uid: string;
  at?: number;
  source_id: number;
  connector: string;
  parser: string;
  status: string;
  metrics: number;
  from?: number;
  to?: number;
}
export interface BatchDetail extends Batch {
  rows: number;
  items: Point[];
  has_text: boolean;
  candidates?: { kind?: string; rows?: unknown[]; note?: string; items?: unknown[]; by?: string; at?: number; dated?: boolean; tz?: number };
}
export interface Grant {
  /** The key the agent's proposals and results are recorded under */
  writer: string;
  id: number;
  name: string;
  groups: string[];
  detail: boolean;
  window: "all" | { last_days: number } | { range: { from_ms: number; to_ms: number } };
  reports: boolean;
  write: "none" | "propose" | "derived";
  expires_ms: number;
  created_ms: number;
  revoked_ms?: number;
}
export interface Audit {
  at: number;
  grant_id: number;
  op: string;
  metrics: string[];
  from_ms?: number;
  to_ms?: number;
  rows: number;
  denied: boolean;
}
export interface Status {
  version: string;
  profile: string;
  key_store: string;
  metrics: number;
  sources: number;
  imports: number;
  reviews: number;
  observations: number;
}

/** The file types each way in takes, for the desktop's open dialog. */
export const FILE_TYPES = {
  photo: ["jpg", "jpeg", "png", "webp", "heic", "tif", "tiff", "bmp", "gif"],
  report: ["jpg", "jpeg", "png", "webp", "heic", "tif", "tiff", "bmp", "gif", "pdf"],
  apple: ["zip"],
  restore: ["zuhealth", "bin"],
  file: ["zip", "zuhealth", "bin", "json", "jsonl", "jpg", "jpeg", "png", "webp", "heic", "tif", "tiff", "bmp", "gif", "pdf"],
} as const;

/** Desktop: the system's open dialog; the file is imported where it is (a large export isn't copied). */
export async function chooseImportFile(types: keyof typeof FILE_TYPES = "file"): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ multiple: false, directory: false, title: t("Import health data"), filters: [{ name: t("Health data"), extensions: [...FILE_TYPES[types]] }] });
  return typeof r === "string" ? r : null;
}

/** Saves an export where the person chooses, once it's asked for: the desktop's save dialog first; a phone writes
 *  it in the app's own folder, then the share sheet (Save to Files, send...); the browser preview downloads it.
 *  `write` makes the file at the path given and returns where it went. Null: the dialog was cancelled. */
export async function saveExport(name: string, mime: string, kind: { name: string; ext: string }, write: (path: string) => Promise<string>): Promise<string | null> {
  if (isDesktop) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: name, title: kind.name, filters: [{ name: kind.name, extensions: [kind.ext] }] });
    return path ? write(path) : null;
  }
  if (isMobile) {
    const path = await write(await invoke<string>("export_path", { name }));
    await invoke("share_file", { path, mime });
    return path;
  }
  const path = await write(await (await fetch(`/dev/export?name=${encodeURIComponent(name)}`, { method: "POST" })).text());
  const a = document.createElement("a");
  a.href = `/dev/download?name=${encodeURIComponent(name)}`;
  a.download = name;
  a.click();
  return path;
}

/** Files dragged onto the window (desktop only): `over` while hovering, `drop` with the paths. */
export function onFileDrop(fn: { over: (hovering: boolean) => void; drop: (paths: string[]) => void }): () => void {
  if (!inTauri) return () => {};
  let stopped = false;
  let unlisten = () => {};
  import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") fn.over(true);
        else if (p.type === "leave") fn.over(false);
        else if (p.type === "drop") {
          fn.over(false);
          fn.drop(p.paths);
        }
      })
      .then((u) => {
        if (stopped) u();
        else unlisten = u;
      }),
  );
  return () => {
    stopped = true;
    unlisten();
  };
}

/** macOS desktop: the app menu owns the shortcuts (the UI handles them itself everywhere else). */
export const menuOwnsKeys = inTauri && /Mac/.test(navigator.userAgent);

/** Items chosen in the app menu ("readings", "find", "import", …). */
export function onMenu(fn: (id: string) => void): () => void {
  return inTauri ? listenAll(["menu"], (p) => fn(String(p))) : () => {};
}

/** Agent apps with a one-click connect that look installed on this computer (desktop only). */
export async function agentClients(): Promise<{ id: string; file: string }[]> {
  return inTauri ? invoke("agent_clients") : [];
}

/** Writes Health's MCP entry with this token into the agent's config; returns the file written. */
export async function connectAgent(id: string, token: string): Promise<string> {
  return invoke<string>("connect_agent", { id, token });
}

/** The number on the dock / taskbar icon (desktop only; 0 clears it). */
export function setBadge(n: number): void {
  if (!inTauri) return;
  import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setBadgeCount(n > 0 ? n : undefined)).catch(() => {});
}

/** One printed line of a lab report, as read (see health-core ocr.rs). */
export interface OcrItem {
  name: string;
  panel?: string;
  v: number | string;
  cmp?: string;
  unit: string;
  ref?: string;
  flag?: "H" | "L";
  text: string;
  code?: string;
  suggest?: { code: string; score: number }[];
}

/** The shell's menu bar and window title follow the UI's language (desktop only). */
export function setShellLanguage(lang: string): void {
  if (isDesktop) invoke("set_language", { lang }).catch(() => {});
}

/** Opens a web page in the default browser (desktop: only the links the shell allows). */
export function openLink(url: string): void {
  if (inTauri) invoke("open_link", { url }).catch(() => {});
  else window.open(url, "_blank", "noopener");
}

export interface OcrComponent {
  ready: boolean;
  files: { name: string; bytes: number; installed: boolean; required: boolean }[];
}

/** The OCR component (models) on this device: what's installed, what a first read would download. */
export async function ocrComponent(): Promise<OcrComponent | null> {
  return inTauri ? invoke("ocr_status") : null;
}

/** The models downloading (bytes) or a report being read (pages), for a progress bar. */
export interface OcrProgress {
  stage: "download" | "read";
  done: number;
  total: number;
}
export function onOcrProgress(fn: (p: OcrProgress) => void): () => void {
  return inTauri ? listenAll(["health:ocr_progress"], (p) => fn(p as OcrProgress)) : () => {};
}

/** Downloads and checks the OCR component (desktop only); `matching` adds the 135 MB matching model. */
export async function installOcr(matching: boolean): Promise<void> {
  try {
    await invoke("ocr_install", { matching });
  } catch (e) {
    const err = e as ApiError;
    throw new OpError(err.code ?? "error", err.message ?? String(e));
  }
}

/** A lab device's values at one time (labs.forcedecks / labs.body_scans) */
export interface Measurement {
  start_ms: number;
  tz_min: number;
  device: string;
  values: Record<string, number | string | null>;
}
/** One time on the VALD ForceDecks plates: its jumps, oldest first, and the best one */
export interface FdSession {
  device: string;
  test: string;
  trials: Measurement[];
  best: number;
}

/** A staged copy that has been imported or put aside, removed (the shell removes only its own copies: a computer's
 *  path is the person's own file). */
export function unstageFile(path?: string) {
  if (path && inTauri) invoke("unstage_file", { path }).catch(() => {});
}

/** A file the person picked, photographed or dropped in the page, handed to the core as a path it can import
 *  (the app's own folder; the browser preview's dev server). */
export async function stageFile(file: File): Promise<string> {
  if (!inTauri) {
    const r = await fetch("/dev/stage", { method: "POST", headers: { "x-file-name": encodeURIComponent(file.name || "file") }, body: file });
    if (!r.ok) throw new OpError("stage_failed", `HTTP ${r.status}`);
    return r.text();
  }
  try {
    if (isAndroid) return await stageInChunks(file);
    return await invoke<string>("stage_file", new Uint8Array(await file.arrayBuffer()), {
      headers: { "x-file-name": encodeURIComponent(file.name || "file") },
    });
  } catch (e) {
    const err = e as ApiError;
    throw new OpError(err.code ?? "stage_failed", err.message ?? String(e));
  }
}

/** Android's IPC can't carry raw bytes: the file goes in base64 chunks, so a large export never sits in memory whole. */
const CHUNK = 2 * 1024 * 1024;
async function stageInChunks(file: File): Promise<string> {
  const id = Math.random().toString(36).slice(2, 12) || "f";
  const base64 = (blob: Blob) =>
    new Promise<string>((ok, bad) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).slice(String(r.result).indexOf(",") + 1));
      r.onerror = () => bad(r.error);
      r.readAsDataURL(blob);
    });
  let path = "";
  for (let at = 0; at === 0 || at < file.size; at += CHUNK) {
    const data = await base64(file.slice(at, at + CHUNK));
    path = await invoke<string>("stage_file", { id, name: file.name || "file", data, first: at === 0 });
  }
  return path;
}

/** Mobile: scans a QR code with the camera; null if the person closed the scanner. */
export async function scanCode(): Promise<string | null> {
  const { scan, cancel, Format, checkPermissions, requestPermissions } = await import("@tauri-apps/plugin-barcode-scanner");
  let p = await checkPermissions();
  if (p !== "granted") p = await requestPermissions();
  if (p !== "granted") throw new OpError("camera", t("Allow the camera in Settings to scan codes."));
  try {
    const r = await scan({ windowed: false, formats: [Format.QRCode] });
    return r.content || null;
  } catch {
    await cancel().catch(() => {});
    return null;
  }
}

export { type CodeTarget, codeTarget, SITE_HOST } from "./codes";
