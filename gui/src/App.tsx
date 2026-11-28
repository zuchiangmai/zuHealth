import { Dialog, DialogButton, Navbar, NavbarBackLink, Tabbar, TabbarLink, ToolbarPane } from "konsta/react";
import { onLink, takeLink } from "./deeplink";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { chooseImportFile, inBackground, initProfile, isAndroid, isDesktop, isMobile, menuOwnsKeys, onFileDrop, onMenu, onStatus, op, OpError, type Point, setBadge, setShellLanguage, type Status, unlock, unstageFile } from "./api";
import meadowDark from "./backdrop/meadow-dark.webp";
import meadowLight from "./backdrop/meadow-light.webp";
import { HOME_GROUPS } from "./format";
import { t, tk } from "./i18n";
import { rubberBand } from "./overscroll";
import { back as goBack, go as nav, parts, useRoute, useScrollPlace } from "./router";
import { About, ClearDataRow } from "./screens/about";
import { HealthAccount, useInbox, useSyncLive } from "./screens/account";
import { AddPage } from "./screens/add";
import { Agents } from "./screens/agents";
import { Backup } from "./screens/backup";
import { Readings } from "./screens/dashboard";
import { DataSources } from "./screens/data";
import { dropInto } from "./screens/import";
import { Record } from "./screens/metric";
import { More } from "./screens/more";
import { ProfilePage } from "./screens/profile";
import { Review } from "./screens/review";
import { ScanButton } from "./screens/scan";
import { useSystemHealthSync } from "./screens/syshealth";
import { Btn, Chevron, errText, GroupIcon, Icon, LangSelect, MAC, MOD, type Page, Problem, TitleContext, useAppearance, useOp, useTitles } from "./ui";

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
    ? t("Your health data is stored encrypted on this device and is decrypted here each time you open PhysiMind. Just a moment.")
    : t("Your health data is stored encrypted on this computer and is decrypted here each time you open PhysiMind. Just a moment.");

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
      title={t("Getting PhysiMind ready")}
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
        <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("PhysiMind is locked")}</h2>
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
    const t = setInterval(() => inBackground(reload), 1000);
    return () => clearInterval(t);
  }, [starting, reload]);
  // a phone has no passphrase: its data opens as Health opens (Face ID / fingerprint will come first, in the shell)
  const locked = !!err?.startsWith("locked:");
  const [unlockErr, setUnlockErr] = useState<string>();
  const unlocking = useRef(false);
  const autoUnlock = useCallback((tries = 3) => {
    // never while Health is out of sight: the lock in the background is the point
    if (unlocking.current || document.hidden) return; // StrictMode's second run
    unlocking.current = true;
    setUnlockErr(undefined);
    unlock("")
      .then(reload, (e) => {
        // back from the background: the shell may tell the core a moment after the page shows
        if (e instanceof OpError && e.code === "locked" && tries > 1) setTimeout(() => autoUnlock(tries - 1), 700);
        else setUnlockErr(errText(e));
      })
      .finally(() => (unlocking.current = false));
  }, [reload]);
  useEffect(() => {
    if (!locked || !isMobile) return;
    autoUnlock();
    const shown = () => autoUnlock();
    document.addEventListener("visibilitychange", shown);
    return () => document.removeEventListener("visibilitychange", shown);
  }, [locked, autoUnlock]);
  // the dashboard's background, fetched while the data opens
  useEffect(() => void Object.assign(new Image(), { src: matchMedia("(prefers-color-scheme: dark)").matches ? meadowDark : meadowLight }), []);
  if (locked && !isMobile) return <Unlock done={reload} />;
  if (core.need_init || err?.includes("no_profile")) return <FirstRun done={reload} />;
  if (starting || locked || (!status && !err))
    return (
      <>
        <Hold title={t("Decrypting your data")} body={decrypting()} err={core.error ?? unlockErr} retry={unlockErr ? () => autoUnlock() : undefined} />
        {/* a database that no longer opens: starting over is one way out */}
        {core.error && isDesktop && (
          <div className="mx-auto mt-[16vh] max-w-md px-4">
            <ClearDataRow />
          </div>
        )}
      </>
    );
  return <Shell status={status} />;
}

/** The app, once its data is open. `status` is the gate's, kept fresh there: one request, not one each. */
function Shell({ status }: { status?: Status }) {
  // redraw everything when the language changes; the menu bar follows
  const { i18n } = useTranslation();
  useEffect(() => setShellLanguage(i18n.language), [i18n.language]);
  // the screen's name for the top bar, from its heading
  const [title, titles] = useTitles();
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
  // a lab device's address opened from the camera or a link: its page, now that the data is open
  const [strangeLink, setStrangeLink] = useState(false);
  useEffect(() => {
    const open = () => {
      const l = takeLink();
      if (l && "path" in l) nav(l.path);
      else if (l) setStrangeLink(true);
    };
    open();
    return onLink(open);
  }, []);
  useEffect(() => {
    try {
      if (PAGES.some((x) => x.key === page)) localStorage.setItem("page", page);
    } catch {}
  }, [page]);
  const setMetric = (code: string) => nav(`metric/${encodeURIComponent(code)}`, !!metric);
  useInbox();
  // the phone's health store, when connected on this device
  useSystemHealthSync();
  const syncLive = useSyncLive();
  const [latest, latestErr] = useOp(() => op<Point[]>("obs.latest"), []);
  const [cats, setCats] = useState(true);
  // a screen opens at its top; one gone back to comes back where it was left
  useScrollPlace(route.join("/"));
  // Android: the content's own rubber band (overscroll.ts); iOS bounces scrolling content natively
  const band = useRef<(() => void) | undefined>(undefined);
  const { dark } = useAppearance();
  const mainEl = useCallback((el: HTMLElement | null) => {
    band.current?.();
    band.current = el && isAndroid ? rubberBand(el) : undefined;
  }, []);
  // narrow screens: the tab a section was opened from, where its back button returns
  // opened at an address under no tab (#/data/lab): More, where those sections are; a measure or report: Dashboard
  const tab = useRef<Tab>(TABS.some((x) => x.key === page) ? (page as Tab) : metric || route[0] === "report" || !route.length ? "readings" : "more");
  useEffect(() => {
    if (TABS.some((x) => x.key === page)) tab.current = page as Tab;
  }, [page]);
  // the category scrolled into view on Readings (null: its top)
  const [inView, setInView] = useState<string | null>(null);
  // a file dropped or chosen from the menu, for the import screen it opened (#/data/file); any other address drops it,
  // so coming back to Data sources neither jumps to it nor reads it again
  const here = route.join("/");
  const [dropped, setDropped] = useState<{ path: string; at: string }>();
  useEffect(() => {
    if (dropped && dropped.at !== here) {
      unstageFile(dropped.path);
      setDropped(undefined);
    }
  }, [here]);
  const importFile = (path: string) => {
    setDropped({ path, at: "data/file" });
    nav("data/file");
  };
  const [hovering, setHovering] = useState(false);
  // a file dropped anywhere on the window opens Import with it
  useEffect(
    () =>
      onFileDrop({
        over: setHovering,
        drop: (paths) => {
          if (!paths[0]) return;
          if (dropInto) return dropInto(paths[0]);
          importFile(paths[0]);
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
        if (f) importFile(f);
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
          <p className="text-[13px] text-black/55 dark:text-white/55">{t("Apple Health export, PhysiMind backup, WHOOP data")}</p>
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
          title={title}
          photo={dash}
          // the dashboard's scanner (a phone's: a computer has no camera to scan with)
          right={isMobile && page === "readings" && !metric && route[0] !== "report" ? <ScanButton /> : undefined}
          className={route.length > 1 ? "" : "wide:hidden"}
          back={route.length > 1 || !isTab ? () => goBack(parentOf(route, pathOf(tab.current))) : undefined}
        />
        <TitleContext.Provider value={titles}>
        <div key={`${page}-${i18n.language}`}>
          {metric && <Record key={metric} code={metric} pick={setMetric} />}
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
          {page === "data" && <DataSources file={dropped?.at === here ? dropped.path : undefined} onFile={(p) => setDropped(p ? { path: p, at: here } : undefined)} go={(p) => setPage(p)} done={open} want={want} path={rest} />}
          {page === "review" && <Review />}
          {page === "agents" && <Agents want={want} path={rest} />}
          {page === "backup" && <Backup want={want} go={(p) => setPage(p)} />}
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
        </TitleContext.Provider>
      </main>
      <Dialog
        opened={strangeLink}
        onBackdropClick={() => setStrangeLink(false)}
        title={t("Can't open this link")}
        content={t("PhysiMind opens the codes on lab devices. This address isn't one.")}
        buttons={<DialogButton onClick={() => setStrangeLink(false)}>{t("OK")}</DialogButton>}
      />
      {/* iOS 26's tab bar sits 13 pt into the home indicator's area (21 pt from the edge on a Face ID iPhone; Files,
          2026-11-27), not 16 pt above it as Konsta's default (pb-safe-4); Material's already sits on the edge */}
      <Tabbar labels icons className="fixed! bottom-0 left-0 wide:hidden ios:pb-[max(8px,calc(var(--k-safe-area-bottom)-13px))]!">
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

// iOS over the dashboard's photo: the blur alone, fading out from the bar's middle (Konsta's own is a band of the
// page's colour, which on the photo reads as a pale wash). Material's bar is clear at rest and takes its surface once
// scrolled, as Material has it.
const PHOTO_BAR_IOS = "backdrop-blur-xl mask-b-from-40% mask-b-to-100%";

/** The top bar, Konsta's as each platform has it: over the screen's large heading only the way back; scrolled, the
 *  content under it blurs and fades (iOS) or the bar takes its surface (Material), and the screen's name shows in it.
 *  The name is the screen's own heading (the first `Heading` on it), so no screen has to say it twice. */
function TopBar({ title, back, right, photo, className = "" }: { title: string; back?: () => void; right?: ReactNode; photo?: boolean; className?: string }) {
  const { theme } = useAppearance();
  return (
    <Navbar
      transparent
      colors={photo ? { bgIos: PHOTO_BAR_IOS } : undefined}
      title={title}
      className={`-mx-4 w-[calc(100%+2rem)]! wide:-mx-9 wide:-mt-6 wide:w-[calc(100%+4.5rem)]! ${className}`}
      innerClassName="wide:mx-auto wide:max-w-3xl wide:px-0!"
      left={back && <NavbarBackLink text={t("Back")} showText={theme === "ios"} onClick={back} />}
      right={right}
    />
  );
}
