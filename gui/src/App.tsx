import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type Audit,
  type Batch,
  type BatchDetail,
  type Day,
  type Grant,
  type Metric,
  type MetricInfo,
  type OcrItem,
  OpError,
  type Point,
  type FdSession,
  type Measurement,
  type Source,
  type Status,
  agentClients,
  connectAgent,
  onChange,
  onSync,
  chooseImportFile,
  FILE_TYPES,
  saveExport,
  corePath,
  clearData,
  initProfile,
  installOcr,
  ocrComponent,
  onOcrProgress,
  type OcrProgress,
  openLink,
  isAndroid,
  isDesktop,
  isMobile,
  scanCode,
  stageFile,
  menuOwnsKeys,
  onFileDrop,
  onMenu,
  setBadge,
  onStatus,
  op,
  setShellLanguage,
  unlock,
} from "./api";
import { DailyChart, type Pt, Spark } from "./charts";
import { LabSelfService } from "./lab";
import { useTranslation } from "react-i18next";
import { LANGS, choice, choose, locale as i18nLocale, t, tk } from "./i18n";
import { backBy, back as goBack, go as nav, parts, useLayer, useRoute } from "./router";
import { rubberBand } from "./overscroll";
import { BirthWheels, isTouch } from "./pickers";
import { Checkbox, Navbar, NavbarBackLink, Page as KPage, Popup, Segmented, SegmentedButton, Tabbar, TabbarLink, Toggle, ToolbarPane } from "konsta/react";
import { createPortal } from "react-dom";
import meadowDark from "./backdrop/meadow-dark.webp";
import meadowLight from "./backdrop/meadow-light.webp";
import { Btn, Callout, card, Group, IconDot, Item, type Look, rowBg, SearchPill, setLook, useAppearance, useLook, useWide } from "./ui";
import { CLIENTS, type Client } from "./agents";
import { KEY, codesNamed, nameOf } from "./names";
import {
  GROUPS,
  HOME_GROUPS,
  type ImportKind,
  KIND_LABEL,
  ago,
  asDuration,
  day,
  dateIn,
  dayMs,
  isLabGroup,
  PER_MS_UNITS,
  shortDate,
  dayUnit,
  dayValue,
  explain,
  fileName,
  groupLabel,
  importKind,
  num,
  shown,
  sourceKind,
  unitLabel,
  when,
  resultText,
} from "./format";

type Page = "readings" | "add" | "data" | "backup" | "profile" | "account" | "agents" | "about" | "review" | "more";
/** Narrow screens (phones): the floating tab bar's pages; the other sections are reached from More. */
type Tab = "readings" | "add" | "more";
const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "readings", label: tk("Dashboard"), icon: "readings" },
  { key: "add", label: tk("Add"), icon: "add" },
  { key: "more", label: tk("More"), icon: "more" },
];
/** The sections, in shortcut order (⌘1…⌘6). */
const PAGES: { key: Page; label: string }[] = [
  { key: "readings", label: tk("Dashboard") },
  { key: "data", label: tk("Data sources") },
  { key: "backup", label: tk("Backup") },
  { key: "profile", label: tk("Profile") },
  { key: "account", label: tk("Health account") },
  { key: "agents", label: tk("Agent access") },
  { key: "about", label: tk("About") },
];
const MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
const MOD = MAC ? "⌘" : "Ctrl+";

/** Sidebar icons: 16px outline, drawn in currentColor. */
const ICON: Record<string, ReactNode> = {
  camera: (
    <>
      <path d="M2 5.5h2.5L6 3.5h4l1.5 2H14V13H2z" />
      <circle cx="8" cy="9" r="2.3" />
    </>
  ),
  photos: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <circle cx="5.8" cy="6" r="1.2" />
      <path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" />
    </>
  ),
  folder: <path d="M2 4.5V12.5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3a1 1 0 0 0-1 1z" />,
  readings: <path d="M2 12h3l2-6 3 9 2-5h2" />,
  data: (
    <>
      <ellipse cx="8" cy="4" rx="5" ry="2" />
      <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </>
  ),
  agents: (
    <>
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 2v3M6 9h0M10 9h0" />
    </>
  ),
  backup: <path d="M3 10v3h10v-3M8 2v8M5 7l3 3 3-3" />,
  profile: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="2" />
      <circle cx="6" cy="7" r="1.5" />
      <path d="M3.8 11c.4-1 1.2-1.6 2.2-1.6s1.8.6 2.2 1.6M9.5 6.5h2.5M9.5 9h2" />
    </>
  ),
  account: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5c.8-2.4 2.7-3.5 5-3.5s4.2 1.1 5 3.5" />
    </>
  ),
  review: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.5l2 1.5" />
    </>
  ),
  id: (
    <>
      <rect x="2.5" y="2.5" width="4" height="4" rx="1" />
      <rect x="9.5" y="2.5" width="4" height="4" rx="1" />
      <rect x="2.5" y="9.5" width="4" height="4" rx="1" />
      <path d="M9.5 9.5h1.5v1.5M13.5 9.5v4h-4" />
    </>
  ),
  inbox: <path d="M2.5 9.5 4 3.5h8l1.5 6v3.5h-11zM2.5 9.5h3.2l.8 1.5h3l.8-1.5h3.2" />,
  wifi: (
    <>
      <path d="M2 6.5a8.5 8.5 0 0 1 12 0M4.2 8.8a5.4 5.4 0 0 1 7.6 0M6.4 11a2.3 2.3 0 0 1 3.2 0" />
      <circle cx="8" cy="13" r=".6" />
    </>
  ),
  list: <path d="M2.5 4.5l1 1 2-2M2.5 10.5l1 1 2-2M7.5 4.5h6M7.5 10.5h6" />,
  link: (
    <>
      <rect x="2" y="4" width="5" height="8" rx="1.2" />
      <path d="M9.5 6.5a2 2 0 0 1 0 3M11.5 5a4 4 0 0 1 0 6" />
    </>
  ),
  about: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.2v3.8M8 5h0" />
    </>
  ),
  look: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11a5.5 5.5 0 0 0 0-11z" fill="currentColor" />
    </>
  ),
  add: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5.2v5.6M5.2 8h5.6" />
    </>
  ),
  more: <path d="M3.5 8h0M8 8h0M12.5 8h0" strokeWidth="2.2" />,
  shield: <path d="M8 2.2 3.2 4v3.6c0 3 2.1 5.2 4.8 6.2 2.7-1 4.8-3.2 4.8-6.2V4z" />,
  scale: <path d="M8 2.5v11M4.5 13.5h7M3 5h10M3 5 1.5 9h3zM13 5l-1.5 4h3z" />,
  device: (
    <>
      <rect x="2" y="3" width="12" height="8" rx="1.2" />
      <path d="M6 13.5h4M8 11v2.5" />
    </>
  ),
};
const Icon = ({ k, className = "h-5 w-5" }: { k: string; className?: string }) => (
  <svg className={`shrink-0 ${className}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICON[k]}
  </svg>
);

/** The address of a section ("readings" is the dashboard's). */
const pathOf = (p: Page) => (p === "readings" ? "dashboard" : p);
/** What an address shows: a section and the view inside it; the dashboard with a measure's history or a lab report. */
function fromRoute([a, b, ...c]: string[]): { page: Page; want?: string; metric?: string; rest?: string[] } {
  if (a === "metric" && b) return { page: "readings", metric: b };
  if (a === "report") return { page: "readings", want: b };
  if (a && a !== "dashboard" && (PAGES.some((x) => x.key === a) || a === "add" || a === "review" || a === "more")) return { page: a as Page, want: b, rest: c };
  return { page: "readings" };
}

/** Where a screen's way back leads when nothing in history is behind it: a measure or a lab report to the
 *  dashboard, a screen inside a section to that section, a section to the tab it was opened from. */
function parentOf(route: string[], tab: string): string {
  if (route[0] === "metric" || route[0] === "report") return "dashboard";
  return route.length > 1 ? route.slice(0, -1).map(encodeURIComponent).join("/") : tab;
}

/** The last section opened, remembered on this computer (a convenience: may be unavailable). */
function savedPage(): Page {
  try {
    const p = localStorage.getItem("page");
    // before data sources were one page
    if (p === "add" || p === "sources") return "data";
    return p && PAGES.some((x) => x.key === p) ? (p as Page) : "readings";
  } catch {
    return "readings";
  }
}

/** Loads `fn` now and after every committed write; returns [data, error, reload]. */
function useOp<T>(fn: () => Promise<T>, deps: unknown[]): [T | undefined, string | undefined, () => void] {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState<string>();
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // biome-ignore lint: deps are the caller's
  useEffect(() => {
    let live = true;
    fn().then(
      (d) => live && (setData(d), setErr(undefined)),
      (e: unknown) => live && setErr(e instanceof OpError ? `${e.code}: ${e.message}` : String(e)),
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  useEffect(() => onChange(reload), [reload]);
  return [data, err, reload];
}

/** The waiting screen while the data opens (as the web's 正在解密数据): a pulsing lock, why it takes a moment, and
 *  cards standing in for the page. `err` replaces the wait with what went wrong and a way to try again. */
function Hold({ title, body, err, retry }: { title: string; body: string; err?: string; retry?: () => void }) {
  return (
    <main className="mx-auto mt-[14vh] flex max-w-[26rem] flex-col items-center gap-2.5 px-4 text-center transition-opacity delay-300 duration-300 starting:opacity-0" role="status" aria-label={title}>
      <span className="mb-1.5 grid h-16 w-16 place-items-center rounded-full bg-primary/15 text-primary data-[pulse]:animate-pulse" data-pulse={err ? undefined : ""} aria-hidden="true">
        <svg className="h-5 w-5 shrink-0" viewBox="0 0 16 16" width="28" height="28">
          <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2M8 9.6v1.4" />
        </svg>
      </span>
      <p className="text-[17px] font-semibold">{title}</p>
      {err ? (
        <>
          <Problem text={err} />
          {retry && (
            <Btn type="button" primary onClick={retry}>
              {t("Try again")}
            </Btn>
          )}
        </>
      ) : (
        <>
          <p className="mb-1.5 max-w-[300px] text-sm leading-relaxed text-black/55 dark:text-white/55">{body}</p>
          <div className="mt-5 flex flex-col gap-3 self-stretch [&>span]:block [&>span]:h-32 [&>span]:animate-pulse [&>span]:rounded-2xl [&>span]:bg-black/5 dark:[&>span]:bg-white/10 [&>span:nth-child(2)]:h-24 [&>span:nth-child(3)]:h-40" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </>
      )}
    </main>
  );
}

const decrypting = () =>
  isMobile
    ? t("Your health data is stored encrypted on this device and is decrypted here each time you open Health. Just a moment.")
    : t("Your health data is stored encrypted on this computer and is decrypted here each time you open Health. Just a moment.");

/** Runs `fn` once per mount and again on `retry` (StrictMode's second mount reuses the call in flight). */
function useOnce(fn: () => Promise<void>): [string | undefined, () => void] {
  const [err, setErr] = useState<string>();
  const [round, setRound] = useState(0);
  const running = useRef<Promise<void> | undefined>(undefined);
  useEffect(() => {
    running.current ??= fn().finally(() => (running.current = undefined));
    running.current.catch((e) => setErr(errText(e)));
  }, [round]);
  return [err, () => (setErr(undefined), setRound((n) => n + 1))];
}

/** No data yet: it is created at once, as the web does (nothing to choose). */
function FirstRun({ done }: { done: () => void }) {
  const [err, retry] = useOnce(async () => {
    await initProfile();
    done();
  });
  return (
    <Hold
      title={t("Getting Health ready")}
      body={isMobile ? t("Your data will be kept encrypted on this device. Nothing is sent anywhere.") : t("Your data will be kept encrypted on this computer. Nothing is sent anywhere.")}
      err={err}
      retry={retry}
    />
  );
}

function Unlock({ done }: { done: () => void }) {
  const [p, setP] = useState("");
  const [err, setErr] = useState<string>();
  return (
    <main className="mx-auto mt-[16vh] max-w-md px-4">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await unlock(p);
            setP("");
            done();
          } catch (x) {
            setErr(x instanceof OpError && x.code === "bad_passphrase" ? t("That passphrase is not right.") : String(x));
          }
        }}
      >
        <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Health is locked")}</h2>
        <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Your data is encrypted with your passphrase. It locks again after a while without use.")}</p>
        <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
          {t("Passphrase")}
          <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" type="password" autoComplete="current-password" autoFocus value={p} onChange={(e) => setP(e.target.value)} required />
        </label>
        <Problem text={err} />
        <Btn type="submit" primary>
          {t("Unlock")}
        </Btn>
      </form>
    </main>
  );
}

/** Opening Health: asks the core how the data is, then opens it (a phone unlocks it as Health opens; a computer
 *  may ask for the passphrase) or creates it. Only then is the app drawn, so nothing it reads runs against data
 *  that's still shut (no screen first drawn and then taken back, no "locked" left on it). One screen throughout:
 *  the page's background, then "Decrypting" if it takes a moment. */
export function App() {
  const [status, err, reload] = useOp(() => op<Status>("status"), []);
  const [core, setCore] = useState<{ up: boolean; error?: string; need_init?: boolean }>({ up: true });
  useEffect(() => onStatus((s) => (setCore(s), reload())), [reload]);
  const starting = !core.up || err?.startsWith("unavailable:");
  // the start-up event can fire before the listener exists: ask again until the core answers
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(reload, 1000);
    return () => clearInterval(t);
  }, [starting, reload]);
  // a phone has no passphrase: its data opens as Health opens (Face ID / fingerprint will come first, in the shell)
  const locked = !!err?.startsWith("locked:");
  const [unlockErr, setUnlockErr] = useState<string>();
  const unlocking = useRef(false);
  const autoUnlock = useCallback(() => {
    if (unlocking.current) return; // StrictMode's second run
    unlocking.current = true;
    setUnlockErr(undefined);
    unlock("")
      .then(reload, (e) => setUnlockErr(errText(e)))
      .finally(() => (unlocking.current = false));
  }, [reload]);
  useEffect(() => {
    if (locked && isMobile) autoUnlock();
  }, [locked, autoUnlock]);
  // the dashboard's background, fetched while the data opens
  useEffect(() => void Object.assign(new Image(), { src: matchMedia("(prefers-color-scheme: dark)").matches ? meadowDark : meadowLight }), []);
  if (locked && !isMobile) return <Unlock done={reload} />;
  if (core.need_init || err?.includes("no_profile")) return <FirstRun done={reload} />;
  if (starting || locked || (!status && !err))
    return (
      <>
        <Hold title={t("Decrypting your data")} body={decrypting()} err={core.error ?? unlockErr} retry={unlockErr ? autoUnlock : undefined} />
        {/* a database that no longer opens: starting over is one way out */}
        {core.error && isDesktop && (
          <div className="mx-auto mt-[16vh] max-w-md px-4">
            <ClearDataRow />
          </div>
        )}
      </>
    );
  return <Shell />;
}

/** The app, once its data is open. */
function Shell() {
  // redraw everything when the language changes; the menu bar follows
  const { i18n } = useTranslation();
  useEffect(() => setShellLanguage(i18n.language), [i18n.language]);
  // the page, the view inside it, the measure or report open on the dashboard: all from the address
  const route = useRoute();
  const { page, want, metric, rest } = fromRoute(route);
  // no address yet (the app just opened): the dashboard, or on a computer the section opened last
  useEffect(() => {
    if (!route.length) nav(pathOf(isMobile ? "readings" : savedPage()), true);
  }, [route.length]);
  const setPage = (p: Page, w?: string) => nav(w ? `${pathOf(p)}/${w}` : pathOf(p), TABS.some((x) => x.key === p) && !w);
  // ⌘F asks Readings to focus its search; Readings clears the request once its search box exists
  const [find, setFind] = useState(false);
  useEffect(() => {
    try {
      if (PAGES.some((x) => x.key === page)) localStorage.setItem("page", page);
    } catch {}
  }, [page]);
  const setMetric = (code: string) => nav(`metric/${encodeURIComponent(code)}`, !!metric);
  useInbox();
  const [status] = useOp(() => op<Status>("status"), []);
  const syncLive = useSyncLive();
  const [latest, latestErr] = useOp(() => op<Point[]>("obs.latest"), []);
  const [cats, setCats] = useState(true);
  // a screen opens at its top, wherever the last one was scrolled to
  useLayoutEffect(() => toTop(), [route.join("/")]);
  // Android: the content's own rubber band (overscroll.ts); iOS bounces scrolling content natively
  const band = useRef<(() => void) | undefined>(undefined);
  const { dark } = useAppearance();
  const mainEl = useCallback((el: HTMLElement | null) => {
    band.current?.();
    band.current = el && isAndroid ? rubberBand(el) : undefined;
  }, []);
  // narrow screens: the tab a section was opened from, where its back button returns
  const tab = useRef<Tab>("readings");
  useEffect(() => {
    if (TABS.some((x) => x.key === page)) tab.current = page as Tab;
  }, [page]);
  // the category scrolled into view on Readings (null: its top)
  const [inView, setInView] = useState<string | null>(null);
  const [dropped, setDropped] = useState<string>();
  const [hovering, setHovering] = useState(false);
  // a file dropped anywhere on the window opens Import with it
  useEffect(
    () =>
      onFileDrop({
        over: setHovering,
        drop: (paths) => {
          if (!paths[0]) return;
          if (dropInto) return dropInto(paths[0]);
          setDropped(paths[0]);
          setPage("data");
        },
      }),
    [],
  );
  useEffect(() => setBadge(status?.reviews ?? 0), [status?.reviews]);
  // the same commands from the macOS menu or, elsewhere, from the keyboard
  const command = useCallback((id: string) => {
    // a section's address replaces whatever was open in the last one
    if (PAGES.some((x) => x.key === id)) setPage(id as Page);
    else if (id === "add") setPage("add");
    else if (id === "back") goBack(parts().slice(0, -1).join("/") || "dashboard");
    else if (id === "find") {
      setPage("readings");
      setFind(true);
    } else if (id === "import")
      chooseImportFile().then((f) => {
        if (f) {
          setDropped(f);
          setPage("data");
        }
      });
  }, []);
  useEffect(() => onMenu(command), [command]);
  useEffect(() => {
    if (menuOwnsKeys) return;
    const keys: Record<string, string> = Object.fromEntries([
      ...PAGES.map((p, i) => [String(i + 1), p.key]),
      ["f", "find"],
      ["o", "import"],
      ["[", "back"],
    ]);
    const down = (e: KeyboardEvent) => {
      const id = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey ? keys[e.key.toLowerCase()] : e.altKey && e.key === "ArrowLeft" ? "back" : undefined;
      if (id && !(id === "import" && !isDesktop)) {
        e.preventDefault();
        command(id);
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [command]);
  // desktop: no browser context menu (Reload, Inspect) except where text is edited or selected
  useEffect(() => {
    if (!isDesktop) return;
    const menu = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("input, textarea, pre, code") && !window.getSelection()?.toString()) e.preventDefault();
    };
    document.addEventListener("contextmenu", menu);
    return () => document.removeEventListener("contextmenu", menu);
  }, []);
  const open = (code: string) => setMetric(code);
  const present = HOME_GROUPS.filter((g) => latest?.some((p) => p.category === g.key));
  const syncAsking = !!syncLive?.peers.some((x) => x.state === "asking");
  const isTab = TABS.some((x) => x.key === page);
  // the side panel (a wide screen): Konsta has none, so it is drawn here
  const navButton = (on: boolean, label: ReactNode, icon: ReactNode, onClick: () => void, extra?: ReactNode, hint?: string, current?: "page" | "location") => (
    <button
      type="button"
      className={`select-none flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-[15px] ${on ? "bg-primary font-medium text-white" : "hover:bg-black/5 dark:hover:bg-white/10"}`}
      aria-current={current}
      onClick={onClick}
      title={hint}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {extra}
    </button>
  );
  const navItem = (p: { key: Page; label: string }, hint?: string, quiet = false) => (
    <li key={p.key}>
      {navButton(
        page === p.key && !quiet,
        t(p.label),
        <Icon k={p.key} />,
        () => setPage(p.key),
        <>
          {p.key === "review" && status && status.reviews > 0 && <span className="inline-block min-w-5 rounded-full bg-brand-red px-1.5 text-center text-xs font-semibold text-white">{status.reviews}</span>}
          {p.key === "account" && syncAsking && <span className="inline-block h-2 w-2 rounded-full bg-brand-red align-middle" role="img" aria-label={t("Waiting for you")} />}
        </>,
        hint,
        page === p.key ? "page" : undefined,
      )}
    </li>
  );
  const railHead = "px-3 pb-1 text-[13px] font-semibold text-black/45 dark:text-white/45";
  const hint = (k: Page) => {
    const i = PAGES.findIndex((x) => x.key === k);
    return `${t(PAGES[i]!.label)} (${MOD}${i + 1})`;
  };
  const dash = page === "readings";
  return (
    <div className="relative min-h-dvh text-black wide:grid wide:grid-cols-[300px_minmax(0,1fr)] dark:text-white">
      {/* the dashboard's morning meadow (dusk when dark), pre-blurred; elsewhere the grouped background */}
      <div
        className="fixed inset-0 -z-10 bg-[length:100%_100%] bg-center ios:bg-[#f2f2f7] ios:dark:bg-black material:bg-md-light-surface-2 material:dark:bg-md-dark-surface"
        style={dash ? { backgroundImage: `url(${dark ? meadowDark : meadowLight})` } : undefined}
        aria-hidden="true"
      />
      {isDesktop && MAC && <div className="fixed inset-x-0 top-0 z-50 h-[52px]" data-tauri-drag-region />}
      {hovering && (
        <div className="fixed inset-0 z-50 grid place-content-center gap-1 bg-primary/15 text-center backdrop-blur-sm" aria-hidden="true">
          <p className="text-[17px] font-semibold">{t("Drop to import")}</p>
          <p className="text-[13px] text-black/55 dark:text-white/55">{t("Apple Health export, Health backup, WHOOP data")}</p>
        </div>
      )}
      <nav
        className={`sticky top-3 m-3 mr-0 hidden h-[calc(100dvh-24px)] flex-col gap-4 overflow-y-auto rounded-[22px] p-3 shadow-xl select-none wide:flex ${MAC && isDesktop ? "pt-14" : ""} ${dash ? "bg-white/80 dark:bg-neutral-900/80" : "bg-white dark:bg-neutral-900"}`}
        aria-label={t("Sections")}
      >
        <ul className="flex flex-col gap-0.5">
          {navItem(PAGES[0]!, hint("readings"), page === "readings" && !!inView)}
          {navItem({ key: "add", label: tk("Add") })}
          {status && status.reviews > 0 && navItem({ key: "review", label: tk("Waiting for you") })}
        </ul>
        {present.length > 0 && (
          <div>
            <button type="button" className={`select-none ${railHead} flex w-full items-center justify-between`} aria-expanded={cats} onClick={() => setCats(!cats)}>
              {t("Categories")}
              <Chevron open={cats} />
            </button>
            {cats && (
              <ul className="flex flex-col gap-0.5">
                {present.map((g) => (
                  <li key={g.key}>
                    {navButton(
                      page === "readings" && inView === g.key,
                      t(g.label),
                      <GroupIcon k={g.key} />,
                      () => {
                        setPage("readings");
                        // marked at once: a short page can't scroll the section to the top
                        requestAnimationFrame(() => {
                          document.getElementById(`g-${g.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                          setInView(g.key);
                        });
                      },
                      undefined,
                      undefined,
                      page === "readings" && inView === g.key ? "location" : undefined,
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div>
          <p className={railHead}>{t("Your data")}</p>
          <ul className="flex flex-col gap-0.5">
            {navItem(PAGES[1]!, hint("data"))}
            {navItem(PAGES[2]!, hint("backup"))}
          </ul>
        </div>
        <div>
          <p className={railHead}>{t("Me")}</p>
          <ul className="flex flex-col gap-0.5">
            {navItem(PAGES[3]!, hint("profile"))}
            {navItem(PAGES[4]!, hint("account"))}
          </ul>
        </div>
        {/* agent apps on this computer; a phone opens its own LAN interface to agents instead (later) */}
        {!isMobile && (
          <div>
            <p className={railHead}>{t("Sharing")}</p>
            <ul className="flex flex-col gap-0.5">{navItem(PAGES[5]!, hint("agents"))}</ul>
          </div>
        )}
        <ul className="flex flex-col gap-0.5">{navItem(PAGES[6]!, hint("about"))}</ul>
        <div className="mt-auto grid gap-2 px-2 text-xs">
          <Totals status={status} />
          <LangSelect small />
        </div>
      </nav>
      <main
        id="content"
        className={`h-dvh min-w-0 overflow-y-auto px-4 pb-[calc(var(--k-safe-area-bottom)+108px)] wide:h-auto wide:overflow-visible wide:px-9 wide:pt-6 wide:pb-16 ${MAC && isDesktop ? "wide:pt-[4.4rem]" : ""}`}
        ref={mainEl}
      >
        {/* the top bar (Konsta's): a phone's every screen; a wide window's screens inside a section (its side panel
            leads to the sections). A screen under a tab has the way back. */}
        <TopBar
          className={route.length > 1 ? "" : "wide:hidden"}
          back={route.length > 1 || !isTab ? () => goBack(parentOf(route, pathOf(tab.current))) : undefined}
        />
        <div key={`${page}-${i18n.language}`}>
          {metric && <Record code={metric} pick={setMetric} />}
          {page === "readings" && !metric && (
            <Readings
              latest={latest}
              err={latestErr}
              open={open}
              go={(p) => setPage(p)}
              want={want}
              reviews={status?.reviews ?? 0}
              find={find}
              found={() => setFind(false)}
              onSection={setInView}
              start={(p, w) => {
                setPage(p, w);
              }}
            />
          )}
          {page === "add" && (
            <AddPage
              go={(p, w) => {
                setPage(p, w);
              }}
              done={open}
            />
          )}
          {page === "data" && <DataSources file={dropped} onFile={setDropped} go={(p) => setPage(p)} done={open} want={want} path={rest} />}
          {page === "review" && <Review />}
          {page === "agents" && <Agents want={want} path={rest} />}
          {page === "backup" && <Backup want={want} />}
          {page === "profile" && <ProfilePage want={want} />}
          {page === "account" && <HealthAccount go={(p) => setPage(p)} want={want} />}
          {page === "about" && <About version={status?.version} want={want} />}
          {page === "more" && (
            <More
              go={(p, w) => {
                setPage(p, w);
              }}
              status={status}
              syncAsking={syncAsking}
            />
          )}
        </div>
      </main>
      <Tabbar labels icons className="fixed! bottom-0 left-0 wide:hidden">
        <ToolbarPane>
        {TABS.map((x) => (
          // a section opened from a tab keeps that tab marked
          <TabbarLink
            key={x.key}
            active={page === x.key || (!isTab && tab.current === x.key)}
            onClick={() => setPage(x.key)}
            icon={
              <span className="relative">
                <Icon k={x.icon} className="h-6 w-6" />
                {x.key === "more" && ((status?.reviews ?? 0) > 0 || syncAsking) && (
                  <span className="absolute -end-1 -top-0.5 inline-block h-2 w-2 rounded-full bg-brand-red" role="img" aria-label={t("Waiting for you")} />
                )}
              </span>
            }
            label={t(x.label)}
          />
        ))}
        </ToolbarPane>
      </Tabbar>
    </div>
  );
}

/** Scrolls the page to its top: the window on a wide screen, the content (its own scroller) on a narrow one. */
function toTop() {
  window.scrollTo(0, 0);
  document.getElementById("content")?.scrollTo(0, 0);
}

/** How much is here: the side panel's foot, More's on narrow screens. */
function Totals({ status }: { status?: Status }) {
  const { i18n } = useTranslation();
  if (!status) return null;
  return (
    <p className="text-[13px] text-black/55 dark:text-white/55">
      {t("{{obs}} entries from {{count}} sources", {
        obs: status.observations.toLocaleString(i18n.language),
        count: status.sources,
      })}
    </p>
  );
}

/** One choice among a few: a touch screen gets a page of them with a tick (as Settings' lists), a mouse the menu. */
function Choice<K extends string>({
  label,
  value,
  options,
  onChange,
  icon,
  color,
  small,
}: {
  label: string;
  value: K;
  options: { key: K; label: string }[];
  onChange: (k: K) => void;
  icon?: ReactNode;
  color?: string;
  /** the side panel's foot: a line of small text, not a row */
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.key === value)?.label;
  return (
    <>
      {small ? (
        <button type="button" className="select-none flex w-full items-center justify-between gap-2 py-1 text-[13px] text-black/55 dark:text-white/55" onClick={() => setOpen(true)}>
          {label}
          <span className="inline-flex items-center gap-1">
            {current}
            <Chevron open={false} />
          </span>
        </button>
      ) : (
        <Item icon={icon} color={color} title={label} after={current} onClick={() => setOpen(true)} />
      )}
      {open && (
        <Sheet label={label} close={() => setOpen(false)}>
          <h2 className="mb-4 text-[28px] leading-tight font-bold tracking-tight">{label}</h2>
          <Group role="radiogroup" aria-label={label}>
            {options.map((o) => (
              <Item
                key={o.key}
                role="radio"
                aria-checked={value === o.key}
                title={o.label}
                chevron={false}
                after={
                  value === o.key ? (
                    <svg className="h-5 w-5 text-primary" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 8.5l3.2 3L13 4.5" />
                    </svg>
                  ) : null
                }
                onClick={() => {
                  setOpen(false);
                  onChange(o.key);
                }}
              />
            ))}
          </Group>
        </Sheet>
      )}
    </>
  );
}

/** The language choice: a row (More), or a small line (the side panel's foot). */
function LangSelect({ small }: { small?: boolean }) {
  return (
    <Choice
      label={t("Language")}
      icon={<Icon k="list" />}
      color="#8e24aa"
      small={small}
      value={choice()}
      options={LANGS.map((l) => ({ key: l.key, label: l.key === "system" ? t("System") : l.label }))}
      onChange={(k) => void choose(k)}
    />
  );
}

/** How the app looks: the platform's own (and the system's dark mode), or either look, light or dark, chosen to
 *  review it on this device. */
function LookSelect() {
  const value = useLook();
  const options: { key: Look; label: string }[] = [
    { key: "auto", label: t("Automatic") },
    { key: "ios-light", label: t("iOS style, light") },
    { key: "ios-dark", label: t("iOS style, dark") },
    { key: "material-light", label: t("Android style, light") },
    { key: "material-dark", label: t("Android style, dark") },
  ];
  return <Choice label={t("Appearance")} icon={<Icon k="look" />} color="#c2185b" value={value} options={options} onChange={setLook} />;
}

/** More (narrow screens), as the web's 更多: one card per part (profile, data sources, backup and export, other
 *  devices, about), each row opening its section at the right place. */
function More({ go, status, syncAsking }: { go: (p: Page, want?: string) => void; status?: Status; syncAsking: boolean }) {
  const reviews = status?.reviews ?? 0;
  // each row says how things stand, as Settings does, not what the section is for
  const [me] = useOp(() => op<Personal>("profile.get"), []);
  const [whoop] = useOp(() => op<WhoopStatus>("whoop.status"), []);
  const [batches] = useOp(() => op<Batch[]>("import.list"), []);
  const [sync] = useOp(() => op<SyncShown>("sync.state"), []);
  const lastOf = (connector: string) => {
    const at = Math.max(0, ...(batches ?? []).filter((b) => b.connector === connector).map((b) => b.at ?? 0));
    return at ? t("Last import {{when}}", { when: shortDate(at) }) : batches ? t("Not imported yet") : undefined;
  };
  const profile = [sexLabel(me?.sex), me?.birth ? birthLabel(me.birth) : undefined].filter(Boolean).join(" · ") || (me ? t("Not set") : undefined);
  const whoopText =
    whoop?.state === "connected"
      ? whoop.last_sync
        ? t("Synced {{when}}", { when: ago(whoop.last_sync) })
        : t("Connected")
      : whoop?.state === "reauth"
        ? t("Sign in again")
        : whoop
          ? t("Not connected")
          : undefined;
  const syncText = sync ? (sync.enabled ? t("On · {{n}} devices", { n: sync.peers.length }) : t("Off")) : undefined;
  const row = (color: string, icon: ReactNode, label: string, p: Page, want?: string, text?: string, value?: ReactNode) => (
    <Row key={label} color={color} icon={icon} label={label} sub={text} value={value} onClick={() => go(p, want)} />
  );
  return (
    <section className="mx-auto w-full max-w-3xl">
      <h2 className="mb-4 text-[28px] leading-tight font-bold tracking-tight">{t("More")}</h2>
      {reviews > 0 && (
        <Callout icon={<Icon k="review" />} title={t("{{count}} imports are waiting for you to check.", { count: reviews })} text={t("Nothing counts until you confirm it.")} onClick={() => go("review")} />
      )}
      <Group>{row("#7c4dff", <Icon k="profile" />, t("Profile"), "profile", undefined, profile)}</Group>
      <Group title={t("Data sources")}>
        {row("#1e88e5", <Icon k="data" />, t("Manage data"), "data", "manage", status ? t("{{obs}} entries from {{count}} sources", { obs: status.observations.toLocaleString(), count: status.sources }) : undefined)}
        {row("#e53935", <GroupIcon k="cardio" />, "WHOOP", "data", "whoop", whoopText)}
        {row("#f4511e", <GroupIcon k="activity" />, t("Apple Health"), "data", "apple", lastOf("apple_health"))}
        {row("#00897b", <GroupIcon k="lab" />, t("Lab report"), "data", "report", lastOf("ocr"))}
        {row("#43a047", <GroupIcon k="infectious" />, t("Lab self-service"), "data", "lab", t("A code for a lab device"))}
      </Group>
      <Group title={t("Backup and export")}>
        {row("#fb8c00", <Icon k="backup" />, t("Save a backup"), "backup", "save", t("Encrypted with a password you choose"))}
        {row("#fb8c00", <Icon k="data" />, t("Restore a backup"), "backup", "restore", t("Merges; nothing is overwritten"))}
        {row("#6d4c41", <GroupIcon k="other" />, t("Export a table (CSV)"), "backup", "csv", t("Unencrypted, for spreadsheets and other tools"))}
      </Group>
      <Group title={t("Other devices")}>
        {row("#3949ab", <Icon k="account" />, t("Health account"), "account", undefined, syncAsking ? t("Waiting for you") : undefined, syncAsking ? <span className="inline-block h-2 w-2 rounded-full bg-brand-red" role="img" aria-label={t("Waiting for you")} /> : undefined)}
        {row("#039be5", <Icon k="wifi" />, t("Local network sync"), "account", "sync", syncText)}
        {row("#5e35b1", <Icon k="link" />, t("Connect another device"), "account", "connect")}
      </Group>
      {/* agent apps on this computer (a narrow desktop window) */}
      {!isMobile && <Group title={t("Sharing")}>{row("#546e7a", <Icon k="agents" />, t("Agent access"), "agents")}</Group>}
      <Group title={t("About")}>
        {row("#00897b", <Icon k="shield" />, t("Privacy"), "about", "privacy", isMobile ? t("Your data is stored encrypted on this device") : t("Your data is stored encrypted on this computer"))}
        {row("#757575", <Icon k="scale" />, t("Open-source licenses"), "about", "licenses")}
        <LookSelect />
        <LangSelect />
        <Item color="#9e9e9e" icon={<Icon k="about" />} title={t("Version")} after={status?.version ?? "–"} />
      </Group>
    </section>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    className={`h-3 w-3 shrink-0 fill-none stroke-current transition-transform [stroke-width:1.8] ${open ? "rotate-90" : ""}`}
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <path d="M6 4l4 4-4 4" />
  </svg>
);

const WEB_VERSION = "https://zuchiangmai.com/health";
const WHOOP_DASHBOARD = "https://developer-dashboard.whoop.com/";

/** A link to a web page, opened in the default browser (never inside the app window). */
function WebLink({ url, label }: { url: string; label?: string }) {
  return (
    <a
      href={url}
      onClick={(e) => {
        e.preventDefault();
        openLink(url);
      }}
    >
      {label ?? url.replace(/^https:\/\//, "").replace(/\/$/, "")}
    </a>
  );
}

/** The top bar, Konsta's as each platform has it: over the screen's large heading only the way back; scrolled, the
 *  content under it blurs and fades (iOS) or the bar takes its surface (Material), and the screen's name shows in it.
 *  The name is the screen's own heading (its first h2), so no screen has to say it twice. */
function TopBar({ back, className = "" }: { back?: () => void; className?: string }) {
  const { theme } = useAppearance();
  const [title, setTitle] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const main = ref.current?.parentElement;
    if (!main) return;
    const read = () => setTitle(main.querySelector("h2")?.textContent ?? "");
    read();
    const watch = new MutationObserver(read);
    watch.observe(main, { childList: true, subtree: true, characterData: true });
    return () => watch.disconnect();
  }, []);
  return (
    <Navbar
      ref={ref}
      transparent
      title={title}
      className={`-mx-4 w-[calc(100%+2rem)]! wide:-mx-9 wide:-mt-6 wide:w-[calc(100%+4.5rem)]! ${className}`}
      innerClassName="wide:mx-auto wide:max-w-3xl wide:px-0!"
      left={back && <NavbarBackLink text={t("Back")} showText={theme === "ios"} onClick={back} />}
    />
  );
}

/** A screen's heading, and the screen under it. */
function Screen({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-3xl">
      <h2 className="mb-4 text-[28px] leading-tight font-bold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

/** A layer over the screen with no address of its own (a choice, a confirmation): the whole screen on a phone, a
 *  large window on a wide one, with the same way back at the top. Escape, the backdrop and the system's back
 *  (Android) close it too. */
function Sheet({ label, close: done, children }: { label: string; close: () => void; children: ReactNode }) {
  const close = useLayer(done);
  // slides in once it's on the page
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setOpened(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const closing = useRef(close);
  closing.current = close;
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && closing.current();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const wide = useWide();
  const { theme } = useAppearance();
  const body = (
    <KPage>
      <Navbar transparent title={label} left={<NavbarBackLink text={t("Back")} showText={theme === "ios"} onClick={close} />} />
      <div className="px-4 pt-2 pb-[calc(var(--k-safe-area-bottom)+32px)] md:px-6">{children}</div>
    </KPage>
  );
  // a wide window: a large window over the page; a phone: a page of its own, pushed in from the side
  return createPortal(
    wide ? (
      <Popup opened={opened} onBackdropClick={close} aria-label={label} className="md:h-[min(88dvh,960px)] md:w-[min(860px,calc(100vw-3rem))]">
        {body}
      </Popup>
    ) : (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`fixed inset-0 z-40 transition-transform duration-300 ease-out ${opened ? "translate-x-0" : "translate-x-full"}`}
      >
        {body}
      </div>
    ),
    // inside Konsta's App, as its sheets are meant to be: its look and safe areas apply
    document.querySelector(".k-app") ?? document.body,
  );
}

/** "code: message" from the core, in words a person can act on. */
function human(text: string): string {
  const m = /^([a-z_]+): ?(.*)$/s.exec(text);
  return m ? explain(m[1]!, m[2]) : text;
}
const errText = (e: unknown) => (e instanceof OpError ? explain(e.code, e.message) : String(e));

function Problem({ text }: { text?: string }) {
  return text ? (
    <p className="text-[15px] text-brand-red" role="alert">
      {human(text)}
    </p>
  ) : null;
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Btn
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2500);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? t("Copied") : label}
    </Btn>
  );
}

function PasswordField({ label, value, onChange, auto }: { label: string; value: string; onChange: (v: string) => void; auto: string }) {
  const [show, setShow] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id}>{label}</label>
      <span className="flex items-center gap-2.5 [&_input]:flex-1">
        <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" id={id} type={show ? "text" : "password"} autoComplete={auto} value={value} onChange={(e) => onChange(e.target.value)} required />
        <Btn type="button" link aria-label={show ? t("Hide {{field}}", { field: label }) : t("Show {{field}}", { field: label })} aria-pressed={show} onClick={() => setShow(!show)}>
          {show ? t("Hide") : t("Show")}
        </Btn>
      </span>
    </div>
  );
}

/** Where a file dropped on the desktop window goes: the picker on screen, if there is one (else Data sources). */
let dropInto: ((path: string) => void) | undefined;

type PickKind = "report" | "apple" | "restore" | "file";

/** The ways to pick a file, the same on every device: a lab report from the camera, the photos or the files; an
 *  export or a backup from the files. The desktop's dialog imports a file where it is; a phone's picker (and the
 *  browser preview) hands its bytes over first. A screen without a finger takes a file dropped on it too. */
function FilePick({ path, onPath, kind }: { path?: string; onPath: (p: string) => void; kind: PickKind }) {
  const [name, setName] = useState<string>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const take = async (f?: File | null) => {
    if (!f) return;
    setErr(undefined);
    setBusy(true);
    try {
      onPath(await stageFile(f));
      setName(f.name);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const chosen = (p: string) => (setName(undefined), onPath(p));
  const latest = useRef(chosen);
  latest.current = chosen;
  useEffect(() => {
    if (isTouch) return;
    dropInto = (p) => latest.current(p);
    return () => void (dropInto = undefined);
  }, []);
  // one row: the desktop's open dialog, or the system's picker behind a hidden input
  const row = (icon: string, color: string, title: string, accept: string | undefined, types: keyof typeof FILE_TYPES, capture?: boolean) =>
    isDesktop ? (
      <Item key={title} color={color} icon={<Icon k={icon} />} title={title} onClick={async () => { const p = await chooseImportFile(types); if (p) chosen(p); }} />
    ) : (
      <label key={title} className="select-none flex min-h-[64px] w-full cursor-pointer items-center gap-4 px-4 py-3 transition-colors active:bg-black/5 dark:active:bg-white/10">
        <IconDot color={color}>
          <Icon k={icon} />
        </IconDot>
        <span className="min-w-0 flex-1 text-[17px] material:text-[16px]">{title}</span>
        <input type="file" hidden accept={accept} capture={capture ? "environment" : undefined} onChange={(e) => void take(e.target.files?.[0])} />
      </label>
    );
  return (
    <div aria-busy={busy}>
      {path && (
        <Group>
          <Item icon={<Icon k="data" />} title={name ?? fileName(path)} text={t("Chosen")} />
        </Group>
      )}
      <Group title={path ? t("Choose another file…") : undefined}>
        {kind === "report" && isTouch && row("camera", "#0a7397", t("Take a photo"), "image/*", "photo", true)}
        {kind === "report" && row("photos", "#43a047", t("Choose from photos"), "image/*", "photo")}
        {row("folder", "#1e88e5", t("Choose from files"), kind === "report" ? "image/*,application/pdf" : kind === "apple" ? ".zip,application/zip" : undefined, kind)}
      </Group>
      {!isTouch && (
        <div
          className={`mb-5 rounded-3xl border-[1.5px] border-dashed px-4 py-6 text-center text-[15px] text-black/55 dark:text-white/55 ${over ? "border-primary bg-primary/10" : "border-black/20 dark:border-white/20"}`}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void take(e.dataTransfer.files[0]);
          }}
        >
          {t("Or drag a file here.")}
        </div>
      )}
      <Problem text={err} />
    </div>
  );
}

interface FileResult {
  written: number;
  added: number;
  sources: number;
  apple?: { records: number; broken: number; skipped_types: Record<string, number> };
}
interface BackupResult {
  added_imports: number;
  erased_imports: number;
  refused_imports: number;
  refused_corrections: number;
  skipped_metrics: string[];
  missing_blobs: string[];
  restored_blobs: number;
}

/** A card's title, with one button that turns every switch in it on (or, when all are on, off). */
function CardHead({ title, on, set }: { title: string; on: boolean; set: (on: boolean) => void }) {
  return (
    <div className="mt-6 mb-2 flex items-center justify-between px-4">
      <h4 className="text-[13px] font-semibold text-black/55 dark:text-white/55">{title}</h4>
      <Btn type="button" link onClick={() => set(!on)}>
        {on ? t("Select none") : t("Select all")}
      </Btn>
    </div>
  );
}

/** A grouped row with a switch on the right (System Settings); the whole row toggles it. */
function SwitchRow({ icon, label, sub, on, set }: { icon?: ReactNode; label: string; sub?: string; on: boolean; set: (on: boolean) => void }) {
  return (
    <Item
      icon={icon}
      title={label}
      text={sub}
      role="switch"
      aria-checked={on}
      chevron={false}
      onClick={() => set(!on)}
      after={<Toggle component="span" className="pointer-events-none" checked={on} readOnly />}
    />
  );
}

/** A row that opens something: its symbol on a coloured circle, its name, a line of state, a value at the end. */
function Row({ icon, color, label, sub, value, onClick }: { icon: ReactNode; color?: string; label: string; sub?: string; value?: ReactNode; onClick: () => void }) {
  return <Item icon={icon} color={color} title={label} text={sub} after={value} onClick={onClick} />;
}

/** The lab report just read: Waiting for you shows it first. */
let justRead: number | undefined;

const SOURCE_SHEETS = ["manage", "whoop", "apple", "report", "lab", "restore", "manual", "file"] as const;
type SourceSheet = (typeof SOURCE_SHEETS)[number];
/** Data sources (as the web's 更多 › 数据来源): managing what is here first, then one row per way data comes
 *  in, each with its live status; the steps open in a sheet. A file dropped on the window opens here. */
function DataSources({
  file,
  onFile,
  go,
  done,
  want,
  path,
}: {
  file?: string;
  onFile: (p?: string) => void;
  go: (p: Page) => void;
  done: (code: string) => void;
  /** The way in open (#/data/whoop), and the address under it (#/data/manage/ocr/5) */
  want?: string;
  path?: string[];
}) {
  // the way in open is the address's (#/data/whoop), a screen of its own
  const sheet = SOURCE_SHEETS.find((x) => x === want);
  const setSheet = (x: SourceSheet) => nav(`data/${x}`);
  const [batches] = useOp(() => op<Batch[]>("import.list"), []);
  const [whoop] = useOp(() => op<WhoopStatus>("whoop.status"), []);
  useEffect(() => {
    if (file && !sheet) setSheet("file");
  }, [file]);
  const lastOf = (connector: string) => {
    const at = Math.max(0, ...(batches ?? []).filter((b) => b.connector === connector).map((b) => b.at ?? 0));
    return at ? t("Last import {{when}}", { when: shortDate(at) }) : batches ? t("Not imported yet") : undefined;
  };
  const whoopValue =
    whoop?.state === "connected"
      ? whoop.last_sync
        ? t("Synced {{when}}", { when: ago(whoop.last_sync) })
        : t("Connected")
      : whoop?.state === "reauth"
        ? t("Sign in again")
        : t("Not connected");
  const titles: Record<SourceSheet, string> = {
    manage: t("Manage data"),
    whoop: "WHOOP",
    apple: t("Apple Health"),
    report: t("Lab report"),
    lab: t("Lab self-service"),
    restore: t("Restore a backup"),
    manual: t("Enter by hand"),
    file: t("Import a file"),
  };
  if (sheet === "manage") return <Sources go={go} path={path ?? []} />;
  if (sheet === "whoop") return <Screen title="WHOOP"><WhoopConnect /></Screen>;
  if (sheet === "lab") return <LabSelfService errText={errText} showResults={() => go("readings")} showIdentity={() => go("account")} pollFast={pollFast} path={path ?? []} />;
  if (sheet === "manual") return <Enter done={done} />;
  if (sheet) return <Import file={file} onFile={onFile} go={go} kind={sheet} title={titles[sheet]} />;
  return (
    <section className="mx-auto w-full max-w-3xl">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Data sources")}</h2>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{(isMobile ? t("Your data on this device.") : t("Your data on this computer. Drop a file anywhere on the window to import it."))}</p>
      <Group>
        <Row
          color="#1e88e5" icon={<Icon k="data" />}
          label={t("Manage data")}
          sub={t("See and delete imports")}
          value={batches ? t("{{count}} imports", { count: batches.length }) : undefined}
          onClick={() => setSheet("manage")}
        />
      </Group>
      <Group>
        <Row color="#e53935" icon={<GroupIcon k="cardio" />} label="WHOOP" sub={whoopValue ?? t("Syncs every hour while Health is open")} onClick={() => setSheet("whoop")} />
        <Row color="#f4511e" icon={<GroupIcon k="activity" />} label={t("Apple Health")} sub={lastOf("apple_health") ?? t("Export from your iPhone")} onClick={() => setSheet("apple")} />
        <Row color="#00897b" icon={<GroupIcon k="lab" />} label={t("Lab report")} sub={lastOf("ocr") ?? t("A photo or a PDF")} onClick={() => setSheet("report")} />
        <Row color="#43a047" icon={<GroupIcon k="infectious" />} label={t("Lab self-service")} sub={t("A code for a lab device")} onClick={() => setSheet("lab")} />
        <Row color="#fb8c00" icon={<Icon k="backup" />} label={t("Restore a backup")} sub={t("A .zuhealth file")} onClick={() => setSheet("restore")} />
        <Row color="#7c4dff" icon={<GroupIcon k="body" />} label={t("Enter by hand")} sub={lastOf("manual") ?? t("Write down a reading")} onClick={() => setSheet("manual")} />
      </Group>
    </section>
  );
}

/** Add (a tab on a phone), as the web's 记录: a lab report from the camera or a file, or a reading entered by hand
 *  after a search. The other ways in (WHOOP, Apple Health, backups, lab devices) are in Data sources. */
function AddPage({ go, done }: { go: (p: Page, want?: string) => void; done: (code: string) => void }) {
  const [file, setFile] = useState<string>();
  return (
    <section className="mx-auto w-full max-w-3xl">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Add")}</h2>
      <Import file={file} onFile={setFile} go={go} kind="report" title={t("Lab report")} part />
      {!file && (
        <>
          <Group className="mt-5">
            <Row color="#43a047" icon={<GroupIcon k="infectious" />} label={t("Lab self-service")} sub={t("A code for a lab device")} onClick={() => go("data", "lab")} />
          </Group>
          <Enter done={done} part />
        </>
      )}
    </section>
  );
}

const IMPORT_LEDE: Record<string, string> = {
  apple: tk("On your iPhone, open Health, tap your picture, then Export All Health Data; choose the .zip here."),
  report: tk("A photo (JPEG, PNG) or a PDF."),
  restore: tk("A Health backup (.zuhealth) from this app or the web version."),
  file: tk("A photo or PDF of a lab report, an Apple Health export, a Health backup (.zuhealth) or WHOOP data. Importing the same file again updates it; nothing is doubled."),
};

function Import({
  file,
  onFile,
  go,
  kind: hint = "file",
  title,
  part,
}: {
  file?: string;
  onFile: (p?: string) => void;
  go: (p: Page) => void;
  kind?: string;
  title?: string;
  /** a part of a page (Add), not the page: a smaller heading */
  part?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<ReactNode>();
  // a lab report's steps, as the web's: asked before the one-off download of the models, then the download, then
  // the reading, each with its progress
  const [step, setStep] = useState<"ask" | "download" | "read">();
  const [progress, setProgress] = useState<OcrProgress>();
  const [askMb, setAskMb] = useState(0);
  useEffect(() => onOcrProgress(setProgress), []);
  const kind: ImportKind | null = file ? importKind(file) : null;
  useEffect(() => {
    setErr(undefined);
    setDone(undefined);
    setPassword("");
    setSource(file ? fileName(file).replace(/\.jsonl$/i, "") : "");
  }, [file]);
  const run = async () => {
    if (!file || !kind) return;
    setBusy(true);
    setErr(undefined);
    setDone(undefined);
    try {
      if (kind === "report") return void (await readReport());
      if (kind === "backup") {
        const r = await op<BackupResult>("backup.import", { path: file, password });
        const notes: string[] = [];
        if (r.refused_imports + r.refused_corrections) notes.push(t("{{count}} entries were refused because their dates lie in the future, which means a damaged or altered file.", { count: r.refused_imports + r.refused_corrections }));
        if (r.skipped_metrics.length) notes.push(t("{{count}} measures were skipped because their unit differs on this computer: {{list}}.", { count: r.skipped_metrics.length, list: r.skipped_metrics.join(", ") }));
        if (r.missing_blobs.length) notes.push(t("{{count}} original files (such as lab report photos) are not in this backup; the readings from them are.", { count: r.missing_blobs.length }));
        setDone(
          <>
            <p>
              {r.erased_imports
                ? t("Restored: {{added}} imports added, {{erased}} removed because they were deleted on the other device. Nothing here was overwritten.", { added: r.added_imports, erased: r.erased_imports })
                : t("Restored: {{added}} imports added. Nothing here was overwritten.", { added: r.added_imports })}
            </p>
            {notes.map((n) => (
              <p key={n} className="text-[13px] text-black/55 dark:text-white/55">
                {n}
              </p>
            ))}
          </>,
        );
      } else {
        const r = await op<FileResult>(`import.${kind}`, kind === "rows" ? { path: file, source } : { path: file });
        const broken = r.apple?.broken ?? 0;
        setDone(
          <>
            <p>
              {t("Imported {{n}} readings from {{count}} devices.", { n: r.written.toLocaleString(), count: r.sources })}
              {r.added < r.written ? ` ${t("{{n}} were already here and were updated.", { n: (r.written - r.added).toLocaleString() })}` : ""}
            </p>
            {broken > 0 && <p className="text-[13px] text-black/55 dark:text-white/55">{t("{{n}} records had a bad date or value and were left out.", { n: broken.toLocaleString() })}</p>}
          </>,
        );
      }
      setPassword("");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  /** A lab report: the models first if they're missing (asked once; a phone takes only the ~21 MB it needs, not
   *  the matching model), then read; the result opens for checking (nothing counts until it's confirmed). */
  const readReport = async (fetch = false) => {
    if (!file) return;
    setErr(undefined);
    setProgress(undefined);
    try {
      const comp = await ocrComponent();
      if (comp && !comp.ready) {
        const missing = comp.files.filter((f) => !f.installed && (f.required || !isMobile));
        if (!fetch) {
          setAskMb(Math.max(1, Math.round(missing.reduce((n, f) => n + f.bytes, 0) / 1e6)));
          return setStep("ask");
        }
        setStep("download");
        await installOcr(!isMobile);
        setProgress(undefined);
      }
      setStep("read");
      const r = await op<{ import_id: number; items: number; matched: number }>("import.ocr", { path: file, tz_min: -new Date().getTimezoneOffset() });
      justRead = r.import_id;
      setStep(undefined);
      go("review");
    } catch (e) {
      setStep(undefined);
      setErr(errText(e));
    }
  };
  // a report is read as soon as it is chosen (as the web's): there is nothing to fill in first. Once per file
  // (StrictMode runs effects twice: the report would be imported twice)
  const started = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per file chosen
  useEffect(() => {
    if (!file || kind !== "report" || started.current === file) return;
    started.current = file;
    void readReport();
  }, [file]);
  return (
    <section className="[&_h3]:mt-6">
      {part ? <h3 className="mt-6 mb-1.5 text-[17px] font-semibold">{title}</h3> : <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{title ?? t("Import a file")}</h2>}
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t(IMPORT_LEDE[hint] ?? IMPORT_LEDE.file!)}</p>
      {hint === "restore" && (
        <p className="text-[13px] text-black/55 dark:text-white/55">
          {t("Web version")} <WebLink url={WEB_VERSION} />
        </p>
      )}
      <FilePick path={file} onPath={onFile} kind={hint === "report" || hint === "apple" || hint === "restore" ? hint : "file"} />
      {file && !kind && (
        <Problem text={t("Health can't read this kind of file. Choose a lab report photo or PDF, a .zip from Apple Health, a .zuhealth backup, or a WHOOP .json file.")} />
      )}
      {file && kind === "report" && (
        <div aria-busy={step === "download" || step === "read"}>
          {step === "ask" ? (
            <div className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]">
              <p>{t("The first time, Health needs the text-recognition models (about {{mb}} MB), once. Reports are read here; nothing is uploaded.", { mb: askMb })}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Btn type="button" primary onClick={() => void readReport(true)}>
                  {t("Download and read")}
                </Btn>
                <Btn type="button" onClick={() => (setStep(undefined), onFile(undefined))}>
                  {t("Not now")}
                </Btn>
              </div>
            </div>
          ) : step ? (
            <div role="status" className="[&_progress]:h-1.5 [&_progress]:w-full [&_progress]:accent-primary">
              {/* a bar only where there's something to count: bytes, or the pages of a PDF */}
              {progress?.stage === step && (step === "download" || progress.total > 1) ? (
                <progress value={progress.done} max={progress.total} />
              ) : (
                <progress />
              )}
              <p className="text-[13px] text-black/55 dark:text-white/55">
                {step === "download"
                  ? t("Downloading the text-recognition models {{pct}}%", { pct: progress?.stage === "download" ? Math.floor((progress.done * 100) / Math.max(1, progress.total)) : 0 })
                  : progress?.stage === "read" && progress.total > 1
                    ? t("Reading page {{n}} of {{m}}…", { n: progress.done + 1, m: progress.total })
                    : t("Reading the report…")}
              </p>
            </div>
          ) : err ? (
            <>
              <Problem text={err} />
              <Btn type="button" primary onClick={() => void readReport()}>
                {t("Try again")}
              </Btn>
            </>
          ) : null}
        </div>
      )}
      {file && kind && kind !== "report" && (
        <form
          className="flex flex-col gap-3"
          aria-busy={busy}
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <p className="text-[13px] text-black/55 dark:text-white/55">{t(KIND_LABEL[kind])}</p>
          {kind === "backup" && <PasswordField label={t("Backup password")} value={password} onChange={setPassword} auto="current-password" />}
          {kind === "rows" && (
            <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
              {t("Where these readings come from")}
              <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={source} onChange={(e) => setSource(e.target.value)} required />
            </label>
          )}
          <Problem text={err} />
          <Btn type="submit" primary disabled={busy}>
            {busy ? (kind === "backup" ? t("Restoring…") : t("Importing…")) : kind === "backup" ? t("Restore backup") : t("Import")}
          </Btn>
          {busy && (
            <p className="text-[13px] text-black/55 dark:text-white/55">
              {t("Large exports can take a few minutes. Health answers again when the import is done; keep this page open to see the result.")}
            </p>
          )}
        </form>
      )}
      {done && (
        <div className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]" role="status">
          {done}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" primary onClick={() => go("readings")}>
              {t("See my readings")}
            </Btn>
            <Btn type="button" onClick={() => onFile(undefined)}>
              {t("Import another file")}
            </Btn>
          </div>
        </div>
      )}
    </section>
  );
}

const DAY = 86_400_000;
const toPts = (agg: string, days: Day[]): Pt[] =>
  days.flatMap((d) => {
    const v = dayValue(agg, d);
    return v === null ? [] : [{ day: d.day, v, lo: agg === "instant" ? d.min : null, hi: agg === "instant" ? d.max : null }];
  });

/** The last 30 days of a measure, reaching back to its latest reading's day when that is older
 *  (one request per tile, refreshed after writes). */
function useMonth(p: Point): Day[] | undefined {
  const from = day(Math.min(Date.now() - 30 * DAY, p.start_ms));
  return useOp(() => op<Day[]>("daily.query", { metric: p.metric, from }), [p.metric, from])[0];
}

function Trend({ p, days, latest }: { p: Point; days?: Day[]; latest: string }) {
  const pts = days ? toPts(p.agg, days) : [];
  return pts.length >= 2 ? <Spark pts={pts} label={nameOf(p.metric, p.name)} latest={latest} /> : null;
}

/** What to show for a reading. Summed measures (steps, energy) show their latest day's total, not the last slice. */
function display(p: Point, days?: Day[]): { value: string; unit: string; note?: string } {
  if (p.agg === "cumulative" && days?.length) {
    const last = days[days.length - 1]!;
    const today = last.day === day(Date.now());
    const note = today ? t("today") : ago(dayMs(last.day));
    const asTime = asDuration(last.sum ?? 0, p.unit, true);
    return asTime ? { value: asTime, unit: "", note } : { value: num(last.sum ?? 0), unit: unitLabel(p.unit), note };
  }
  return shown(p);
}

/** Generic device names ("OCR", "photo") read better as their kind. */
function sourceLabel(src?: Source): string {
  if (!src) return t("Source");
  if (src.connector === "manual") return t("Entered by you");
  const generic = ["ocr", "photo", src.connector].includes(src.name.toLowerCase());
  return generic ? sourceKind(src.connector) : src.name;
}

const STALE_DAYS = 60;

/** Out-of-range mark from a lab sheet (H/L printed next to the value). */
function Flag({ p }: { p: Point }) {
  const f = (p.detail?.flag ?? (p.detail?.printed as { flag?: string } | undefined)?.flag) as string | undefined;
  if (p.corrected || (f !== "H" && f !== "L")) return null;
  return (
    <span className="ms-1 text-xs font-semibold text-amber-600" title={f === "H" ? t("Above the reference range") : t("Below the reference range")}>
      {f === "H" ? t("↑ high") : t("↓ low")}
    </span>
  );
}

const isStale = (p: Point) => Date.now() - p.start_ms > STALE_DAYS * DAY;

/** Category symbols, tinted per category (the tint marks the category only; text stays in ink). */
const GROUP_ICON: Record<string, ReactNode> = {
  body: (
    <>
      <circle cx="8" cy="3.5" r="1.8" />
      <path d="M4 7h8M8 7v4M8 11l-2.5 3.5M8 11l2.5 3.5" />
    </>
  ),
  cardio: <path d="M8 13.5S2.5 10 2.5 6.2A2.7 2.7 0 0 1 8 5a2.7 2.7 0 0 1 5.5 1.2C13.5 10 8 13.5 8 13.5z" />,
  sleep: <path d="M12.5 10A5.5 5.5 0 0 1 6 3.5a5.5 5.5 0 1 0 6.5 6.5z" />,
  activity: <path d="M9 2L4 9h4l-1 5 5-7H8z" />,
  force: <path d="M8 12V3M4.5 6.5 8 3l3.5 3.5M3 14h10" />,
  lab: <path d="M6 2h4M6.5 2v4L3 13a1 1 0 0 0 .9 1.4h8.2A1 1 0 0 0 13 13L9.5 6V2" />,
  infectious: <path d="M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z" />,
  tumor: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  repro: (
    <>
      <circle cx="8" cy="6" r="3.5" />
      <path d="M8 9.5V15M5.5 12.5h5" />
    </>
  ),
  derived: <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2" />,
  custom: <path d="M3 13l1-3.5L10.5 3a1.4 1.4 0 0 1 2 2L6 11.5zM9.5 4l2 2" />,
  lab_other: (
    <>
      <path d="M4 2.5h8v11H4z" />
      <path d="M6 6h4M6 8.5h4M6 11h2.5" />
    </>
  ),
  other: (
    <>
      <circle cx="4" cy="8" r="1" />
      <circle cx="8" cy="8" r="1" />
      <circle cx="12" cy="8" r="1" />
    </>
  ),
};
/** Each group's colour: it marks the group only, the text stays in ink. */
const TINT: Record<string, string> = {
  body: "#8a6fd3",
  cardio: "#dc5149",
  sleep: "#5a6ee0",
  activity: "#e0742a",
  force: "#c25a2f",
  lab: "#2a8db6",
  infectious: "#2f9873",
  tumor: "#b5627c",
  repro: "#c25b98",
  other: "#7d8d94",
};
const GroupIcon = ({ k }: { k: string }) => (
  <svg className="h-5 w-5 shrink-0" style={{ color: TINT[k] ?? TINT.other }} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {GROUP_ICON[k] ?? <rect x="3" y="3" width="10" height="10" rx="2.5" />}
  </svg>
);

/** One measure as a tile: its name, the value large, and the month's trend or when it was taken. */
function Tile({ p, open }: { p: Point; open: (code: string) => void }) {
  return p.agg === "cumulative" ? <SummedTile p={p} open={open} /> : <TileBody p={p} open={open} s={shown(p)} days={undefined} />;
}

function SummedTile({ p, open }: { p: Point; open: (code: string) => void }) {
  const days = useMonth(p);
  return <TileBody p={p} open={open} s={display(p, days)} days={days} />;
}

function TrendTile({ p, open, s }: { p: Point; open: (code: string) => void; s: { value: string; unit: string; note?: string } }) {
  const days = useMonth(p);
  return <TileBody p={p} open={open} s={s} days={days} />;
}

function TileBody({
  p,
  open,
  s,
  days,
}: { p: Point; open: (code: string) => void; s: { value: string; unit: string; note?: string }; days?: Day[] }) {
  const old = isStale(p);
  // a trend where there is one (everyday measures); the date otherwise (lab values, old or sparse ones)
  const trend = !old && !!days && toPts(p.agg, days).length >= 2;
  const note = s.note ?? ago(p.start_ms);
  return (
    <button type="button" className="select-none flex w-full min-h-[64px] items-center gap-3 px-4 py-2.5 text-start transition-colors active:bg-black/5 dark:active:bg-white/10" onClick={() => open(p.metric)}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] leading-snug">{nameOf(p.metric, p.name)}</span>
        <span className="block text-[13px] text-black/55 dark:text-white/55">
          {note}
          <Flag p={p} />
        </span>
      </span>
      {trend && <Trend p={p} days={days} latest={s.unit ? `${s.value} ${s.unit}` : s.value} />}
      <span className={`shrink-0 text-end text-[20px] font-semibold tracking-tight tabular-nums ${old ? "text-black/55 dark:text-white/55" : ""}`}>
        {s.value}
        {s.unit && <span className="ms-0.5 text-[13px] font-medium text-black/55 dark:text-white/55">{s.unit}</span>}
      </span>
    </button>
  );
}

/** Key, everyday measures show their month's trend; lab and old values show their date instead. */
function AnyTile({ p, open, lab }: { p: Point; open: (code: string) => void; lab: boolean }) {
  if (!lab && !isStale(p) && p.agg !== "cumulative" && typeof p.value === "number") return <TrendTile p={p} open={open} s={shown(p)} />;
  return <Tile p={p} open={open} />;
}


function Section({
  g,
  rows,
  sources,
  open,
  all,
}: { g: (typeof GROUPS)[number]; rows: Point[]; sources: Source[]; open: (code: string) => void; all: boolean }) {
  const [more, setMore] = useState(false);
  const key = KEY[g.key] ?? [];
  // key measures first, then everyday ones, then detailed body-composition analysis, newest first within each
  const detailed = (p: Point) => /^x:(seca\/|fat_|ecw|extracellular|total_body_water|skeletal_muscle|appendicular|bia_|phase_angle|visceral|resting_energy|total_energy)/.test(p.metric);
  const ranked = [...rows].sort((a, b) => {
    const ka = key.indexOf(a.metric);
    const kb = key.indexOf(b.metric);
    if (ka >= 0 || kb >= 0) return (ka < 0 ? 99 : ka) - (kb < 0 ? 99 : kb);
    return Number(detailed(a)) - Number(detailed(b)) || b.start_ms - a.start_ms;
  });
  const lab = g.key === "lab" || g.sensitive;
  // collapsed: the first few rows (more for a big category), the rest on request
  const fold = rows.length > 12 ? 6 : 4;
  const shownRows = all || more ? ranked : ranked.slice(0, fold);
  // where these numbers come from, newest first
  const bySource = new Map<number, number>();
  for (const p of rows) bySource.set(p.source_id, Math.max(bySource.get(p.source_id) ?? 0, p.start_ms));
  const from = [...bySource.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => sourceLabel(sources.find((x) => x.id === id)));
  return (
    <section className="mb-2 scroll-mt-10 break-inside-avoid" id={`g-${g.key}`} aria-labelledby={`h-${g.key}`}>
      <Group
        title={
          <span id={`h-${g.key}`} className="flex items-center gap-2 text-[15px] font-semibold text-black dark:text-white">
            <IconDot color={TINT[g.key] ?? TINT.other} className="h-7! w-7!">
              <GroupIcon k={g.key} />
            </IconDot>
            {t(g.label)}
          </span>
        }
        after={
          !all && rows.length > fold ? (
            <Btn type="button" link aria-expanded={more} onClick={() => setMore(!more)}>
              {more ? t("Show fewer") : t("Show all {{n}}", { n: rows.length })}
            </Btn>
          ) : undefined
        }
      >
        {shownRows.map((p) => (
          <AnyTile key={p.metric} p={p} open={open} lab={lab} />
        ))}
      </Group>
      {from.length > 0 && (
        <p className="-mt-3 mb-5 px-4 text-[13px] text-black/55 dark:text-white/55">
          {new Set(from).size > 3
            ? t("From {{list}} and {{n}} more", { list: [...new Set(from)].slice(0, 3).join(t(", ")), n: new Set(from).size - 3 })
            : t("From {{list}}", { list: [...new Set(from)].slice(0, 3).join(t(", ")) })}
        </p>
      )}
    </section>
  );
}

/** Nothing recorded yet: where data comes in on this computer (as the web's dashboard getting-started card) */
function Start({ start }: { start: (p: Page, want: string) => void }) {
  return (
    <section className="mx-auto w-full max-w-5xl">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Dashboard")}</h2>
          <p className="text-[13px] text-black/55 dark:text-white/55">{(isMobile ? t("Your data is stored encrypted on this device") : t("Your data is stored encrypted on this computer"))}</p>
        </div>
      </div>
      <div className="max-w-[640px] overflow-hidden rounded-3xl bg-white/80 shadow-sm dark:bg-neutral-900/80">
        <div className="px-4.5 pt-4.5 pb-1.5 [&_h3]:m-0 [&_h3]:text-[17px]">
          <h3 id="h-start" className="mb-2 text-[17px] font-semibold">{t("Start recording your health")}</h3>
          <p className="text-[13px] text-black/55 dark:text-white/55">{t("Choose a way to add your first data")}</p>
        </div>
        <Group aria-labelledby="h-start">
          <Row icon={<GroupIcon k="lab" />} label={t("Lab report")} sub={t("A photo or a PDF")} onClick={() => start("data", "report")} />
          <Row icon={<GroupIcon k="activity" />} label={t("Apple Health")} sub={t("Export from your iPhone")} onClick={() => start("data", "apple")} />
          <Row icon={<Icon k="backup" />} label={t("Restore a backup")} sub={t("A .zuhealth file")} onClick={() => start("data", "restore")} />
          <Row icon={<GroupIcon k="body" />} label={t("Enter by hand")} sub={t("Write down a reading")} onClick={() => start("data", "manual")} />
          <Row icon={<Icon k="link" />} label={t("Connect another device")} onClick={() => start("account", "connect")} />
        </Group>
      </div>
      {/* dropping a file on the window is the desktop's */}
      {isDesktop && <p className="text-[13px] text-black/55 dark:text-white/55 mt-3 text-[13px]">{t("You can also drop a file anywhere on this window.")}</p>}
    </section>
  );
}

function Readings({
  latest,
  err,
  open,
  go,
  want,
  reviews,
  find,
  found,
  onSection,
  start,
}: {
  latest?: Point[];
  err?: string;
  open: (code: string) => void;
  go: (p: Page) => void;
  /** The lab report open (#/report/seca, #/report/forcedecks). */
  want?: string;
  reviews: number;
  find: boolean;
  found: () => void;
  /** The category now in view (null: the top), for the sidebar */
  onSection: (key: string | null) => void;
  /** Opens a page at a way in (the getting-started card) */
  start: (p: Page, want: string) => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  const [sources] = useOp(() => op<Source[]>("source.list"), []);
  const [fd] = useOp(() => op<FdSession[]>("labs.forcedecks"), []);

  const [scans] = useOp(() => op<Measurement[]>("labs.body_scans"), []);

  const [q, setQ] = useState("");
  useEffect(() => {
    if (find && search.current) {
      search.current.focus();
      found();
    }
  }, [find, latest, found]);
  // which category is under the page's top edge: the sidebar marks it
  useEffect(() => {
    if (!latest?.length) return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const x of entries) seen.set(x.target.id.slice(2), x.isIntersecting);
        const first = HOME_GROUPS.find((g) => seen.get(g.key));
        onSection(window.scrollY < 40 ? null : (first?.key ?? null));
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    for (const el of document.querySelectorAll("section[id^='g-']")) io.observe(el);
    const top = () => window.scrollY < 40 && onSection(null);
    window.addEventListener("scroll", top, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", top);
      onSection(null);
    };
  }, [latest, onSection]);
  if (err) return <Problem text={err} />;
  if (!latest) return <section aria-busy="true" aria-label={t("Loading your readings…")} />;
  // the lab devices' reports, each a screen of its own (#/report/seca, #/report/forcedecks)
  if (want === "seca") return <Screen title={t("Body composition")}>{scans && <SecaReport scans={scans} />}</Screen>;
  if (want === "forcedecks")
    return <Screen title={t("VALD ForceDecks tests")}>{fd && <FdReport sessions={fd} names={Object.fromEntries(latest.map((p) => [p.metric, p.name]))} />}</Screen>;
  if (!latest.length) return <Start start={start} />;
  const needle = q.trim().toLowerCase();
  const match = (p: Point) => !needle || nameOf(p.metric, p.name).toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle);
  // the latest time on the VALD ForceDecks plates shows its best jump, not its last one (the web's withBestJump)
  const fdLatest = fd?.[0];
  // values a seca measurement gave are in its report, not loose on the body card (weight, height, BMI stay)
  const unscanned = scans?.length ? withoutScans(latest, scans, sources ?? []) : latest;
  const rowsOf = fdLatest ? withBestJump(unscanned, fdLatest, sources ?? []) : unscanned;
  // a body composition measurement keeps the body card even when it holds nothing else (as the web's home)
  const withReport = (key: string) => (key === "body" && !!scans?.length && !needle) || (key === "force" && !!fdLatest && !needle);
  const groups = HOME_GROUPS.map((g) => ({ g, rows: rowsOf.filter((p) => p.category === g.key && match(p)) })).filter(
    (x) => x.rows.length || withReport(x.g.key),
  );
  const newest = Math.max(...latest.map((p) => p.start_ms));
  const labs = !needle && (!!scans?.[0] || !!fdLatest);
  return (
    <section className="mx-auto w-full max-w-5xl">
      <h2 className="mb-0.5 text-[28px] leading-tight font-bold tracking-tight">{t("Dashboard")}</h2>
      <p className="mb-4 text-[13px] text-black/55 dark:text-white/55">{t("Updated {{when}}", { when: when(newest) })}</p>
      <SearchPill
        className="mb-5"
        ref={search}
        placeholder={isMobile ? t("Find a measure") : `${t("Find a measure")} (${MOD}F)`}
        aria-label={t("Find a measure")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setQ("")}
      />
      {reviews > 0 && (
        <Callout
          icon={<Icon k="review" />}
          title={t("{{count}} imports are waiting for you to check.", { count: reviews })}
          text={t("Nothing counts until you confirm it.")}
          onClick={() => go("review")}
        />
      )}
      {/* the lab devices' reports first: what a visit to the testing room gave, before any loose number */}
      {labs && (
        <Group title={t("Latest tests")}>
          {scans?.[0] && <SecaLabCard scan={scans[0]} open={() => nav("report/seca")} />}
          {fdLatest && <FdCard session={fdLatest} open={() => nav("report/forcedecks")} />}
        </Group>
      )}
      {!groups.length && <p className="text-black/55 dark:text-white/55">{t("No measure matches “{{q}}”.", { q })}</p>}
      <div className="wide:columns-2 wide:gap-6">
        {groups.map(({ g, rows }) => (
          <Section key={g.key} g={g} rows={rows} sources={sources ?? []} open={open} all={!!needle} />
        ))}
      </div>
    </section>
  );
}

const RANGES = [
  { label: tk("30 days"), days: 30 },
  { label: tk("90 days"), days: 90 },
  { label: tk("1 year"), days: 365 },
  { label: tk("All"), days: 0 },
];

/** Finds a measure by the name shown (any language on screen), the catalog's English, its code or a name printed on
 *  a report. `manual`: only measures entered as one number. */
function MetricPicker({ onPick, placeholder, manual }: { onPick: (m: Metric) => void; placeholder: string; manual?: boolean }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Metric[]>();
  useEffect(() => {
    if (!q.trim()) return setHits(undefined);
    let live = true;
    const t = setTimeout(
      () =>
        op<Metric[]>("metric.search", { q, codes: codesNamed(q), manual: !!manual, limit: 30 }).then(
          (h) => live && setHits(h),
          () => live && setHits([]),
        ),
      150,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, manual]);
  return (
    <div className="relative max-w-md">
      <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" aria-label={placeholder} placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      {hits && !hits.length && <p className="text-[13px] text-black/55 dark:text-white/55">{t("No measures found.")}</p>}
      {hits && hits.length > 0 && (
        <ul className="mt-1 max-h-72 overflow-y-auto rounded-2xl bg-white p-1 shadow-lg dark:bg-neutral-800 [&_button]:block [&_button]:w-full [&_button]:rounded-lg [&_button]:px-2.5 [&_button]:py-1.5 [&_button]:text-start [&_button:hover]:bg-primary [&_button:hover]:text-white">
          {hits.map((m) => (
            <li key={m.code}>
              <Btn
                type="button"
                onClick={() => {
                  onPick(m);
                  setQ("");
                }}
              >
                {nameOf(m.code, m.name)}{" "}
                <span className="text-[13px] text-black/55 dark:text-white/55">
                  {m.code}
                  {m.unit ? ` · ${unitLabel(m.unit)}` : ""}
                </span>
              </Btn>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Record({ code, pick }: { code?: string; pick: (c: string) => void }) {
  // the shortest range with enough days to show a shape; the person can still choose
  const [range, setRange] = useState<number | null>(null);
  const [info] = useOp(() => (code ? op<MetricInfo>("metric.show", { code }) : Promise.resolve(undefined)), [code]);
  const [allDays] = useOp(() => (code ? op<Day[]>("daily.query", { metric: code }) : Promise.resolve([] as Day[])), [code]);
  // the newest 10 entries show; "Show all" asks for the rest
  const [allEntries, setAllEntries] = useState(false);
  const [points] = useOp(
    () => (code ? op<Point[]>("obs.query", { metric: code, limit: allEntries ? 100_000 : 30, newest_first: true }) : Promise.resolve([])),
    [code, allEntries],
  );
  const [sources] = useOp(() => op<Source[]>("source.list"), []);
  useEffect(() => {
    setRange(null);
    setAllEntries(false);
  }, [code]);
  const auto = useMemo(() => {
    const days = allDays ?? [];
    for (const r of [30, 90, 365]) if (days.filter((d) => dayMs(d.day) >= Date.now() - r * DAY).length >= 7) return r;
    return 0;
  }, [allDays]);
  const span = range ?? auto;
  const days = (allDays ?? []).filter((d) => !span || dayMs(d.day) >= Date.now() - span * DAY);
  const recent = points ?? [];
  if (!code)
    return (
      <section className="mx-auto w-full max-w-3xl">
        <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("History")}</h2>
        <MetricPicker placeholder={t("Search measures, e.g. weight")} onPick={(m) => pick(m.code)} />
      </section>
    );
  const agg = info?.agg ?? "instant";
  const pts = toPts(agg, days);
  const unit = dayUnit(agg, info?.unit ?? "");
  const vals = pts.map((p) => p.v);
  // highs and lows of every reading, not of daily means (heart rate: many readings a day)
  const lows = agg === "instant" ? days.map((d) => d.min).filter((v): v is number => v !== null) : vals;
  const highs = agg === "instant" ? days.map((d) => d.max).filter((v): v is number => v !== null) : vals;
  const lab = isLabGroup(recent[0]?.group);
  // durations read as hours and minutes everywhere: stats, axis, tooltip, table (interval days are in hours)
  // durations of a minute or more read as hours and minutes (as tiles do); HRV's 40 ms stays "40 ms"
  const big = (u: string) => vals.length > 0 && asDuration(Math.max(...vals.map(Math.abs)), u, true) !== undefined;
  const dur = agg === "interval" || ((agg === "instant" || agg === "cumulative") && PER_MS_UNITS.has(info?.unit ?? "") && big(info?.unit ?? ""));
  // lab: no more decimals than the reports printed (an average must not grow six of them)
  const places = Math.max(0, ...recent.map((p) => (typeof p.value === "number" ? (String(p.value).split(".")[1]?.length ?? 0) : 0)));
  const labNum = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: Math.min(places, 6) });
  const fmt = (v: number) =>
    !dur ? (lab ? labNum(v) : num(v)) : agg === "interval" ? (asDuration(v, "h") ?? num(v)) : (asDuration(v, info!.unit) ?? num(v));
  const shownUnit = dur ? "" : unit;
  const ref = recent.find((p) => p.detail?.ref || (p.detail?.printed as { ref?: string } | undefined)?.ref);
  const refText = (ref?.detail?.ref ?? (ref?.detail?.printed as { ref?: string } | undefined)?.ref) as string | undefined;
  const sourceName = (id: number) => {
    return sourceLabel(sources?.find((s) => s.id === id));
  };
  return (
    <section className="[&_h3]:mt-6">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{info ? nameOf(info.code, info.name) : code}</h2>
      <p className="text-[13px] text-black/55 dark:text-white/55" title={code}>
        {info && nameOf(info.code, info.name) !== info.name ? info.name : code}
      </p>
      <Segmented strong rounded className="mt-3" role="group" aria-label={t("Range")}>
        {RANGES.map((r) => (
          <SegmentedButton key={r.label} active={span === r.days} aria-pressed={span === r.days} onClick={() => setRange(r.days)}>
            {t(r.label)}
          </SegmentedButton>
        ))}
      </Segmented>
      {vals.length > 0 && (
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 [&_dd]:m-0 [&_dd]:text-xl [&_dd]:font-semibold [&_dt]:text-xs [&_dt]:text-black/55 dark:[&_dt]:text-white/55">
          <div>
            <dt>{t("Average")}</dt>
            <dd>
              {fmt(vals.reduce((a, b) => a + b, 0) / vals.length)} <span className="ms-0.5 text-[0.65em] font-medium text-black/55 dark:text-white/55">{shownUnit}</span>
            </dd>
          </div>
          <div>
            <dt>{t("Lowest")}</dt>
            <dd>
              {fmt(Math.min(...lows))} <span className="ms-0.5 text-[0.65em] font-medium text-black/55 dark:text-white/55">{shownUnit}</span>
            </dd>
          </div>
          <div>
            <dt>{t("Highest")}</dt>
            <dd>
              {fmt(Math.max(...highs))} <span className="ms-0.5 text-[0.65em] font-medium text-black/55 dark:text-white/55">{shownUnit}</span>
            </dd>
          </div>
          <div>
            <dt>{t("Days with data")}</dt>
            <dd>{vals.length}</dd>
          </div>
          {refText && (
            <div>
              <dt>{t("Reference range")}</dt>
              <dd>{refText}</dd>
            </div>
          )}
        </dl>
      )}
      <DailyChart pts={pts} unit={shownUnit} fmt={fmt} />
      <h3 className="mb-2 text-[17px] font-semibold">{t("Latest entries")}</h3>
      <table className="w-full text-sm">
        <tbody>
          {(allEntries ? recent : recent.slice(0, 10)).map((p) => {
            const s = shown(p);
            return (
              <tr key={`${p.start_ms}-${p.source_id}`}>
                <td className="px-2 py-1.5 align-top">{p.detail?.precision === "day" ? dateIn(p.start_ms, p.tz_min) : when(p.start_ms, p.tz_min)}</td>
                <td className="text-[13px] text-black/55 dark:text-white/55">{sourceName(p.source_id)}</td>
                <td className="font-semibold tabular-nums font-medium">
                  {s.value} <span className="ms-0.5 text-[0.65em] font-medium text-black/55 dark:text-white/55">{s.unit}</span>
                  <Flag p={p} />
                  {p.corrected && <span className="text-[13px] text-black/55 dark:text-white/55"> {t("corrected")}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!allEntries && recent.length > 10 && (
        <Btn type="button" link onClick={() => setAllEntries(true)}>
          {t("Show all entries")}
        </Btn>
      )}
    </section>
  );
}

/** Common measures, one tap away (as the web version's record page). */
const QUICK: [string, string][] = [
  ["loinc:29463-7", tk("Weight")],
  ["loinc:8480-6", tk("Blood pressure, systolic")],
  ["loinc:8462-4", tk("Blood pressure, diastolic")],
  ["loinc:8867-4", tk("Heart rate")],
  ["loinc:2339-0", tk("Blood glucose")],
  ["loinc:8310-5", tk("Body temperature")],
];

/** A typed number: "10,000" and "10 000" are ten thousand; "36,6" and "0,125" use a decimal comma; anything
 *  else that isn't a plain number is NaN. The form shows how it was read before saving (see `Enter`). */
export function parseNumber(s: string): number {
  const t = s.replace(/[\s\u00a0']/g, "");
  if (/^-?0\d*,\d+$/.test(t)) return Number(t.replace(",", ".")); // a leading 0 is never a thousands group
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replaceAll(",", ""));
  if (/^-?\d+,\d+$/.test(t)) return Number(t.replace(",", "."));
  return /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : Number.NaN;
}

function localNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function Enter({ done, part }: { done: (code: string) => void; part?: boolean }) {
  const [m, setM] = useState<MetricInfo>();
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [at, setAt] = useState(localNow());
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pick = async (x: Metric) => {
    const info = await op<MetricInfo>("metric.show", { code: x.code });
    setM(info);
    setUnit(info.units.length === 1 ? (info.units[0] ?? "") : "");
    // a fresh form: now, no value, no old error
    setAt(localNow());
    setValue("");
    setErr(undefined);
  };
  const save = async () => {
    if (!m) return;
    const local = new Date(at);
    const text = m.agg === "none";
    const trimmed = value.trim();
    if (!trimmed) return setErr(t("Type a value."));
    const v = text ? trimmed : parseNumber(trimmed);
    if (!text && !Number.isFinite(v)) return setErr(t("Type a number, such as 72 or 36.6."));
    if (busy) return;
    setBusy(true);
    try {
      await op("manual.enter", {
        entries: [{ metric: m.code, value: v, ...(unit ? { unit } : {}), at: { ms: local.getTime(), tz_min: -local.getTimezoneOffset() } }],
      });
      done(m.code);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="[&_h3]:mt-6">
      {part ? <h3 className="mt-6 mb-1.5 text-[17px] font-semibold">{t("Or enter by hand")}</h3> : <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Enter by hand")}</h2>}
      {!m ? (
        <>
          <MetricPicker placeholder={t("What did you measure?")} onPick={pick} manual />
          <div className="my-3 mb-6 flex flex-wrap gap-2" role="group" aria-label={t("Common measures")}>
            {QUICK.map(([code, label]) => (
              <Btn key={code} type="button" small onClick={() => pick({ code, name: label, unit: "", agg: "instant" })}>
                {t(label)}
              </Btn>
            ))}
          </div>
        </>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <p>
            <strong>{nameOf(m.code, m.name)}</strong>{" "}
            <Btn type="button" link onClick={() => setM(undefined)}>
              {t("Change")}
            </Btn>
          </p>
          <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
            {t("Value")}
            <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" inputMode={m.agg === "none" ? "text" : "decimal"} value={value} onChange={(e) => setValue(e.target.value)} required />
          </label>
          {m.agg !== "none" && value.includes(",") && Number.isFinite(parseNumber(value)) && (
            <p className="text-[13px] text-black/55 dark:text-white/55" role="status">
              {t("Read as {{n}}", { n: parseNumber(value).toLocaleString(undefined, { maximumFractionDigits: 6 }) })}
            </p>
          )}
          {m.units.length > 1 &&
            (isTouch && m.units.length <= 4 ? (
            <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0 [&_legend]:mb-1.5 [&_legend]:text-[13px]">
              <legend>{t("Unit")}</legend>
              {m.units.map((u) => (
                <Btn key={u} type="button" on={unit === u} aria-pressed={unit === u} onClick={() => setUnit(u)}>
                  {unitLabel(u) || u}
                </Btn>
              ))}
            </fieldset>
          ) : (
            <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
              {t("Unit")}
              <select className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={unit} onChange={(e) => setUnit(e.target.value)} required>
                <option value="">{t("Choose the unit on your device")}</option>
                {m.units.map((u) => (
                  <option key={u} value={u}>
                    {unitLabel(u) || u}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
            {t("When")}
            <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required />
          </label>
          <Problem text={err} />
          <Btn type="submit" primary disabled={busy}>
            {t("Save reading")}
          </Btn>
        </form>
      )}
    </section>
  );
}


/** Sources whose imports are told apart by the device, lab or room they came from (the web's NAMED). */
const NAMED = new Set(["apple_health", "lab", "room"]);
/** Deleted only as a whole: every sync fetches the last days again, so one sync deleted would come back. */
const WHOLE_ONLY = new Set(["whoop"]);

/** A delete that can't be undone asks twice: what goes, then once more (as the web does). */
function DeleteTwice({ label, title, detail, busy, run }: { label: string; title: string; detail: string; busy: boolean; run: () => void }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  if (step === 0)
    return (
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Btn type="button" danger disabled={busy} onClick={() => setStep(1)}>
          {label}
        </Btn>
      </div>
    );
  return (
    <div className="mt-5 rounded-2xl border border-brand-red/30 bg-brand-red/10 px-4 py-3.5 [&_p]:mb-1.5" role="group" aria-label={step === 1 ? title : t("Delete for good?")}>
      <p>
        <strong>{step === 1 ? title : t("Delete for good?")}</strong>
      </p>
      <p className="text-[13px] text-black/55 dark:text-white/55">{step === 1 ? detail : t("This can't be undone. Backups you saved earlier still have this data.")}</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Btn type="button" autoFocus disabled={busy} onClick={() => setStep(0)}>
          {t("Cancel")}
        </Btn>
        <Btn type="button" danger disabled={busy} onClick={() => (step === 1 ? setStep(2) : run())}>
          {step === 1 ? t("Delete") : t("Delete for good")}
        </Btn>
      </div>
    </div>
  );
}

/** Manage data (the web's 管理数据): each kind of source with how many times data came from it; a kind lists
 *  those imports, newest first; an import shows what it holds now and can be deleted; a kind can be deleted
 *  whole. WHOOP only whole, and is disconnected with it. */
function Sources({ go, path: [kind, id] }: { go: (p: Page) => void; path: string[] }) {
  const [sources, , reloadSources] = useOp(() => op<Source[]>("source.list"), []);
  const [batches, err, reload] = useOp(() => op<Batch[]>("import.list"), []);
  const setKind = (k: string) => nav(`data/manage/${encodeURIComponent(k)}`);
  const open = id ? batches?.find((b) => String(b.import_id) === id) : undefined;
  const setOpen = (b: Batch) => nav(`data/manage/${encodeURIComponent(kind!)}/${b.import_id}`);
  const [msg, setMsg] = useState<string>();
  const [ordering, setOrdering] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(undefined);
    try {
      await fn();
      setMsg(ok);
      reload();
      reloadSources();
    } catch (e) {
      setMsg(errText(e));
    }
  };
  /** Moves a source one place up by swapping it with the one above (ties included), then numbers them 10, 20, 30… */
  const moveUp = async (i: number) => {
    setOrdering(true);
    await run(async () => {
      const order = [...(sources ?? [])];
      [order[i - 1], order[i]] = [order[i]!, order[i - 1]!];
      for (const [k, s] of order.entries()) if (s.priority !== (k + 1) * 10) await op("source.update", { id: s.id, priority: (k + 1) * 10 });
    }, t("Order saved."));
    setOrdering(false);
  };
  const kinds = new Map<string, Batch[]>();
  for (const b of batches ?? []) kinds.set(b.connector, [...(kinds.get(b.connector) ?? []), b]);
  const last = (list: Batch[]) => Math.max(0, ...list.map((b) => b.at ?? 0));
  const ordered = [...kinds.entries()].sort((a, b) => last(b[1]) - last(a[1]) || a[0].localeCompare(b[0]));
  const status = msg && (
    <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]" role="status">
      {msg}
    </p>
  );

  if (kind && open)
    return (
      <ImportView
        b={open}
        kind={kind}
        device={sources?.find((s) => s.id === open.source_id)?.name}
        go={go}
        erased={() => {
          goBack(`data/manage/${encodeURIComponent(kind)}`);
          setMsg(t("Deleted."));
          reload();
          reloadSources();
        }}
      />
    );
  if (kind) {
    const list = kinds.get(kind) ?? [];
    const whole = WHOLE_ONLY.has(kind);
    const name = sourceKind(kind);
    return (
      <div>
        <h2 className="mb-4 text-[28px] leading-tight font-bold tracking-tight">{name}</h2>
        {status}
        {list.length ? (
          <Group aria-label={name}>
            {list.map((b) => (
              <Row
                key={b.import_id}
                icon={null}
                label={b.at ? when(b.at) : "–"}
                value={
                  b.status === "review" ? (
                    <span className="text-amber-600">{t("waiting for you")}</span>
                  ) : NAMED.has(kind) ? (
                    sources?.find((s) => s.id === b.source_id)?.name
                  ) : (
                    t("{{count}} measures", { count: b.metrics })
                  )
                }
                onClick={() => {
                  setMsg(undefined);
                  setOpen(b);
                }}
              />
            ))}
          </Group>
        ) : (
          <p className="text-black/55 dark:text-white/55">{t("No imports yet.")}</p>
        )}
        {whole && <p className="mt-1 mb-4 px-4 text-[13px] text-black/55 dark:text-white/55">{t("WHOOP fetches the last few days again at every sync, so its data can only be deleted all at once.")}</p>}
        {list.length > 0 && (
          <DeleteTwice
            label={whole ? t("Delete all and disconnect") : t("Delete all")}
            title={t("Delete everything from {{name}}?", { name })}
            detail={
              whole
                ? t("The data of {{count}} syncs will be deleted, and WHOOP disconnected.", { count: list.length })
                : t("The data of {{count}} imports will be deleted.", { count: list.length })
            }
            busy={false}
            run={() =>
              run(async () => {
                await op("import.erase_source", { connector: kind });
                if (whole) await op("whoop.disconnect");
                goBack("data/manage");
              }, t("Deleted."))
            }
          />
        )}
      </div>
    );
  }
  return (
    <div>
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Manage data")}</h2>
      {status}
      <Problem text={err} />
      {batches && !batches.length && <p className="text-black/55 dark:text-white/55">{t("No imports yet.")}</p>}
      {ordered.length > 0 && (
        <>
          <Group aria-label={t("Manage data")}>
            {ordered.map(([k, list]) => (
              <Row
                key={k}
                icon={null}
                label={sourceKind(k)}
                sub={last(list) ? t("Last import {{when}}", { when: shortDate(last(list)) }) : undefined}
                value={t("{{count}} imports", { count: list.length })}
                onClick={() => {
                  setMsg(undefined);
                  setKind(k);
                }}
              />
            ))}
          </Group>
          <p className="mt-1 mb-4 px-4 text-[13px] text-black/55 dark:text-white/55">{t("Open a source to see what each import brought, or to delete it.")}</p>
        </>
      )}
      <details className="group/prio mt-6 mb-4">
        <summary className={`select-none flex min-h-[56px] cursor-pointer list-none items-center gap-3 rounded-3xl px-4 [&::-webkit-details-marker]:hidden ${rowBg}`}>
          <span className="flex-1 text-[16px] font-medium">{t("Source priority")}</span>
          <span className="text-black/40 transition-transform group-open/prio:rotate-90 dark:text-white/40">
            <Chevron open={false} />
          </span>
        </summary>
        <p className="text-[13px] text-black/55 dark:text-white/55">{t("Daily summaries follow the order of this list.")}</p>
        <ol className="p-0">
          {(sources ?? []).map((s, i) => (
            <li key={s.id}>
              <span>
                {s.connector === "manual" ? t("Entered by you") : s.name} <span className="text-[13px] text-black/55 dark:text-white/55">{sourceKind(s.connector)}</span>
              </span>
              <Btn type="button" link disabled={i === 0 || ordering} aria-label={t("Prefer {{name}}", { name: s.name })} onClick={() => moveUp(i)}>
                {t("Move up")}
              </Btn>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

/** One import: what it holds now (a row belongs to the newest import that delivered it), newest first. */
function ImportView({ b, kind, device, go, erased }: { b: Batch; kind: string; device?: string; go: (p: Page) => void; erased: () => void }) {
  const [d, err] = useOp(() => op<BatchDetail>("import.show", { id: b.import_id, limit: 50 }), [b.import_id]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const name = sourceKind(kind);
  const erase = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      await op("import.erase", { id: b.import_id });
      erased();
    } catch (e) {
      setProblem(errText(e));
      setBusy(false);
    }
  };
  return (
    <div>
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{b.at ? when(b.at) : name}</h2>
      {NAMED.has(kind) && device && <p className="text-[13px] text-black/55 dark:text-white/55">{device}</p>}
      <Problem text={err ?? problem} />
      {b.status === "review" ? (
        <p>
          {t("Waiting for you to check. Nothing from it is in your data yet.")}{" "}
          <Btn type="button" link onClick={() => go("review")}>
            {t("Check it")}
          </Btn>
        </p>
      ) : (
        d && (
          <>
            <p className="text-[13px] text-black/55 dark:text-white/55">{t("{{count}} entries", { count: d.rows })}</p>
            {d.items.length > 0 && (
              <Group>
                {d.items.map((p) => {
                  const v = shown(p);
                  return (
                    <li key={`${p.metric}|${p.start_ms}`} className="flex items-center gap-3 px-4 py-3">
                      <span className="me-auto grid min-w-0 gap-px">
                        <strong>{nameOf(p.metric, p.name)}</strong>
                        <span className="text-[13px] text-black/55 dark:text-white/55">{when(p.start_ms, p.tz_min)}</span>
                      </span>
                      <span className="max-w-1/2 truncate text-end">
                        {v.value} {v.unit}
                      </span>
                    </li>
                  );
                })}
              </Group>
            )}
            {d.rows > d.items.length && <p className="mt-1 mb-4 px-4 text-[13px] text-black/55 dark:text-white/55">{t("Showing the newest {{count}}.", { count: d.items.length })}</p>}
          </>
        )
      )}
      {!WHOLE_ONLY.has(kind) && (
        <DeleteTwice
          label={t("Delete this import")}
          title={t("Delete this import's data?")}
          detail={b.status === "review" ? t("The import waiting for you will be deleted.") : t("{{count}} entries will be deleted.", { count: d?.rows ?? 0 })}
          busy={busy || (!d && b.status !== "review")}
          run={erase}
        />
      )}
    </div>
  );
}

type OcrPick = { code?: string; new?: boolean; skip?: boolean; unit?: string };

/** One lab report waiting for review: each printed result → a measure (suggested, searched, or new) and its
 *  unit, or skipped; the test date for all of them. The core applies the rules (units, duplicates). */
function OcrReview({ b, done, discard }: { b: BatchDetail; done: (text: string) => void; discard: () => void }) {
  const c = b.candidates as { at: number; dated?: boolean; items: OcrItem[] };
  // no date on the report: the person sets it (the import time isn't the test date)
  const [date, setDate] = useState(c.dated === false ? "" : day(c.at));
  const [picks, setPicks] = useState<OcrPick[]>(() => c.items.map((it) => (it.code ? { code: it.code } : {})));
  const [other, setOther] = useState<number>();
  const [info, setInfo] = useState<Record<string, MetricInfo>>({});
  /** "<code className="font-mono text-[0.9em]"> <printed unit>" → the measure's unit the printed one maps to ("" when none fits), from the core */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  // names and units of every measure on offer
  useEffect(() => {
    const codes = new Set<string>();
    c.items.forEach((it, i) => {
      if (it.code) codes.add(it.code);
      for (const s of it.suggest ?? []) codes.add(s.code);
      const p = picks[i]?.code;
      if (p) codes.add(p);
    });
    const missing = [...codes].filter((x) => !info[x]);
    if (missing.length)
      Promise.all(missing.map((code) => op<MetricInfo>("metric.show", { code }).then((m) => [code, m] as const, () => null))).then((got) =>
        setInfo((old) => ({ ...old, ...Object.fromEntries(got.filter((g): g is readonly [string, MetricInfo] => !!g)) })),
      );
    // which unit each chosen measure would take the printed one as
    const want = c.items.flatMap((it, i) => {
      const code = picks[i]?.code;
      return code && picked[`${code} ${it.unit}`] === undefined ? [[code, it.unit] as const] : [];
    });
    if (want.length)
      Promise.all(
        want.map(([code, unit]) =>
          op<MetricInfo & { picked_unit?: string }>("metric.show", { code, printed_unit: unit }).then(
            (m): readonly [string, string] => [`${code} ${unit}`, m.picked_unit ?? ""],
            () => null,
          ),
        ),
      ).then((got) => setPicked((old) => ({ ...old, ...Object.fromEntries(got.filter((g): g is readonly [string, string] => !!g)) })));
  }, [picks, c.items, info, picked]);
  const set = (i: number, p: OcrPick) => setPicks((old) => old.map((x, k) => (k === i ? p : x)));
  /** a numeric measure whose units don't include the printed one: the person must choose */
  const needsUnit = (i: number) => {
    const p = picks[i];
    const m = p?.code ? info[p.code] : undefined;
    if (!p?.code || !m || m.agg === "none" || m.agg === "interval" || !m.units.some((u) => u)) return false;
    return !p.unit && picked[`${p.code} ${c.items[i]!.unit}`] === "";
  };
  const count = picks.filter((p, i) => !p.skip && (p.code || p.new) && !needsUnit(i)).length;
  const save = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const choices = picks.map((p) => (p.skip ? { skip: true } : p.new ? { new: true } : p.code ? { code: p.code, ...(p.unit ? { unit: p.unit } : {}) } : {}));
      const r = await op<{ saved: number; left: number; created: number }>("review.confirm_ocr", {
        id: b.import_id,
        choices,
        date,
        tz_min: -new Date(`${date}T12:00`).getTimezoneOffset(),
      });
      done(
        (r.created
          ? t("Saved {{count}} results, with {{created}} new measures.", { count: r.saved, created: r.created })
          : t("Saved {{count}} results.", { count: r.saved })) +
          (r.left ? ` ${t("{{n}} left out: no measure, or a unit that doesn't fit it.", { n: r.left })}` : ""),
      );
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const label = (code: string) => (info[code] ? nameOf(code, info[code]!.name) : code);
  // as the web's review card: only what needs the person is listed; what matched by itself folds into one line
  const [unmatched] = useState(() => c.items.flatMap((it, i) => (it.code ? [] : [i])));
  const [open, setOpen] = useState<number>();
  const [showMatched, setShowMatched] = useState(false);
  const todo = c.items.flatMap((_, i) => (unmatched.includes(i) || needsUnit(i) ? [i] : []));
  const matched = c.items.flatMap((_, i) => (todo.includes(i) ? [] : [i]));
  const left = picks.filter((p) => !p.skip && !p.code && !p.new).length;
  const choose = (i: number, p: OcrPick) => {
    set(i, p);
    setOpen(undefined);
    setOther(undefined);
  };
  const item = (i: number) => {
    const it = c.items[i]!;
    const p = picks[i] ?? {};
    const m = p.code ? info[p.code] : undefined;
    const numeric = m && m.agg !== "none" && m.agg !== "interval";
    const offered = [...new Set([...(it.code ? [it.code] : []), ...(it.suggest ?? []).map((x) => x.code), ...(p.code ? [p.code] : [])])];
    const state = p.skip ? t("Skipped") : p.new ? t("New measure") : p.code ? label(p.code) : t("Choose a measure");
    return (
      <li key={i} className={p.skip ? "opacity-50" : ""}>
        <button type="button" className="select-none flex min-h-[64px] w-full items-center gap-3 px-4 py-2.5 text-start transition-colors active:bg-black/5 dark:active:bg-white/10" aria-expanded={open === i} onClick={() => setOpen(open === i ? undefined : i)}>
          <span className="min-w-0 flex-1">
            <strong>{it.name}</strong>
            <span className="text-[13px] text-black/55 dark:text-white/55">
              {state}
              {it.ref ? ` · ${t("Reference {{ref}}", { ref: it.ref })}` : ""}
            </span>
          </span>
          <span className="shrink-0 text-end text-[17px] font-semibold tabular-nums">
            {it.cmp ?? ""}
            {String(it.v)}
            <span className="ms-1 block text-[12px] font-normal text-black/55 dark:text-white/55">{it.unit}</span>
            {it.flag && (
              <span className="ms-1 text-xs font-semibold text-amber-600" title={it.flag === "H" ? t("Marked high") : t("Marked low")}>
                {it.flag === "H" ? "↑" : "↓"}
              </span>
            )}
          </span>
        </button>
        {open === i && (
          <div className="flex flex-wrap gap-2 px-4 pb-3 [&>label]:basis-full" role="group" aria-label={t("Measure for {{name}}", { name: it.name })}>
            {offered.map((code) => (
              <Btn key={code} type="button" on={p.code === code} aria-pressed={p.code === code} onClick={() => choose(i, { code })}>
                {label(code)}
              </Btn>
            ))}
            <Btn type="button" aria-pressed={!!p.new} on={p.new} onClick={() => choose(i, { new: true })}>
              {t("New measure “{{name}}”", { name: it.name })}
            </Btn>
            <Btn type="button" onClick={() => setOther(i)}>
              {t("Another measure…")}
            </Btn>
            <Btn type="button" onClick={() => choose(i, p.skip ? (it.code ? { code: it.code } : {}) : { skip: true })}>
              {p.skip ? t("Restore") : t("Skip")}
            </Btn>
            {other === i && <MetricPicker placeholder={t("Search measures")} onPick={(x) => choose(i, { code: x.code })} />}
            {numeric && m.units.some((u) => u) && (m.units.length > 1 || needsUnit(i)) && (
              <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
                {t("Unit")}
                <select className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" aria-label={t("Unit for {{name}}", { name: it.name })} value={p.unit ?? ""} onChange={(e) => set(i, { ...p, unit: e.target.value || undefined })}>
                  <option value="">{picked[`${p.code} ${it.unit}`] ? t("As printed ({{unit}})", { unit: it.unit }) : t("Choose the unit…")}</option>
                  {m.units.map((u) => (
                    <option key={u} value={u}>
                      {unitLabel(u) || u}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
      </li>
    );
  };
  return (
    <div className="mb-8">
      <h3 className="mb-3 text-[20px] font-semibold">{t("Lab report")}</h3>
      <Group>
        <Item
          title={t("Test date")}
          after={<input className="rounded-lg bg-black/5 px-2 py-1 text-[15px] text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}
        />
      </Group>
      {c.dated === false && <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]">{t("The date wasn't found on the report. Set the day the sample was taken.")}</p>}
      <p className="mb-4 px-1 text-[15px] text-black/55 dark:text-white/55">
        {todo.length
          ? t("{{n}} results, {{k}} matched by themselves.", { n: c.items.length, k: matched.length })
          : t("{{n}} results, all matched by themselves. Check them against the report before saving.", { n: c.items.length })}
      </p>
      {todo.length > 0 && <Group title={t("Needs you ({{n}})", { n: todo.length })}>{todo.map(item)}</Group>}
      {/* what matched by itself folds into one row (as the web's): open it to check or change */}
      {matched.length > 0 && (
        <Group>
          <button type="button" className="select-none flex min-h-[56px] w-full items-center gap-3 px-4 text-start" aria-expanded={showMatched} onClick={() => setShowMatched(!showMatched)}>
            <span className="flex-1 text-[16px] font-medium">{t("{{n}} matched", { n: matched.length })}</span>
            <span className="text-black/40 dark:text-white/40">
              <Chevron open={showMatched} />
            </span>
          </button>
          {showMatched && matched.map(item)}
        </Group>
      )}
      <Problem text={err} />
      {left > 0 && <p className="mb-2 px-1 text-[13px] text-black/55 dark:text-white/55">{t("{{n}} not handled: they won't be saved.", { n: left })}</p>}
      <Btn type="button" primary className="w-full!" disabled={busy || !count || !date} onClick={save}>
        {t("Save {{count}} results", { count })}
      </Btn>
      <div className="mt-1 flex justify-center">
        <Btn type="button" link danger onClick={discard}>
          {t("Discard this report")}
        </Btn>
      </div>
    </div>
  );
}

function Review() {
  const [items, err, reload] = useOp(() => op<BatchDetail[]>("review.list"), []);
  const [grants] = useOp(() => op<Grant[]>("grant.list"), []);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const act = async (name: string, id: number, ok: string) => {
    try {
      await op(name, { id });
      setMsg({ ok: true, text: ok });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  };
  // which agent proposed it: its writer key (older proposals: "g<grant id>")
  const agent = (by?: unknown) => grants?.find((g) => g.writer === by || `g${g.id}` === by)?.name;
  if (err) return <Problem text={err} />;
  return (
    <section className="mx-auto w-full max-w-3xl">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Waiting for you")}</h2>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Nothing here is visible in your readings until you confirm it.")}</p>
      {msg &&
        (msg.ok ? (
          <p className="text-[13px] text-black/55 dark:text-white/55" role="status">
            {msg.text}
          </p>
        ) : (
          <Problem text={msg.text} />
        ))}
      {items && !items.length && <p className="text-black/55 dark:text-white/55">{t("Nothing is waiting.")}</p>}
      {[...(items ?? [])].sort((a, b) => Number(b.import_id === justRead) - Number(a.import_id === justRead)).map((b) => {
        if (b.candidates?.kind === "ocr")
          return (
            <OcrReview
              key={b.import_id}
              b={b}
              done={(text) => (setMsg({ ok: true, text }), reload())}
              discard={() => act("review.discard", b.import_id, t("Discarded."))}
            />
          );
        if (b.candidates?.kind === "result")
          return (
            <ResultReview
              key={b.import_id}
              b={b}
              done={(text) => (setMsg({ ok: true, text }), reload())}
              discard={() => act("review.discard", b.import_id, t("Discarded."))}
            />
          );
        const proposal = b.candidates?.kind === "proposal";
        const rows = (b.candidates?.rows ?? []) as { metric: string; start_ms: number; tz_min?: number; value: unknown; unit?: string }[];
        const by = proposal ? agent(b.candidates?.by) : undefined;
        return (
          <div key={b.import_id} className={`${card}`}>
            <h3 className="mb-2 text-[17px] font-semibold">{proposal ? (by ? t("Proposed by {{name}}", { name: by }) : t("Proposed by an agent")) : t("From a lab report photo")}</h3>
            {b.candidates?.note && <p>“{b.candidates.note}”</p>}
            {proposal ? (
              <table className="w-full text-sm">
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.metric}-${r.start_ms}`}>
                      <td title={r.metric}>{nameOf(r.metric, r.metric)}</td>
                      <td className="px-2 py-1.5 align-top">{when(r.start_ms, r.tz_min)}</td>
                      <td className="font-semibold tabular-nums">
                        {typeof r.value === "string" ? resultText(r.value) : String(r.value)} <span className="ms-0.5 text-[0.65em] font-medium text-black/55 dark:text-white/55">{unitLabel(r.unit ?? "")}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-[13px] text-black/55 dark:text-white/55">{t("Matching lab items to measures arrives with photo import.")}</p>
            )}
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              {proposal && (
                <Btn type="button" primary onClick={() => act("review.confirm", b.import_id, t("Added to your readings."))}>
                  {t("Add to my readings")}
                </Btn>
              )}
              <Btn type="button" onClick={() => act("review.discard", b.import_id, t("Discarded."))}>
                {t("Discard")}
              </Btn>
            </div>
          </div>
        );
      })}
    </section>
  );
}

const windowText = (w: Grant["window"]) =>
  w === "all" ? t("all time") : "last_days" in w ? t("last {{n}} days", { n: w.last_days }) : t("a date range");
const writeText = (w: "none" | "propose" | "derived") =>
  ({ none: t("read only"), propose: t("read and write"), derived: t("full read and write") })[w];

const EXPIRY: [number, string][] = [
  [30, tk("30 days")],
  [90, tk("90 days")],
  [365, tk("1 year")],
];

/** After a grant is made: how to plug it into the chosen app, one click where the shell can do it. */
function ConnectSteps({ client, token, bin, found, done }: { client: Client; token: string; bin: string; found: boolean; done: () => void }) {
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const oneClick = client.oneClick && isDesktop;
  return (
    <div className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]" role="status">
      <h3 className="mb-2 text-[17px] font-semibold">{t("Connect {{name}}", { name: client.name })}</h3>
      {oneClick && (
        <>
          <p>
            {found ? t("{{name}} is on this computer.", { name: client.name }) : t("{{name}}'s settings folder wasn't found; it is created if you go ahead.", { name: client.name })}{" "}
            {t("Health can add itself to its settings for you. Other servers there are kept, and the original file is saved next to it (.health-bak).")}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn
              type="button"
              primary
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const f = await connectAgent(client.id, token);
                  setResult({ ok: true, text: t("Added to {{file}}. Restart {{name}} to pick it up.", { file: f, name: client.name }) });
                } catch (e) {
                  setResult({ ok: false, text: String(e) });
                }
                setBusy(false);
              }}
            >
              {t("Add to {{name}}", { name: client.name })}
            </Btn>
          </div>
          {result && <p className={result.ok ? "text-[13px] text-black/55 dark:text-white/55" : "text-[15px] text-brand-red"}>{result.text}</p>}
          <p className="text-[13px] text-black/55 dark:text-white/55">{t("Or do it by hand:")}</p>
        </>
      )}
      <ol className="list-decimal ps-5 leading-relaxed [&_li+li]:mt-3">
        {client.steps(bin, token).map((st) => (
          <li key={st.text}>
            {st.text}
            {st.code && (
              <div className="mt-1.5 flex items-start gap-2 [&_pre]:min-w-0 [&_pre]:flex-1 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre">
                <pre className="overflow-x-auto rounded-xl bg-black/5 p-3 font-mono text-xs whitespace-pre-wrap break-all dark:bg-white/10">{st.code}</pre>
                <Copy text={st.code} label={t("Copy")} />
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className="text-[13px] text-black/55 dark:text-white/55">
        {t("The token is shown only this once. The app works with your data even when Health is closed (with a passphrase lock, keep Health open and unlocked). If you move the Health app, or the access expires, connect again. Apps that run in a web browser (such as ChatGPT or claude.ai) can't reach Health: it only answers on this computer.")}
      </p>
      <Btn type="button" link onClick={done}>
        {t("Done")}
      </Btn>
    </div>
  );
}

/** Revoking cuts the app off at once: ask first, and say so if it fails. */
function Revoke({ id, name, done }: { id: number; name: string; done: () => void }) {
  const [ask, setAsk] = useState(false);
  const [err, setErr] = useState<string>();
  if (!ask)
    return (
      <Btn type="button" link onClick={() => setAsk(true)}>
        {t("Revoke")}
      </Btn>
    );
  return (
    <span className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center flex items-center gap-2">
      <Btn
        type="button"
        danger
        onClick={() =>
          op("grant.revoke", { id }).then(
            () => (setAsk(false), done()),
            (e) => setErr(errText(e)),
          )
        }
      >
        {t("Revoke {{name}}", { name })}
      </Btn>
      <Btn type="button" onClick={() => setAsk(false)}>
        {t("Keep")}
      </Btn>
      {err && <Problem text={err} />}
    </span>
  );
}

function LastUsed({ id }: { id: number }) {
  const [last, , reload] = useOp(() => op<Audit[]>("audit.list", { grant_id: id, limit: 1 }), [id]);
  usePoll(reload);
  if (!last) return null;
  return <span className="text-[13px] text-black/55 dark:text-white/55">{last[0] ? t("last used {{when}}", { when: ago(last[0].at) }) : t("not used yet")}</span>;
}

function Agents({ want, path }: { want?: string; path?: string[] }) {
  const [grants, err, reload] = useOp(() => op<Grant[]>("grant.list"), []);
  const [found, setFound] = useState<string[]>([]);
  // connecting is two screens: the apps (#/agents/connect), then what the one chosen may use (…/connect/claude)
  const connecting = want === "connect";
  const client = connecting ? CLIENTS.find((c) => c.id === path?.[0]) : undefined;
  const [name, setName] = useState("");
  const [groups, setGroups] = useState<string[]>(GROUPS.filter((g) => !g.sensitive).map((g) => g.key));
  const [detail, setDetail] = useState(false);
  const [days, setDays] = useState(90);
  const [expiry, setExpiry] = useState(90);
  const [write, setWrite] = useState<Grant["write"]>("none");
  const [reports, setReports] = useState(false);
  const [profile, setProfile] = useState(false);
  const [made, setMade] = useState<{ client: Client; token: string }>();
  const [msg, setMsg] = useState<string>();
  const [bin, setBin] = useState("health");
  useEffect(() => {
    corePath().then(setBin, () => {});
    agentClients().then((c) => setFound(c.map((x) => x.id)), () => {});
  }, []);
  const pick = (c: Client) => {
    setName(c.id === "other" ? "" : c.name);
    setMade(undefined);
    nav(`agents/connect/${c.id}`);
  };
  const create = async () => {
    if (!client) return;
    setMsg(undefined);
    try {
      const r = await op<Grant & { token: string }>("grant.create", {
        name,
        groups: write === "derived" ? [...new Set([...groups, "derived"])] : groups,
        detail,
        reports,
        profile,
        window: days ? { last_days: days } : "all",
        write,
        expires_ms: Date.now() + expiry * DAY,
      });
      setMade({ client, token: r.token });
      backBy(2, "agents");
      reload();
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const toggle = (k: string) => setGroups((g) => (g.includes(k) ? g.filter((x) => x !== k) : [...g, k]));
  const everyday = GROUPS.filter((g) => g.key !== "derived" && !g.sensitive).map((g) => g.key);
  const sensitive = GROUPS.filter((g) => g.key !== "derived" && g.sensitive).map((g) => g.key);
  const setAll = (keys: string[], on: boolean) => setGroups((g) => (on ? [...new Set([...g, ...keys])] : g.filter((k) => !keys.includes(k))));
  const ordered = [...CLIENTS].sort((a, b) => Number(found.includes(b.id)) - Number(found.includes(a.id)));
  if (connecting)
    return (
      <section className="mx-auto w-full max-w-3xl">
        {!client ? (
          <>
            <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Connect an app")}</h2>
            <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Choose the AI app that should use your health data.")}</p>
            <Group aria-label={t("Agent apps")}>
              {ordered.map((c) => (
                <Item key={c.id} title={c.name} text={found.includes(c.id) ? t("On this computer") : undefined} onClick={() => pick(c)} />
              ))}
            </Group>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{client.id === "other" ? t("What the app may use") : t("What {{name}} may use", { name: client.name })}</h2>
            <p className="text-[13px] text-black/55 dark:text-white/55">{t("It sees only what you turn on here. It can never delete anything or open your backups.")}</p>

            <CardHead title={t("Health data")} on={everyday.every((k) => groups.includes(k))} set={(on) => setAll(everyday, on)} />
            <Group>
              {GROUPS.filter((g) => g.key !== "derived" && !g.sensitive).map((g) => (
                <SwitchRow key={g.key} icon={<GroupIcon k={g.key} />} label={t(g.label)} on={groups.includes(g.key)} set={() => toggle(g.key)} />
              ))}
            </Group>

            <CardHead title={t("Sensitive data")} on={sensitive.every((k) => groups.includes(k))} set={(on) => setAll(sensitive, on)} />
            <Group>
              {GROUPS.filter((g) => g.key !== "derived" && g.sensitive).map((g) => (
                <SwitchRow key={g.key} icon={<GroupIcon k={g.key} />} label={t(g.label)} on={groups.includes(g.key)} set={() => toggle(g.key)} />
              ))}
            </Group>
            <p className="mt-1 mb-4 px-4 text-[13px] text-black/55 dark:text-white/55">{t("Off unless you turn them on. Turn on only what the app needs.")}</p>

            <CardHead title={t("Detail")} on={detail && reports && profile} set={(on) => (setDetail(on), setReports(on), setProfile(on))} />
            <Group>
              <SwitchRow label={t("Individual entries")} sub={t("Otherwise one summary per day")} on={detail} set={setDetail} />
              <SwitchRow label={t("Full lab report text")} sub={t("Every item on the report, including categories that are off")} on={reports} set={setReports} />
              <SwitchRow label={t("Age and sex")} sub={t("From your profile; never your birth month")} on={profile} set={setProfile} />
            </Group>

            <h4 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("What it may do")}</h4>
            <Group role="radiogroup" aria-label={t("What it may do")}>
              {(
                [
                  ["none", t("Read only"), t("The agent can only look at your data")],
                  ["propose", t("Read and write"), t("You confirm each entry the agent saves")],
                  ["derived", t("Full read and write"), t("The agent can write data without asking you")],
                ] as const
              ).map(([k, label, sub]) => (
                <li key={k}>
                  <label className="select-none flex items-center gap-3 px-4 py-3 relative cursor-default [&_input[type=radio]]:pointer-events-none [&_input[type=radio]]:absolute [&_input[type=radio]]:opacity-0">
                    <input type="radio" name="write" checked={write === k} onChange={() => setWrite(k)} />
                    <span className="me-auto grid min-w-0 gap-px">
                      <strong>{label}</strong>
                      <span className="text-[13px] text-black/55 dark:text-white/55">{sub}</span>
                    </span>
                    <span className="min-w-4 text-end font-semibold text-primary" aria-hidden="true">
                      {write === k ? "✓" : ""}
                    </span>
                  </label>
                </li>
              ))}
            </Group>

            <h4 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("Time")}</h4>
            <Group>
              <li className="flex items-center gap-3 px-4 py-3">
                <span className="me-auto grid min-w-0 gap-px" id="grant-back">
                  <strong>{t("Data from the last")}</strong>
                </span>
                <span className="mt-3 inline-flex rounded-[9px] bg-black/5 p-0.5 dark:bg-white/10" role="group" aria-labelledby="grant-back">
                  {(
                    [
                      [30, t("30 days")],
                      [90, t("90 days")],
                      [365, t("1 year")],
                      [0, t("All")],
                    ] as const
                  ).map(([d, l]) => (
                    <Btn key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
                      {l}
                    </Btn>
                  ))}
                </span>
              </li>
              <li className="flex items-center gap-3 px-4 py-3">
                <label className="me-auto grid min-w-0 gap-px" htmlFor="grant-expiry">
                  <strong>{t("Agent access ends after")}</strong>
                </label>
                <select id="grant-expiry" className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white w-auto min-w-36 max-w-1/2" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
                  {EXPIRY.map(([d, l]) => (
                    <option key={d} value={d}>
                      {t(l)}
                    </option>
                  ))}
                </select>
              </li>
            </Group>

            <h4 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("Name")}</h4>
            <Group>
              <li className="flex items-center gap-3 px-4 py-3">
                <label className="me-auto grid min-w-0 gap-px" htmlFor="grant-name">
                  <strong>{t("Name shown in the access log")}</strong>
                </label>
                <input id="grant-name" className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white w-auto min-w-36 max-w-1/2 text-end" placeholder={t("My agent")} value={name} onChange={(e) => setName(e.target.value)} required />
              </li>
            </Group>

            <Problem text={msg} />
            <Btn type="submit" primary className="mt-4 w-full!" disabled={!groups.length || !name.trim()}>
              {t("Allow access")}
            </Btn>
          </form>
        )}
      </section>
    );
  return (
    <section className="mx-auto w-full max-w-3xl">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Agent access")}</h2>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Btn type="button" primary onClick={() => (setMade(undefined), nav("agents/connect"))}>
            {t("Connect an app…")}
          </Btn>
        </div>
      </div>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">
        {t("Let AI apps (Claude, Codex and others) use your data through MCP, with access settings built in.")}
      </p>
      {made && <ConnectSteps client={made.client} token={made.token} bin={bin} found={found.includes(made.client.id)} done={() => setMade(undefined)} />}
      <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("Current access")}</h3>
      <Problem text={err} />
      {grants && !grants.length ? (
        <p className="text-black/55 dark:text-white/55">{t("No app has access yet.")}</p>
      ) : (
        <Group>
          {(grants ?? [])
            .slice()
            .reverse()
            .map((g) => {
              const live = !g.revoked_ms && g.expires_ms > Date.now();
              return (
                <li key={g.id} className={`flex items-center gap-3 px-4 py-3 ${live ? "" : "opacity-55"}`} aria-label={g.name}>
                  <span className="me-auto grid min-w-0 gap-px">
                    <strong>{g.name}</strong>
                    <span className="text-[13px] text-black/55 dark:text-white/55">
                      {g.groups.map(groupLabel).join(t(", "))}
                      {t(", ")}
                      {g.detail ? t("individual entries") : t("daily summaries")}
                      {t(", ")}
                      {windowText(g.window)}
                      {t(", ")}
                      {writeText(g.write)}
                    </span>
                    {live && <LastUsed id={g.id} />}
                  </span>
                  <span className="flex flex-none flex-col items-end gap-1.5">
                    <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs whitespace-nowrap text-black/60 dark:bg-white/10 dark:text-white/60">
                      {live
                        ? t("until {{date}}", { date: new Date(g.expires_ms).toLocaleDateString(i18nLocale()) })
                        : g.revoked_ms
                          ? t("revoked")
                          : t("expired")}
                    </span>
                    {live && <Revoke id={g.id} name={g.name} done={reload} />}
                  </span>
                </li>
              );
            })}
        </Group>
      )}
      <AuditLog />
    </section>
  );
}

/** Agents' reads change no data, so no change event announces them: look again every few seconds. */
function usePoll(reload: () => void, ms = 5000) {
  useEffect(() => {
    const t = setInterval(reload, ms);
    return () => clearInterval(t);
  }, [reload, ms]);
}

function AuditLog() {
  const [log, err, reloadLog] = useOp(() => op<Audit[]>("audit.list", { limit: 200 }), []);
  usePoll(reloadLog);
  const [grants] = useOp(() => op<Grant[]>("grant.list"), []);
  const nameOf = (id: number) => grants?.find((g) => g.id === id)?.name ?? `#${id}`;
  return (
    <div className={`${card}`}>
      <h3 className="mb-2 text-[17px] font-semibold">{t("Access log")}</h3>
      <Problem text={err} />
      {log && !log.length && <p className="text-black/55 dark:text-white/55">{t("No agent has read anything yet.")}</p>}
      <table className="w-full text-sm">
        <tbody>
          {(log ?? []).map((a, i) => (
            <tr key={`${a.at}-${i}`}>
              <td className="px-2 py-1.5 align-top">{when(a.at)}</td>
              <th scope="row">{nameOf(a.grant_id)}</th>
              <td className="px-2 py-1.5 align-top">{a.op}</td>
              <td className="px-2 py-1.5 align-top">{a.metrics.join(", ")}</td>
              <td className="font-semibold tabular-nums">{a.denied ? <span className="text-amber-600">{t("refused")}</span> : t("{{count}} rows", { count: a.rows })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Backup and export (as the web's 备份与导出): save a backup, restore one, or write a table for other tools. */
function Backup({ want }: { want?: string }) {
  const setSheet = (x: "save" | "restore" | "csv") => nav(`backup/${x}`);
  const [file, setFile] = useState<string>();
  const titles = { save: t("Save a backup"), restore: t("Restore a backup"), csv: t("Export a table (CSV)") };
  // each a screen of its own (#/backup/save)
  if (want === "save") return <BackupSave />;
  if (want === "restore") return <Import file={file} onFile={setFile} go={() => goBack("backup")} kind="restore" title={titles.restore} />;
  if (want === "csv") return <CsvExport />;
  return (
    <section className="mx-auto w-full max-w-3xl">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Backup")}</h2>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Save or restore a backup file to move your data to another device.")}</p>
      <Group>
        <Row icon={<Icon k="backup" />} label={titles.save} sub={t("Encrypted with a password you choose")} onClick={() => setSheet("save")} />
        <Row icon={<Icon k="data" />} label={titles.restore} sub={t("Merges; nothing is overwritten")} onClick={() => setSheet("restore")} />
        <Row icon={<GroupIcon k="other" />} label={titles.csv} sub={t("Unencrypted, for spreadsheets and other tools")} onClick={() => setSheet("csv")} />
      </Group>
      <ClearDataRow />
    </section>
  );
}

/** A table of readings for other tools (web 导出表格): chosen groups only; unencrypted, so it says so. */
function CsvExport() {
  const [groups, setGroups] = useState<string[]>(GROUPS.filter((g) => !g.sensitive).map((g) => g.key));
  const [dateOnly, setDateOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<string>();
  const save = async () => {
    setErr(undefined);
    setDone(undefined);
    setBusy(true);
    try {
      let rows = 0;
      const path = await saveExport(`health-${day(Date.now())}.csv`, "text/csv", { name: "CSV", ext: "csv" }, async (path) => {
        const r = await op<{ path: string; rows: number }>("export.csv", { path, groups, date_only: dateOnly });
        rows = r.rows;
        return r.path;
      });
      if (path) setDone(t("Saved {{file}}: {{count}} rows. It isn't encrypted: keep it somewhere safe.", { file: fileName(path), count: rows }));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="[&_h3]:mt-6">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Export a table (CSV)")}</h2>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Export unencrypted data for use in other software.")}</p>
      <form
        className="flex flex-col gap-3"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {[false, true].map((sensitive) => (
          <Group key={String(sensitive)} title={sensitive ? t("Sensitive: tick only what you need") : t("What to include")}>
            {GROUPS.filter((g) => g.sensitive === sensitive).map((g) => (
              <label key={g.key} className="select-none flex min-h-[52px] cursor-pointer items-center gap-4 px-4">
                <Checkbox
                  component="span"
                  checked={groups.includes(g.key)}
                  onChange={() => setGroups((x) => (x.includes(g.key) ? x.filter((k) => k !== g.key) : [...x, g.key]))}
                />
                <span className="flex-1 text-[16px]">{t(g.label)}</span>
              </label>
            ))}
          </Group>
        ))}
        <Group>
          <SwitchRow label={t("Dates only (no times or time zones)")} on={dateOnly} set={setDateOnly} />
        </Group>
        <Problem text={err} />
        <Btn type="submit" primary disabled={busy || !groups.length}>
          {busy ? t("Saving…") : t("Save table…")}
        </Btn>
      </form>
      {done && (
        <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]" role="status">
          {done}
        </p>
      )}
    </section>
  );
}

function BackupSave() {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<string>();
  // local date and time: a second backup the same day gets its own name
  const stamp = (() => {
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  })();
  const save = async () => {
    setErr(undefined);
    setDone(undefined);
    if (pw.length < 8) return setErr(t("Use at least 8 characters."));
    if (pw !== pw2) return setErr(t("The two passwords differ."));
    setBusy(true);
    try {
      let bytes = 0;
      // the save dialog already asked before replacing a file; elsewhere it's the app's own folder
      const path = await saveExport(`health-${stamp}.zuhealth`, "application/octet-stream", { name: t("Health backup"), ext: "zuhealth" }, async (path) => {
        const r = await op<{ bytes: number; path: string }>("backup.export", { path, password: pw, replace: true });
        bytes = r.bytes;
        return r.path;
      });
      if (!path) return;
      setDone(t("Saved {{file}} ({{mb}} MB). Keep the password safe: without it the backup cannot be opened.", { file: fileName(path), mb: (bytes / 1e6).toFixed(1) }));
      setPw("");
      setPw2("");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="[&_h3]:mt-6">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Save a backup")}</h2>
      <form
        className="flex flex-col gap-3"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <PasswordField label={t("Password")} value={pw} onChange={setPw} auto="new-password" />
        <PasswordField label={t("Repeat password")} value={pw2} onChange={setPw2} auto="new-password" />
        <p className="text-[13px] text-black/55 dark:text-white/55">{t("At least 8 characters. There is no way to recover a forgotten backup password.")}</p>
        <Problem text={err} />
        <Btn type="submit" primary disabled={busy}>
          {busy ? t("Saving…") : t("Save backup…")}
        </Btn>
      </form>
      {done && (
        <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]" role="status">
          {done}
        </p>
      )}
    </section>
  );
}

// ---- Health account (protocol 1, 3.1, 3.5): the identity code, linking, the inbox --------------------------

type AccountInfo = { id: string; registered: boolean; identity?: string; drops: number };
type LinkState =
  | { state: "none" | "expired" }
  | { state: "waiting"; channel: string; expires_ms: number }
  | { state: "received"; channel: string; check: string; account: string; replaces: boolean }
  | { state: "failed"; code: string };
type Polled = { status: string; saved: number; review: number; seen: number; dropped: number };

/** Fast inbox polling (every 30 s) for an hour after the identity code was shown (protocol 3.2). */
let fastUntil = 0;
export const pollFast = () => {
  fastUntil = Date.now() + 3_600_000;
};

/** Fetches results while the app is open: at once, every 5 minutes, every 30 s in the fast hour. Sends
 *  nothing while there is no registered account (the core answers `nokey` without a request). */
function useInbox() {
  useEffect(() => {
    let last = 0;
    let busy = false;
    let caughtUp = false;
    const tick = async () => {
      const due = Date.now() - last >= (Date.now() < fastUntil ? 30_000 : 300_000);
      if (!due || busy) return;
      busy = true;
      try {
        await op<Polled>("inbox.poll");
        last = Date.now();
        // once per opening: lab self-service results that came in meanwhile (ForceDecks in the last 7 days, a seca
        // measurement still waiting), as the web does on opening
        if (!caughtUp) {
          caughtUp = true;
          await op("fd.catch_up").catch(() => {});
          const seca = await op<{ pending?: unknown }>("seca.show").catch(() => ({ pending: undefined }));
          if (seca.pending) await op("seca.poll").catch(() => {});
        }
        // WHOOP, when connected: the core skips it if the last sync was under an hour ago
        await op("whoop.sync").catch(() => {});
      } catch {
        // the core starting or locked, or the service down: try again in a minute
        last = Date.now() - (Date.now() < fastUntil ? 0 : 240_000);
      } finally {
        busy = false;
      }
    };
    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);
}

function Qr({ text, label }: { text: string; label: string }) {
  const [svg, setSvg] = useState<string>();
  useEffect(() => {
    op<{ svg: string }>("account.qr", { text }).then((r) => setSvg(r.svg), () => setSvg(undefined));
  }, [text]);
  return svg ? <div className="h-42 w-42 flex-none rounded-xl bg-white p-2 [&_svg]:block [&_svg]:h-full [&_svg]:w-full" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="h-42 w-42 flex-none rounded-xl bg-white p-2 [&_svg]:block [&_svg]:h-full [&_svg]:w-full" />;
}

type AccountSheet = "identity" | "results" | "history";

/** The health account, as the web's 更多 groups it: the identity, results, and other devices, each a row with its
 *  state; details in a sheet, connecting and LAN sync on their own pages. */
function HealthAccount({ go, want }: { go: (p: Page) => void; want?: string }) {
  const [acc, setAcc] = useState<AccountInfo | null>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  type View = "main" | "connect" | "join" | "give" | "sync";
  const view: View = want === "connect" || want === "sync" || want === "join" || want === "give" ? want : "main";
  // join and give open from connect (back returns there); a result replaces the step it ends
  const setView = (v: Exclude<View, "main">, replace = false) => nav(`account/${v}`, replace);
  const [sheet, setSheet] = useState<AccountSheet>();
  const [polled, setPolled] = useState<string>();
  const [waiting, setWaiting] = useState(false);
  const [history] = useOp(() => op<{ state: "ok"; entries: LinkEntry[] } | { state: "unreadable" }>("link.devices"), []);
  const [sync] = useOp(() => op<SyncShown>("sync.state"), []);
  const live = useSyncLive();
  const load = useCallback(() => {
    op<{ account: AccountInfo | null }>("account.show").then((r) => setAcc(r.account), (e) => setErr(errText(e)));
  }, []);
  useEffect(load, [load]);
  const show = async () => {
    setErr(undefined);
    setBusy(true);
    try {
      await op("account.register");
      pollFast();
      load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setErr(undefined);
    setBusy(true);
    try {
      const r = await op<Polled>("inbox.poll");
      const parts = [
        r.saved && t("{{count}} new results saved", { count: r.saved }),
        r.review && t("{{count}} waiting for you to check", { count: r.review }),
        r.dropped && t("{{count}} discarded (failed a check)", { count: r.dropped }),
      ].filter(Boolean);
      setPolled(parts.length ? `${parts.join(t(", "))}${t(".")}` : t("No new results."));
      setWaiting(r.review > 0);
      load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (acc === undefined) return <section className="mx-auto w-full max-w-3xl" aria-busy="true"><h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Health account")}</h2></section>;
  if (view === "connect") return <ConnectDevice hasAccount={!!acc} join={() => setView("join")} give={() => setView("give")} />;
  // joined: on to sync, the reason most people connect a device
  if (view === "join") return <LinkThis done={(ok) => { load(); setView(ok ? "sync" : "connect", true); }} />;
  if (view === "give") return <GiveAccount done={() => setView("connect", true)} />;
  if (view === "sync") return <SyncPage />;
  const entries = history?.state === "ok" ? history.entries.length : undefined;
  return (
    <section className="mx-auto w-full max-w-3xl">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Health account")}</h2>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">
        {t("Labs and service desks send results to your health account, sealed so only your devices can open them. Your account key stays on your devices, and your readings only travel between your own devices.")}
      </p>
      {!acc && (
        <div className={`${card} flex flex-col gap-3`}>
          <p>{(isMobile ? t("There is no health account on this device yet.") : t("There is no health account on this computer yet."))}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" primary disabled={busy} onClick={show}>
              {busy ? t("Contacting the service…") : t("Create my account")}
            </Btn>
            <Btn type="button" disabled={busy} onClick={() => setView("connect")}>
              {t("Connect another device…")}
            </Btn>
          </div>
        </div>
      )}
      <Problem text={err} />
      {acc && (
        <>
          <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("Health identity")}</h3>
          <Group>
            <Row
              icon={<Icon k="id" />}
              label={t("Identity code")}
              sub={t("Show it at a lab or service desk so they can send your results here")}
              value={acc.identity ? `${acc.id.slice(0, 4)}…${acc.id.slice(-4)}` : busy ? t("Contacting the service…") : t("Show")}
              onClick={() => (acc.identity ? setSheet("identity") : show())}
            />
          </Group>
          <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("Results")}</h3>
          <Group>
            <Row
              icon={<Icon k="inbox" />}
              label={t("Lab results")}
              sub={t("Checked when Health opens and every few minutes")}
              value={waiting ? t("Waiting for you") : acc.drops > 0 ? t("{{count}} discarded", { count: acc.drops }) : undefined}
              onClick={() => setSheet("results")}
            />
          </Group>
        </>
      )}
      <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("Other devices")}</h3>
      <Group>
        {acc && (
          <Row
            icon={<Icon k="wifi" />}
            label={t("Local network sync")}
            value={<SyncValue st={sync} live={live} />}
            onClick={() => setView("sync")}
          />
        )}
        {acc && (
          <Row icon={<Icon k="list" />} label={t("Connection history")} value={entries} onClick={() => setSheet("history")} />
        )}
        <Row icon={<Icon k="link" />} label={t("Connect another device")} onClick={() => setView("connect")} />
      </Group>
      {sheet && (
        <Sheet
          label={{ identity: t("Your identity code"), results: t("Lab results"), history: t("Connection history") }[sheet]}
          close={() => setSheet(undefined)}
        >
          {sheet === "identity" && acc?.identity && (
            <div className="flex items-center gap-5">
              <h3 className="mb-2 text-[17px] font-semibold">{t("Your identity code")}</h3>
              <Qr text={acc.identity} label={t("Your identity code")} />
              <p className="text-[13px] text-black/55 dark:text-white/55">{t("Show it at a lab or service desk so they can send your results here.")}</p>
              <p className="text-[13px] text-black/55 dark:text-white/55 font-mono text-[13px] break-all">{t("Account {{id}}…", { id: acc.id.slice(0, 8) })}</p>
            </div>
          )}
          {sheet === "results" && acc && (
            <div className="flex flex-col gap-3">
              <h3 className="mb-2 text-[17px] font-semibold">{t("Lab results")}</h3>
              <p className="text-[13px] text-black/55 dark:text-white/55">{t("Health checks for new results when it opens and every few minutes while it's open.")}</p>
              {acc.drops > 0 && <p className="text-[13px] text-black/55 dark:text-white/55">{t("{{count}} results were discarded because they failed a check.", { count: acc.drops })}</p>}
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Btn type="button" primary disabled={busy || !acc.registered} onClick={check}>
                  {busy ? t("Checking…") : t("Check for results now")}
                </Btn>
                {waiting && (
                  <Btn type="button" link onClick={() => go("review")}>
                    {t("Check them now")}
                  </Btn>
                )}
              </div>
              {polled && <p role="status" className="text-[13px] text-black/55 dark:text-white/55">{polled}</p>}
            </div>
          )}
          {sheet === "history" && <LinkHistoryList history={history} />}
        </Sheet>
      )}
    </section>
  );
}

/** The value on the LAN sync row: off, paused, waiting for you, syncing, or how many devices are up to date. */
function SyncValue({ st, live }: { st?: SyncShown; live?: SyncLive }) {
  if (!st) return null;
  const asking = live?.peers.some((p) => p.state === "asking");
  const text = !st.enabled
    ? t("Off")
    : st.paused
      ? t("Paused")
      : asking
        ? t("Waiting for you")
        : live?.peers.some((p) => p.state === "syncing")
          ? t("Syncing")
          : st.peers.some((p) => p.up_to_date)
            ? t("Up to date · {{count}} devices", { count: st.peers.filter((p) => p.up_to_date).length })
            : t("No devices yet");
  return (
    <>
      {asking && <span className="inline-block h-2 w-2 rounded-full bg-brand-red align-middle" aria-hidden="true" />}
      {text}
    </>
  );
}

/** One entry for connecting devices (as the web's 连接其他设备): which side is this one? */
function ConnectDevice({ hasAccount, join, give }: { hasAccount: boolean; join: () => void; give: () => void }) {
  return (
    <section className="mx-auto w-full max-w-3xl">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Connect another device")}</h2>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Your devices can sync data with each other on the same local network.")}</p>
      <div className={`${card} flex flex-col gap-2.5 [&_h3]:m-0`}>
        <h3 className="mb-2 text-[17px] font-semibold">{t("This is a new device")}</h3>
        <p className="text-[13px] text-black/55 dark:text-white/55">{t("Get data from another device.")}</p>
        <Btn type="button" primary onClick={join}>
          {t("Show connection code")}
        </Btn>
      </div>
      <div className={`${card} flex flex-col gap-2.5 [&_h3]:m-0`}>
        <h3 className="mb-2 text-[17px] font-semibold">{t("This one is already in use")}</h3>
        <p className="text-[13px] text-black/55 dark:text-white/55">{t("Send data to another device.")}</p>
        <Btn type="button" disabled={!hasAccount} onClick={give}>
          {t("Enter connection code")}
        </Btn>
        {!hasAccount && <p className="text-[13px] text-black/55 dark:text-white/55">{(isMobile ? t("There's no health identity on this device yet, so there's nothing to hand over.") : t("There's no health identity on this computer yet, so there's nothing to hand over."))}</p>}
      </div>
    </section>
  );
}

/** This computer joins an account on another device: the code to show, then the check code (protocol 3.5). */
function LinkThis({ done }: { done: (joined: boolean) => void }) {
  const [code, setCode] = useState<string>();
  // the link this screen started: adopt only that one
  const [channel, setChannel] = useState<string>();
  const [st, setSt] = useState<LinkState>({ state: "none" });
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const start = useCallback(async () => {
    setErr(undefined);
    try {
      const j = await op<{ code: string; channel: string; expires_ms: number }>("link.join");
      setCode(j.code);
      setChannel(j.channel);
      setSt({ state: "waiting", channel: j.channel, expires_ms: j.expires_ms });
    } catch (e) {
      setErr(errText(e));
    }
  }, []);
  useEffect(() => {
    start();
    return () => {
      op("link.cancel").catch(() => {});
    };
  }, [start]);
  useEffect(() => {
    if (st.state !== "waiting") return;
    const t = setTimeout(async () => {
      try {
        setSt(await op<LinkState>("link.poll"));
      } catch (e) {
        setErr(errText(e));
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [st]);
  const adopt = async () => {
    if (st.state !== "received") return;
    setBusy(true);
    try {
      await op("link.adopt", { channel, check: st.check });
      await op("account.register").catch(() => {});
      pollFast();
      done(true);
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  const copy = () => {
    if (!code) return;
    navigator.clipboard?.writeText(code).then(
      () => setCopied(true),
      () => {},
    );
  };
  return (
    <section className="mx-auto w-full max-w-3xl">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Show connection code")}</h2>
      {st.state === "waiting" && code && (
        <div className={`${card} flex items-center gap-5`}>
          <Qr text={code} label={t("Connection code")} />
          <div>
            <p>{t("Use your earlier device to scan or paste this code and connect this new one. Once connected, data moves between them on the same network with Local network sync, or with Backup.")}</p>
            <p className="text-[13px] text-black/55 dark:text-white/55 font-mono text-[13px] break-all break-all select-all">{code}</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <Btn type="button" onClick={copy}>
                {copied ? t("Copied") : t("Copy code")}
              </Btn>
            </div>
            <p className="text-[13px] text-black/55 dark:text-white/55">{t("Waiting… The code works for 10 minutes.")}</p>
          </div>
        </div>
      )}
      {st.state === "received" && (
        <div className={`${card} flex flex-col gap-3`}>
          <p>{t("Check that your other device shows the same code:")}</p>
          <p className="mt-2 mb-3 text-[34px] font-semibold tracking-[0.08em] tabular-nums" aria-label={t("Check code {{code}}", { code: st.check })}>{st.check}</p>
          {st.replaces && (
            <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]">{t("This computer's identity code will change to the other device's. Results not yet received here won't arrive.")}</p>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" primary disabled={busy} onClick={adopt}>
              {busy ? t("Connecting…") : t("They match")}
            </Btn>
            <Btn type="button" disabled={busy} onClick={() => done(false)}>
              {t("They don't match")}
            </Btn>
          </div>
        </div>
      )}
      {(st.state === "expired" || st.state === "failed") && (
        <div className={`${card} flex flex-col gap-3`}>
          <p>
            {st.state === "expired" ? t("The code expired.") : t("Connecting failed.")} {(isMobile ? t("Nothing was changed on this device.") : t("Nothing was changed on this computer."))}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" primary onClick={start}>
              {t("Start again")}
            </Btn>
          </div>
        </div>
      )}
      <Problem text={err} />
    </section>
  );
}

/** This computer hands its account to a new device showing a connection code (protocol 3.5 rule 2). */
function GiveAccount({ done }: { done: () => void }) {
  const [code, setCode] = useState("");
  const [sure, setSure] = useState(false);
  const [check, setCheck] = useState<string>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const give = async () => {
    setErr(undefined);
    setBusy(true);
    try {
      const r = await op<{ check: string }>("link.give", { code: code.trim(), confirmed: true });
      setCheck(r.check);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mx-auto w-full max-w-3xl">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Enter connection code")}</h2>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Connect a new device. Once connected, data moves between them on the same network with Local network sync, or with Backup.")}</p>
      {check ? (
        <div className={`${card} flex flex-col gap-3`}>
          <p>{t("The new device must show the same code:")}</p>
          <p className="mt-2 mb-3 text-[34px] font-semibold tracking-[0.08em] tabular-nums" aria-label={t("Check code {{code}}", { code: check })}>{check}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" primary onClick={done}>
              {t("Done")}
            </Btn>
          </div>
        </div>
      ) : (
        <form
          className={`${card} flex flex-col gap-3`}
          onSubmit={(e) => {
            e.preventDefault();
            give();
          }}
        >
          {isMobile && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <Btn
                type="button"
                primary
                onClick={async () => {
                  setErr(undefined);
                  try {
                    const text = await scanCode();
                    if (!text) return;
                    if (!text.trim().startsWith("ZUHL1:")) return setErr(t("That isn't a connection code."));
                    setCode(text.trim());
                  } catch (x) {
                    setErr(errText(x));
                  }
                }}
              >
                {t("Scan the code on the new device")}
              </Btn>
            </div>
          )}
          <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
            {t("Connection code shown on the new device")}
            <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ZUHL1:…" spellCheck={false} autoComplete="off" autoFocus={!isMobile} />
          </label>
          <label className="flex items-center gap-2">
            <input className="h-4 w-4 shrink-0 accent-primary" type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
            {t("This hands my health account to the device showing this code. It is my own device.")}
          </label>
          <Problem text={err} />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="submit" primary disabled={busy || !sure || !code.trim()}>
              {busy ? t("Sending…") : t("Hand over my account")}
            </Btn>
          </div>
        </form>
      )}
    </section>
  );
}

type ResultLine = { code: string; v: unknown; u?: string; t?: number };
type LineState = { metric?: MetricInfo; unit: string; skip: boolean };
const numericAgg = (m: MetricInfo) => m.agg !== "none" && m.agg !== "interval";

/** A result sent to the account whose measure or unit Health couldn't settle (protocol 2.3 step 4): a measure
 *  and unit per line, or skip it (W review-form.ts). Known codes and fitting units come preselected. */
function ResultReview({ b, done, discard }: { b: BatchDetail; done: (text: string) => void; discard: () => void }) {
  const c = b.candidates as unknown as { src: string; at: number; tz: number; lines: ResultLine[] };
  const [lines, setLines] = useState<LineState[]>(() => c.lines.map(() => ({ unit: "", skip: false })));
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const choose = useCallback(
    async (i: number, code: string) => {
      const l = c.lines[i]!;
      const m = await op<MetricInfo & { picked_unit?: string }>("metric.show", { code, ...(l.u ? { printed_unit: l.u } : {}) });
      setLines((ls) => ls.map((s, j) => (j === i ? { metric: m, unit: numericAgg(m) ? (m.picked_unit ?? "") : "", skip: false } : s)));
    },
    [c.lines],
  );
  // codes Health knows are preselected, once per batch: a reload of the list mustn't undo the person's choices
  const preselected = useRef<number>(undefined);
  useEffect(() => {
    if (preselected.current === b.import_id) return;
    preselected.current = b.import_id;
    c.lines.forEach((l, i) => {
      choose(i, l.code).catch(() => {});
    });
  }, [b.import_id, c.lines, choose]);
  const ready = lines.every((s) => s.skip || (s.metric && (!numericAgg(s.metric) || s.metric.units.length === 0 || s.unit))) && lines.some((s) => !s.skip);
  const save = async () => {
    setErr(undefined);
    setBusy(true);
    try {
      const choices = lines.map((s) => (s.skip ? { skip: true } : { code: s.metric?.code, ...(s.unit ? { unit: s.unit } : {}) }));
      const r = await op<{ written: number }>("review.confirm_result", { id: b.import_id, choices });
      done(t("Saved {{count}} readings.", { count: r.written }));
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  const [kind, device] = [c.src.split(":")[0], c.src.split(":").slice(1).join(":")];
  const from =
    kind === "lab" ? t("Lab device {{id}}", { id: device }) : kind === "staff" ? t("Service desk {{id}}", { id: device }) : t("Room {{id}}", { id: device });
  return (
    <div className={`${card}`}>
      <h3 className="mb-2 text-[17px] font-semibold">{t("A result from {{from}}", { from })}</h3>
      <p className="text-[13px] text-black/55 dark:text-white/55">
        {when(c.at, c.tz)}
        {t(".")} {t("Choose what each line is, or skip it.")}
      </p>
      <table className="w-full text-sm">
        <tbody>
          {c.lines.map((l, i) => {
            const s = lines[i]!;
            return (
              <tr key={`${l.code}-${i}`} className={s.skip ? "opacity-50" : undefined}>
                <td className="font-mono text-[13px] break-all">{l.code}</td>
                <td className="font-semibold tabular-nums">
                  {String(l.v)} <span className="ms-0.5 text-[0.65em] font-medium text-black/55 dark:text-white/55">{unitLabel(l.u ?? "")}</span>
                </td>
                <td className="px-2 py-1.5 align-top">
                  {s.metric ? (
                    <span>
                      {nameOf(s.metric.code, s.metric.name)}{" "}
                      <Btn
                        type="button"
                        link
                        onClick={() => setLines((ls) => ls.map((x, j) => (j === i ? { unit: "", skip: false } : x)))}
                      >
                        {t("Change")}
                      </Btn>
                    </span>
                  ) : (
                    <MetricPicker placeholder={t("Which measure is this?")} onPick={(m) => choose(i, m.code)} />
                  )}
                </td>
                <td className="px-2 py-1.5 align-top">
                  {s.metric && numericAgg(s.metric) && (s.metric.units.length > 1 || (s.metric.units.length === 1 && !s.unit)) && (
                    <select className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white"
                      aria-label={t("Unit for {{name}}", { name: l.code })}
                      value={s.unit}
                      onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}
                    >
                      <option value="">{t("Unit…")}</option>
                      {s.metric.units.map((u) => (
                        <option key={u} value={u}>
                          {unitLabel(u)}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="px-2 py-1.5 align-top">
                  <label className="flex items-center gap-2">
                    <input className="h-4 w-4 shrink-0 accent-primary"
                      type="checkbox"
                      checked={s.skip}
                      onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, skip: e.target.checked } : x)))}
                    />
                    {t("Skip")}
                  </label>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Problem text={err} />
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Btn type="button" primary disabled={!ready || busy} onClick={save}>
          {busy ? t("Saving…") : t("Save to my readings")}
        </Btn>
        <Btn type="button" onClick={discard}>
          {t("Discard")}
        </Btn>
      </div>
    </div>
  );
}

type WhoopStatus = { state: "none" | "pending" | "reauth" } | { state: "connected"; last_sync: number | null };

/** WHOOP sync with the person's own WHOOP developer app (protocol 6, decision 67): sign-in in the browser,
 *  back to this computer, then hourly while Health is open. */
function WhoopConnect() {
  const [st, setSt] = useState<WhoopStatus>();
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [redirect, setRedirect] = useState("http://localhost:47630/whoop");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const load = useCallback(() => op<WhoopStatus>("whoop.status").then(setSt, (e) => setErr(errText(e))), []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (st?.state !== "pending") return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [st, load]);
  const run = async (f: () => Promise<void>) => {
    setErr(undefined);
    setNote(undefined);
    setBusy(true);
    try {
      await f();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
      load();
    }
  };
  const connect = () =>
    run(async () => {
      const b = await op<{ url: string; redirect: string }>("whoop.begin", { client_id: id, client_secret: secret, open: true });
      setRedirect(b.redirect);
      setSecret("");
      setNote(t("WHOOP's sign-in page opened in your browser. Health finishes when you come back."));
    });
  const sync = () =>
    run(async () => {
      const r = await op<{ written: number }>("whoop.sync", { force: true });
      setNote(r.written ? t("{{count}} new readings from WHOOP.", { count: r.written }) : t("No new WHOOP data."));
    });
  if (!st) return null;
  return (
    <div className={`${card} flex flex-col gap-3`}>
      {st.state === "connected" ? (
        <>
          <p className="text-[13px] text-black/55 dark:text-white/55">
            {st.last_sync
              ? t("Connected. Health fetches new WHOOP data every hour while it's open; last time {{when}}.", { when: when(st.last_sync) })
              : t("Connected. Health fetches new WHOOP data every hour while it's open.")}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" disabled={busy} onClick={sync}>
              {busy ? t("Syncing…") : t("Sync now")}
            </Btn>
            <Btn type="button" disabled={busy} onClick={() => run(async () => void (await op("whoop.disconnect")))}>
              {t("Disconnect")}
            </Btn>
          </div>
        </>
      ) : isMobile ? (
        // nothing on a phone opens WHOOP's sign-in or catches its redirect yet (plan D14)
        <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("WHOOP can't be connected on a phone yet. Connect it in Health on your computer; its data reaches this phone when your devices sync.")}</p>
      ) : st.state === "pending" ? (
        <p className="text-[13px] text-black/55 dark:text-white/55">{t("Waiting for the WHOOP sign-in in your browser…")}</p>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            connect();
          }}
        >
          <p className="text-[13px] text-black/55 dark:text-white/55">
            {st.state === "reauth" ? `${t("WHOOP needs you to sign in again.")} ` : ""}
            {t("Create your own app in the WHOOP developer dashboard, then copy its Client ID and Client Secret here.")}{" "}
            <WebLink url={WHOOP_DASHBOARD} label={t("Open the WHOOP developer dashboard")} />
          </p>
          <p className="text-[13px] text-black/55 dark:text-white/55">
            {t("Add this redirect URL to the app:")} <span className="font-mono text-[13px] break-all">{redirect}</span>{" "}
            <Copy text={redirect} label={t("Copy")} />
          </p>
          <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
            {t("Client ID")}
            <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <PasswordField label={t("Client Secret")} value={secret} onChange={setSecret} auto="off" />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="submit" primary disabled={busy || !id.trim() || !secret.trim()}>
              {t("Connect WHOOP")}
            </Btn>
          </div>
        </form>
      )}
      {note && <p className="text-[13px] text-black/55 dark:text-white/55" role="status">{note}</p>}
      <Problem text={err} />
    </div>
  );
}

// ---- Profile (web personal.tsx): sex and birth month kept on this computer; height and weight are the latest
// readings, and changing one here records a new reading -------------------------------------------------------

const HEIGHT = "loinc:8302-2";
const WEIGHT = "loinc:29463-7";
type Personal = { sex?: "Male" | "Female"; age?: number; birth?: string };
type ProfileField = "sex" | "birth" | "height" | "weight";

const sexLabel = (s?: string) => (s === "Male" ? t("Male") : s === "Female" ? t("Female") : undefined);
const birthLabel = (b: string) =>
  new Intl.DateTimeFormat(i18nLocale(), { year: "numeric", month: "long", timeZone: "UTC" }).format(Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, 1));

function ProfilePage({ want }: { want?: string }) {
  const [me, , reloadMe] = useOp(() => op<Personal>("profile.get"), []);
  const [latest, , reloadLatest] = useOp(() => op<Point[]>("obs.latest"), []);
  const edit = (["sex", "birth", "height", "weight"] as const).find((f) => f === want);
  const setEdit = (f: ProfileField) => nav(`profile/${f}`);
  if (edit)
    return (
      <ProfileEdit
        field={edit}
        me={me ?? {}}
        done={() => {
          goBack("profile");
          reloadMe();
          reloadLatest();
        }}
      />
    );
  const latestOf = (code: string) => {
    const v = latest?.find((p) => p.metric === code)?.value;
    return typeof v === "number" ? v : undefined;
  };
  const h = latestOf(HEIGHT);
  const w = latestOf(WEIGHT);
  const unset = <span className="text-[13px] text-black/55 dark:text-white/55">{t("Not set")}</span>;
  // as the web shows them: one decimal at most
  const one = (v: number) => (Math.round(v * 10) / 10).toLocaleString(i18nLocale(), { maximumFractionDigits: 1 });
  const rows: { k: ProfileField; label: string; value: ReactNode }[] = [
    { k: "sex", label: t("Sex"), value: sexLabel(me?.sex) ?? unset },
    { k: "birth", label: t("Birth month"), value: me?.birth ? `${birthLabel(me.birth)} · ${t("{{count}} years old", { count: me.age ?? 0 })}` : unset },
    { k: "height", label: t("Height"), value: h !== undefined ? `${one(h * 100)} cm` : unset },
    { k: "weight", label: t("Weight"), value: w !== undefined ? `${one(w)} kg` : unset },
  ];
  return (
    <section className="mx-auto w-full max-w-3xl">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Profile")}</h2>
      <Group>
        {rows.map((x) => (
          <Item key={x.k} title={x.label} after={x.value} onClick={() => setEdit(x.k)} />
        ))}
      </Group>
    </section>
  );
}

function ProfileEdit({ field, me, done }: { field: ProfileField; me: Personal; done: () => void }) {
  const [year, setYear] = useState(me.birth?.slice(0, 4) ?? "");
  const [month, setMonth] = useState(me.birth ? String(Number(me.birth.slice(5, 7))) : "");
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const now = new Date();
  const run = async (f: () => Promise<unknown>) => {
    setErr(undefined);
    setBusy(true);
    try {
      await f();
      done();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  const measure = (metric: string, unit: string, min: number, max: number) => {
    const v = parseNumber(value);
    if (!Number.isFinite(v) || v < min || v > max) return setErr(t("Type a number between {{min}} and {{max}}.", { min, max }));
    const d = new Date();
    run(() => op("manual.enter", { entries: [{ metric, value: v, unit, at: { ms: d.getTime(), tz_min: -d.getTimezoneOffset() } }] }));
  };
  const title = { sex: t("Sex"), birth: t("Birth month"), height: t("Height"), weight: t("Weight") }[field];
  return (
    <section className="[&_h3]:mt-6">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{title}</h2>
      {field === "sex" && (
        <>
          <Group role="radiogroup" aria-label={t("Sex")}>
            {(["Female", "Male"] as const).map((s) => (
              <li key={s}>
                <button
                  type="button"
                  className="select-none flex w-full items-center gap-3 px-4 py-3 text-start"
                  role="radio"
                  aria-checked={me.sex === s}
                  disabled={busy}
                  onClick={() => run(() => op("profile.set", { sex: s }))}
                >
                  <span className="me-auto grid min-w-0 gap-px">
                    <strong>{sexLabel(s)}</strong>
                  </span>
                  <span className="min-w-4 text-end font-semibold text-primary" aria-hidden="true">
                    {me.sex === s ? "✓" : ""}
                  </span>
                </button>
              </li>
            ))}
          </Group>
          {me.sex && (
            <Btn type="button" link disabled={busy} onClick={() => run(() => op("profile.set", { sex: null }))}>
              {t("Clear")}
            </Btn>
          )}
        </>
      )}
      {field === "birth" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!year || !month) return setErr(t("Choose a year and a month."));
            run(() => op("profile.set", { birth: `${year}-${month.padStart(2, "0")}` }));
          }}
        >
          {isTouch ? (
            <BirthWheels year={year} month={month} setYear={setYear} setMonth={setMonth} />
          ) : (
            <>
            <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
              {t("Year")}
              <select className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={year} onChange={(e) => setYear(e.target.value)} required>
                <option value="">{t("Choose…")}</option>
                {Array.from({ length: now.getFullYear() - 1900 + 1 }, (_, i) => now.getFullYear() - i).map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
              {t("Month")}
              <select className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={month} onChange={(e) => setMonth(e.target.value)} required>
                <option value="">{t("Choose…")}</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>
                    {new Intl.DateTimeFormat(i18nLocale(), { month: "long", timeZone: "UTC" }).format(Date.UTC(2000, m - 1, 1))}
                  </option>
                ))}
              </select>
            </label>
            </>
          )}
          <Problem text={err} />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="submit" primary disabled={busy}>
              {t("Save")}
            </Btn>
            {me.birth && (
              <Btn type="button" link disabled={busy} onClick={() => run(() => op("profile.set", { birth: null }))}>
                {t("Clear")}
              </Btn>
            )}
          </div>
        </form>
      )}
      {(field === "height" || field === "weight") && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (field === "height") measure(HEIGHT, "cm", 30, 272);
            else measure(WEIGHT, "kg", 1, 650);
          }}
        >
          <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
            {field === "height" ? t("Height (cm)") : t("Weight (kg)")}
            <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus required />
          </label>
          <p className="text-[13px] text-black/55 dark:text-white/55">{t("Saved as a new reading now, entered by you.")}</p>
          <Problem text={err} />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="submit" primary disabled={busy}>
              {t("Save")}
            </Btn>
          </div>
        </form>
      )}
      {field === "sex" && <Problem text={err} />}
    </section>
  );
}

type LinkEntry = { id: string; dir: "gave" | "got"; at: number; check: string };

/** Connection history (owner, 2026-11-22: a local record of the links this device completed; list only, as the
 *  web's 连接记录). Newest first, after this device itself. */
function LinkHistoryList({ history }: { history?: { state: "ok"; entries: LinkEntry[] } | { state: "unreadable" } }) {
  if (!history) return null;
  return (
    <>
      <h3 className="mb-2 text-[17px] font-semibold">{t("Connection history")}</h3>
      <Group aria-label={t("Connection history")}>
        <li className="flex items-center gap-3 px-4 py-3">
          <Icon k="account" />
          <span className="me-auto grid min-w-0 gap-px">
            <strong>{t("This device")}</strong>
          </span>
          <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs whitespace-nowrap text-black/60 dark:bg-white/10 dark:text-white/60">{t("This one")}</span>
        </li>
        {history.state === "unreadable" ? (
          <li className="flex items-center gap-3 px-4 py-3 text-[13px] text-black/55 dark:text-white/55">{t("Can't read the connection history")}</li>
        ) : history.entries.length === 0 ? (
          <li className="flex items-center gap-3 px-4 py-3 text-[13px] text-black/55 dark:text-white/55">{t("No connections recorded on this device")}</li>
        ) : (
          history.entries.map((x) => (
            <li key={x.id} className="flex items-center gap-3 px-4 py-3">
              <Icon k="account" />
              <span className="me-auto grid min-w-0 gap-px">
                <strong>{x.dir === "gave" ? t("Handed over from this device") : t("Received from another device")}</strong>
                <span className="text-[13px] text-black/55 dark:text-white/55">{t("{{date}} · Check code {{code}}", { date: when(x.at), code: x.check })}</span>
                {x.dir === "gave" && <span className="text-[13px] text-black/55 dark:text-white/55">{t("The other device may not have confirmed it")}</span>}
              </span>
            </li>
          ))
        )}
      </Group>
    </>
  );
}

type SyncQuestion = { ask: "join"; imports: number } | { ask: "erase"; imports: number; rows: number };
type LivePeer = {
  device: string;
  name: string;
  state: "connecting" | "syncing" | "up_to_date" | "partly" | "asking" | "cant_connect" | "ended";
  received?: number;
  wanted?: number;
  skipped?: number;
  asking?: SyncQuestion;
  code?: string;
  last_synced?: number;
};
type SyncLive = { idle?: string; clock_off: boolean; peers: LivePeer[] };
type SyncShown = {
  enabled: boolean;
  joined: boolean;
  paused: boolean;
  account: boolean;
  device: string;
  peers: { device: string; name: string; last_seen: number; last_synced?: number; up_to_date: boolean; skipped: number }[];
};

/** LAN sync's live state, kept fresh by the core's events. */
function useSyncLive(): SyncLive | undefined {
  const [live, setLive] = useState<SyncLive>();
  useEffect(() => {
    let on = true;
    const load = () => op<SyncLive>("sync.live").then((l) => on && setLive(l), () => {});
    load();
    const stop = onSync(load);
    return () => {
      on = false;
      stop();
    };
  }, []);
  return live;
}

/** A device as people know it: the name another Health sends ("Health for Mac", "Health web · Chrome"). */
function deviceName(n: string): string {
  if (!n) return t("Another device");
  const web = /^Health web · (.+)$/.exec(n);
  if (web) return t("Web · {{browser}}", { browser: web[1] });
  if (n === "Health web") return t("Web");
  const os = /^Health for (Mac|Windows|Linux)$/.exec(n) ?? /^Health [\d.]+ · (macos|windows|linux)$/i.exec(n);
  if (os) {
    const k = os[1]!.toLowerCase();
    return k.startsWith("mac") ? t("Health for Mac") : k === "windows" ? t("Health for Windows") : t("Health for Linux");
  }
  return n;
}

/** Why a session ended, in words; the code itself is kept for "Details". */
function endedText(code?: string): string {
  switch (code) {
    case "paused":
      return t("Sync paused");
    case "declined":
      return t("You chose Not now. Health asks again next time.");
    case "off":
      return t("Sync is off on that device");
    case "sync_changed":
      return t("That device changed during the sync. Health syncs again shortly.");
    case "sync_proto":
      return t("That device needs an update to sync with this one.");
    case "stall":
    case "restart":
    case "closed":
    case "disconnected":
    case "webrtc":
      return t("The connection dropped. Health tries again shortly.");
    default:
      return t("Sync stopped. Health tries again shortly.");
  }
}

function peerState(p: LivePeer): string {
  switch (p.state) {
    case "up_to_date":
      return t("Up to date");
    case "syncing":
      return p.wanted ? t("Syncing · {{received}} of {{wanted}} imports", { received: p.received ?? 0, wanted: p.wanted }) : t("Syncing");
    case "partly":
      return t("Partly synced");
    case "asking":
      return t("Waiting for you");
    case "cant_connect":
      return t("On the same network but can't connect directly");
    case "ended":
      return endedText(p.code);
    default:
      return t("Connecting…");
  }
}

/** LAN sync (docs/lan-sync.md §11) on its own page: the switch, a row per device with its state, and the two
 *  questions as a dialog that says what happens. */
function SyncPage() {
  const [st, err, reload] = useOp(() => op<SyncShown>("sync.state"), []);
  const live = useSyncLive();
  const [busy, setBusy] = useState(false);
  // a question put aside with Esc comes back when it changes
  const [dismissed, setDismissed] = useState<string>();
  const run = (f: () => Promise<unknown>) => {
    setBusy(true);
    f().finally(() => {
      setBusy(false);
      reload();
    });
  };
  const livePeers = live?.peers ?? [];
  const known = (st?.peers ?? []).filter((p) => !livePeers.some((l) => l.device === p.device));
  const asking = livePeers.find((p) => p.asking);
  const askKey = asking ? `${asking.device}:${JSON.stringify(asking.asking)}` : undefined;
  const answer = (device: string, allow: boolean) => run(() => op("sync.answer", { device, allow }));
  return (
    <section className="mx-auto w-full max-w-3xl">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Local network sync")}</h2>
      <Problem text={err} />
      {st?.paused && (
        <div className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px] flex items-center justify-between gap-4">
          <span>{t("Sync is paused: you chose Not now when another device would delete data here.")}</span>
          <Btn type="button" primary disabled={busy} onClick={() => run(() => op("sync.set", { paused: false }))}>
            {t("Continue syncing")}
          </Btn>
        </div>
      )}
      {live?.clock_off && <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]">{t("This computer's clock is off by more than 2 minutes, so other devices can't be reached.")}</p>}
      {st && (
        <Group>
          <SwitchRow
            icon={<Icon k="wifi" />}
            label={t("Sync on this network")}
            sub={t("Devices you've connected sync automatically when Health is open on the same local network.")}
            on={st.enabled}
            set={(on) => run(() => op("sync.set", { enabled: on }))}
          />
        </Group>
      )}
      {st?.enabled && live?.idle === "offline" && <p className="text-[13px] text-black/55 dark:text-white/55">{t("Health is offline, so it doesn't sync.")}</p>}
      {st?.enabled && (
        <>
          <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("Devices")}</h3>
          <Group aria-label={t("Devices on this network")}>
            {livePeers.length === 0 && known.length === 0 && (
              <li className="flex items-center gap-3 px-4 py-3 text-[13px] text-black/55 dark:text-white/55">{t("No other device seen yet. Open Health on your other device on this network.")}</li>
            )}
            {livePeers.map((p) => (
              <li key={p.device} className="flex items-center gap-3 px-4 py-3 [&_progress]:mt-1.5 [&_progress]:h-1 [&_progress]:w-full [&_progress]:accent-primary">
                <Icon k="device" />
                <span className="me-auto grid min-w-0 gap-px">
                  <strong>{deviceName(p.name)}</strong>
                  <span className="text-[13px] text-black/55 dark:text-white/55" role="status">
                    {peerState(p)}
                    {p.last_synced ? ` · ${t("Last synced {{date}}", { date: when(p.last_synced) })}` : ""}
                  </span>
                  {p.state === "syncing" && p.wanted ? (
                    <progress max={p.wanted} value={p.received ?? 0} aria-label={t("Syncing")} />
                  ) : null}
                  {p.state === "partly" && (
                    <span className="text-[13px] text-black/55 dark:text-white/55">
                      {t("{{count}} items can't be merged, for example a measure whose unit differs between the two devices. Health tries again every day.", { count: p.skipped ?? 0 })}
                    </span>
                  )}
                  {p.state === "asking" && (
                    <Btn type="button" link onClick={() => setDismissed(undefined)}>
                      {t("Answer")}
                    </Btn>
                  )}
                  {p.state === "ended" && p.code && (
                    <details className="text-[13px] text-black/55 dark:text-white/55">
                      <summary className="select-none cursor-pointer py-1.5">{t("Details")}</summary>
                      <span className="font-mono text-[13px] break-all">{p.code}</span>
                    </details>
                  )}
                </span>
                <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs whitespace-nowrap text-black/60 dark:bg-white/10 dark:text-white/60">{p.state === "up_to_date" ? "✓" : ""}</span>
              </li>
            ))}
            {known.map((p) => (
              <li key={p.device} className="flex items-center gap-3 px-4 py-3">
                <Icon k="device" />
                <span className="me-auto grid min-w-0 gap-px">
                  <strong>{deviceName(p.name)}</strong>
                  <span className="text-[13px] text-black/55 dark:text-white/55">
                    {t("Not on this network now")}
                    {p.last_synced ? ` · ${t("Last synced {{date}}", { date: when(p.last_synced) })}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </Group>
        </>
      )}
      {asking?.asking && askKey !== dismissed && (
        <Sheet label={t("Sync")} close={() => setDismissed(askKey)}>
          {asking.asking.ask === "join" ? (
            <div className="flex flex-col gap-3">
              <h3 className="mb-2 text-[17px] font-semibold">{t("Combine with {{device}}?", { device: deviceName(asking.name) })}</h3>
              <p>
                {t("This computer's data and that device's data are combined, and both then hold the same. This computer has {{count}} imports. Combining can't be undone.", {
                  count: asking.asking.imports,
                })}
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Btn type="button" primary disabled={busy} onClick={() => answer(asking.device, true)}>
                  {t("Combine")}
                </Btn>
                <Btn type="button" disabled={busy} onClick={() => answer(asking.device, false)}>
                  {t("Not now")}
                </Btn>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <h3 className="mb-2 text-[17px] font-semibold">{t("Delete here too?")}</h3>
              <p>
                {t("{{device}} deleted {{imports}} imports. Syncing deletes their {{rows}} readings on this computer too.", {
                  device: deviceName(asking.name),
                  imports: asking.asking.imports,
                  rows: asking.asking.rows,
                })}
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Btn type="button" danger disabled={busy} onClick={() => answer(asking.device, true)}>
                  {t("Delete here too")}
                </Btn>
                <Btn type="button" disabled={busy} onClick={() => answer(asking.device, false)}>
                  {t("Not now (pauses sync)")}
                </Btn>
              </div>
            </div>
          )}
        </Sheet>
      )}
    </section>
  );
}

// ---- About: privacy and open-source licenses (as the web's 更多 › 关于) --------------------------------------------

/** Every sentence matches what the desktop does (checked 2026-11-24): data in the encrypted profile (SQLCipher, key in
 *  the keychain or from the passphrase); OCR on this computer, models downloaded once from Hugging Face and GitHub
 *  (health-ocr components); lab results sealed to the account's key, the lab's device history kept by the backend
 *  (as on the web); WHOOP relayed, not kept; LAN sync direct and encrypted, the relay sees sealed signalling only;
 *  agents only through grants, every call audited. Change the page when any of that changes. */
function Privacy() {
  const sections: [string, string[]][] = [
    [
      t("Where your data is"),
      [
        (isMobile ? t("Your health data is kept in one encrypted file on this device. Its key is in the device's secure storage (Keychain or Keystore).") : t("Your health data is kept in one encrypted file on this computer. Its key is in your system keychain, or comes from your passphrase if you set one.")),
        (isMobile ? t("Nothing is uploaded to a cloud. If this device is lost or the data deleted, it can't be recovered: save a backup now and then in Backup.") : t("Nothing is uploaded to a cloud. If this computer is lost or the data deleted, it can't be recovered: save a backup now and then in Backup.")),
      ],
    ],
    [
      t("How it's protected"),
      [
        (isMobile ? t("Lab reports are read entirely on this device; photos and PDFs aren't uploaded. The first use downloads the recognition models from Hugging Face and GitHub.") : t("Lab reports are read entirely on this computer; photos and PDFs aren't uploaded. The first use downloads the recognition models from Hugging Face and GitHub.")),
        t("Lab results arrive encrypted (some PDF files aren't, but random file names keep others from finding them), and only your devices can open them. The lab records the devices and dates you used, for its staff to see."),
        t("When WHOOP is connected, its data passes through the health service on its way here and isn't kept."),
        t("Local network sync sends data directly between your own devices on the same network, encrypted. The health service only passes on sealed connection details: it can't read them or tell whose they are."),
        t("AI assistants (MCP) read your health data only within the access you grant in Agent access, and every read is recorded there."),
      ],
    ],
    [t("Coming later"), [t("Android and iOS versions will follow.")]],
  ];
  return (
    <>
      {sections.map(([title, lines]) => (
        <section key={title} aria-label={title}>
          <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{title}</h3>
          <Group>
            {lines.map((line) => (
              <li key={line} className="flex items-center gap-3 px-4 py-3">
                <span className="me-auto grid min-w-0 gap-px">{line}</span>
              </li>
            ))}
          </Group>
        </section>
      ))}
    </>
  );
}

type LicenseEntry = { name: string; versions: string[]; license: string; url?: string };
/** The main components by hand, with the copyright lines from their own license files (checked 2026-11-24); the
 *  full list is generated (scripts/gen-licenses.ts). License texts, copyright lines and the LOINC notice stay in
 *  English, as written. */
const MAIN_COMPONENTS: { name: string; license: string; by: string; url: string }[] = [
  { name: "Tauri", license: "MIT OR Apache-2.0", by: "Copyright (c) 2017 - Present Tauri Apps Contributors", url: "https://tauri.app" },
  { name: "React", license: "MIT", by: "Copyright (c) Meta Platforms, Inc. and affiliates.", url: "https://react.dev" },
  { name: "i18next, react-i18next", license: "MIT", by: "Copyright (c) 2025 i18next", url: "https://www.i18next.com" },
  { name: "SQLCipher", license: "BSD-3-Clause", by: "Copyright (c) 2025, ZETETIC LLC", url: "https://www.zetetic.net/sqlcipher/" },
  { name: "SQLite", license: "Public domain", by: "SQLite Consortium", url: "https://sqlite.org/copyright.html" },
  { name: "LibTomCrypt", license: "Public domain or WTFPL", by: "Tom St Denis and contributors", url: "https://github.com/libtom/libtomcrypt" },
  { name: "OpenSSL", license: "Apache-2.0", by: "The OpenSSL Project Authors", url: "https://www.openssl.org" },
  { name: "rusqlite", license: "MIT", by: "Copyright (c) 2014 The rusqlite developers", url: "https://github.com/rusqlite/rusqlite" },
  { name: "tract", license: "MIT OR Apache-2.0", by: "Sonos, Inc. and Mathieu Poumeyrol", url: "https://github.com/sonos/tract" },
  { name: "hayro", license: "Apache-2.0 OR MIT", by: "Copyright (c) The Hayro Authors", url: "https://github.com/LaurenzV/hayro" },
  { name: "str0m", license: "MIT OR Apache-2.0", by: "Martin Algesten", url: "https://github.com/algesten/str0m" },
  { name: "RustCrypto", license: "MIT OR Apache-2.0", by: "Copyright (c) 2019-2026 The RustCrypto Project Developers", url: "https://github.com/RustCrypto" },
  { name: "dalek-cryptography", license: "BSD-3-Clause", by: "Copyright (c) 2016-2021 isis agora lovecruft", url: "https://github.com/dalek-cryptography" },
  { name: "rustls", license: "Apache-2.0 OR ISC OR MIT", by: "Copyright (c) 2016, Joseph Birr-Pixton", url: "https://github.com/rustls/rustls" },
  { name: "PP-OCRv5", license: "Apache-2.0", by: "PaddlePaddle Authors", url: "https://github.com/PaddlePaddle/PaddleOCR" },
  { name: "multilingual-e5-small", license: "MIT", by: "intfloat", url: "https://huggingface.co/intfloat/multilingual-e5-small" },
  {
    name: "LOINC",
    license: "LOINC License",
    by: "Copyright (c) 1995 Regenstrief Institute, Inc. and the Logical Observation Identifiers Names and Codes (LOINC) Committee",
    url: "https://loinc.org/license/",
  },
  { name: "UCUM", license: "UCUM License", by: "Copyright 1999-2024 Regenstrief Institute, Inc.", url: "https://unitsofmeasure.org/license" },
];

/** The attribution the LOINC license asks for, verbatim (as the web shows it). */
const LOINC_NOTICE =
  "This product includes all or a portion of the LOINC® table, LOINC panels and forms file, LOINC document ontology file, and/or LOINC hierarchies file, or is derived from one or more of the foregoing, subject to a license from Regenstrief Institute, Inc. LOINC is a registered United States trademark of Regenstrief Institute, Inc. Full license: https://loinc.org/license/";

function Licenses() {
  const [all, setAll] = useState<{ crates: LicenseEntry[]; npm: LicenseEntry[]; texts: Record<string, string> }>();
  useEffect(() => {
    import("./licenses.json").then((m) => setAll(m.default as typeof all));
  }, []);
  const list = (items: LicenseEntry[]) => (
    <ul className="mb-3 columns-2 gap-6 text-xs [&_li]:break-inside-avoid [&_li]:py-0.5">
      {items.map((c) => (
        <li key={c.name}>
          {c.url ? <WebLink url={c.url} label={c.name} /> : c.name} <span className="text-[13px] text-black/55 dark:text-white/55">{c.versions.join(", ")}</span>{" "}
          <span className="text-[13px] text-black/55 dark:text-white/55 font-mono text-[13px] break-all">{c.license}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Health is open-source software under the MIT License. It uses these open-source components and data, with thanks to their authors.")}</p>
      <Group aria-label={t("Components")}>
        {MAIN_COMPONENTS.map((c) => (
          <li key={c.name} className="flex items-center gap-3 px-4 py-3">
            <span className="me-auto grid min-w-0 gap-px">
              <strong>
                <WebLink url={c.url} label={c.name} />
              </strong>
              <span className="text-[13px] text-black/55 dark:text-white/55">{c.by}</span>
            </span>
            <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs whitespace-nowrap text-black/60 dark:bg-white/10 dark:text-white/60">{c.license}</span>
          </li>
        ))}
      </Group>
      <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">LOINC</h3>
      <p className="text-[13px] text-black/55 dark:text-white/55 mb-5 leading-snug">{LOINC_NOTICE}</p>
      {all && (
        <>
          <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("All components")}</h3>
          <details className="mb-2 [&_summary]:cursor-pointer [&_summary]:py-1.5 [&_pre]:max-h-96 [&_pre]:overflow-auto [&_pre]:text-xs [&_pre]:leading-snug [&_pre]:whitespace-pre-wrap [&_pre]:text-black/55">
            <summary className="select-none cursor-pointer py-1.5">{t("{{count}} Rust crates", { count: all.crates.length })}</summary>
            {list(all.crates)}
          </details>
          <details className="mb-2 [&_summary]:cursor-pointer [&_summary]:py-1.5 [&_pre]:max-h-96 [&_pre]:overflow-auto [&_pre]:text-xs [&_pre]:leading-snug [&_pre]:whitespace-pre-wrap [&_pre]:text-black/55">
            <summary className="select-none cursor-pointer py-1.5">{t("{{count}} JavaScript packages", { count: all.npm.length })}</summary>
            {list(all.npm)}
          </details>
          <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("License texts")}</h3>
          {Object.entries(all.texts).map(([name, text]) => (
            <details key={name} className="mb-2 [&_summary]:cursor-pointer [&_summary]:py-1.5 [&_pre]:max-h-96 [&_pre]:overflow-auto [&_pre]:text-xs [&_pre]:leading-snug [&_pre]:whitespace-pre-wrap [&_pre]:text-black/55">
              <summary className="select-none cursor-pointer py-1.5">{name}</summary>
              <pre className="overflow-x-auto rounded-xl bg-black/5 p-3 font-mono text-xs whitespace-pre-wrap break-all dark:bg-white/10">{text}</pre>
            </details>
          ))}
          <p className="text-[13px] text-black/55 dark:text-white/55">
            {t("Other licenses named above:")} <WebLink url="https://www.mozilla.org/MPL/2.0/" label="MPL-2.0" />, <WebLink url="https://cdla.dev/permissive-2-0/" label="CDLA-Permissive-2.0" />,{" "}
            <WebLink url="https://www.boost.org/LICENSE_1_0.txt" label="BSL-1.0" />
          </p>
        </>
      )}
    </>
  );
}

/** About (as the web's 更多 › 关于): the version, privacy and open-source licenses. */
function About({ version, want }: { version?: string; want?: string }) {
  const view = want === "privacy" || want === "licenses" ? want : undefined;
  const setView = (v: "privacy" | "licenses") => nav(`about/${v}`);
  if (view) return <Screen title={view === "privacy" ? t("Privacy") : t("Open-source licenses")}>{view === "privacy" ? <Privacy /> : <Licenses />}</Screen>;
  return (
    <section className="mx-auto w-full max-w-3xl">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("About")}</h2>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{version ? t("Health {{version}}", { version }) : "Health"}</p>
      <Group>
        <Row icon={<Icon k="shield" />} label={t("Privacy")} onClick={() => setView("privacy")} />
        <Row icon={<Icon k="scale" />} label={t("Open-source licenses")} onClick={() => setView("licenses")} />
      </Group>
    </section>
  );
}

// ---- VALD ForceDecks (as the web's fd-report.tsx; grouping and the best jump come from the core, labs.rs) ----------

/** The figure each test's best jump is picked by (the core's labs::key_of) */
const FD_KEY: Record<string, string> = { cmj: "x:fd/cmj/jump_height_imp_mom" };
/** A test's rows, in the web's order (FD_BY_TEST), with their unit */
const FD_ROWS: Record<string, [string, string][]> = {
  cmj: [
    ["x:fd/cmj/jump_height_imp_mom", "cm"],
    ["x:fd/cmj/jump_height_flight_time", "cm"],
    ["x:fd/cmj/rsi_modified", "m/s"],
    ["x:fd/cmj/flight_time", "ms"],
    ["x:fd/cmj/contraction_time", "ms"],
    ["x:fd/cmj/eccentric_duration", "ms"],
    ["x:fd/cmj/concentric_duration", "ms"],
    ["x:fd/cmj/peak_power", "W"],
    ["x:fd/cmj/peak_power_bm", "W/kg"],
    ["x:fd/cmj/concentric_mean_force_bm", "N/kg"],
    ["x:fd/cmj/concentric_impulse", "N.s"],
    ["x:fd/cmj/countermovement_depth", "cm"],
    ["x:fd/cmj/concentric_peak_velocity", "m/s"],
    ["x:fd/cmj/eccentric_braking_rfd", "N/s"],
    ["x:fd/cmj/body_mass", "kg"],
  ],
};
/** Trends need this many sessions: two points look like a broken divider (the web's TREND_MIN) */
const TREND_MIN = 3;

const fdStart = (s: FdSession) => s.trials[0]!.start_ms;
const fdBest = (s: FdSession) => s.trials[s.best]!;
const testLabel = (test: string) => (test === "cmj" ? t("Countermovement jump (CMJ)") : test.toUpperCase());
const figure = (m: Measurement | undefined, code: string): number | null => {
  const v = m?.values[code];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/** The home page's rows with the latest time on the plates' best jump in place of the latest jump (same device) */
function withBestJump(rows: Point[], s: FdSession, sources: Source[]): Point[] {
  const best = fdBest(s);
  const device = (id: number) => sources.find((x) => x.id === id);
  return rows.map((p) => {
    const src = device(p.source_id);
    return src?.connector === "lab" && src.external_id === s.device && p.metric in best.values
      ? { ...p, value: best.values[p.metric] ?? null, start_ms: best.start_ms, tz_min: best.tz_min }
      : p;
  });
}

/** A jump's key figure with its unit, as lists tell jumps apart */
function keyText(s: FdSession, k: number): string {
  const code = FD_KEY[s.test];
  const v = code ? figure(s.trials[k], code) : null;
  const unit = FD_ROWS[s.test]?.find(([c]) => c === code)?.[1] ?? "";
  return v === null ? "–" : `${num(v)} ${unitLabel(unit)}`.trim();
}

/** The session before session i of the same test and device (sessions newest first) */
const previousOf = (list: FdSession[], i: number) => list.slice(i + 1).find((p) => p.test === list[i]!.test && p.device === list[i]!.device);

function deltaOf(list: FdSession[], i: number, code: string): number | null {
  const p = previousOf(list, i);
  const a = figure(fdBest(list[i]!), code);
  const b = p ? figure(fdBest(p), code) : null;
  return a === null || b === null ? null : a - b;
}

function trendOf(list: FdSession[], i: number, code: string): { v: number; at: number }[] {
  const s = list[i]!;
  const out: { v: number; at: number }[] = [];
  for (let k = list.length - 1; k >= i; k--) {
    const p = list[k]!;
    if (p.test !== s.test || p.device !== s.device) continue;
    const v = figure(fdBest(p), code);
    if (v !== null) out.push({ v, at: fdStart(p) });
  }
  return out;
}

/** The latest VALD ForceDecks session as the dashboard's card: its best jump's height, RSI and power. */
function FdCard({ session, open }: { session: FdSession; open: () => void }) {
  const best = session.trials[session.best];
  const v = (code: string, digits: number) => {
    const x = figure(best, code);
    return x === null ? "–" : `${fixed(x, digits)}`;
  };
  return (
    <LabCard
      color={TINT.force!}
      icon={<GroupIcon k="force" />}
      title={t("VALD ForceDecks test record")}
      text={`${shortDate(fdStart(session))} · ${t("{{count}} jumps", { count: session.trials.length })}`}
      stats={[
        [t("Jump height"), v("x:fd/cmj/jump_height_imp_mom", 1), "cm"],
        ["RSI", v("x:fd/cmj/rsi_modified", 2), ""],
        [t("Peak power"), v("x:fd/cmj/peak_power_bm", 1), "W/kg"],
      ]}
      open={open}
    />
  );
}

/** A lab device's report on the dashboard: what it is and when, its key figures side by side; a tap opens it. */
function LabCard({ color, icon, title, text, stats, open }: { color: string; icon: ReactNode; title: string; text: string; stats: [string, string, string][]; open: () => void }) {
  return (
    <button type="button" className="select-none flex w-full flex-col gap-3 px-4 py-3.5 text-start transition-colors active:bg-black/5 dark:active:bg-white/10" onClick={open}>
      <span className="flex w-full items-center gap-3">
        <IconDot color={color}>{icon}</IconDot>
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-semibold leading-snug">{title}</span>
          <span className="block text-[13px] text-black/55 dark:text-white/55">{text}</span>
        </span>
        <svg className="h-4 w-4 shrink-0 text-black/30 dark:text-white/30" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 3.5 10.5 8 6 12.5" />
        </svg>
      </span>
      <span className="grid w-full grid-cols-3 gap-2">
        {stats.map(([label, value, unit]) => (
          <span key={label} className="min-w-0">
            <span className="block truncate text-[13px] text-black/55 dark:text-white/55">{label}</span>
            <span className="block text-[22px] font-semibold tracking-tight tabular-nums">
              {value}
              {unit && value !== "–" && <span className="ms-0.5 text-[13px] font-medium text-black/55 dark:text-white/55">{unitLabel(unit)}</span>}
            </span>
          </span>
        ))}
      </span>
    </button>
  );
}

function Delta({ d, unit }: { d: number | null; unit: string }) {
  if (d === null || num(Math.abs(d)).replace(/[0.,\s]/g, "") === "") return null;
  const text = `${d > 0 ? "↑" : "↓"} ${num(Math.abs(d))}`;
  return (
    <span className="ms-2.5 text-xs font-normal text-black/55 dark:text-white/55" role="img" aria-label={t("Compared with last time: {{d}}", { d: `${d > 0 ? "+" : "−"}${num(Math.abs(d))} ${unit}`.trim() })}>
      {t("vs last time")} {text}
    </span>
  );
}

function FdTrend({ list, i, code }: { list: FdSession[]; i: number; code: string }) {
  const pts = trendOf(list, i, code);
  if (pts.length < TREND_MIN) return null;
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const xy = pts.map((p, k) => ({ x: (k / (pts.length - 1)) * 100, y: hi === lo ? 50 : 90 - ((p.v - lo) / (hi - lo)) * 80 }));
  return (
    <figure className="mt-2 text-primary" aria-label={t("Trend over {{count}} tests", { count: pts.length })}>
      <div className="relative mx-1 h-16 [&_svg]:h-full [&_svg]:w-full [&_svg]:overflow-visible">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={xy.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* round dots over the stretched line, this test's filled */}
        {xy.map((p, k) => (
          <span key={pts[k]!.at} className={`absolute -ms-[3.5px] -mt-[3.5px] h-[7px] w-[7px] rounded-full border-[1.5px] border-current ${k === xy.length - 1 ? "bg-current" : "bg-white dark:bg-neutral-900"}`} style={{ left: `${p.x}%`, top: `${p.y}%` }} />
        ))}
      </div>
      <figcaption className="text-[13px] text-black/55 dark:text-white/55">
        <span>{shortDate(pts[0]!.at)}</span>
        <span>{t("This test")}</span>
      </figcaption>
    </figure>
  );
}

/** VALD ForceDecks tests: the latest by default; each jump can be opened; the best jump against the previous
 *  best of the same test; a trend from three tests; every test in History. `names`: the catalog's names of the
 *  measures (from the dashboard's readings), for the English list. */
function FdReport({ sessions, names }: { sessions: FdSession[]; names?: Record<string, string> }) {
  const [i, setI] = useState(0);
  const [jump, setJump] = useState<number | null>(null);
  const [hist, setHist] = useState(false);
  const at = Math.min(i, Math.max(0, sessions.length - 1));
  const cur = sessions[at];
  if (!cur)
    return (
      <div className="flex flex-col gap-3">
        <h3 className="mb-2 text-[17px] font-semibold">{t("No VALD ForceDecks tests yet")}</h3>
        <p className="text-[13px] text-black/55 dark:text-white/55">{t("After a test on VALD ForceDecks at the lab, the results show here.")}</p>
      </div>
    );
  const k = jump !== null && jump < cur.trials.length ? jump : cur.best;
  const tr = cur.trials[k]!;
  const onBest = k === cur.best;
  const pick = (n: number) => {
    setI(n);
    setJump(null);
    setHist(false);
  };
  return (
    <div className="[&_h4]:mt-3 [&_h4]:mb-1">
      <header className="mb-3 flex items-start justify-between gap-4 [&_h3]:m-0 [&_p]:m-0">
        <div>
          <h3 className="mb-2 text-[17px] font-semibold">{t("VALD ForceDecks tests")}</h3>
          <p className="text-[13px] text-black/55 dark:text-white/55">VALD ForceDecks · {when(fdStart(cur))}</p>
        </div>
        <Btn type="button" aria-expanded={hist} onClick={() => setHist(!hist)}>
          {t("History")}
        </Btn>
      </header>
      {hist && (
        <Group aria-label={t("Test history")}>
          {sessions.map((s, n) => (
            <li key={`${s.device}|${s.test}|${fdStart(s)}`}>
              <button type="button" className="select-none flex w-full items-center gap-3 px-4 py-3 text-start" aria-current={n === at ? "true" : undefined} onClick={() => pick(n)}>
                <span className="me-auto grid min-w-0 gap-px">
                  <strong>{when(fdStart(s))}</strong>
                  <span className="text-[13px] text-black/55 dark:text-white/55">
                    {testLabel(s.test)} · {t("{{count}} jumps", { count: s.trials.length })} · {keyText(s, s.best)}
                  </span>
                </span>
                {n === 0 && <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs whitespace-nowrap text-black/60 dark:bg-white/10 dark:text-white/60">{t("Latest")}</span>}
                {n === at && <span aria-hidden="true">✓</span>}
              </button>
            </li>
          ))}
        </Group>
      )}
      {at > 0 && (
        <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px] flex items-center justify-between gap-4" role="status">
          <span>{t("Viewing the test of {{date}}", { date: when(fdStart(cur)) })}</span>
          <Btn type="button" onClick={() => pick(0)}>
            {t("Back to the latest")}
          </Btn>
        </p>
      )}
      <section aria-label={testLabel(cur.test)}>
        <h4 className="mb-1 text-[15px] font-semibold">
          {testLabel(cur.test)} <span className="text-[13px] text-black/55 dark:text-white/55">{t("{{count}} jumps", { count: cur.trials.length })}</span>
        </h4>
        <p className="text-[13px] text-black/55 dark:text-white/55">
          {onBest
            ? cur.trials.length > 1
              ? t("Below is this test's best jump (jump {{k}})", { k: k + 1 })
              : t("One jump this time")
            : t("Below is jump {{k}}, at {{time}}", { k: k + 1, time: new Date(tr.start_ms).toLocaleTimeString([], { timeStyle: "short" }) })}
        </p>
        {cur.trials.length > 1 && (
          <div className="my-2.5 flex flex-wrap gap-1.5" role="group" aria-label={t("Each jump")}>
            {cur.trials.map((x, n) => (
              <Btn key={x.start_ms} type="button" aria-pressed={n === k} on={n === k} onClick={() => setJump(n === cur.best ? null : n)}>
                {t("Jump {{k}}", { k: n + 1 })} · {keyText(cur, n)}
                {n === cur.best && <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs whitespace-nowrap text-black/60 dark:bg-white/10 dark:text-white/60">{t("Best")}</span>}
              </Btn>
            ))}
          </div>
        )}
      </section>
      <dl className="my-3 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2 [&>div]:rounded-2xl [&>div]:bg-white [&>div]:px-3 [&>div]:py-2.5 [&>div]:shadow-sm dark:[&>div]:bg-neutral-900 [&>div.key]:col-span-full [&_dt]:text-xs [&_dt]:text-black/55 [&_dd]:mt-0.5 [&_dd]:text-lg [&_dd]:font-semibold [&_dd]:tabular-nums [&_dd_small]:text-xs [&_dd_small]:font-normal" aria-label={t("Each measure")}>
        {(FD_ROWS[cur.test] ?? []).map(([code, unit]) => {
          const v = figure(tr, code);
          const u = unitLabel(unit);
          return (
            <div key={code} className={code === FD_KEY[cur.test] ? "col-span-full" : ""}>
              <dt>{nameOf(code, names?.[code] ?? code)}</dt>
              <dd>
                {v === null ? "–" : num(v)}
                {v !== null && u ? <small> {u}</small> : null}
                {onBest && <Delta d={deltaOf(sessions, at, code)} unit={u} />}
              </dd>
              {onBest && code === FD_KEY[cur.test] && <FdTrend list={sessions} i={at} code={code} />}
            </div>
          );
        })}
      </dl>
      <p className="text-[13px] text-black/55 dark:text-white/55">{t("Each test is compared by its best jump with the previous test's best jump.")}</p>
    </div>
  );
}

// ---- seca mBCA Pro body composition report (as the web's seca.tsx and seca-model.ts) ------------------------------
// Values only: seca's reference ranges, ratings and age percentiles aren't in the exported data, so none are drawn.

const C = {
  weight: "loinc:29463-7",
  height: "loinc:8302-2",
  bmi: "loinc:39156-5",
  fmp: "loinc:41982-0",
  smm: "x:body_skeletal_muscle_mass",
  wc: "x:waist_circumference",
  r: "x:bia_resistance",
  xc: "x:bia_reactance",
  fm: "x:fat_mass",
  fmi: "x:fat_mass_index",
  ffm: "x:fat_free_mass",
  ffmp: "x:fat_free_mass_percentage",
  ffmi: "x:fat_free_mass_index",
  tbw: "x:total_body_water",
  tbwp: "x:total_body_water_percentage",
  ecw: "x:extracellular_water",
  ecwp: "x:extracellular_water_percentage",
  wr: "x:ecw_tbw_ratio",
  smmp: "x:skeletal_muscle_mass_percentage",
  smi: "x:skeletal_muscle_index",
  asmm: "x:appendicular_skeletal_muscle_mass",
  asmi: "x:appendicular_skeletal_muscle_index",
  asmp: "x:appendicular_skeletal_muscle_percentage",
  pha: "x:phase_angle",
  vat: "x:visceral_adipose_tissue",
  ree: "x:resting_energy_expenditure",
  tee: "x:total_energy_expenditure",
  smoa: "x:seca/smm_over_age",
  smoaBi: "x:seca/smm_over_age_bmi_independent",
  zsmi: "x:seca/zsmi",
  bivaR: "x:seca/biva_z_r_h",
  bivaXc: "x:seca/biva_z_xc_h",
  tbs: "x:seca/tbs",
  tbsMuscle: "x:seca/tbs_muscle",
  tbsFat: "x:seca/tbs_fat",
  bcc: "x:seca/bcc",
  bccWeight: "x:seca/bcc_weight",
  bccMuscle: "x:seca/bcc_muscle",
} as const;
type Seg = "torso" | "rightArm" | "leftArm" | "rightLeg" | "leftLeg";
const SSMM: Record<Seg, string> = {
  torso: "x:skeletal_muscle_mass_torso",
  rightArm: "x:skeletal_muscle_mass_right_arm",
  leftArm: "x:skeletal_muscle_mass_left_arm",
  rightLeg: "x:skeletal_muscle_mass_right_leg",
  leftLeg: "x:skeletal_muscle_mass_left_leg",
};
const SSMM_BI: Record<Seg, string> = {
  torso: "x:seca/ssmm_torso_bmi_independent",
  rightArm: "x:seca/ssmm_right_arm_bmi_independent",
  leftArm: "x:seca/ssmm_left_arm_bmi_independent",
  rightLeg: "x:seca/ssmm_right_leg_bmi_independent",
  leftLeg: "x:seca/ssmm_left_leg_bmi_independent",
};
const WEIGHT_LEVELS = ["LowWeight", "NormalWeight", "HighWeight", "VeryHighWeight"];
const MUSCLE_LEVELS = ["LowMuscle", "NormalMuscle", "HighMuscle", "VeryHighMuscle"];
const KCAL_TO_MJ = 0.004184;
/* weight, height and BMI stay on the body card even when seca measured them last */
const BASIC = new Set([C.weight, C.height, C.bmi]);

const fixed = (v: number, digits: number) => v.toLocaleString(i18nLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
const textOf = (m: Measurement | undefined, code: string): string | null => {
  const v = m?.values[code];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

/** The home page's rows without the values a seca measurement gave (they're in its report); weight, height, BMI stay */
function withoutScans(rows: Point[], scans: Measurement[], sources: Source[]): Point[] {
  const keys = new Set(scans.map((s) => `${s.device}|${s.start_ms}`));
  return rows.filter((p) => {
    if (BASIC.has(p.metric as (typeof C)["weight"])) return true;
    const src = sources.find((x) => x.id === p.source_id);
    return !(src?.connector === "lab" && keys.has(`${src.external_id}|${p.start_ms}`));
  });
}

type SecaCtx = { scans: Measurement[]; i: number };

function SecaDelta({ ctx, code, digits, scale = 1, unit, label = true }: { ctx: SecaCtx; code: string; digits: number; scale?: number; unit?: string; label?: boolean }) {
  const now = figure(ctx.scans[ctx.i], code);
  const before = figure(ctx.scans[ctx.i + 1], code);
  const d = now === null || before === null ? null : Number(((now - before) * scale).toFixed(digits));
  if (d === null || d === 0) return null;
  return (
    <span className="ms-2.5 text-xs font-normal text-black/55 dark:text-white/55" role="img" aria-label={t("Compared with last time: {{d}}", { d: `${d > 0 ? "+" : "−"}${fixed(Math.abs(d), digits)} ${unit ?? ""}`.trim() })}>
      {label ? `${t("vs last time")} ` : ""}
      {d > 0 ? "↑" : "↓"} {fixed(Math.abs(d), digits)}
    </span>
  );
}

function SecaTrend({ ctx, code }: { ctx: SecaCtx; code: string }) {
  const pts: { v: number; at: number }[] = [];
  for (let k = ctx.scans.length - 1; k >= ctx.i; k--) {
    const v = figure(ctx.scans[k], code);
    if (v !== null) pts.push({ v, at: ctx.scans[k]!.start_ms });
  }
  if (pts.length < TREND_MIN) return null;
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const xy = pts.map((p, k) => ({ x: (k / (pts.length - 1)) * 100, y: hi === lo ? 50 : 90 - ((p.v - lo) / (hi - lo)) * 80 }));
  return (
    <figure className="mt-2 text-primary" aria-label={t("Trend over {{count}} measurements", { count: pts.length })}>
      <div className="relative mx-1 h-16 [&_svg]:h-full [&_svg]:w-full [&_svg]:overflow-visible">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={xy.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
        {xy.map((p, k) => (
          <span key={pts[k]!.at} className={`absolute -ms-[3.5px] -mt-[3.5px] h-[7px] w-[7px] rounded-full border-[1.5px] border-current ${k === xy.length - 1 ? "bg-current" : "bg-white dark:bg-neutral-900"}`} style={{ left: `${p.x}%`, top: `${p.y}%` }} />
        ))}
      </div>
      <figcaption className="text-[13px] text-black/55 dark:text-white/55">
        <span>{shortDate(pts[0]!.at)}</span>
        <span>{t("This measurement")}</span>
      </figcaption>
    </figure>
  );
}

type SecaMain = { code: string; unit: string; digits: number; scale?: number };
type SecaSub = { label: string; code: string; unit: string; digits: number; scale?: number; pct?: string };

function SecaCard({ ctx, title, abbr, main, subs = [], missing, children }: { ctx: SecaCtx; title: string; abbr: string; main?: SecaMain; subs?: SecaSub[]; missing?: string; children?: ReactNode }) {
  const s = ctx.scans[ctx.i];
  const v = main ? figure(s, main.code) : null;
  return (
    <section className="rounded-2xl bg-white shadow-sm dark:bg-neutral-900 p-3.5 [&_h4]:m-0 [&_h4]:text-[13px] [&_header]:flex [&_header]:items-baseline [&_header]:justify-between [&_header]:gap-2" aria-label={title}>
      <header>
        <h4 className="mb-1 text-[15px] font-semibold">{title}</h4>
        <span className="text-[13px] text-black/55 dark:text-white/55">{abbr}</span>
      </header>
      {main &&
        (v !== null ? (
          <p className="my-1 tabular-nums [&_b]:text-xl [&_small]:text-black/55 dark:[&_small]:text-white/55">
            <b>{fixed(v * (main.scale ?? 1), main.digits)}</b>
            {main.unit && <small> {main.unit}</small>}
            <SecaDelta ctx={ctx} code={main.code} digits={main.digits} scale={main.scale ?? 1} unit={main.unit} />
          </p>
        ) : (
          <p className="text-[13px] text-black/55 dark:text-white/55">{missing ?? t("No data")}</p>
        ))}
      {children}
      {subs.length > 0 && (
        <dl className="mt-1.5 grid gap-0.5 text-xs [&_dd]:m-0 [&_dd]:tabular-nums [&_div]:flex [&_div]:justify-between [&_div]:gap-2 [&_dt]:text-black/55 dark:[&_dt]:text-white/55">
          {subs.map((x) => {
            const sv = figure(s, x.code);
            const pv = x.pct ? figure(s, x.pct) : null;
            return (
              <div key={x.code}>
                <dt>{x.label}</dt>
                <dd>
                  {sv === null ? "–" : `${fixed(sv * (x.scale ?? 1), x.digits)}${x.unit ? ` ${x.unit}` : ""}`}
                  {pv !== null ? ` (${fixed(pv, 1)} %)` : ""}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {main && v !== null && <SecaTrend ctx={ctx} code={main.code} />}
    </section>
  );
}

function ZScale({ z }: { z: number | null }) {
  if (z === null) return null;
  const pos = Math.min(1, Math.max(0, (z + 3) / 6));
  return (
    <div className="my-2" role="img" aria-label={t("Muscle mass z-score {{z}}", { z: fixed(z, 2) })}>
      <div className="relative h-1.5 rounded-full bg-gradient-to-r from-primary/20 to-primary [&_span]:absolute [&_span]:-top-[3px] [&_span]:-ms-1.5 [&_span]:h-3 [&_span]:w-3 [&_span]:rounded-full [&_span]:border-2 [&_span]:border-primary [&_span]:bg-white">
        <span style={{ left: `${pos * 100}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[13px] text-black/55 dark:text-white/55">
        <span>{t("Less muscle")}</span>
        <span>{t("More muscle")}</span>
      </div>
    </div>
  );
}

/** Where each limb sits around the figure (facing the person) */
const AREA: Record<Seg, string> = { rightArm: "ra", leftArm: "la", torso: "tr", rightLeg: "rl", leftLeg: "ll" };
function Segments({ ctx, codes }: { ctx: SecaCtx; codes: Record<Seg, string> }) {
  const s = ctx.scans[ctx.i];
  const label: Record<Seg, string> = { torso: t("Torso"), rightArm: t("Right arm"), leftArm: t("Left arm"), rightLeg: t("Right leg"), leftLeg: t("Left leg") };
  // the right limbs on the left, as when facing the person
  const order: Seg[] = ["rightArm", "leftArm", "torso", "rightLeg", "leftLeg"];
  return (
    <div className="my-2 grid grid-cols-[1fr_5rem_1fr] items-center gap-x-2.5 gap-y-1 [grid-template-areas:'ra_fig_la'_'tr_fig_.'_'rl_fig_ll']">
      {order.map((seg) => {
        const v = figure(s, codes[seg]);
        return (
          <div key={seg} className="flex flex-col tabular-nums" style={{ gridArea: AREA[seg] }}>
            <span className="text-[13px] text-black/55 dark:text-white/55">{label[seg]}</span>
            <b>
              {v === null ? "–" : fixed(v, 2)}
              {v !== null && <small> kg</small>}
            </b>
            <SecaDelta ctx={ctx} code={codes[seg]} digits={2} unit="kg" label={false} />
          </div>
        );
      })}
      <svg className="w-20 fill-primary/20 [grid-area:fig]" viewBox="0 0 120 200" aria-hidden="true">
        <circle cx="60" cy="18" r="13" />
        <rect x="38" y="36" width="44" height="74" rx="10" />
        <rect x="18" y="38" width="16" height="72" rx="8" />
        <rect x="86" y="38" width="16" height="72" rx="8" />
        <rect x="40" y="114" width="18" height="82" rx="9" />
        <rect x="62" y="114" width="18" height="82" rx="9" />
      </svg>
    </div>
  );
}

function WaterBar({ tbw, ecw }: { tbw: number | null; ecw: number | null }) {
  if (tbw === null || ecw === null || tbw <= 0 || ecw < 0 || ecw > tbw) return null;
  const share = (ecw / tbw) * 100;
  return (
    <div>
      <div className="mt-2 mb-1 flex h-2.5 overflow-hidden rounded-full" role="img" aria-label={t("Extracellular water is {{p}} % of total body water", { p: fixed(share, 1) })}>
        <span className="bg-primary" style={{ width: `${share}%` }} />
        <span className="bg-primary/30" style={{ width: `${100 - share}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[13px] text-black/55 dark:text-white/55">
        <span>
          {t("Extracellular water")} {fixed(ecw, 1)} L
        </span>
        <span>
          {t("Intracellular water")} {fixed(tbw - ecw, 1)} L
        </span>
      </div>
    </div>
  );
}

function Biva({ zr, zxc }: { zr: number | null; zxc: number | null }) {
  if (zr === null || zxc === null) return null;
  const S = 160;
  const clip = (z: number) => Math.min(4, Math.max(-4, z));
  const x = ((clip(zr) + 4) / 8) * S;
  const y = (1 - (clip(zxc) + 4) / 8) * S;
  const g = (z: number) => ((z + 4) / 8) * S;
  return (
    <svg className="mx-auto my-1.5 block w-full max-w-56 [&_text]:fill-black/55 [&_text]:text-[10px]" viewBox={`-24 -8 ${S + 32} ${S + 30}`} role="img" aria-label={`Z(R/H) ${fixed(zr, 2)}, Z(Xc/H) ${fixed(zxc, 2)}`}>
      <rect x="0" y="0" width={S} height={S} className="fill-black/5 dark:fill-white/5" />
      {[-2, 2].map((z) => (
        <g key={z} className="stroke-black/10 dark:stroke-white/10">
          <line x1={g(z)} y1="0" x2={g(z)} y2={S} />
          <line x1="0" y1={S - g(z)} x2={S} y2={S - g(z)} />
        </g>
      ))}
      <line className="stroke-black/55 [stroke-width:0.6] dark:stroke-white/55" x1={S / 2} y1="0" x2={S / 2} y2={S} />
      <line className="stroke-black/55 [stroke-width:0.6] dark:stroke-white/55" x1="0" y1={S / 2} x2={S} y2={S / 2} />
      <circle cx={x} cy={y} r="5" className="fill-primary" />
      <text x={S / 2} y={S + 18} textAnchor="middle">
        Z(R/H)
      </text>
      <text x="-14" y={S / 2} textAnchor="middle" transform={`rotate(-90 -14 ${S / 2})`}>
        Z(Xc/H)
      </text>
    </svg>
  );
}

function bccLabel(v: string): string {
  switch (v.replace(/[\s_-]+/g, "").toLowerCase()) {
    case "average":
      return t("Average build");
    case "overweight":
      return t("Overweight");
    case "underweight":
      return t("Underweight");
    case "active":
      return t("Active");
    case "athletic":
      return t("Athletic");
    case "obese":
    case "obesity":
      return t("Obese");
    case "sarcopenic":
    case "sarcopenia":
      return t("Sarcopenic");
    case "sarcopenicobesity":
      return t("Sarcopenic obesity");
    default:
      // a type not seen before: split the camel case so it reads
      return v.replace(/([a-z])([A-Z])/g, "$1 $2");
  }
}

function Bcc({ ctx }: { ctx: SecaCtx }) {
  const s = ctx.scans[ctx.i];
  const cls = textOf(s, C.bcc);
  const w = textOf(s, C.bccWeight);
  const m = textOf(s, C.bccMuscle);
  if (!cls && !w && !m) return <p className="text-[13px] text-black/55 dark:text-white/55">{t("No data")}</p>;
  const levels = [t("Low"), t("Normal"), t("High"), t("Very high")];
  const row = (label: string, all: string[], v: string | null) => {
    const k = v === null ? -1 : all.indexOf(v);
    return (
      <div className="my-1 flex items-center justify-between gap-2">
        <span className="text-[13px] text-black/55 dark:text-white/55">{label}</span>
        {k >= 0 ? (
          <ol className="m-0 flex list-none gap-0.5 p-0 text-[11px] [&_li]:rounded [&_li]:bg-black/5 [&_li]:px-1.5 [&_li]:py-0.5 [&_li]:text-black/55 [&_li[aria-current=true]]:bg-primary [&_li[aria-current=true]]:text-white">
            {all.map((lv, j) => (
              <li key={lv} aria-current={j === k ? "true" : undefined}>
                {levels[j]}
              </li>
            ))}
          </ol>
        ) : (
          <b>{v ?? "–"}</b>
        )}
      </div>
    );
  };
  return (
    <div>
      {cls && <p className="my-1 tabular-nums [&_b]:text-xl [&_small]:text-black/55 dark:[&_small]:text-white/55">{bccLabel(cls)}</p>}
      {row(t("Weight"), WEIGHT_LEVELS, w)}
      {row(t("Muscle"), MUSCLE_LEVELS, m)}
    </div>
  );
}

function SecaCards({ ctx }: { ctx: SecaCtx }) {
  const s = ctx.scans[ctx.i];
  const ree = figure(s, C.ree);
  const kg = "kg";
  const kgm2 = "kg/m²";
  const L = "L";
  const kcal = "kcal/d";
  const pts = t("points");
  return (
    <div className="my-3 grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-2.5">
      <SecaCard ctx={ctx} title={t("Fat mass index")} abbr="FMI" main={{ code: C.fmi, unit: kgm2, digits: 1 }} subs={[{ label: t("Fat mass"), code: C.fm, unit: kg, digits: 2 }, { label: t("Body fat percentage"), code: C.fmp, unit: "%", digits: 1 }]} />
      <SecaCard ctx={ctx} title={t("Fat-free mass index")} abbr="FFMI" main={{ code: C.ffmi, unit: kgm2, digits: 1 }} subs={[{ label: t("Fat-free mass"), code: C.ffm, unit: kg, digits: 2, pct: C.ffmp }]} />
      <SecaCard ctx={ctx} title={t("Body fat percentage")} abbr="FM %" main={{ code: C.fmp, unit: "%", digits: 1 }} subs={[{ label: t("Fat mass"), code: C.fm, unit: kg, digits: 2 }, { label: t("Fat mass index"), code: C.fmi, unit: kgm2, digits: 1 }]} />
      <SecaCard ctx={ctx} title={t("Skeletal muscle mass")} abbr="SMM" main={{ code: C.smm, unit: kg, digits: 2 }} subs={[{ label: t("Skeletal muscle share of weight"), code: C.smmp, unit: "%", digits: 1 }, { label: t("Body mass index"), code: C.bmi, unit: kgm2, digits: 1 }]}>
        <ZScale z={figure(s, C.zsmi)} />
      </SecaCard>
      <SecaCard ctx={ctx} title={t("Skeletal muscle index (MRI)")} abbr="SMI" main={{ code: C.smi, unit: kgm2, digits: 1 }} subs={[{ label: t("Skeletal muscle mass"), code: C.smm, unit: kg, digits: 2 }]} />
      <SecaCard ctx={ctx} title={t("Skeletal muscle mass for age")} abbr="SMM" main={{ code: C.smoa, unit: kg, digits: 2 }} />
      <SecaCard ctx={ctx} title={t("Phase angle")} abbr="PhA" main={{ code: C.pha, unit: "°", digits: 1 }} />
      <SecaCard ctx={ctx} title={t("Water ratio")} abbr="ECW / TBW" main={{ code: C.wr, unit: "%", digits: 1 }} subs={[{ label: t("Total body water"), code: C.tbw, unit: L, digits: 1, pct: C.tbwp }, { label: t("Extracellular water"), code: C.ecw, unit: L, digits: 1, pct: C.ecwp }]} />
      <SecaCard ctx={ctx} title={t("Visceral fat")} abbr="VAT" main={{ code: C.vat, unit: L, digits: 1 }} missing={t("No waist measurement, so it can't be calculated")} />
      <SecaCard ctx={ctx} title={t("Appendicular skeletal muscle index (DXA)")} abbr="ASMI" main={{ code: C.asmi, unit: kgm2, digits: 1 }} subs={[{ label: t("Appendicular skeletal muscle mass"), code: C.asmm, unit: kg, digits: 2, pct: C.asmp }]} />
      <SecaCard ctx={ctx} title={t("Waist circumference")} abbr="WC" main={{ code: C.wc, unit: "cm", digits: 1, scale: 100 }} />
      <SecaCard ctx={ctx} title={t("Body composition chart")} abbr="BCC">
        <Bcc ctx={ctx} />
      </SecaCard>
      <SecaCard ctx={ctx} title={t("Segmental skeletal muscle")} abbr="SSMM" subs={[{ label: t("Total skeletal muscle"), code: C.smm, unit: kg, digits: 2 }]}>
        <Segments ctx={ctx} codes={SSMM} />
      </SecaCard>
      <SecaCard ctx={ctx} title={t("Body water")} abbr="TBW / ECW" subs={[{ label: t("Total body water"), code: C.tbw, unit: L, digits: 1, pct: C.tbwp }, { label: t("Extracellular water"), code: C.ecw, unit: L, digits: 1, pct: C.ecwp }]}>
        <WaterBar tbw={figure(s, C.tbw)} ecw={figure(s, C.ecw)} />
      </SecaCard>
      <SecaCard ctx={ctx} title={t("Skeletal muscle mass for age (BMI-independent)")} abbr="SMM" main={{ code: C.smoaBi, unit: kg, digits: 2 }} />
      <SecaCard ctx={ctx} title={t("Segmental skeletal muscle (BMI-independent)")} abbr="SSMM">
        <Segments ctx={ctx} codes={SSMM_BI} />
      </SecaCard>
      <SecaCard ctx={ctx} title={t("Bioelectrical impedance vector analysis")} abbr="BIVA" subs={[{ label: t("Resistance"), code: C.r, unit: "Ω", digits: 1 }, { label: t("Reactance"), code: C.xc, unit: "Ω", digits: 1 }]}>
        <Biva zr={figure(s, C.bivaR)} zxc={figure(s, C.bivaXc)} />
      </SecaCard>
      <SecaCard ctx={ctx} title={t("TRU body score")} abbr="TBS" main={{ code: C.tbs, unit: pts, digits: 0 }} subs={[{ label: t("Muscle score"), code: C.tbsMuscle, unit: pts, digits: 0 }, { label: t("Fat score"), code: C.tbsFat, unit: pts, digits: 0 }]} />
      <SecaCard ctx={ctx} title={t("Resting energy expenditure")} abbr="REE" main={{ code: C.ree, unit: kcal, digits: 0 }} subs={[{ label: t("Total energy expenditure"), code: C.tee, unit: kcal, digits: 0 }]}>
        {ree !== null && <p className="text-[13px] text-black/55 dark:text-white/55">{t("About {{mj}} MJ a day", { mj: fixed(ree * KCAL_TO_MJ, 2) })}</p>}
        {figure(s, C.tee) === null && <p className="text-[13px] text-black/55 dark:text-white/55">{t("No activity level (PAL), so total energy expenditure can't be calculated")}</p>}
      </SecaCard>
      <SecaCard ctx={ctx} title={t("Body mass index")} abbr="BMI" main={{ code: C.bmi, unit: kgm2, digits: 1 }} subs={[{ label: t("Weight"), code: C.weight, unit: kg, digits: 1 }, { label: t("Height"), code: C.height, unit: "cm", digits: 1, scale: 100 }]} />
      <SecaCard ctx={ctx} title={t("Weight")} abbr="Weight" main={{ code: C.weight, unit: kg, digits: 1 }} />
    </div>
  );
}

/** seca mBCA Pro body composition (as the web's seca.tsx): the latest measurement, History for the others. */
function SecaReport({ scans }: { scans: Measurement[] }) {
  const [i, setI] = useState(0);
  const [hist, setHist] = useState(false);
  const at = Math.min(i, Math.max(0, scans.length - 1));
  const cur = scans[at];
  if (!cur)
    return (
      <div className="flex flex-col gap-3">
        <h3 className="mb-2 text-[17px] font-semibold">{t("No body composition data yet")}</h3>
        <p className="text-[13px] text-black/55 dark:text-white/55">{t("After a seca mBCA Pro measurement at the lab, the results show here.")}</p>
      </div>
    );
  return (
    <div className="[&_h4]:mt-3 [&_h4]:mb-1">
      <header className="mb-3 flex items-start justify-between gap-4 [&_h3]:m-0 [&_p]:m-0">
        <div>
          <h3 className="mb-2 text-[17px] font-semibold">{t("Body composition")}</h3>
          <p className="text-[13px] text-black/55 dark:text-white/55">seca mBCA Pro · {when(cur.start_ms)}</p>
        </div>
        <Btn type="button" aria-expanded={hist} onClick={() => setHist(!hist)}>
          {t("History")}
        </Btn>
      </header>
      {hist && (
        <Group aria-label={t("Measurement history")}>
          {scans.map((s, k) => (
            <li key={`${s.device}|${s.start_ms}`}>
              <button
                type="button"
                className="select-none flex w-full items-center gap-3 px-4 py-3 text-start"
                aria-current={k === at ? "true" : undefined}
                onClick={() => {
                  setI(k);
                  setHist(false);
                }}
              >
                <span className="me-auto grid min-w-0 gap-px">
                  <strong>{when(s.start_ms)}</strong>
                </span>
                {k === 0 && <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs whitespace-nowrap text-black/60 dark:bg-white/10 dark:text-white/60">{t("Latest")}</span>}
                {k === at && <span aria-hidden="true">✓</span>}
              </button>
            </li>
          ))}
        </Group>
      )}
      {at > 0 && (
        <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px] flex items-center justify-between gap-4" role="status">
          <span>{t("Viewing the measurement of {{date}}", { date: when(cur.start_ms) })}</span>
          <Btn type="button" onClick={() => setI(0)}>
            {t("Back to the latest")}
          </Btn>
        </p>
      )}
      <SecaCards ctx={{ scans, i: at }} />
      <p className="text-[13px] text-black/55 dark:text-white/55">{t("For reference ranges and ratings, go by the report the lab gives you.")}</p>
    </div>
  );
}

/** The latest seca measurement as the dashboard's card: body fat, skeletal muscle, weight. */
function SecaLabCard({ scan, open }: { scan: Measurement; open: () => void }) {
  const v = (code: string, digits: number) => {
    const x = figure(scan, code);
    return x === null ? "–" : fixed(x, digits);
  };
  return (
    <LabCard
      color={TINT.body!}
      icon={<GroupIcon k="body" />}
      title={t("Body composition report")}
      text={`seca mBCA Pro · ${shortDate(scan.start_ms)}`}
      stats={[
        [t("Body fat"), v(C.fmp, 1), "%"],
        [t("Skeletal muscle"), v(C.smm, 1), "kg"],
        [t("Weight"), v(C.weight, 1), "kg"],
      ]}
      open={open}
    />
  );
}

/** The confirm word for "Clear data": the same in every language (the owner's choice, as on the web). */
const CLEAR_WORD = "DELETE";

/** "Clear data" (as the web's): a quiet red text button on its own line; the confirm form opens in a sheet. Works
 *  when the database no longer opens too (the shell stops the core and deletes the files without opening them). */
function ClearDataRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="mt-5">
        <Btn type="button" link danger onClick={() => setOpen(true)}>
          {t("Clear data")}
        </Btn>
      </p>
      {open && (
        <Sheet label={t("Clear data")} close={() => setOpen(false)}>
          <ClearData cancel={() => setOpen(false)} />
        </Sheet>
      )}
    </>
  );
}

function ClearData({ cancel }: { cancel: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState(false);
  const ok = typed.trim().toUpperCase() === CLEAR_WORD;
  const run = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      await clearData(typed);
      setDone(true);
      // settings kept in this window go too: a fresh install
      try {
        localStorage.clear();
      } catch {}
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      setErr(
        e instanceof OpError && e.code === "busy"
          ? t("Health data is in use by another program (such as a connected AI assistant). Quit it, then try again.")
          : t("Couldn't clear the data"),
      );
      setBusy(false);
    }
  };
  return (
    <section className="[&_h3]:mt-6">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Clear data")}</h2>
      <form
        className="flex flex-col gap-3"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <p className="text-amber-600">
          {t("This deletes all Health data on this device: every record, your health account and identity code, links to other devices, and settings. This can't be undone.")}
        </p>
        <p className="text-[13px] text-black/55 dark:text-white/55">
          {t("To keep your data, save a backup first. Data on your other devices isn't affected; to sync again, link them again.")}
        </p>
        <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
          {t("Type “{{words}}” to confirm", { words: CLEAR_WORD })}
          <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={busy || done} />
        </label>
        <Problem text={err} />
        {done ? (
          <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]" role="status">
            {t("Cleared. Reloading…")}
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" disabled={busy} onClick={cancel}>
              {t("Cancel")}
            </Btn>
            <Btn type="submit" danger disabled={!ok || busy}>
              {busy ? t("Clearing…") : t("Clear data")}
            </Btn>
          </div>
        )}
      </form>
    </section>
  );
}
