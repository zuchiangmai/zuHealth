// Display rules shared by every page (ported from the web model.ts): units as people write them,
// durations as hours and minutes, censored values with their comparator.

import { locale, t, tk } from "./i18n";

const UNITS: Record<string, string> = {
  "mm[Hg]": "mmHg", Cel: "°C", "[lb_av]": "lb", "[oz_av]": "oz", "[stone_av]": "st", "[in_i]": "in", "[ft_i]": "ft",
  "[mi_i]": "mi", "[degF]": "°F", "[IU]/L": "IU/L", "m[IU]/L": "mIU/L", "u[IU]/mL": "uIU/mL", "meq/L": "mEq/L",
  "1": "", "/uL": "/µL", "/min": "/min", "mL/min/{1.73_m2}": "mL/min/1.73m²", "N.s": "N·s",
};
const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
export function unitLabel(u: string): string {
  if (u in UNITS) return UNITS[u] as string;
  return u
    .replace(/\{[^}]*\}/g, "")
    .replace(/[[\]]/g, "")
    .replace(/10\*(\d+)/g, (_, n: string) => `10${[...n].map((d) => SUP[Number(d)]).join("")}`)
    .replace(/(^|\/)u(L|l)$/, "$1µ$2");
}

const PER_MS: Record<string, number> = { ms: 1, s: 1000, min: 60_000, h: 3_600_000 };

export function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  const h = Math.floor(m / 60);
  return h ? t("{{h}} h {{m}}", { h, m: String(m % 60).padStart(2, "0") }) : t("{{m}} min", { m });
}

/** What people read (the web's model.ts): whole numbers from 100, one decimal from 10, three below. Lab results
 *  keep every printed decimal (up to 6): 1.025 and 1.03 are different results. */
export function num(v: number, lab = false): string {
  const a = Math.abs(v);
  const digits = lab ? 6 : a >= 100 ? 0 : a >= 10 ? 1 : 3;
  return v.toLocaleString(locale(), { maximumFractionDigits: digits });
}

/** Lab-like groups show values as printed. */
export const isLabGroup = (g?: string) => g === "lab" || !!GROUPS.find((x) => x.key === g)?.sensitive;

export const PER_MS_UNITS = new Set(["ms", "s", "min", "h"]);
/** A duration unit's value as hours and minutes (`1 h 30`), else undefined. */
export function asDuration(v: number, unit: string, minuteUp = false): string | undefined {
  const per = PER_MS[unit];
  if (!per || (minuteUp && Math.abs(v * per) < 60_000)) return undefined;
  return duration(v * per);
}

/** Qualitative results as labs print them in English (the web's names.ts) → the UI language; anything else
 *  ("0-1", "+", Chinese) as printed. */
const RESULTS: Record<string, string> = {
  positive: tk("Positive"),
  pos: tk("Positive"),
  reactive: tk("Positive"),
  negative: tk("Negative"),
  neg: tk("Negative"),
  "non-reactive": tk("Negative"),
  nonreactive: tk("Negative"),
  "weakly positive": tk("Weakly positive"),
  normal: tk("Normal"),
  abnormal: tk("Abnormal"),
  trace: tk("Trace"),
  detected: tk("Detected"),
  "not detected": tk("Not detected"),
  absent: tk("Not seen"),
  none: tk("Not seen"),
  nil: tk("Not seen"),
  present: tk("Seen"),
  few: tk("Few"),
  rare: tk("Occasional"),
  occasional: tk("Occasional"),
  moderate: tk("Moderate"),
  many: tk("Many"),
  numerous: tk("Many"),
  clear: tk("Clear"),
  hazy: tk("Slightly cloudy"),
  "slightly turbid": tk("Slightly cloudy"),
  cloudy: tk("Cloudy"),
  turbid: tk("Cloudy"),
  yellow: tk("Yellow"),
  "pale yellow": tk("Pale yellow"),
  "light yellow": tk("Pale yellow"),
  straw: tk("Pale yellow"),
  "dark yellow": tk("Dark yellow"),
  amber: tk("Amber"),
  colorless: tk("Colourless"),
  colourless: tk("Colourless"),
  orange: tk("Orange"),
  red: tk("Red"),
  brown: tk("Brown"),
};

export function resultText(text: string): string {
  const k = text.trim().toLowerCase().replace(/\s+/g, " ");
  const label = Object.hasOwn(RESULTS, k) ? RESULTS[k] : undefined;
  return label ? t(label) : text;
}

export interface Shown {
  value: string;
  unit: string;
}

export function shown(p: Pick<import("./api").Point, "agg" | "value" | "unit" | "start_ms" | "end_ms" | "comparator"> & { group?: string }): Shown {
  if (p.agg === "interval") return { value: p.end_ms ? duration(p.end_ms - p.start_ms) : "", unit: "" };
  if (p.value === null) return { value: t("no reading"), unit: "" };
  if (typeof p.value === "string") return { value: resultText(p.value), unit: "" };
  const per = PER_MS[p.unit];
  if (per && !p.comparator && Math.abs(p.value * per) >= 60_000) return { value: duration(p.value * per), unit: "" };
  return { value: `${p.comparator ?? ""}${num(p.value, isLabGroup(p.group))}`, unit: unitLabel(p.unit) };
}

/** The number a daily row is drawn and read by. */
export function dayValue(agg: string, d: import("./api").Day): number | null {
  if (agg === "interval") return d.seconds === null ? null : d.seconds / 3600;
  if (agg === "cumulative") return d.sum;
  return d.mean ?? null;
}

export function dayUnit(agg: string, unit: string): string {
  return agg === "interval" ? t("h") : unitLabel(unit);
}

/** Calendar days between the reading's local day and today (not 24-hour periods). */
export function ago(ms: number, now = Date.now()): string {
  const midnight = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const d = Math.round((midnight(now) - midnight(ms)) / 86_400_000);
  if (d <= 0) return t("today");
  if (d === 1) return t("yesterday");
  if (d < 60) return t("{{count}} days ago", { count: d });
  return shortDate(ms);
}

export const GROUPS: { key: string; label: string; sensitive: boolean }[] = [
  { key: "body", label: tk("Body and vitals"), sensitive: false },
  { key: "cardio", label: tk("Heart and recovery"), sensitive: false },
  { key: "sleep", label: tk("Sleep"), sensitive: false },
  { key: "activity", label: tk("Activity"), sensitive: false },
  { key: "lab", label: tk("Routine lab"), sensitive: false },
  { key: "infectious", label: tk("Infectious disease tests"), sensitive: true },
  { key: "tumor", label: tk("Tumour markers"), sensitive: true },
  { key: "repro", label: tk("Reproductive health"), sensitive: true },
  { key: "custom", label: tk("Your own lab items"), sensitive: true },
  { key: "lab_other", label: tk("Other lab tests"), sensitive: true },
  { key: "other", label: tk("Other"), sensitive: true },
  { key: "derived", label: tk("Computed by agents"), sensitive: true },
];
/** The home page's categories: the groups, with lab devices that have a card of their own (VALD ForceDecks: force,
 *  after activity, as the web's model.ts). Exports and grants keep using GROUPS. */
export const HOME_GROUPS: { key: string; label: string; sensitive: boolean }[] = [
  ...GROUPS.slice(0, 4),
  { key: "force", label: tk("Strength and jumps"), sensitive: false },
  ...GROUPS.slice(4),
];
export const groupLabel = (k: string) => t(GROUPS.find((g) => g.key === k)?.label ?? k);

export const SOURCE_KIND: Record<string, string> = {
  manual: tk("Entered by you"),
  apple_health: tk("Apple Health"),
  whoop: tk("WHOOP"),
  ocr: tk("Lab report photo"),
  lab: tk("Lab"),
  staff: tk("Clinic staff"),
  agent: tk("Agent proposal"),
  derived: tk("Computed"),
  file: tk("File"),
  room: tk("Sleep room"),
};
export const sourceKind = (c: string) => t(SOURCE_KIND[c] ?? c);

/** The local calendar day (daily rows are keyed by the local day), as YYYY-MM-DD. */
export const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** Local midnight of a YYYY-MM-DD day (Date.parse would read it as UTC). */
export const dayMs = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
};
/** A short date: "Mar 3", with the year when it isn't this year. */
export const shortDate = (ms: number) => {
  const d = new Date(ms);
  return d.toLocaleDateString(locale(), d.getFullYear() === new Date().getFullYear() ? { month: "short", day: "numeric" } : { dateStyle: "medium" });
};
/** A reading's time in the zone it was measured in (a trip abroad shows the local clock there), as the CSV does. */
export const when = (ms: number, tz?: number) =>
  tz === undefined
    ? new Date(ms).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" })
    : new Date(ms + tz * 60_000).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** The date alone, in the zone it was measured in (entries made for a day, not a moment). */
export const dateIn = (ms: number, tz: number) => new Date(ms + tz * 60_000).toLocaleDateString(locale(), { dateStyle: "medium", timeZone: "UTC" });

/** What a person should read for an error code: what happened and what to do. Unknown codes keep the core's message. */
export function explain(code: string, message = ""): string {
  const known: Record<string, string> = {
    pack_auth: tk("Wrong password, or the file was changed after it was saved."),
    pack_format: tk("This is not a Health backup file."),
    pack_truncated: tk("The backup file is incomplete. Copy it again and retry."),
    pack_container: tk("The backup file is damaged."),
    backup_db: tk("The backup's contents are not a Health database."),
    backup_dup: tk("The backup file is damaged (an entry appears twice)."),
    not_apple: tk("This is not an Apple Health export. In the Health app on iPhone: your picture, then Export All Health Data."),
    bad_whoop: tk("This is not a WHOOP data file Health can read."),
    bad_row: tk("A line in the file is not a reading Health understands."),
    no_file: tk("The file can't be found. It may have been moved."),
    exists: tk("A file with that name already exists. Choose another name."),
    weak_password: tk("Use at least 8 characters."),
    blob_dup: tk("This file was already imported: it is under Sources, or under Waiting for you if it hasn't been checked yet."),
    unit_required: tk("Choose the unit your device showed."),
    unit_unknown: tk("That unit doesn't fit this measure."),
    rejected: tk("The value doesn't fit this measure."),
    import_failed: tk("The file couldn't be read to the end. If it is in iCloud, download it first."),
    bad_passphrase: tk("That passphrase is not right."),
    unavailable: tk("The health core is restarting. Try again in a moment."),
    no_ocr_component: tk("Reading lab reports needs the OCR component. Install it below."),
    unsupported: tk("Health can't read this kind of file. Use a photo (JPEG, PNG) or a PDF; on iPhone, share HEIC photos as JPEG."),
    unreadable: tk("The file couldn't be read. It may be damaged."),
    password: tk("This PDF is protected by a password. Save a copy without it and try again."),
    too_big: tk("The file is larger than 40 MB."),
    empty: tk("No lab results were found in this file. Try a sharper, straight photo of the table."),
    ocr_crashed: tk("The reader stopped unexpectedly. Your data is untouched; try again or use a smaller file."),
    duplicate_target: tk("Two items point to the same measure. Change or skip one of them."),
    nothing_to_save: tk("Choose a measure for at least one item."),
    same_day_report: tk("Another report of the same day already has a value for some of these measures. Skip those items, or set a different date."),
    date_required: tk("Set the day the sample was taken."),
    ocr_component: tk("The recognition models on this computer are damaged. Install them again below."),
    bad_tz: tk("The time zone isn't valid."),
    network: tk("Couldn't reach the server. Check the internet connection and try again."),
    offline: tk("Health is set to work offline."),
    slow: tk("The health service asks to wait a little. Try again in a minute."),
    clock: tk("This computer's clock is off by more than 2 minutes. Correct it and try again."),
    server: tk("The health service gave an unexpected answer. Try again later."),
    auth: tk("The health service refused this device's signature."),
    link_changed: tk("This link is no longer the one shown. Start again."),
    link_busy: tk("The link failed. Start again on the new device."),
    not_link_code: tk("That isn't a connection code. It starts with ZUHL1:."),
    bad_device: tk("That isn't a device id."),
    whoop_reauth: tk("WHOOP needs you to sign in again."),
    whoop_client: tk("WHOOP refused the Client ID or Secret."),
    whoop_denied: tk("The WHOOP sign-in was declined."),
    whoop_state: tk("That WHOOP sign-in isn't the one Health started. Connect again."),
    whoop_none: tk("WHOOP isn't connected."),
    whoop_server: tk("WHOOP gave an unexpected answer. Try again later."),
    port_busy: tk("Another program uses the port WHOOP's sign-in comes back to. Close it and connect again."),
    line_open: tk("Choose a measure for every line, or skip it."),
    no_device: tk("That device doesn't exist or isn't open for self-service."),
    integrity: tk("A downloaded file wasn't the expected one and was discarded. Try again later."),
  };
  return known[code] ? t(known[code]) : message || code;
}

export type ImportKind = "apple" | "backup" | "whoop" | "rows" | "report";

/** Photos and PDFs of lab reports (HEIC isn't read: the phone can share it as JPEG). */
export const REPORT_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp", "gif", "pdf"];

/** What a file is, by its name. */
export function importKind(path: string): ImportKind | null {
  const p = path.toLowerCase();
  if (REPORT_EXTENSIONS.some((e) => p.endsWith(`.${e}`))) return "report";
  if (p.endsWith(".zuhealth")) return "backup";
  if (p.endsWith(".zip")) return "apple";
  if (p.endsWith(".jsonl")) return "rows";
  if (p.endsWith(".json")) return "whoop";
  return null;
}

export const KIND_LABEL: Record<ImportKind, string> = {
  apple: tk("Apple Health export"),
  backup: tk("Health backup"),
  whoop: tk("WHOOP data"),
  rows: tk("Readings file (JSON lines)"),
  report: tk("Lab report (photo or PDF)"),
};

export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
