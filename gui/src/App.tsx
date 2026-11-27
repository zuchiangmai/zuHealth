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
  chooseSavePath,
  corePath,
  clearData,
  initProfile,
  installOcr,
  openLink,
  isDesktop,
  isMobile,
  scanCode,
  shareFile,
  exportPath,
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

type Page = "readings" | "data" | "backup" | "profile" | "account" | "agents" | "about" | "review" | "more";
/** Narrow screens (phones): the floating tab bar's pages; the other sections are reached from More. */
type Tab = "readings" | "data" | "more";
const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "readings", label: tk("Readings"), icon: "readings" },
  { key: "data", label: tk("Add"), icon: "add" },
  { key: "more", label: tk("More"), icon: "more" },
];
/** The sections, in shortcut order (⌘1…⌘6). */
const PAGES: { key: Page; label: string }[] = [
  { key: "readings", label: tk("Readings") },
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
const Icon = ({ k }: { k: string }) => (
  <svg className="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    {ICON[k]}
  </svg>
);

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
    <main className="gate hold" role="status" aria-label={title}>
      <span className="hold-ico" data-pulse={err ? undefined : ""} aria-hidden="true">
        <svg className="icon" viewBox="0 0 16 16" width="28" height="28">
          <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2M8 9.6v1.4" />
        </svg>
      </span>
      <p className="hold-t">{title}</p>
      {err ? (
        <>
          <Problem text={err} />
          {retry && (
            <button type="button" className="primary" onClick={retry}>
              {t("Try again")}
            </button>
          )}
        </>
      ) : (
        <>
          <p className="hold-b">{body}</p>
          <div className="hold-skel" aria-hidden="true">
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
  const running = useRef<Promise<void>>();
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
  // a phone has no passphrase: the data opens as Health opens (Face ID / fingerprint will come first, in the shell)
  if (isMobile) return <AutoUnlock done={done} />;
  return (
    <main className="gate">
      <form
        className="form"
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
        <h2>{t("Health is locked")}</h2>
        <p className="lede">{t("Your data is encrypted with your passphrase. It locks again after a while without use.")}</p>
        <label>
          {t("Passphrase")}
          <input type="password" autoComplete="current-password" autoFocus value={p} onChange={(e) => setP(e.target.value)} required />
        </label>
        <Problem text={err} />
        <button type="submit" className="primary">
          {t("Unlock")}
        </button>
      </form>
    </main>
  );
}

function AutoUnlock({ done }: { done: () => void }) {
  const [err, retry] = useOnce(async () => {
    await unlock("");
    done();
  });
  return <Hold title={t("Decrypting your data")} body={decrypting()} err={err} retry={retry} />;
}

export function App() {
  // redraw everything when the language changes; the menu bar follows
  const { i18n } = useTranslation();
  useEffect(() => setShellLanguage(i18n.language), [i18n.language]);
  const [page, setPage] = useState<Page>(savedPage);
  // ⌘F asks Readings to focus its search; Readings clears the request once its search box exists
  const [find, setFind] = useState(false);
  useEffect(() => {
    try {
      if (PAGES.some((x) => x.key === page)) localStorage.setItem("page", page);
    } catch {}
  }, [page]);
  const [metric, setMetric] = useState<string>();
  useInbox();
  const [status, statusErr, reload] = useOp(() => op<Status>("status"), []);
  const syncLive = useSyncLive();
  const [latest, latestErr] = useOp(() => op<Point[]>("obs.latest"), []);
  const [cats, setCats] = useState(true);
  // narrow screens: the tab a section was opened from, where its back button returns
  const tab = useRef<Tab>("readings");
  useEffect(() => {
    if (TABS.some((x) => x.key === page)) tab.current = page as Tab;
  }, [page]);
  // the category scrolled into view on Readings (null: its top)
  const [inView, setInView] = useState<string | null>(null);
  const [core, setCore] = useState<{ up: boolean; error?: string; need_init?: boolean }>({ up: true });
  const [dropped, setDropped] = useState<string>();
  // a way in chosen on the getting-started card: the page opens with that sheet (or view); taken when it mounts
  const [want, setWant] = useState<string>();
  useEffect(() => setWant(undefined), [page]);
  const [hovering, setHovering] = useState(false);
  // a file dropped anywhere on the window opens Import with it
  useEffect(
    () =>
      onFileDrop({
        over: setHovering,
        drop: (paths) => {
          if (paths[0]) {
            setDropped(paths[0]);
            setMetric(undefined);
            setPage("data");
          }
        },
      }),
    [],
  );
  useEffect(() => onStatus((s) => (setCore(s), reload())), [reload]);
  useEffect(() => setBadge(status?.reviews ?? 0), [status?.reviews]);
  // the same commands from the macOS menu or, elsewhere, from the keyboard
  const command = useCallback((id: string) => {
    if (id !== "back") setMetric(undefined); // a section change or import replaces whatever sheet is open
    if (PAGES.some((x) => x.key === id)) setPage(id as Page);
    else if (id === "add") setPage("data");
    else if (id === "back") setMetric(undefined);
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
  const starting = !core.up || statusErr?.startsWith("unavailable:");
  // the start-up event can fire before the listener exists: ask again until the core answers
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(reload, 1000);
    return () => clearInterval(t);
  }, [starting, reload]);
  if (statusErr?.startsWith("locked:")) return <Unlock done={reload} />;
  if (core.need_init || statusErr?.includes("no_profile")) return <FirstRun done={reload} />;
  if (starting)
    return (
      <>
        <Hold title={t("Decrypting your data")} body={decrypting()} err={core.error} />
        {/* a database that no longer opens: starting over is one way out */}
        {core.error && isDesktop && (
          <div className="gate">
            <ClearDataRow />
          </div>
        )}
      </>
    );
  const open = (code: string) => setMetric(code);
  const present = HOME_GROUPS.filter((g) => latest?.some((p) => p.category === g.key));
  const syncAsking = !!syncLive?.peers.some((x) => x.state === "asking");
  const isTab = TABS.some((x) => x.key === page);
  const navItem = (p: { key: Page; label: string }, hint?: string, quiet = false) => (
    <li key={p.key}>
      <button
        type="button"
        className={page === p.key && !quiet ? "on" : ""}
        aria-current={page === p.key ? "page" : undefined}
        onClick={() => setPage(p.key)}
        title={hint}
      >
        <Icon k={p.key} />
        <span className="label">{t(p.label)}</span>
        {p.key === "review" && status && status.reviews > 0 && <span className="count">{status.reviews}</span>}
        {p.key === "account" && syncAsking && <span className="dot" role="img" aria-label={t("Waiting for you")} />}
      </button>
    </li>
  );
  const hint = (k: Page) => {
    const i = PAGES.findIndex((x) => x.key === k);
    return `${t(PAGES[i]!.label)} (${MOD}${i + 1})`;
  };
  return (
    <div className={`app${isDesktop ? " desktop" : ""}${isDesktop && MAC ? " mac" : ""}${page === "readings" ? " dash" : ""}`}>
      <div className="backdrop" aria-hidden="true" />
      {isDesktop && MAC && <div className="titlebar" data-tauri-drag-region />}
      {hovering && (
        <div className="drop-overlay" aria-hidden="true">
          <p>{t("Drop to import")}</p>
          <p className="fine">{t("Apple Health export, Health backup, WHOOP data")}</p>
        </div>
      )}
      <nav className="rail" aria-label={t("Sections")}>
        <ul>
          {navItem(PAGES[0]!, hint("readings"), page === "readings" && !!inView)}
          {status && status.reviews > 0 && navItem({ key: "review", label: tk("Waiting for you") })}
        </ul>
        {present.length > 0 && (
          <div className="rail-section">
            <button type="button" className="rail-head" aria-expanded={cats} onClick={() => setCats(!cats)}>
              {t("Categories")}
              <Chevron open={cats} />
            </button>
            {cats && (
              <ul>
                {present.map((g) => (
                  <li key={g.key}>
                    <button
                      type="button"
                      className={page === "readings" && inView === g.key ? "on" : ""}
                      aria-current={page === "readings" && inView === g.key ? "location" : undefined}
                      onClick={() => {
                        setPage("readings");
                        // marked at once: a short page can't scroll the section to the top
                        requestAnimationFrame(() => {
                          document.getElementById(`g-${g.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                          setInView(g.key);
                        });
                      }}
                    >
                      <GroupIcon k={g.key} />
                      <span className="label">{t(g.label)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="rail-section">
          <p className="rail-head">{t("Your data")}</p>
          <ul>
            {navItem(PAGES[1]!, hint("data"))}
            {navItem(PAGES[2]!, hint("backup"))}
          </ul>
        </div>
        <div className="rail-section">
          <p className="rail-head">{t("Me")}</p>
          <ul>
            {navItem(PAGES[3]!, hint("profile"))}
            {navItem(PAGES[4]!, hint("account"))}
          </ul>
        </div>
        {/* agent apps on this computer; a phone opens its own LAN interface to agents instead (later) */}
        {!isMobile && (
          <div className="rail-section">
            <p className="rail-head">{t("Sharing")}</p>
            <ul>{navItem(PAGES[5]!, hint("agents"))}</ul>
          </div>
        )}
        <div className="rail-section">
          <ul>{navItem(PAGES[6]!, hint("about"))}</ul>
        </div>
        <div className="rail-foot">
          <Totals status={status} />
          <LangSelect />
        </div>
      </nav>
      <main className="main">
        {/* narrow screens: a section opened from More (or Readings' notice) leads back there */}
        {!isTab && (
          <button type="button" className="back-btn" onClick={() => setPage(tab.current)}>
            <Chevron open={false} />
            {t(TABS.find((x) => x.key === tab.current)!.label)}
          </button>
        )}
        <div className="view" key={`${page}-${i18n.language}`}>
          {page === "readings" && (
            <Readings
              latest={latest}
              err={latestErr}
              open={open}
              go={setPage}
              reviews={status?.reviews ?? 0}
              find={find}
              found={() => setFind(false)}
              onSection={setInView}
              start={(p, w) => {
                setPage(p);
                setWant(w);
              }}
            />
          )}
          {page === "data" && <DataSources file={dropped} onFile={setDropped} go={setPage} done={open} want={want as SourceSheet | undefined} />}
          {page === "review" && <Review />}
          {page === "agents" && <Agents />}
          {page === "backup" && <Backup want={want} />}
          {page === "profile" && <ProfilePage />}
          {page === "account" && <HealthAccount go={setPage} want={want} />}
          {page === "about" && <About version={status?.version} want={want} />}
          {page === "more" && (
            <More
              go={(p, w) => {
                setPage(p);
                setWant(w);
              }}
              status={status}
              syncAsking={syncAsking}
            />
          )}
        </div>
      </main>
      <nav className="tabbar" aria-label={t("Sections")}>
        {TABS.map((x) => (
          // a section opened from a tab keeps that tab marked
          <button key={x.key} type="button" aria-current={page === x.key ? "page" : !isTab && tab.current === x.key ? "true" : undefined} onClick={() => setPage(x.key)}>
            <Icon k={x.icon} />
            <span>{t(x.label)}</span>
            {x.key === "more" && ((status?.reviews ?? 0) > 0 || syncAsking) && <span className="dot" role="img" aria-label={t("Waiting for you")} />}
          </button>
        ))}
      </nav>
      {metric && <Sheet label={t("History")} close={() => setMetric(undefined)}>
        <Record code={metric} pick={setMetric} />
      </Sheet>}
    </div>
  );
}

/** How much is here: the side panel's foot, More's on narrow screens. */
function Totals({ status }: { status?: Status }) {
  const { i18n } = useTranslation();
  if (!status) return null;
  return (
    <p className="fine">
      {t("{{obs}} entries from {{count}} sources", {
        obs: status.observations.toLocaleString(i18n.language),
        count: status.sources,
      })}
    </p>
  );
}

/** The language choice; `bare`: the select alone, in a row that names it. */
function LangSelect({ bare }: { bare?: boolean }) {
  const select = (
    <select aria-label={bare ? t("Language") : undefined} value={choice()} onChange={(e) => choose(e.target.value as Parameters<typeof choose>[0])}>
      {LANGS.map((l) => (
        <option key={l.key} value={l.key}>
          {l.key === "system" ? t("System") : l.label}
        </option>
      ))}
    </select>
  );
  if (bare) return select;
  return (
    <label className="fine lang">
      {t("Language")}
      {select}
    </label>
  );
}

/** More (narrow screens), as the web's 更多: one card per part (profile, data sources, backup and export, other
 *  devices, about), each row opening its section at the right place. */
function More({ go, status, syncAsking }: { go: (p: Page, want?: string) => void; status?: Status; syncAsking: boolean }) {
  const reviews = status?.reviews ?? 0;
  const row = (icon: ReactNode, label: string, p: Page, want?: string, value?: ReactNode) => (
    <Row key={label} icon={icon} label={label} value={value} onClick={() => go(p, want)} />
  );
  const card = (title: string, rows: ReactNode) => (
    <>
      <h3 className="rows-title">{title}</h3>
      <ul className="rows-card">{rows}</ul>
    </>
  );
  return (
    <section className="page more">
      <h2>{t("More")}</h2>
      {reviews > 0 && <ul className="rows-card">{row(<Icon k="review" />, t("Waiting for you"), "review", undefined, <span className="count">{reviews}</span>)}</ul>}
      <ul className="rows-card">{row(<Icon k="profile" />, t("Profile"), "profile")}</ul>
      {card(
        t("Data sources"),
        <>
          {row(<Icon k="data" />, t("Manage data"), "data", "manage")}
          {row(<GroupIcon k="cardio" />, "WHOOP", "data", "whoop")}
          {row(<GroupIcon k="activity" />, t("Apple Health"), "data", "apple")}
          {row(<GroupIcon k="lab" />, t("Lab report"), "data", "report")}
          {row(<GroupIcon k="infectious" />, t("Lab self-service"), "data", "lab")}
        </>,
      )}
      {card(
        t("Backup and export"),
        <>
          {row(<Icon k="backup" />, t("Save a backup"), "backup", "save")}
          {row(<Icon k="data" />, t("Restore a backup"), "backup", "restore")}
          {row(<GroupIcon k="other" />, t("Export a table (CSV)"), "backup", "csv")}
        </>,
      )}
      {card(
        t("Other devices"),
        <>
          {row(<Icon k="account" />, t("Health account"), "account", undefined, syncAsking ? <span className="dot" role="img" aria-label={t("Waiting for you")} /> : undefined)}
          {row(<Icon k="wifi" />, t("Local network sync"), "account", "sync")}
          {row(<Icon k="link" />, t("Connect another device"), "account", "connect")}
        </>,
      )}
      {/* agent apps on this computer (a narrow desktop window) */}
      {!isMobile && card(t("Sharing"), row(<Icon k="agents" />, t("Agent access"), "agents"))}
      {card(
        t("About"),
        <>
          {row(<Icon k="shield" />, t("Privacy"), "about", "privacy")}
          {row(<Icon k="scale" />, t("Open-source licenses"), "about", "licenses")}
          <li>
            <div className="row-static">
              <Icon k="about" />
              <span className="row-l">
                <strong>{t("Version")}</strong>
              </span>
              <span className="row-v fine">{status?.version ?? "–"}</span>
            </div>
          </li>
          <li>
            <div className="row-static">
              <Icon k="list" />
              <span className="row-l">
                <strong>{t("Language")}</strong>
              </span>
              <LangSelect bare />
            </div>
          </li>
        </>,
      )}
      <div className="more-foot">
        <Totals status={status} />
      </div>
    </section>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg className={`chevron${open ? " open" : ""}`} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M6 4l4 4-4 4" />
  </svg>
);

const WEB_VERSION = "https://zuchiangmai.com/health";
const WHOOP_DASHBOARD = "https://developer-dashboard.whoop.com/";

/** A link to a web page, opened in the default browser (never inside the app window). */
function WebLink({ url, label }: { url: string; label?: string }) {
  return (
    <a
      className="link"
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

/** A layer over the window (native <dialog>: focus stays inside, Esc closes). */
function Sheet({ label, close, children }: { label: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);
  // a layout effect: its cleanup runs before React removes the <dialog>, so close() can hand focus back to
  // whatever had it when the sheet opened (removing an open modal leaves focus on <body>)
  // read during the first render, before an autoFocus field inside takes focus
  const [back] = useState(() => document.activeElement as HTMLElement | null);
  useLayoutEffect(() => {
    const d = ref.current;
    if (d && !d.open) {
      // showModal() focuses the close button, which WebKit rings as if tabbed to; focus the sheet itself,
      // unless a field inside already took focus (autoFocus runs before this effect)
      const now = document.activeElement as HTMLElement | null;
      const field = now && d.contains(now) ? now : null;
      d.showModal();
      (field ?? d).focus();
    }
    return () => {
      d?.close();
      back?.focus?.();
    };
  }, [back]);
  return (
    <dialog
      ref={ref}
      className="sheet"
      tabIndex={-1}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      // close on a click on the backdrop itself, not on a text selection dragged out of the sheet
      onMouseDown={(e) => {
        pressedOutside.current = e.target === ref.current;
      }}
      onClick={(e) => e.target === ref.current && pressedOutside.current && close()}
    >
      <div className="sheet-body">
        <button type="button" className="close" aria-label={t("Close")} onClick={close}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
        {children}
      </div>
    </dialog>
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
    <p className="problem" role="alert">
      {human(text)}
    </p>
  ) : null;
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
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
    </button>
  );
}

function PasswordField({ label, value, onChange, auto }: { label: string; value: string; onChange: (v: string) => void; auto: string }) {
  const [show, setShow] = useState(false);
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <span className="with-toggle">
        <input id={id} type={show ? "text" : "password"} autoComplete={auto} value={value} onChange={(e) => onChange(e.target.value)} required />
        <button type="button" className="link" aria-label={show ? t("Hide {{field}}", { field: label }) : t("Show {{field}}", { field: label })} aria-pressed={show} onClick={() => setShow(!show)}>
          {show ? t("Hide") : t("Show")}
        </button>
      </span>
    </div>
  );
}

/** Where a file comes from: native dialog and drag and drop on desktop; the system's picker (or the camera, for a
 *  lab report) on a phone; a typed path in the browser preview. */
function FilePick({ path, onPath, photo }: { path?: string; onPath: (p: string) => void; photo?: boolean }) {
  if (isMobile) return <MobilePick path={path} onPath={onPath} photo={photo} />;
  if (!isDesktop)
    return (
      <label className="block">
        {t("File path")}
        <input value={path ?? ""} onChange={(e) => onPath(e.target.value)} placeholder="/Users/you/Downloads/export.zip" />
      </label>
    );
  return (
    <div className="dropzone">
      {path ? (
        <p>
          <strong>{fileName(path)}</strong>
          <br />
          <span className="fine">{path}</span>
        </p>
      ) : (
        <p>{t("Drag a file here.")}</p>
      )}
      <button
        type="button"
        className={path ? "" : "primary"}
        onClick={async () => {
          const p = await chooseImportFile();
          if (p) onPath(p);
        }}
      >
        {path ? t("Choose another file…") : t("Choose file…")}
      </button>
    </div>
  );
}

/** The phone's picker: the file's bytes go to the app's own folder, and the import takes that path. */
function MobilePick({ path, onPath, photo }: { path?: string; onPath: (p: string) => void; photo?: boolean }) {
  const [name, setName] = useState<string>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const take = async (files: FileList | null) => {
    const f = files?.[0];
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
  return (
    <div className="dropzone" aria-busy={busy}>
      {path && <p><strong>{name ?? fileName(path)}</strong></p>}
      <div className="actions">
        {photo && (
          <label className="button primary">
            {t("Take a photo")}
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => void take(e.target.files)} />
          </label>
        )}
        <label className={`button${photo || path ? "" : " primary"}`}>
          {path ? t("Choose another file…") : t("Choose file…")}
          <input type="file" hidden onChange={(e) => void take(e.target.files)} />
        </label>
      </div>
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

/** A row of an inset grouped list: icon, name with a line under it, a live status, a chevron. */
/** A grouped row with a switch on the right (System Settings); the whole row toggles it. */
/** A card's title, with one button that turns every switch in it on (or, when all are on, off). */
function CardHead({ title, on, set }: { title: string; on: boolean; set: (on: boolean) => void }) {
  return (
    <div className="rows-head card-head">
      <h4>{title}</h4>
      <button type="button" className="link" onClick={() => set(!on)}>
        {on ? t("Select none") : t("Select all")}
      </button>
    </div>
  );
}

function SwitchRow({ icon, label, sub, on, set }: { icon?: ReactNode; label: string; sub?: string; on: boolean; set: (on: boolean) => void }) {
  return (
    <li>
      <label className="row-static row-toggle">
        {icon}
        <span className="row-l">
          <strong>{label}</strong>
          {sub && <span className="fine">{sub}</span>}
        </span>
        <input type="checkbox" role="switch" className="switch" checked={on} onChange={(e) => set(e.target.checked)} />
      </label>
    </li>
  );
}

function Row({ icon, label, sub, value, onClick }: { icon: ReactNode; label: string; sub?: string; value?: ReactNode; onClick: () => void }) {
  return (
    <li>
      <button type="button" className="row-btn" onClick={onClick}>
        {icon}
        <span className="row-l">
          <strong>{label}</strong>
          {sub && <span className="fine">{sub}</span>}
        </span>
        {value !== undefined && <span className="row-v fine">{value}</span>}
        <span className="row-chev" aria-hidden="true">
          ›
        </span>
      </button>
    </li>
  );
}

type SourceSheet = "manage" | "whoop" | "apple" | "report" | "lab" | "restore" | "manual" | "file";
/** Data sources (as the web's 更多 › 数据来源): managing what is here first, then one row per way data comes
 *  in, each with its live status; the steps open in a sheet. A file dropped on the window opens here. */
function DataSources({
  file,
  onFile,
  go,
  done,
  want,
}: {
  file?: string;
  onFile: (p?: string) => void;
  go: (p: Page) => void;
  done: (code: string) => void;
  /** The sheet to open with (a way in chosen on the getting-started card) */
  want?: SourceSheet;
}) {
  const [sheet, setSheet] = useState<SourceSheet | undefined>(want);
  const [batches] = useOp(() => op<Batch[]>("import.list"), []);
  const [whoop] = useOp(() => op<WhoopStatus>("whoop.status"), []);
  useEffect(() => {
    if (file) setSheet((s) => s ?? "file");
  }, [file]);
  const close = () => {
    setSheet(undefined);
    onFile(undefined);
  };
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
  return (
    <section className="page">
      <h2>{t("Data sources")}</h2>
      <p className="lede">{(isMobile ? t("Your data on this device.") : t("Your data on this computer. Drop a file anywhere on the window to import it."))}</p>
      <ul className="rows-card">
        <Row
          icon={<Icon k="data" />}
          label={t("Manage data")}
          sub={t("See and delete imports")}
          value={batches ? t("{{count}} imports", { count: batches.length }) : undefined}
          onClick={() => setSheet("manage")}
        />
      </ul>
      <ul className="rows-card">
        <Row icon={<GroupIcon k="cardio" />} label="WHOOP" sub={t("Syncs every hour while Health is open")} value={whoopValue} onClick={() => setSheet("whoop")} />
        <Row icon={<GroupIcon k="activity" />} label={t("Apple Health")} sub={t("Export from your iPhone")} value={lastOf("apple_health")} onClick={() => setSheet("apple")} />
        <Row icon={<GroupIcon k="lab" />} label={t("Lab report")} sub={t("A photo or a PDF")} value={lastOf("ocr")} onClick={() => setSheet("report")} />
        <Row icon={<GroupIcon k="infectious" />} label={t("Lab self-service")} sub={t("A code for a lab device")} onClick={() => setSheet("lab")} />
        <Row icon={<Icon k="backup" />} label={t("Restore a backup")} sub={t("A .zuhealth file")} onClick={() => setSheet("restore")} />
        <Row icon={<GroupIcon k="body" />} label={t("Enter by hand")} sub={t("Write down a reading")} value={lastOf("manual")} onClick={() => setSheet("manual")} />
      </ul>
      {sheet && (
        <Sheet label={titles[sheet]} close={close}>
          {sheet === "manage" && (
            <Sources
              go={(p) => {
                close();
                go(p);
              }}
            />
          )}
          {sheet === "whoop" && <WhoopConnect />}
          {(sheet === "apple" || sheet === "report" || sheet === "restore" || sheet === "file") && (
            <Import file={file} onFile={onFile} go={go} kind={sheet} title={titles[sheet]} />
          )}
          {sheet === "lab" && <LabSelfService errText={errText} showResults={() => go("readings")} showIdentity={() => go("account")} pollFast={pollFast} />}
          {sheet === "manual" && (
            <Enter
              done={(code) => {
                close();
                done(code);
              }}
            />
          )}
        </Sheet>
      )}
    </section>
  );
}

/** A self-service code for a lab device (protocol 3.3): the device id is beside its QR. */
/** Installs the OCR models (desktop: downloaded and checked by the core; elsewhere: the command to run). */
function OcrInstall({ done }: { done: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  if (!isDesktop && !isMobile)
    return (
      <div className="group notice">
        <p>{t("Install it once from a terminal:")}</p>
        <pre>health component install ocr</pre>
      </div>
    );
  return (
    <div className="group notice" aria-busy={busy}>
      <h3>{isMobile ? t("Read lab reports on this device") : t("Read lab reports on this computer")}</h3>
      <p className="fine">
        {(isMobile ? t("Health downloads the text-recognition models once (about 156 MB) to read images on this device.") : t("Health downloads the text-recognition models once (about 156 MB) to read images on this computer."))}
      </p>
      <Problem text={err} />
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(undefined);
            try {
              await installOcr(true);
              done();
            } catch (e) {
              setErr(errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t("Downloading…") : t("Install")}
        </button>
      </div>
    </div>
  );
}

const IMPORT_LEDE: Record<string, string> = {
  apple: tk("On your iPhone, open Health, tap your picture, then Export All Health Data; choose the .zip here."),
  report: tk("A photo (JPEG, PNG) or a PDF."),
  restore: tk("A Health backup (.zuhealth) from this app or the web version."),
  file: tk("A photo or PDF of a lab report, an Apple Health export, a Health backup (.zuhealth) or WHOOP data. Importing the same file again updates it; nothing is doubled."),
};

function Import({ file, onFile, go, kind: hint = "file", title }: { file?: string; onFile: (p?: string) => void; go: (p: Page) => void; kind?: string; title?: string }) {
  const [password, setPassword] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<ReactNode>();
  const [needsOcr, setNeedsOcr] = useState(false);
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
      if (kind === "report") {
        // recognised in a separate process by the core, then kept as a batch you check before anything counts
        const r = await op<{ import_id: number; items: number; matched: number }>("import.ocr", { path: file, tz_min: -new Date().getTimezoneOffset() });
        setDone(
          <>
            <p>{t("Read {{count}} results. Please check them.", { count: r.items })}</p>
            <div className="actions">
              <button type="button" className="primary" onClick={() => go("review")}>
                {t("Check them now")}
              </button>
            </div>
          </>,
        );
        return;
      }
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
              <p key={n} className="fine">
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
            {broken > 0 && <p className="fine">{t("{{n}} records had a bad date or value and were left out.", { n: broken.toLocaleString() })}</p>}
          </>,
        );
      }
      setPassword("");
    } catch (e) {
      if (e instanceof OpError && (e.code === "no_ocr_component" || e.code === "ocr_component")) setNeedsOcr(true);
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="record">
      <h2>{title ?? t("Import a file")}</h2>
      <p className="lede">{t(IMPORT_LEDE[hint] ?? IMPORT_LEDE.file!)}</p>
      {hint === "restore" && (
        <p className="fine">
          {t("Web version")} <WebLink url={WEB_VERSION} />
        </p>
      )}
      <FilePick path={file} onPath={onFile} photo={hint === "report"} />
      {file && !kind && (
        <Problem text={t("Health can't read this kind of file. Choose a lab report photo or PDF, a .zip from Apple Health, a .zuhealth backup, or a WHOOP .json file.")} />
      )}
      {needsOcr && <OcrInstall done={() => (setNeedsOcr(false), setErr(undefined))} />}
      {file && kind && (
        <form
          className="form"
          aria-busy={busy}
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <p className="fine">{t(KIND_LABEL[kind])}</p>
          {kind === "backup" && <PasswordField label={t("Backup password")} value={password} onChange={setPassword} auto="current-password" />}
          {kind === "rows" && (
            <label>
              {t("Where these readings come from")}
              <input value={source} onChange={(e) => setSource(e.target.value)} required />
            </label>
          )}
          <Problem text={err} />
          <button type="submit" className="primary" disabled={busy}>
            {busy ? (kind === "backup" ? t("Restoring…") : t("Importing…")) : kind === "backup" ? t("Restore backup") : t("Import")}
          </button>
          {busy && (
            <p className="fine">
              {kind === "report"
                ? t("Reading the report: a few seconds a page.")
                : t("Large exports can take a few minutes. Health answers again when the import is done; keep this page open to see the result.")}
            </p>
          )}
        </form>
      )}
      {done && (
        <div className="group notice" role="status">
          {done}
          <div className="actions">
            <button type="button" className="primary" onClick={() => go("readings")}>
              {t("See my readings")}
            </button>
            <button type="button" onClick={() => onFile(undefined)}>
              {t("Import another file")}
            </button>
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
    <span className="flag" title={f === "H" ? t("Above the reference range") : t("Below the reference range")}>
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
const GroupIcon = ({ k }: { k: string }) => (
  <svg className={`icon tint-${k}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    {GROUP_ICON[k] ?? <rect x="3" y="3" width="10" height="10" rx="2.5" />}
  </svg>
);

/** One measure as a tile: its name, the value large, and the month's trend or when it was taken. */
function Tile({ p, open, lab }: { p: Point; open: (code: string) => void; lab: boolean }) {
  return p.agg === "cumulative" ? <SummedTile p={p} open={open} /> : <TileBody p={p} open={open} s={shown(p)} days={undefined} lab={lab} />;
}

function SummedTile({ p, open }: { p: Point; open: (code: string) => void }) {
  const days = useMonth(p);
  return <TileBody p={p} open={open} s={display(p, days)} days={days} lab={false} />;
}

function TrendTile({ p, open, s }: { p: Point; open: (code: string) => void; s: { value: string; unit: string; note?: string } }) {
  const days = useMonth(p);
  return <TileBody p={p} open={open} s={s} days={days} lab={false} />;
}

function TileBody({
  p,
  open,
  s,
  days,
  lab,
}: { p: Point; open: (code: string) => void; s: { value: string; unit: string; note?: string }; days?: Day[]; lab: boolean }) {
  const old = isStale(p);
  // no trend to draw (lab values, old or sparse ones): the date of the value fills the space instead
  const trend = !old && !!days && toPts(p.agg, days).length >= 2;
  const note = s.note ?? (lab || old || !trend ? ago(p.start_ms) : undefined);
  return (
    <button type="button" className={`tile${old ? " stale" : ""}`} onClick={() => open(p.metric)}>
      <span className="tile-name">{nameOf(p.metric, p.name)}</span>
      <span className="tile-value">
        {s.value}
        {s.unit && <span className="unit"> {s.unit}</span>}
        <Flag p={p} />
      </span>
      <span className="tile-foot">
        {note && <span className="fine">{note}</span>}
        {!old && days && <Trend p={p} days={days} latest={s.unit ? `${s.value} ${s.unit}` : s.value} />}
      </span>
    </button>
  );
}

/** Key, everyday measures show their month's trend; lab and old values show their date instead. */
function AnyTile({ p, open, lab }: { p: Point; open: (code: string) => void; lab: boolean }) {
  if (!lab && !isStale(p) && p.agg !== "cumulative" && typeof p.value === "number") return <TrendTile p={p} open={open} s={shown(p)} />;
  return <Tile p={p} open={open} lab={lab} />;
}

/** How many tiles fit in one row of `.tiles` (176px minimum, 10px gaps; see styles.css). */
function useColumns(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(4);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // the columns the grid laid out (its minimum tile width is in the CSS, narrower on phones)
    const ro = new ResizeObserver(() => setCols(Math.max(1, getComputedStyle(el).gridTemplateColumns.split(" ").length)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, cols];
}

function Section({
  g,
  rows,
  sources,
  open,
  all,
  report,
}: { g: (typeof GROUPS)[number]; rows: Point[]; sources: Source[]; open: (code: string) => void; all: boolean; report?: ReactNode }) {
  const [more, setMore] = useState(false);
  const [grid, cols] = useColumns();
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
  // collapsed: one full row (two for a category this big, so key measures and a few more show)
  const fold = cols * (rows.length > cols * 3 ? 2 : 1);
  const shownRows = all || more ? ranked : ranked.slice(0, fold);
  // where these numbers come from, newest first
  const bySource = new Map<number, number>();
  for (const p of rows) bySource.set(p.source_id, Math.max(bySource.get(p.source_id) ?? 0, p.start_ms));
  const from = [...bySource.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => sourceLabel(sources.find((x) => x.id === id)));
  return (
    <section className="section" id={`g-${g.key}`} aria-labelledby={`h-${g.key}`}>
      <header>
        <h3 id={`h-${g.key}`}>
          <GroupIcon k={g.key} />
          {t(g.label)}
        </h3>
        {!all && rows.length > fold && (
          <button type="button" className="link" aria-expanded={more} onClick={() => setMore(!more)}>
            {more ? t("Show fewer") : t("Show all {{n}}", { n: rows.length })}
          </button>
        )}
      </header>
      <div className="tiles" ref={grid}>
        {shownRows.map((p) => (
          <AnyTile key={p.metric} p={p} open={open} lab={lab} />
        ))}
      </div>
      {report}
      {from.length > 0 && (
        <p className="fine from">
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
    <section className="page wide">
      <div className="page-head">
        <div>
          <h2>{t("Readings")}</h2>
          <p className="fine">{(isMobile ? t("Your data is stored encrypted on this device") : t("Your data is stored encrypted on this computer"))}</p>
        </div>
      </div>
      <div className="start">
        <div className="start-h">
          <h3 id="h-start">{t("Start recording your health")}</h3>
          <p className="fine">{t("Choose a way to add your first data")}</p>
        </div>
        <ul className="rows-card" aria-labelledby="h-start">
          <Row icon={<GroupIcon k="lab" />} label={t("Lab report")} sub={t("A photo or a PDF")} onClick={() => start("data", "report")} />
          <Row icon={<GroupIcon k="activity" />} label={t("Apple Health")} sub={t("Export from your iPhone")} onClick={() => start("data", "apple")} />
          <Row icon={<Icon k="backup" />} label={t("Restore a backup")} sub={t("A .zuhealth file")} onClick={() => start("data", "restore")} />
          <Row icon={<GroupIcon k="body" />} label={t("Enter by hand")} sub={t("Write down a reading")} onClick={() => start("data", "manual")} />
          <Row icon={<Icon k="link" />} label={t("Connect another device")} onClick={() => start("account", "connect")} />
        </ul>
      </div>
      {/* dropping a file on the window is the desktop's */}
      {isDesktop && <p className="fine start-foot">{t("You can also drop a file anywhere on this window.")}</p>}
    </section>
  );
}

function Readings({
  latest,
  err,
  open,
  go,
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
  const [fdOpen, setFdOpen] = useState(false);
  const [scans] = useOp(() => op<Measurement[]>("labs.body_scans"), []);
  const [secaOpen, setSecaOpen] = useState(false);
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
    for (const el of document.querySelectorAll("section.section[id^='g-']")) io.observe(el);
    const top = () => window.scrollY < 40 && onSection(null);
    window.addEventListener("scroll", top, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", top);
      onSection(null);
    };
  }, [latest, onSection]);
  if (err) return <Problem text={err} />;
  if (!latest) return <p className="empty" aria-busy="true">{t("Loading your readings…")}</p>;
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
  return (
    <section className="page wide">
      <div className="page-head">
        <div>
          <h2>{t("Readings")}</h2>
          <p className="fine">{t("Updated {{when}}", { when: when(newest) })}</p>
        </div>
        <div className="search-field">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            ref={search}
            type="search"
            placeholder={isMobile ? t("Find a measure") : `${t("Find a measure")} (${MOD}F)`}
            aria-label={t("Find a measure")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQ("")}
          />
        </div>
      </div>
      {reviews > 0 && (
        <p className="notice">
          {t("{{count}} imports are waiting for you to check.", { count: reviews })}{" "}
          <button type="button" className="link" onClick={() => go("review")}>
            {t("Review now")}
          </button>
        </p>
      )}
      {!groups.length && <p className="empty">{t("No measure matches “{{q}}”.", { q })}</p>}
      {groups.map(({ g, rows }) => (
        <Section
          key={g.key}
          g={g}
          rows={rows}
          sources={sources ?? []}
          open={open}
          all={!!needle}
          report={
            g.key === "force" && fdLatest ? (
              <FdReportRow session={fdLatest} open={() => setFdOpen(true)} />
            ) : g.key === "body" && scans?.[0] ? (
              <SecaReportRow scan={scans[0]} open={() => setSecaOpen(true)} />
            ) : undefined
          }
        />
      ))}
      {secaOpen && scans && (
        <Sheet label={t("Body composition")} close={() => setSecaOpen(false)}>
          <SecaReport scans={scans} />
        </Sheet>
      )}
      {fdOpen && fd && (
        <Sheet label={t("VALD ForceDecks tests")} close={() => setFdOpen(false)}>
          <FdReport sessions={fd} />
        </Sheet>
      )}
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
    <div className="picker">
      <input aria-label={placeholder} placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      {hits && !hits.length && <p className="fine">{t("No measures found.")}</p>}
      {hits && hits.length > 0 && (
        <ul className="hits">
          {hits.map((m) => (
            <li key={m.code}>
              <button
                type="button"
                onClick={() => {
                  onPick(m);
                  setQ("");
                }}
              >
                {nameOf(m.code, m.name)}{" "}
                <span className="fine">
                  {m.code}
                  {m.unit ? ` · ${unitLabel(m.unit)}` : ""}
                </span>
              </button>
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
      <section className="page">
        <h2>{t("History")}</h2>
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
    <section className="record">
      <h2>{info ? nameOf(info.code, info.name) : code}</h2>
      <p className="fine" title={code}>
        {info && nameOf(info.code, info.name) !== info.name ? info.name : code}
      </p>
      <div className="segmented" role="group" aria-label={t("Range")}>
        {RANGES.map((r) => (
          <button key={r.label} type="button" aria-pressed={span === r.days} onClick={() => setRange(r.days)}>
            {t(r.label)}
          </button>
        ))}
      </div>
      {vals.length > 0 && (
        <dl className="stats">
          <div>
            <dt>{t("Average")}</dt>
            <dd>
              {fmt(vals.reduce((a, b) => a + b, 0) / vals.length)} <span className="unit">{shownUnit}</span>
            </dd>
          </div>
          <div>
            <dt>{t("Lowest")}</dt>
            <dd>
              {fmt(Math.min(...lows))} <span className="unit">{shownUnit}</span>
            </dd>
          </div>
          <div>
            <dt>{t("Highest")}</dt>
            <dd>
              {fmt(Math.max(...highs))} <span className="unit">{shownUnit}</span>
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
      <h3>{t("Latest entries")}</h3>
      <table className="rows">
        <tbody>
          {(allEntries ? recent : recent.slice(0, 10)).map((p) => {
            const s = shown(p);
            return (
              <tr key={`${p.start_ms}-${p.source_id}`}>
                <td>{p.detail?.precision === "day" ? dateIn(p.start_ms, p.tz_min) : when(p.start_ms, p.tz_min)}</td>
                <td className="fine">{sourceName(p.source_id)}</td>
                <td className="n value">
                  {s.value} <span className="unit">{s.unit}</span>
                  <Flag p={p} />
                  {p.corrected && <span className="fine"> {t("corrected")}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!allEntries && recent.length > 10 && (
        <button type="button" className="link" onClick={() => setAllEntries(true)}>
          {t("Show all entries")}
        </button>
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

function Enter({ done }: { done: (code: string) => void }) {
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
    <section className="record">
      <h2>{t("Enter by hand")}</h2>
      {!m ? (
        <>
          <MetricPicker placeholder={t("What did you measure?")} onPick={pick} manual />
          <div className="chips" role="group" aria-label={t("Common measures")}>
            {QUICK.map(([code, label]) => (
              <button key={code} type="button" className="chip-button" onClick={() => pick({ code, name: label, unit: "", agg: "instant" })}>
                {t(label)}
              </button>
            ))}
          </div>
        </>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <p>
            <strong>{nameOf(m.code, m.name)}</strong>{" "}
            <button type="button" className="link" onClick={() => setM(undefined)}>
              {t("Change")}
            </button>
          </p>
          <label>
            {t("Value")}
            <input inputMode={m.agg === "none" ? "text" : "decimal"} value={value} onChange={(e) => setValue(e.target.value)} required />
          </label>
          {m.agg !== "none" && value.includes(",") && Number.isFinite(parseNumber(value)) && (
            <p className="fine" role="status">
              {t("Read as {{n}}", { n: parseNumber(value).toLocaleString(undefined, { maximumFractionDigits: 6 }) })}
            </p>
          )}
          {m.units.length > 1 && (
            <label>
              {t("Unit")}
              <select value={unit} onChange={(e) => setUnit(e.target.value)} required>
                <option value="">{t("Choose the unit on your device")}</option>
                {m.units.map((u) => (
                  <option key={u} value={u}>
                    {unitLabel(u) || u}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {t("When")}
            <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required />
          </label>
          <Problem text={err} />
          <button type="submit" className="primary" disabled={busy}>
            {t("Save reading")}
          </button>
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
      <div className="actions">
        <button type="button" className="danger" disabled={busy} onClick={() => setStep(1)}>
          {label}
        </button>
      </div>
    );
  return (
    <div className="confirm" role="group" aria-label={step === 1 ? title : t("Delete for good?")}>
      <p>
        <strong>{step === 1 ? title : t("Delete for good?")}</strong>
      </p>
      <p className="fine">{step === 1 ? detail : t("This can't be undone. Backups you saved earlier still have this data.")}</p>
      <div className="actions">
        <button type="button" autoFocus disabled={busy} onClick={() => setStep(0)}>
          {t("Cancel")}
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => (step === 1 ? setStep(2) : run())}>
          {step === 1 ? t("Delete") : t("Delete for good")}
        </button>
      </div>
    </div>
  );
}

/** Manage data (the web's 管理数据): each kind of source with how many times data came from it; a kind lists
 *  those imports, newest first; an import shows what it holds now and can be deleted; a kind can be deleted
 *  whole. WHOOP only whole, and is disconnected with it. */
function Sources({ go }: { go: (p: Page) => void }) {
  const [sources, , reloadSources] = useOp(() => op<Source[]>("source.list"), []);
  const [batches, err, reload] = useOp(() => op<Batch[]>("import.list"), []);
  const [kind, setKind] = useState<string>();
  const [open, setOpen] = useState<Batch>();
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
    <p className="notice" role="status">
      {msg}
    </p>
  );

  if (kind && open)
    return (
      <ImportView
        b={open}
        kind={kind}
        device={sources?.find((s) => s.id === open.source_id)?.name}
        back={() => setOpen(undefined)}
        go={go}
        erased={() => {
          setOpen(undefined);
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
      <div className="manage">
        <button type="button" className="link back" onClick={() => setKind(undefined)}>
          ‹ {t("Manage data")}
        </button>
        <h3 className="manage-title">{name}</h3>
        {status}
        {list.length ? (
          <ul className="rows-card" aria-label={name}>
            {list.map((b) => (
              <Row
                key={b.import_id}
                icon={null}
                label={b.at ? when(b.at) : "–"}
                value={
                  b.status === "review" ? (
                    <span className="signal">{t("waiting for you")}</span>
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
          </ul>
        ) : (
          <p className="empty">{t("No imports yet.")}</p>
        )}
        {whole && <p className="rows-foot">{t("WHOOP fetches the last few days again at every sync, so its data can only be deleted all at once.")}</p>}
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
                setKind(undefined);
              }, t("Deleted."))
            }
          />
        )}
      </div>
    );
  }
  return (
    <div className="manage">
      <h2>{t("Manage data")}</h2>
      {status}
      <Problem text={err} />
      {batches && !batches.length && <p className="empty">{t("No imports yet.")}</p>}
      {ordered.length > 0 && (
        <>
          <ul className="rows-card" aria-label={t("Manage data")}>
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
          </ul>
          <p className="rows-foot">{t("Open a source to see what each import brought, or to delete it.")}</p>
        </>
      )}
      <details className="group">
        <summary>
          <h3>{t("Source priority")}</h3>
        </summary>
        <p className="fine">{t("Daily summaries follow the order of this list.")}</p>
        <ol className="order">
          {(sources ?? []).map((s, i) => (
            <li key={s.id}>
              <span>
                {s.connector === "manual" ? t("Entered by you") : s.name} <span className="fine">{sourceKind(s.connector)}</span>
              </span>
              <button type="button" className="link" disabled={i === 0 || ordering} aria-label={t("Prefer {{name}}", { name: s.name })} onClick={() => moveUp(i)}>
                {t("Move up")}
              </button>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

/** One import: what it holds now (a row belongs to the newest import that delivered it), newest first. */
function ImportView({ b, kind, device, back, go, erased }: { b: Batch; kind: string; device?: string; back: () => void; go: (p: Page) => void; erased: () => void }) {
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
    <div className="manage">
      <button type="button" className="link back" disabled={busy} onClick={back}>
        ‹ {name}
      </button>
      <h3 className="manage-title">{b.at ? when(b.at) : name}</h3>
      {NAMED.has(kind) && device && <p className="fine">{device}</p>}
      <Problem text={err ?? problem} />
      {b.status === "review" ? (
        <p>
          {t("Waiting for you to check. Nothing from it is in your data yet.")}{" "}
          <button type="button" className="link" onClick={() => go("review")}>
            {t("Check it")}
          </button>
        </p>
      ) : (
        d && (
          <>
            <p className="fine">{t("{{count}} entries", { count: d.rows })}</p>
            {d.items.length > 0 && (
              <ul className="rows-card batch-items">
                {d.items.map((p) => {
                  const v = shown(p);
                  return (
                    <li key={`${p.metric}|${p.start_ms}`} className="row-static">
                      <span className="row-l">
                        <strong>{nameOf(p.metric, p.name)}</strong>
                        <span className="fine">{when(p.start_ms, p.tz_min)}</span>
                      </span>
                      <span className="row-v">
                        {v.value} {v.unit}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {d.rows > d.items.length && <p className="rows-foot">{t("Showing the newest {{count}}.", { count: d.items.length })}</p>}
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
  /** "<code> <printed unit>" → the measure's unit the printed one maps to ("" when none fits), from the core */
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
  return (
    <div className="group ocr">
      <div className="ocr-head">
        <h3>{t("Lab report")}</h3>
        <label className="inline">
          {t("Test date")}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
      </div>
      {c.dated === false && <p className="notice">{t("The date wasn't found on the report. Set the day the sample was taken.")}</p>}
      <table className="rows ocr-items">
        <thead>
          <tr>
            <th>{t("On the report")}</th>
            <th>{t("Result")}</th>
            <th>{t("Measure")}</th>
            <th>{t("Unit")}</th>
          </tr>
        </thead>
        <tbody>
          {c.items.map((it, i) => {
            const p = picks[i] ?? {};
            const m = p.code ? info[p.code] : undefined;
            const numeric = m && m.agg !== "none" && m.agg !== "interval";
            const value = p.skip ? "skip" : p.new ? "new" : (p.code ?? "");
            const offered = [...new Set([...(it.code ? [it.code] : []), ...(it.suggest ?? []).map((s) => s.code), ...(p.code ? [p.code] : [])])];
            return (
              <tr key={`${i}-${it.name}`} className={p.skip ? "stale" : ""}>
                <td>
                  {it.name}
                  {it.panel && <span className="fine"> · {it.panel}</span>}
                  {it.ref && <div className="fine">{t("Reference {{ref}}", { ref: it.ref })}</div>}
                </td>
                <td className="value">
                  {it.cmp ?? ""}
                  {String(it.v)} <span className="unit">{it.unit}</span>
                  {it.flag && (
                    <span className="flag" title={it.flag === "H" ? t("Marked high") : t("Marked low")}>
                      {it.flag === "H" ? "↑" : "↓"}
                    </span>
                  )}
                </td>
                <td>
                  <select
                    aria-label={t("Measure for {{name}}", { name: it.name })}
                    value={value}
                    onChange={(e) => {
                      const v = e.target.value;
                      setOther(undefined);
                      if (v === "skip") set(i, { skip: true });
                      else if (v === "new") set(i, { new: true });
                      else if (v === "other") setOther(i);
                      else set(i, v ? { code: v } : {});
                    }}
                  >
                    <option value="">{t("Choose…")}</option>
                    {offered.map((code) => (
                      <option key={code} value={code}>
                        {label(code)}
                      </option>
                    ))}
                    <option value="other">{t("Another measure…")}</option>
                    <option value="new">{t("New measure “{{name}}”", { name: it.name })}</option>
                    <option value="skip">{t("Skip")}</option>
                  </select>
                  {other === i && (
                    <MetricPicker
                      placeholder={t("Search measures")}
                      onPick={(x) => {
                        set(i, { code: x.code });
                        setOther(undefined);
                      }}
                    />
                  )}
                </td>
                <td>
                  {numeric && m.units.some((u) => u) && (m.units.length > 1 || needsUnit(i)) && (
                    <select aria-label={t("Unit for {{name}}", { name: it.name })} value={p.unit ?? ""} onChange={(e) => set(i, { ...p, unit: e.target.value || undefined })}>
                      <option value="">{picked[`${p.code} ${it.unit}`] ? t("As printed ({{unit}})", { unit: it.unit }) : t("Choose the unit…")}</option>
                      {m.units.map((u) => (
                        <option key={u} value={u}>
                          {unitLabel(u) || u}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Problem text={err} />
      <div className="actions">
        <button type="button" className="primary" disabled={busy || !count || !date} onClick={save}>
          {t("Save {{count}} results", { count })}
        </button>
        <button type="button" onClick={discard}>
          {t("Discard")}
        </button>
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
    <section className="page">
      <h2>{t("Waiting for you")}</h2>
      <p className="lede">{t("Nothing here is visible in your readings until you confirm it.")}</p>
      {msg &&
        (msg.ok ? (
          <p className="fine" role="status">
            {msg.text}
          </p>
        ) : (
          <Problem text={msg.text} />
        ))}
      {items && !items.length && <p className="empty">{t("Nothing is waiting.")}</p>}
      {(items ?? []).map((b) => {
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
          <div key={b.import_id} className="group">
            <h3>{proposal ? (by ? t("Proposed by {{name}}", { name: by }) : t("Proposed by an agent")) : t("From a lab report photo")}</h3>
            {b.candidates?.note && <p>“{b.candidates.note}”</p>}
            {proposal ? (
              <table className="rows">
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.metric}-${r.start_ms}`}>
                      <td title={r.metric}>{nameOf(r.metric, r.metric)}</td>
                      <td>{when(r.start_ms, r.tz_min)}</td>
                      <td className="n">
                        {typeof r.value === "string" ? resultText(r.value) : String(r.value)} <span className="unit">{unitLabel(r.unit ?? "")}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="fine">{t("Matching lab items to measures arrives with photo import.")}</p>
            )}
            <div className="actions">
              {proposal && (
                <button type="button" className="primary" onClick={() => act("review.confirm", b.import_id, t("Added to your readings."))}>
                  {t("Add to my readings")}
                </button>
              )}
              <button type="button" onClick={() => act("review.discard", b.import_id, t("Discarded."))}>
                {t("Discard")}
              </button>
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
    <div className="group notice connect" role="status">
      <h3>{t("Connect {{name}}", { name: client.name })}</h3>
      {oneClick && (
        <>
          <p>
            {found ? t("{{name}} is on this computer.", { name: client.name }) : t("{{name}}'s settings folder wasn't found; it is created if you go ahead.", { name: client.name })}{" "}
            {t("Health can add itself to its settings for you. Other servers there are kept, and the original file is saved next to it (.health-bak).")}
          </p>
          <div className="actions">
            <button
              type="button"
              className="primary"
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
            </button>
          </div>
          {result && <p className={result.ok ? "fine" : "problem"}>{result.text}</p>}
          <p className="fine">{t("Or do it by hand:")}</p>
        </>
      )}
      <ol className="steps">
        {client.steps(bin, token).map((st) => (
          <li key={st.text}>
            {st.text}
            {st.code && (
              <div className="snippet">
                <pre>{st.code}</pre>
                <Copy text={st.code} label={t("Copy")} />
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className="fine">
        {t("The token is shown only this once. The app works with your data even when Health is closed (with a passphrase lock, keep Health open and unlocked). If you move the Health app, or the access expires, connect again. Apps that run in a web browser (such as ChatGPT or claude.ai) can't reach Health: it only answers on this computer.")}
      </p>
      <button type="button" className="link" onClick={done}>
        {t("Done")}
      </button>
    </div>
  );
}

/** Revoking cuts the app off at once: ask first, and say so if it fails. */
function Revoke({ id, name, done }: { id: number; name: string; done: () => void }) {
  const [ask, setAsk] = useState(false);
  const [err, setErr] = useState<string>();
  if (!ask)
    return (
      <button type="button" className="link" onClick={() => setAsk(true)}>
        {t("Revoke")}
      </button>
    );
  return (
    <span className="actions inline">
      <button
        type="button"
        className="danger"
        onClick={() =>
          op("grant.revoke", { id }).then(
            () => (setAsk(false), done()),
            (e) => setErr(errText(e)),
          )
        }
      >
        {t("Revoke {{name}}", { name })}
      </button>
      <button type="button" onClick={() => setAsk(false)}>
        {t("Keep")}
      </button>
      {err && <Problem text={err} />}
    </span>
  );
}

function LastUsed({ id }: { id: number }) {
  const [last, , reload] = useOp(() => op<Audit[]>("audit.list", { grant_id: id, limit: 1 }), [id]);
  usePoll(reload);
  if (!last) return null;
  return <span className="fine">{last[0] ? t("last used {{when}}", { when: ago(last[0].at) }) : t("not used yet")}</span>;
}

function Agents() {
  const [grants, err, reload] = useOp(() => op<Grant[]>("grant.list"), []);
  const [found, setFound] = useState<string[]>([]);
  const [client, setClient] = useState<Client>();
  const [name, setName] = useState("");
  const [groups, setGroups] = useState<string[]>(GROUPS.filter((g) => !g.sensitive).map((g) => g.key));
  const [detail, setDetail] = useState(false);
  const [days, setDays] = useState(90);
  const [expiry, setExpiry] = useState(90);
  const [write, setWrite] = useState<Grant["write"]>("none");
  const [reports, setReports] = useState(false);
  const [profile, setProfile] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [made, setMade] = useState<{ client: Client; token: string }>();
  const [msg, setMsg] = useState<string>();
  const [bin, setBin] = useState("health");
  useEffect(() => {
    corePath().then(setBin, () => {});
    agentClients().then((c) => setFound(c.map((x) => x.id)), () => {});
  }, []);
  const pick = (c: Client) => {
    setClient(c);
    setName(c.id === "other" ? "" : c.name);
    setMade(undefined);
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
      setClient(undefined);
      setConnecting(false);
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
  return (
    <section className="page">
      <div className="page-head">
        <h2>{t("Agent access")}</h2>
        <div className="actions">
          <button type="button" className="primary" onClick={() => (setMade(undefined), setConnecting(true))}>
            {t("Connect an app…")}
          </button>
        </div>
      </div>
      <p className="lede">
        {t("Let AI apps (Claude, Codex and others) use your data through MCP, with access settings built in.")}
      </p>
      {made && <ConnectSteps client={made.client} token={made.token} bin={bin} found={found.includes(made.client.id)} done={() => setMade(undefined)} />}
      {connecting && (
        <Sheet label={t("Connect an app")} close={() => (setConnecting(false), setClient(undefined))}>
          {!client ? (
            <div className="group">
              <h3>{t("Connect an app")}</h3>
              <p className="fine">{t("Choose the AI app that should use your health data.")}</p>
              <div className="clients" role="group" aria-label={t("Agent apps")}>
                {ordered.map((c) => (
                  <button key={c.id} type="button" className="client" onClick={() => pick(c)}>
                    {c.name}
                    {found.includes(c.id) && <span className="fine">{t("On this computer")}</span>}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <form
              className="grant-form"
              onSubmit={(e) => {
                e.preventDefault();
                create();
              }}
            >
              <button type="button" className="link back" onClick={() => setClient(undefined)}>
                ‹ {t("All apps")}
              </button>
              <h3 className="grant-title">{client.id === "other" ? t("What the app may use") : t("What {{name}} may use", { name: client.name })}</h3>
              <p className="fine">{t("It sees only what you turn on here. It can never delete anything or open your backups.")}</p>

              <CardHead title={t("Health data")} on={everyday.every((k) => groups.includes(k))} set={(on) => setAll(everyday, on)} />
              <ul className="rows-card">
                {GROUPS.filter((g) => g.key !== "derived" && !g.sensitive).map((g) => (
                  <SwitchRow key={g.key} icon={<GroupIcon k={g.key} />} label={t(g.label)} on={groups.includes(g.key)} set={() => toggle(g.key)} />
                ))}
              </ul>

              <CardHead title={t("Sensitive data")} on={sensitive.every((k) => groups.includes(k))} set={(on) => setAll(sensitive, on)} />
              <ul className="rows-card">
                {GROUPS.filter((g) => g.key !== "derived" && g.sensitive).map((g) => (
                  <SwitchRow key={g.key} icon={<GroupIcon k={g.key} />} label={t(g.label)} on={groups.includes(g.key)} set={() => toggle(g.key)} />
                ))}
              </ul>
              <p className="rows-foot">{t("Off unless you turn them on. Turn on only what the app needs.")}</p>

              <CardHead title={t("Detail")} on={detail && reports && profile} set={(on) => (setDetail(on), setReports(on), setProfile(on))} />
              <ul className="rows-card">
                <SwitchRow label={t("Individual entries")} sub={t("Otherwise one summary per day")} on={detail} set={setDetail} />
                <SwitchRow label={t("Full lab report text")} sub={t("Every item on the report, including categories that are off")} on={reports} set={setReports} />
                <SwitchRow label={t("Age and sex")} sub={t("From your profile; never your birth month")} on={profile} set={setProfile} />
              </ul>

              <h4 className="rows-head">{t("What it may do")}</h4>
              <ul className="rows-card" role="radiogroup" aria-label={t("What it may do")}>
                {(
                  [
                    ["none", t("Read only"), t("The agent can only look at your data")],
                    ["propose", t("Read and write"), t("You confirm each entry the agent saves")],
                    ["derived", t("Full read and write"), t("The agent can write data without asking you")],
                  ] as const
                ).map(([k, label, sub]) => (
                  <li key={k}>
                    <label className="row-static row-pick">
                      <input type="radio" name="write" checked={write === k} onChange={() => setWrite(k)} />
                      <span className="row-l">
                        <strong>{label}</strong>
                        <span className="fine">{sub}</span>
                      </span>
                      <span className="row-check" aria-hidden="true">
                        {write === k ? "✓" : ""}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>

              <h4 className="rows-head">{t("Time")}</h4>
              <ul className="rows-card">
                <li className="row-static">
                  <span className="row-l" id="grant-back">
                    <strong>{t("Data from the last")}</strong>
                  </span>
                  <span className="segmented" role="group" aria-labelledby="grant-back">
                    {(
                      [
                        [30, t("30 days")],
                        [90, t("90 days")],
                        [365, t("1 year")],
                        [0, t("All")],
                      ] as const
                    ).map(([d, l]) => (
                      <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
                        {l}
                      </button>
                    ))}
                  </span>
                </li>
                <li className="row-static">
                  <label className="row-l" htmlFor="grant-expiry">
                    <strong>{t("Agent access ends after")}</strong>
                  </label>
                  <select id="grant-expiry" className="row-select" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
                    {EXPIRY.map(([d, l]) => (
                      <option key={d} value={d}>
                        {t(l)}
                      </option>
                    ))}
                  </select>
                </li>
              </ul>

              <h4 className="rows-head">{t("Name")}</h4>
              <ul className="rows-card">
                <li className="row-static">
                  <label className="row-l" htmlFor="grant-name">
                    <strong>{t("Name shown in the access log")}</strong>
                  </label>
                  <input id="grant-name" className="row-input" placeholder={t("My agent")} value={name} onChange={(e) => setName(e.target.value)} required />
                </li>
              </ul>

              <Problem text={msg} />
              <div className="actions grant-actions">
                <button type="button" onClick={() => setClient(undefined)}>
                  {t("Cancel")}
                </button>
                <button type="submit" className="primary" disabled={!groups.length || !name.trim()}>
                  {t("Allow access")}
                </button>
              </div>
            </form>
          )}
        </Sheet>
      )}
      <h3 className="rows-head">{t("Current access")}</h3>
      <Problem text={err} />
      {grants && !grants.length ? (
        <p className="empty">{t("No app has access yet.")}</p>
      ) : (
        <ul className="rows-card grants">
          {(grants ?? [])
            .slice()
            .reverse()
            .map((g) => {
              const live = !g.revoked_ms && g.expires_ms > Date.now();
              return (
                <li key={g.id} className={live ? "row-static" : "row-static stale"} aria-label={g.name}>
                  <span className="row-l">
                    <strong>{g.name}</strong>
                    <span className="fine">
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
                  <span className="grant-end">
                    <span className="tag">
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
        </ul>
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
    <div className="group">
      <h3>{t("Access log")}</h3>
      <Problem text={err} />
      {log && !log.length && <p className="empty">{t("No agent has read anything yet.")}</p>}
      <table className="rows">
        <tbody>
          {(log ?? []).map((a, i) => (
            <tr key={`${a.at}-${i}`}>
              <td>{when(a.at)}</td>
              <th scope="row">{nameOf(a.grant_id)}</th>
              <td>{a.op}</td>
              <td>{a.metrics.join(", ")}</td>
              <td className="n">{a.denied ? <span className="signal">{t("refused")}</span> : t("{{count}} rows", { count: a.rows })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Backup and export (as the web's 备份与导出): save a backup, restore one, or write a table for other tools. */
function Backup({ want }: { want?: string }) {
  const [sheet, setSheet] = useState<"save" | "restore" | "csv" | undefined>(want === "save" || want === "restore" || want === "csv" ? want : undefined);
  const [file, setFile] = useState<string>();
  const titles = { save: t("Save a backup"), restore: t("Restore a backup"), csv: t("Export a table (CSV)") };
  return (
    <section className="page">
      <h2>{t("Backup")}</h2>
      <p className="lede">{t("Save or restore a backup file to move your data to another device.")}</p>
      <ul className="rows-card">
        <Row icon={<Icon k="backup" />} label={titles.save} sub={t("Encrypted with a password you choose")} onClick={() => setSheet("save")} />
        <Row icon={<Icon k="data" />} label={titles.restore} sub={t("Merges; nothing is overwritten")} onClick={() => setSheet("restore")} />
        <Row icon={<GroupIcon k="other" />} label={titles.csv} sub={t("Unencrypted, for spreadsheets and other tools")} onClick={() => setSheet("csv")} />
      </ul>
      <ClearDataRow />
      {sheet && (
        <Sheet label={titles[sheet]} close={() => (setSheet(undefined), setFile(undefined))}>
          {sheet === "save" && <BackupSave />}
          {sheet === "restore" && <Import file={file} onFile={setFile} go={() => setSheet(undefined)} kind="restore" title={titles.restore} />}
          {sheet === "csv" && <CsvExport />}
        </Sheet>
      )}
    </section>
  );
}

/** A table of readings for other tools (web 导出表格): chosen groups only; unencrypted, so it says so. */
function CsvExport() {
  const [groups, setGroups] = useState<string[]>(GROUPS.filter((g) => !g.sensitive).map((g) => g.key));
  const [dateOnly, setDateOnly] = useState(false);
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<string>();
  const save = async () => {
    setErr(undefined);
    setDone(undefined);
    let path = out;
    if (isDesktop) {
      const p = await chooseSavePath(`health-${day(Date.now())}.csv`, "CSV", "csv");
      if (!p) return;
      path = p;
    }
    // a phone: written in the app's own folder, then handed to the share sheet (save to Files, send, ...)
    if (isMobile) path = await exportPath(`health-${day(Date.now())}.csv`);
    if (!path) return setErr(t("Choose where to save the table."));
    setBusy(true);
    try {
      const r = await op<{ path: string; rows: number }>("export.csv", { path, groups, date_only: dateOnly });
      if (isMobile) await shareFile(r.path, "text/csv");
      setDone(t("Saved {{file}}: {{count}} rows. It isn't encrypted: keep it somewhere safe.", { file: fileName(r.path), count: r.rows }));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="record">
      <h2>{t("Export a table (CSV)")}</h2>
      <p className="lede">{t("Export unencrypted data for use in other software.")}</p>
      <form
        className="form"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {[false, true].map((sensitive) => (
          <fieldset key={String(sensitive)}>
            <legend>{sensitive ? t("Sensitive: tick only what you need") : t("What to include")}</legend>
            {GROUPS.filter((g) => g.sensitive === sensitive).map((g) => (
              <label key={g.key} className="check">
                <input
                  type="checkbox"
                  checked={groups.includes(g.key)}
                  onChange={() => setGroups((x) => (x.includes(g.key) ? x.filter((k) => k !== g.key) : [...x, g.key]))}
                />
                {t(g.label)}
              </label>
            ))}
          </fieldset>
        ))}
        <label className="check">
          <input type="checkbox" checked={dateOnly} onChange={(e) => setDateOnly(e.target.checked)} />
          {t("Dates only (no times or time zones)")}
        </label>
        {!isDesktop && !isMobile && (
          <label>
            {t("Save to")}
            <input value={out} onChange={(e) => setOut(e.target.value)} placeholder="/Users/you/Documents/health.csv" />
          </label>
        )}
        <Problem text={err} />
        <button type="submit" className="primary" disabled={busy || !groups.length}>
          {busy ? t("Saving…") : isDesktop ? t("Save table…") : t("Save table")}
        </button>
      </form>
      {done && (
        <p className="notice" role="status">
          {done}
        </p>
      )}
    </section>
  );
}

function BackupSave() {
  const [out, setOut] = useState("");
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
    let path = out;
    if (isDesktop) {
      const p = await chooseSavePath(`health-${stamp}.zuhealth`, t("Health backup"), "zuhealth");
      if (!p) return;
      path = p;
    }
    if (isMobile) path = await exportPath(`health-${stamp}.zuhealth`);
    if (!path) return setErr(t("Choose where to save the backup."));
    setBusy(true);
    try {
      // the native save dialog already asked before replacing a file; a phone writes in its own folder
      const r = await op<{ bytes: number; path: string }>("backup.export", { path, password: pw, replace: isDesktop || isMobile });
      if (isMobile) await shareFile(r.path, "application/octet-stream");
      setDone(
        t("Saved {{file}} ({{mb}} MB). Keep the password safe: without it the backup cannot be opened.", { file: fileName(r.path), mb: (r.bytes / 1e6).toFixed(1) }),
      );
      setPw("");
      setPw2("");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="record">
      <h2>{t("Save a backup")}</h2>
      <form
        className="group form"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <PasswordField label={t("Password")} value={pw} onChange={setPw} auto="new-password" />
        <PasswordField label={t("Repeat password")} value={pw2} onChange={setPw2} auto="new-password" />
        <p className="fine">{t("At least 8 characters. There is no way to recover a forgotten backup password.")}</p>
        {!isDesktop && !isMobile && (
          <label>
            {t("Save to")}
            <input value={out} onChange={(e) => setOut(e.target.value)} placeholder={`/Users/you/Documents/health-${stamp}.zuhealth`} />
          </label>
        )}
        <Problem text={err} />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? t("Saving…") : isDesktop ? t("Save backup…") : t("Save backup")}
        </button>
      </form>
      {done && (
        <p className="notice" role="status">
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
  return svg ? <div className="qr" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="qr" />;
}

type AccountSheet = "identity" | "results" | "history";

/** The health account, as the web's 更多 groups it: the identity, results, and other devices, each a row with its
 *  state; details in a sheet, connecting and LAN sync on their own pages. */
function HealthAccount({ go, want }: { go: (p: Page) => void; want?: string }) {
  const [acc, setAcc] = useState<AccountInfo | null>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"main" | "connect" | "join" | "give" | "sync">(want === "connect" || want === "sync" ? want : "main");
  // the view it was opened at: on a narrow screen the shell's back button leads out of it, so its own goes
  const [entry] = useState(view);
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
  if (acc === undefined) return <section className="page narrow" aria-busy="true"><h2>{t("Health account")}</h2></section>;
  const back = () => {
    setView("main");
    load();
  };
  if (view === "connect")
    return <ConnectDevice hasAccount={!!acc} back={back} entry={entry === "connect"} join={() => setView("join")} give={() => setView("give")} />;
  // joined: on to sync, the reason most people connect a device
  if (view === "join") return <LinkThis done={(ok) => { load(); setView(ok ? "sync" : "connect"); }} />;
  if (view === "give") return <GiveAccount done={() => setView("connect")} />;
  if (view === "sync") return <SyncPage back={back} entry={entry === "sync"} />;
  const entries = history?.state === "ok" ? history.entries.length : undefined;
  return (
    <section className="page narrow">
      <h2>{t("Health account")}</h2>
      <p className="lede">
        {t("Labs and service desks send results to your health account, sealed so only your devices can open them. Your account key stays on your devices, and your readings only travel between your own devices.")}
      </p>
      {!acc && (
        <div className="group form">
          <p>{(isMobile ? t("There is no health account on this device yet.") : t("There is no health account on this computer yet."))}</p>
          <div className="actions">
            <button type="button" className="primary" disabled={busy} onClick={show}>
              {busy ? t("Contacting the service…") : t("Create my account")}
            </button>
            <button type="button" disabled={busy} onClick={() => setView("connect")}>
              {t("Connect another device…")}
            </button>
          </div>
        </div>
      )}
      <Problem text={err} />
      {acc && (
        <>
          <h3 className="rows-head">{t("Health identity")}</h3>
          <ul className="rows-card">
            <Row
              icon={<Icon k="id" />}
              label={t("Identity code")}
              sub={t("Show it at a lab or service desk so they can send your results here")}
              value={acc.identity ? `${acc.id.slice(0, 4)}…${acc.id.slice(-4)}` : busy ? t("Contacting the service…") : t("Show")}
              onClick={() => (acc.identity ? setSheet("identity") : show())}
            />
          </ul>
          <h3 className="rows-head">{t("Results")}</h3>
          <ul className="rows-card">
            <Row
              icon={<Icon k="inbox" />}
              label={t("Lab results")}
              sub={t("Checked when Health opens and every few minutes")}
              value={waiting ? t("Waiting for you") : acc.drops > 0 ? t("{{count}} discarded", { count: acc.drops }) : undefined}
              onClick={() => setSheet("results")}
            />
          </ul>
        </>
      )}
      <h3 className="rows-head">{t("Other devices")}</h3>
      <ul className="rows-card">
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
      </ul>
      {sheet && (
        <Sheet
          label={{ identity: t("Your identity code"), results: t("Lab results"), history: t("Connection history") }[sheet]}
          close={() => setSheet(undefined)}
        >
          {sheet === "identity" && acc?.identity && (
            <div className="identity">
              <h3>{t("Your identity code")}</h3>
              <Qr text={acc.identity} label={t("Your identity code")} />
              <p className="fine">{t("Show it at a lab or service desk so they can send your results here.")}</p>
              <p className="fine mono">{t("Account {{id}}…", { id: acc.id.slice(0, 8) })}</p>
            </div>
          )}
          {sheet === "results" && acc && (
            <div className="form">
              <h3>{t("Lab results")}</h3>
              <p className="fine">{t("Health checks for new results when it opens and every few minutes while it's open.")}</p>
              {acc.drops > 0 && <p className="fine">{t("{{count}} results were discarded because they failed a check.", { count: acc.drops })}</p>}
              <div className="actions">
                <button type="button" className="primary" disabled={busy || !acc.registered} onClick={check}>
                  {busy ? t("Checking…") : t("Check for results now")}
                </button>
                {waiting && (
                  <button type="button" className="link" onClick={() => go("review")}>
                    {t("Check them now")}
                  </button>
                )}
              </div>
              {polled && <p role="status" className="fine">{polled}</p>}
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
      {asking && <span className="dot" aria-hidden="true" />}
      {text}
    </>
  );
}

/** One entry for connecting devices (as the web's 连接其他设备): which side is this one? */
function ConnectDevice({ hasAccount, back, entry, join, give }: { hasAccount: boolean; back: () => void; entry?: boolean; join: () => void; give: () => void }) {
  return (
    <section className="page narrow">
      <button type="button" className={`link back${entry ? " entry" : ""}`} onClick={back}>
        ‹ {t("Health account")}
      </button>
      <h2>{t("Connect another device")}</h2>
      <p className="lede">{t("Your devices can sync data with each other on the same local network.")}</p>
      <div className="role-card">
        <h3>{t("This is a new device")}</h3>
        <p className="fine">{t("Get data from another device.")}</p>
        <button type="button" className="primary wide" onClick={join}>
          {t("Show connection code")}
        </button>
      </div>
      <div className="role-card">
        <h3>{t("This one is already in use")}</h3>
        <p className="fine">{t("Send data to another device.")}</p>
        <button type="button" className="tonal wide" disabled={!hasAccount} onClick={give}>
          {t("Enter connection code")}
        </button>
        {!hasAccount && <p className="fine">{(isMobile ? t("There's no health identity on this device yet, so there's nothing to hand over.") : t("There's no health identity on this computer yet, so there's nothing to hand over."))}</p>}
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
    <section className="page narrow">
      <button type="button" className="link back" disabled={busy} onClick={() => done(false)}>
        ‹ {t("Connect another device")}
      </button>
      <h2>{t("Show connection code")}</h2>
      {st.state === "waiting" && code && (
        <div className="group identity">
          <Qr text={code} label={t("Connection code")} />
          <div>
            <p>{t("Use your earlier device to scan or paste this code and connect this new one. Once connected, data moves between them on the same network with Local network sync, or with Backup.")}</p>
            <p className="fine mono link-code">{code}</p>
            <div className="actions">
              <button type="button" onClick={copy}>
                {copied ? t("Copied") : t("Copy code")}
              </button>
            </div>
            <p className="fine">{t("Waiting… The code works for 10 minutes.")}</p>
          </div>
        </div>
      )}
      {st.state === "received" && (
        <div className="group form">
          <p>{t("Check that your other device shows the same code:")}</p>
          <p className="check-code" aria-label={t("Check code {{code}}", { code: st.check })}>{st.check}</p>
          {st.replaces && (
            <p className="notice">{t("This computer's identity code will change to the other device's. Results not yet received here won't arrive.")}</p>
          )}
          <div className="actions">
            <button type="button" className="primary" disabled={busy} onClick={adopt}>
              {busy ? t("Connecting…") : t("They match")}
            </button>
            <button type="button" disabled={busy} onClick={() => done(false)}>
              {t("They don't match")}
            </button>
          </div>
        </div>
      )}
      {(st.state === "expired" || st.state === "failed") && (
        <div className="group form">
          <p>
            {st.state === "expired" ? t("The code expired.") : t("Connecting failed.")} {(isMobile ? t("Nothing was changed on this device.") : t("Nothing was changed on this computer."))}
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={start}>
              {t("Start again")}
            </button>
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
    <section className="page narrow">
      <button type="button" className="link back" disabled={busy} onClick={done}>
        ‹ {t("Connect another device")}
      </button>
      <h2>{t("Enter connection code")}</h2>
      <p className="lede">{t("Connect a new device. Once connected, data moves between them on the same network with Local network sync, or with Backup.")}</p>
      {check ? (
        <div className="group form">
          <p>{t("The new device must show the same code:")}</p>
          <p className="check-code" aria-label={t("Check code {{code}}", { code: check })}>{check}</p>
          <div className="actions">
            <button type="button" className="primary" onClick={done}>
              {t("Done")}
            </button>
          </div>
        </div>
      ) : (
        <form
          className="group form"
          onSubmit={(e) => {
            e.preventDefault();
            give();
          }}
        >
          {isMobile && (
            <div className="actions">
              <button
                type="button"
                className="primary"
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
              </button>
            </div>
          )}
          <label>
            {t("Connection code shown on the new device")}
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ZUHL1:…" spellCheck={false} autoComplete="off" autoFocus={!isMobile} />
          </label>
          <label className="check">
            <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
            {t("This hands my health account to the device showing this code. It is my own device.")}
          </label>
          <Problem text={err} />
          <div className="actions">
            <button type="submit" className="primary" disabled={busy || !sure || !code.trim()}>
              {busy ? t("Sending…") : t("Hand over my account")}
            </button>
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
    <div className="group ocr">
      <h3>{t("A result from {{from}}", { from })}</h3>
      <p className="fine">
        {when(c.at, c.tz)}
        {t(".")} {t("Choose what each line is, or skip it.")}
      </p>
      <table className="rows">
        <tbody>
          {c.lines.map((l, i) => {
            const s = lines[i]!;
            return (
              <tr key={`${l.code}-${i}`} className={s.skip ? "skipped" : undefined}>
                <td className="mono">{l.code}</td>
                <td className="n">
                  {String(l.v)} <span className="unit">{unitLabel(l.u ?? "")}</span>
                </td>
                <td>
                  {s.metric ? (
                    <span>
                      {nameOf(s.metric.code, s.metric.name)}{" "}
                      <button
                        type="button"
                        className="link"
                        onClick={() => setLines((ls) => ls.map((x, j) => (j === i ? { unit: "", skip: false } : x)))}
                      >
                        {t("Change")}
                      </button>
                    </span>
                  ) : (
                    <MetricPicker placeholder={t("Which measure is this?")} onPick={(m) => choose(i, m.code)} />
                  )}
                </td>
                <td>
                  {s.metric && numericAgg(s.metric) && (s.metric.units.length > 1 || (s.metric.units.length === 1 && !s.unit)) && (
                    <select
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
                <td>
                  <label className="check">
                    <input
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
      <div className="actions">
        <button type="button" className="primary" disabled={!ready || busy} onClick={save}>
          {busy ? t("Saving…") : t("Save to my readings")}
        </button>
        <button type="button" onClick={discard}>
          {t("Discard")}
        </button>
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
    <div className="group form">
      <h3>WHOOP</h3>
      {st.state === "connected" ? (
        <>
          <p className="fine">
            {st.last_sync
              ? t("Connected. Health fetches new WHOOP data every hour while it's open; last time {{when}}.", { when: when(st.last_sync) })
              : t("Connected. Health fetches new WHOOP data every hour while it's open.")}
          </p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={sync}>
              {busy ? t("Syncing…") : t("Sync now")}
            </button>
            <button type="button" disabled={busy} onClick={() => run(async () => void (await op("whoop.disconnect")))}>
              {t("Disconnect")}
            </button>
          </div>
        </>
      ) : st.state === "pending" ? (
        <p className="fine">{t("Waiting for the WHOOP sign-in in your browser…")}</p>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            connect();
          }}
        >
          <p className="fine">
            {st.state === "reauth" ? `${t("WHOOP needs you to sign in again.")} ` : ""}
            {t("Create your own app in the WHOOP developer dashboard, then copy its Client ID and Client Secret here.")}{" "}
            <WebLink url={WHOOP_DASHBOARD} label={t("Open the WHOOP developer dashboard")} />
          </p>
          <p className="fine">
            {t("Add this redirect URL to the app:")} <span className="mono">{redirect}</span>{" "}
            <Copy text={redirect} label={t("Copy")} />
          </p>
          <label>
            {t("Client ID")}
            <input value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <PasswordField label={t("Client Secret")} value={secret} onChange={setSecret} auto="off" />
          <div className="actions">
            <button type="submit" className="primary" disabled={busy || !id.trim() || !secret.trim()}>
              {t("Connect WHOOP")}
            </button>
          </div>
        </form>
      )}
      {note && <p className="fine" role="status">{note}</p>}
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

function ProfilePage() {
  const [me, , reloadMe] = useOp(() => op<Personal>("profile.get"), []);
  const [latest, , reloadLatest] = useOp(() => op<Point[]>("obs.latest"), []);
  const [edit, setEdit] = useState<ProfileField>();
  const latestOf = (code: string) => {
    const v = latest?.find((p) => p.metric === code)?.value;
    return typeof v === "number" ? v : undefined;
  };
  const h = latestOf(HEIGHT);
  const w = latestOf(WEIGHT);
  const unset = <span className="fine">{t("Not set")}</span>;
  // as the web shows them: one decimal at most
  const one = (v: number) => (Math.round(v * 10) / 10).toLocaleString(i18nLocale(), { maximumFractionDigits: 1 });
  const rows: { k: ProfileField; label: string; value: ReactNode }[] = [
    { k: "sex", label: t("Sex"), value: sexLabel(me?.sex) ?? unset },
    { k: "birth", label: t("Birth month"), value: me?.birth ? `${birthLabel(me.birth)} · ${t("{{count}} years old", { count: me.age ?? 0 })}` : unset },
    { k: "height", label: t("Height"), value: h !== undefined ? `${one(h * 100)} cm` : unset },
    { k: "weight", label: t("Weight"), value: w !== undefined ? `${one(w)} kg` : unset },
  ];
  return (
    <section className="page">
      <h2>{t("Profile")}</h2>
      <ul className="rows-card">
        {rows.map((x) => (
          <li key={x.k}>
            <button type="button" className="row-btn" onClick={() => setEdit(x.k)}>
              <span className="row-l">
                <strong>{x.label}</strong>
              </span>
              <span className="row-v">{x.value}</span>
              <span className="row-chev" aria-hidden="true">
                ›
              </span>
            </button>
          </li>
        ))}
      </ul>
      {edit && (
        <Sheet label={rows.find((x) => x.k === edit)!.label} close={() => setEdit(undefined)}>
          <ProfileEdit
            field={edit}
            me={me ?? {}}
            done={() => {
              setEdit(undefined);
              reloadMe();
              reloadLatest();
            }}
          />
        </Sheet>
      )}
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
    <section className="record">
      <h2>{title}</h2>
      {field === "sex" && (
        <>
          <ul className="rows-card" role="radiogroup" aria-label={t("Sex")}>
            {(["Female", "Male"] as const).map((s) => (
              <li key={s}>
                <button
                  type="button"
                  className="row-btn"
                  role="radio"
                  aria-checked={me.sex === s}
                  disabled={busy}
                  onClick={() => run(() => op("profile.set", { sex: s }))}
                >
                  <span className="row-l">
                    <strong>{sexLabel(s)}</strong>
                  </span>
                  <span className="row-check" aria-hidden="true">
                    {me.sex === s ? "✓" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {me.sex && (
            <button type="button" className="link" disabled={busy} onClick={() => run(() => op("profile.set", { sex: null }))}>
              {t("Clear")}
            </button>
          )}
        </>
      )}
      {field === "birth" && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!year || !month) return setErr(t("Choose a year and a month."));
            run(() => op("profile.set", { birth: `${year}-${month.padStart(2, "0")}` }));
          }}
        >
          <label>
            {t("Year")}
            <select value={year} onChange={(e) => setYear(e.target.value)} required>
              <option value="">{t("Choose…")}</option>
              {Array.from({ length: now.getFullYear() - 1900 + 1 }, (_, i) => now.getFullYear() - i).map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Month")}
            <select value={month} onChange={(e) => setMonth(e.target.value)} required>
              <option value="">{t("Choose…")}</option>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {new Intl.DateTimeFormat(i18nLocale(), { month: "long", timeZone: "UTC" }).format(Date.UTC(2000, m - 1, 1))}
                </option>
              ))}
            </select>
          </label>
          <Problem text={err} />
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {t("Save")}
            </button>
            {me.birth && (
              <button type="button" className="link" disabled={busy} onClick={() => run(() => op("profile.set", { birth: null }))}>
                {t("Clear")}
              </button>
            )}
          </div>
        </form>
      )}
      {(field === "height" || field === "weight") && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (field === "height") measure(HEIGHT, "cm", 30, 272);
            else measure(WEIGHT, "kg", 1, 650);
          }}
        >
          <label>
            {field === "height" ? t("Height (cm)") : t("Weight (kg)")}
            <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus required />
          </label>
          <p className="fine">{t("Saved as a new reading now, entered by you.")}</p>
          <Problem text={err} />
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {t("Save")}
            </button>
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
      <h3>{t("Connection history")}</h3>
      <ul className="rows-card" aria-label={t("Connection history")}>
        <li className="row-static">
          <Icon k="account" />
          <span className="row-l">
            <strong>{t("This device")}</strong>
          </span>
          <span className="tag">{t("This one")}</span>
        </li>
        {history.state === "unreadable" ? (
          <li className="row-static fine">{t("Can't read the connection history")}</li>
        ) : history.entries.length === 0 ? (
          <li className="row-static fine">{t("No connections recorded on this device")}</li>
        ) : (
          history.entries.map((x) => (
            <li key={x.id} className="row-static">
              <Icon k="account" />
              <span className="row-l">
                <strong>{x.dir === "gave" ? t("Handed over from this device") : t("Received from another device")}</strong>
                <span className="fine">{t("{{date}} · Check code {{code}}", { date: when(x.at), code: x.check })}</span>
                {x.dir === "gave" && <span className="fine">{t("The other device may not have confirmed it")}</span>}
              </span>
            </li>
          ))
        )}
      </ul>
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
function SyncPage({ back, entry }: { back: () => void; entry?: boolean }) {
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
    <section className="page narrow">
      <button type="button" className={`link back${entry ? " entry" : ""}`} onClick={back}>
        ‹ {t("Health account")}
      </button>
      <h2>{t("Local network sync")}</h2>
      <Problem text={err} />
      {st?.paused && (
        <div className="notice banner">
          <span>{t("Sync is paused: you chose Not now when another device would delete data here.")}</span>
          <button type="button" className="primary" disabled={busy} onClick={() => run(() => op("sync.set", { paused: false }))}>
            {t("Continue syncing")}
          </button>
        </div>
      )}
      {live?.clock_off && <p className="notice">{t("This computer's clock is off by more than 2 minutes, so other devices can't be reached.")}</p>}
      {st && (
        <ul className="rows-card">
          <SwitchRow
            icon={<Icon k="wifi" />}
            label={t("Sync on this network")}
            sub={t("Devices you've connected sync automatically when Health is open on the same local network.")}
            on={st.enabled}
            set={(on) => run(() => op("sync.set", { enabled: on }))}
          />
        </ul>
      )}
      {st?.enabled && live?.idle === "offline" && <p className="fine">{t("Health is offline, so it doesn't sync.")}</p>}
      {st?.enabled && (
        <>
          <h3 className="rows-head">{t("Devices")}</h3>
          <ul className="rows-card" aria-label={t("Devices on this network")}>
            {livePeers.length === 0 && known.length === 0 && (
              <li className="row-static fine">{t("No other device seen yet. Open Health on your other device on this network.")}</li>
            )}
            {livePeers.map((p) => (
              <li key={p.device} className="row-static sync-peer">
                <Icon k="device" />
                <span className="row-l">
                  <strong>{deviceName(p.name)}</strong>
                  <span className="fine" role="status">
                    {peerState(p)}
                    {p.last_synced ? ` · ${t("Last synced {{date}}", { date: when(p.last_synced) })}` : ""}
                  </span>
                  {p.state === "syncing" && p.wanted ? (
                    <progress max={p.wanted} value={p.received ?? 0} aria-label={t("Syncing")} />
                  ) : null}
                  {p.state === "partly" && (
                    <span className="fine">
                      {t("{{count}} items can't be merged, for example a measure whose unit differs between the two devices. Health tries again every day.", { count: p.skipped ?? 0 })}
                    </span>
                  )}
                  {p.state === "asking" && (
                    <button type="button" className="link" onClick={() => setDismissed(undefined)}>
                      {t("Answer")}
                    </button>
                  )}
                  {p.state === "ended" && p.code && (
                    <details className="fine">
                      <summary>{t("Details")}</summary>
                      <span className="mono">{p.code}</span>
                    </details>
                  )}
                </span>
                <span className={`tag state-${p.state}`}>{p.state === "up_to_date" ? "✓" : ""}</span>
              </li>
            ))}
            {known.map((p) => (
              <li key={p.device} className="row-static">
                <Icon k="device" />
                <span className="row-l">
                  <strong>{deviceName(p.name)}</strong>
                  <span className="fine">
                    {t("Not on this network now")}
                    {p.last_synced ? ` · ${t("Last synced {{date}}", { date: when(p.last_synced) })}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {asking?.asking && askKey !== dismissed && (
        <Sheet label={t("Sync")} close={() => setDismissed(askKey)}>
          {asking.asking.ask === "join" ? (
            <div className="form">
              <h3>{t("Combine with {{device}}?", { device: deviceName(asking.name) })}</h3>
              <p>
                {t("This computer's data and that device's data are combined, and both then hold the same. This computer has {{count}} imports. Combining can't be undone.", {
                  count: asking.asking.imports,
                })}
              </p>
              <div className="actions">
                <button type="button" className="primary" disabled={busy} onClick={() => answer(asking.device, true)}>
                  {t("Combine")}
                </button>
                <button type="button" disabled={busy} onClick={() => answer(asking.device, false)}>
                  {t("Not now")}
                </button>
              </div>
            </div>
          ) : (
            <div className="form">
              <h3>{t("Delete here too?")}</h3>
              <p>
                {t("{{device}} deleted {{imports}} imports. Syncing deletes their {{rows}} readings on this computer too.", {
                  device: deviceName(asking.name),
                  imports: asking.asking.imports,
                  rows: asking.asking.rows,
                })}
              </p>
              <div className="actions">
                <button type="button" className="danger" disabled={busy} onClick={() => answer(asking.device, true)}>
                  {t("Delete here too")}
                </button>
                <button type="button" disabled={busy} onClick={() => answer(asking.device, false)}>
                  {t("Not now (pauses sync)")}
                </button>
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
          <h3 className="rows-head">{title}</h3>
          <ul className="rows-card">
            {lines.map((line) => (
              <li key={line} className="row-static">
                <span className="row-l">{line}</span>
              </li>
            ))}
          </ul>
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
    <ul className="lic-all">
      {items.map((c) => (
        <li key={c.name}>
          {c.url ? <WebLink url={c.url} label={c.name} /> : c.name} <span className="fine">{c.versions.join(", ")}</span>{" "}
          <span className="fine mono">{c.license}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <p className="lede">{t("Health is open-source software under the MIT License. It uses these open-source components and data, with thanks to their authors.")}</p>
      <ul className="rows-card" aria-label={t("Components")}>
        {MAIN_COMPONENTS.map((c) => (
          <li key={c.name} className="row-static lic-row">
            <span className="row-l">
              <strong>
                <WebLink url={c.url} label={c.name} />
              </strong>
              <span className="fine">{c.by}</span>
            </span>
            <span className="tag">{c.license}</span>
          </li>
        ))}
      </ul>
      <h3 className="rows-head">LOINC</h3>
      <p className="fine lic-notice">{LOINC_NOTICE}</p>
      {all && (
        <>
          <h3 className="rows-head">{t("All components")}</h3>
          <details className="lic-texts">
            <summary>{t("{{count}} Rust crates", { count: all.crates.length })}</summary>
            {list(all.crates)}
          </details>
          <details className="lic-texts">
            <summary>{t("{{count}} JavaScript packages", { count: all.npm.length })}</summary>
            {list(all.npm)}
          </details>
          <h3 className="rows-head">{t("License texts")}</h3>
          {Object.entries(all.texts).map(([name, text]) => (
            <details key={name} className="lic-texts">
              <summary>{name}</summary>
              <pre>{text}</pre>
            </details>
          ))}
          <p className="fine">
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
  const [view, setView] = useState<"privacy" | "licenses" | undefined>(want === "privacy" || want === "licenses" ? want : undefined);
  const [entry] = useState(view);
  if (view)
    return (
      <section className="page narrow">
        <button type="button" className={`link back${view === entry ? " entry" : ""}`} onClick={() => setView(undefined)}>
          ‹ {t("About")}
        </button>
        <h2>{view === "privacy" ? t("Privacy") : t("Open-source licenses")}</h2>
        {view === "privacy" ? <Privacy /> : <Licenses />}
      </section>
    );
  return (
    <section className="page narrow">
      <h2>{t("About")}</h2>
      <p className="lede">{version ? t("Health {{version}}", { version }) : "Health"}</p>
      <ul className="rows-card">
        <Row icon={<Icon k="shield" />} label={t("Privacy")} onClick={() => setView("privacy")} />
        <Row icon={<Icon k="scale" />} label={t("Open-source licenses")} onClick={() => setView("licenses")} />
      </ul>
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

/** On the home page's Strength and jumps card: the latest time on the plates, its jumps and its best jump. */
function FdReportRow({ session, open }: { session: FdSession; open: () => void }) {
  return (
    <ul className="rows-card report-row">
      <Row
        icon={<GroupIcon k="force" />}
        label={t("VALD ForceDecks test record")}
        sub={`${shortDate(fdStart(session))} · ${t("{{count}} jumps", { count: session.trials.length })}`}
        value={t("Best jump {{v}}", { v: keyText(session, session.best) })}
        onClick={open}
      />
    </ul>
  );
}

function Delta({ d, unit }: { d: number | null; unit: string }) {
  if (d === null || num(Math.abs(d)).replace(/[0.,\s]/g, "") === "") return null;
  const text = `${d > 0 ? "↑" : "↓"} ${num(Math.abs(d))}`;
  return (
    <span className="fd-delta" role="img" aria-label={t("Compared with last time: {{d}}", { d: `${d > 0 ? "+" : "−"}${num(Math.abs(d))} ${unit}`.trim() })}>
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
    <figure className="fd-trend" aria-label={t("Trend over {{count}} tests", { count: pts.length })}>
      <div className="fd-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={xy.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* round dots over the stretched line, this test's filled */}
        {xy.map((p, k) => (
          <span key={pts[k]!.at} className={`fd-dot${k === xy.length - 1 ? " now" : ""}`} style={{ left: `${p.x}%`, top: `${p.y}%` }} />
        ))}
      </div>
      <figcaption className="fine">
        <span>{shortDate(pts[0]!.at)}</span>
        <span>{t("This test")}</span>
      </figcaption>
    </figure>
  );
}

/** VALD ForceDecks tests: the latest by default; each jump can be opened; the best jump against the previous
 *  best of the same test; a trend from three tests; every test in History. */
function FdReport({ sessions }: { sessions: FdSession[] }) {
  const [i, setI] = useState(0);
  const [jump, setJump] = useState<number | null>(null);
  const [hist, setHist] = useState(false);
  const at = Math.min(i, Math.max(0, sessions.length - 1));
  const cur = sessions[at];
  if (!cur)
    return (
      <div className="form">
        <h3>{t("No VALD ForceDecks tests yet")}</h3>
        <p className="fine">{t("After a test on VALD ForceDecks at the lab, the results show here.")}</p>
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
    <div className="fd">
      <header className="fd-head">
        <div>
          <h3>{t("VALD ForceDecks tests")}</h3>
          <p className="fine">VALD ForceDecks · {when(fdStart(cur))}</p>
        </div>
        <button type="button" aria-expanded={hist} onClick={() => setHist(!hist)}>
          {t("History")}
        </button>
      </header>
      {hist && (
        <ul className="rows-card" aria-label={t("Test history")}>
          {sessions.map((s, n) => (
            <li key={`${s.device}|${s.test}|${fdStart(s)}`}>
              <button type="button" className="row-btn" aria-current={n === at ? "true" : undefined} onClick={() => pick(n)}>
                <span className="row-l">
                  <strong>{when(fdStart(s))}</strong>
                  <span className="fine">
                    {testLabel(s.test)} · {t("{{count}} jumps", { count: s.trials.length })} · {keyText(s, s.best)}
                  </span>
                </span>
                {n === 0 && <span className="tag">{t("Latest")}</span>}
                {n === at && <span aria-hidden="true">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {at > 0 && (
        <p className="notice banner" role="status">
          <span>{t("Viewing the test of {{date}}", { date: when(fdStart(cur)) })}</span>
          <button type="button" onClick={() => pick(0)}>
            {t("Back to the latest")}
          </button>
        </p>
      )}
      <section aria-label={testLabel(cur.test)}>
        <h4>
          {testLabel(cur.test)} <span className="fine">{t("{{count}} jumps", { count: cur.trials.length })}</span>
        </h4>
        <p className="fine">
          {onBest
            ? cur.trials.length > 1
              ? t("Below is this test's best jump (jump {{k}})", { k: k + 1 })
              : t("One jump this time")
            : t("Below is jump {{k}}, at {{time}}", { k: k + 1, time: new Date(tr.start_ms).toLocaleTimeString([], { timeStyle: "short" }) })}
        </p>
        {cur.trials.length > 1 && (
          <div className="fd-jumps" role="group" aria-label={t("Each jump")}>
            {cur.trials.map((x, n) => (
              <button key={x.start_ms} type="button" aria-pressed={n === k} className={n === k ? "on" : ""} onClick={() => setJump(n === cur.best ? null : n)}>
                {t("Jump {{k}}", { k: n + 1 })} · {keyText(cur, n)}
                {n === cur.best && <span className="tag">{t("Best")}</span>}
              </button>
            ))}
          </div>
        )}
      </section>
      <dl className="fd-vals" aria-label={t("Each measure")}>
        {(FD_ROWS[cur.test] ?? []).map(([code, unit]) => {
          const v = figure(tr, code);
          const u = unitLabel(unit);
          return (
            <div key={code} className={code === FD_KEY[cur.test] ? "key" : ""}>
              <dt>{nameOf(code, code)}</dt>
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
      <p className="fine">{t("Each test is compared by its best jump with the previous test's best jump.")}</p>
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
    <span className="fd-delta" role="img" aria-label={t("Compared with last time: {{d}}", { d: `${d > 0 ? "+" : "−"}${fixed(Math.abs(d), digits)} ${unit ?? ""}`.trim() })}>
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
    <figure className="fd-trend" aria-label={t("Trend over {{count}} measurements", { count: pts.length })}>
      <div className="fd-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={xy.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
        {xy.map((p, k) => (
          <span key={pts[k]!.at} className={`fd-dot${k === xy.length - 1 ? " now" : ""}`} style={{ left: `${p.x}%`, top: `${p.y}%` }} />
        ))}
      </div>
      <figcaption className="fine">
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
    <section className="seca-card" aria-label={title}>
      <header>
        <h4>{title}</h4>
        <span className="fine">{abbr}</span>
      </header>
      {main &&
        (v !== null ? (
          <p className="seca-v">
            <b>{fixed(v * (main.scale ?? 1), main.digits)}</b>
            {main.unit && <small> {main.unit}</small>}
            <SecaDelta ctx={ctx} code={main.code} digits={main.digits} scale={main.scale ?? 1} unit={main.unit} />
          </p>
        ) : (
          <p className="fine">{missing ?? t("No data")}</p>
        ))}
      {children}
      {subs.length > 0 && (
        <dl className="seca-sub">
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
    <div className="seca-scale" role="img" aria-label={t("Muscle mass z-score {{z}}", { z: fixed(z, 2) })}>
      <div className="seca-track">
        <span style={{ left: `${pos * 100}%` }} />
      </div>
      <div className="seca-ends fine">
        <span>{t("Less muscle")}</span>
        <span>{t("More muscle")}</span>
      </div>
    </div>
  );
}

function Segments({ ctx, codes }: { ctx: SecaCtx; codes: Record<Seg, string> }) {
  const s = ctx.scans[ctx.i];
  const label: Record<Seg, string> = { torso: t("Torso"), rightArm: t("Right arm"), leftArm: t("Left arm"), rightLeg: t("Right leg"), leftLeg: t("Left leg") };
  // the right limbs on the left, as when facing the person
  const order: Seg[] = ["rightArm", "leftArm", "torso", "rightLeg", "leftLeg"];
  return (
    <div className="seca-segs">
      {order.map((seg) => {
        const v = figure(s, codes[seg]);
        return (
          <div key={seg} className={`seca-limb seg-${seg}`}>
            <span className="fine">{label[seg]}</span>
            <b>
              {v === null ? "–" : fixed(v, 2)}
              {v !== null && <small> kg</small>}
            </b>
            <SecaDelta ctx={ctx} code={codes[seg]} digits={2} unit="kg" label={false} />
          </div>
        );
      })}
      <svg className="seca-fig" viewBox="0 0 120 200" aria-hidden="true">
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
    <div className="seca-water">
      <div className="seca-bar" role="img" aria-label={t("Extracellular water is {{p}} % of total body water", { p: fixed(share, 1) })}>
        <span className="ecw" style={{ width: `${share}%` }} />
        <span className="icw" style={{ width: `${100 - share}%` }} />
      </div>
      <div className="seca-ends fine">
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
    <svg className="seca-biva" viewBox={`-24 -8 ${S + 32} ${S + 30}`} role="img" aria-label={`Z(R/H) ${fixed(zr, 2)}, Z(Xc/H) ${fixed(zxc, 2)}`}>
      <rect x="0" y="0" width={S} height={S} className="bg" />
      {[-2, 2].map((z) => (
        <g key={z} className="grid">
          <line x1={g(z)} y1="0" x2={g(z)} y2={S} />
          <line x1="0" y1={S - g(z)} x2={S} y2={S - g(z)} />
        </g>
      ))}
      <line className="axis" x1={S / 2} y1="0" x2={S / 2} y2={S} />
      <line className="axis" x1="0" y1={S / 2} x2={S} y2={S / 2} />
      <circle cx={x} cy={y} r="5" className="pt" />
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
  if (!cls && !w && !m) return <p className="fine">{t("No data")}</p>;
  const levels = [t("Low"), t("Normal"), t("High"), t("Very high")];
  const row = (label: string, all: string[], v: string | null) => {
    const k = v === null ? -1 : all.indexOf(v);
    return (
      <div className="seca-bcc-row">
        <span className="fine">{label}</span>
        {k >= 0 ? (
          <ol className="seca-steps">
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
      {cls && <p className="seca-v">{bccLabel(cls)}</p>}
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
    <div className="seca-cards">
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
        {ree !== null && <p className="fine">{t("About {{mj}} MJ a day", { mj: fixed(ree * KCAL_TO_MJ, 2) })}</p>}
        {figure(s, C.tee) === null && <p className="fine">{t("No activity level (PAL), so total energy expenditure can't be calculated")}</p>}
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
      <div className="form">
        <h3>{t("No body composition data yet")}</h3>
        <p className="fine">{t("After a seca mBCA Pro measurement at the lab, the results show here.")}</p>
      </div>
    );
  return (
    <div className="fd">
      <header className="fd-head">
        <div>
          <h3>{t("Body composition")}</h3>
          <p className="fine">seca mBCA Pro · {when(cur.start_ms)}</p>
        </div>
        <button type="button" aria-expanded={hist} onClick={() => setHist(!hist)}>
          {t("History")}
        </button>
      </header>
      {hist && (
        <ul className="rows-card" aria-label={t("Measurement history")}>
          {scans.map((s, k) => (
            <li key={`${s.device}|${s.start_ms}`}>
              <button
                type="button"
                className="row-btn"
                aria-current={k === at ? "true" : undefined}
                onClick={() => {
                  setI(k);
                  setHist(false);
                }}
              >
                <span className="row-l">
                  <strong>{when(s.start_ms)}</strong>
                </span>
                {k === 0 && <span className="tag">{t("Latest")}</span>}
                {k === at && <span aria-hidden="true">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {at > 0 && (
        <p className="notice banner" role="status">
          <span>{t("Viewing the measurement of {{date}}", { date: when(cur.start_ms) })}</span>
          <button type="button" onClick={() => setI(0)}>
            {t("Back to the latest")}
          </button>
        </p>
      )}
      <SecaCards ctx={{ scans, i: at }} />
      <p className="fine">{t("For reference ranges and ratings, go by the report the lab gives you.")}</p>
    </div>
  );
}

/** On the home page's body card: the latest body composition measurement, its body fat and skeletal muscle. */
function SecaReportRow({ scan, open }: { scan: Measurement; open: () => void }) {
  const v = (code: string, unit: string, digits: number) => {
    const x = figure(scan, code);
    return x === null ? "–" : `${fixed(x, digits)} ${unit}`;
  };
  return (
    <ul className="rows-card report-row">
      <Row
        icon={<GroupIcon k="body" />}
        label={t("Body composition report")}
        sub={`seca mBCA Pro · ${shortDate(scan.start_ms)}`}
        value={`${t("Body fat")} ${v(C.fmp, "%", 1)} · ${t("Skeletal muscle")} ${v(C.smm, "kg", 1)}`}
        onClick={open}
      />
    </ul>
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
      <p className="clear-row">
        <button type="button" className="link danger" onClick={() => setOpen(true)}>
          {t("Clear data")}
        </button>
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
    <section className="record">
      <h2>{t("Clear data")}</h2>
      <form
        className="form"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <p className="warn">
          {t("This deletes all Health data on this device: every record, your health account and identity code, links to other devices, and settings. This can't be undone.")}
        </p>
        <p className="fine">
          {t("To keep your data, save a backup first. Data on your other devices isn't affected; to sync again, link them again.")}
        </p>
        <label>
          {t("Type “{{words}}” to confirm", { words: CLEAR_WORD })}
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={busy || done} />
        </label>
        <Problem text={err} />
        {done ? (
          <p className="notice" role="status">
            {t("Cleared. Reloading…")}
          </p>
        ) : (
          <div className="actions">
            <button type="button" disabled={busy} onClick={cancel}>
              {t("Cancel")}
            </button>
            <button type="submit" className="danger" disabled={!ok || busy}>
              {busy ? t("Clearing…") : t("Clear data")}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
