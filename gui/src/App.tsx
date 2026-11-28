import { Dialog, DialogButton, Page as KPage, Navbar, NavbarBackLink, Tabbar, TabbarLink, ToolbarPane } from "konsta/react";
import { onLink, takeLink } from "./deeplink";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { chooseImportFile, inBackground, initProfile, isAndroid, isDesktop, isMobile, menuOwnsKeys, onFileDrop, onMenu, onStatus, op, OpError, type Point, setBadge, setShellLanguage, type Status, unlock, unstageFile } from "./api";
import meadowDark from "./backdrop/meadow-dark.webp";
import meadowLight from "./backdrop/meadow-light.webp";
import { HOME_GROUPS } from "./format";
import { t, tk } from "./i18n";
import { rubberBand } from "./overscroll";
import { PageContext, type PageInfo } from "./page";
import { type Entry, back as goBack, go as nav, parts, scrollBack, useRoute, useStack } from "./router";
import { About, ClearDataRow } from "./screens/about";
import { HealthAccount, IdentityPage, useInbox, useSyncLive } from "./screens/account";
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
import { Btn, Chevron, errText, GroupIcon, Icon, LangSelect, MAC, MOD, type Page, Problem, TitleContext, type Titles, useAppearance, useOp, useTitles, useWide } from "./ui";

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
  { key: "id", label: tk("Identity code") },
  { key: "agents", label: tk("Agent access") },
  { key: "about", label: tk("About") },
];

/** The address of a section ("readings" is the dashboard's). */
const pathOf = (p: Page) => (p === "readings" ? "dashboard" : p);

/** What an address shows: a section and the view inside it; the dashboard with a measure's history or a lab report. */
function fromRoute([a, b, ...c]: string[]): { page: Page; want?: string; metric?: string; rest?: string[] } {
  if (a === "metric" && b) return { page: "readings", metric: b };
  if (a === "report") return { page: "readings", want: b };
  if (a && a !== "dashboard" && (PAGES.some((x) => x.key === a) || a === "add" || a === "review" || a === "more" || a === "account")) return { page: a as Page, want: b, rest: c };
  return { page: "readings" };
}

/** Where a screen's way back leads when nothing in history is behind it: a measure or a lab report to the
 *  dashboard, a screen inside a section to that section, a section to the tab it was opened from. */
function parentOf(route: string[], tab: string): string {
  if (route[0] === "metric" || route[0] === "report") return "dashboard";
  // other devices' pages (connecting, LAN sync, the history) have no page above them: the tab they came from
  if (route[0] === "account" && route.length === 2) return tab;
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
  // the page on top, the measure open on it: from the address (each page of the stack reads its own)
  const route = useRoute();
  const { page, metric } = fromRoute(route);
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
  // the pages open, one over another; the one on top is the address's. The page just closed stays a moment, to
  // leave the way it came (worked out while rendering, so it is never unmounted and mounted again in between)
  const stack = useStack();
  const [shown, setShown] = useState<{ stack: typeof stack; leaving: Entry[] }>({ stack, leaving: [] });
  if (shown.stack !== stack) {
    const gone = stack.move === "pop" ? shown.stack.entries.filter((e) => !stack.entries.some((x) => x.key === e.key)).slice(-1) : [];
    setShown({ stack, leaving: gone });
  }
  useEffect(() => {
    if (!shown.leaving.length) return;
    const t = setTimeout(() => setShown((s) => ({ ...s, leaving: [] })), LEAVE_MS);
    return () => clearTimeout(t);
  }, [shown]);
  const { dark } = useAppearance();
  // narrow screens: the tab a section was opened from, where its back button returns
  // opened at an address under no tab (#/data/lab): More, where those sections are; a measure or report: Dashboard
  const tab = useRef<Tab>(TABS.some((x) => x.key === page) ? (page as Tab) : metric || route[0] === "report" || !route.length ? "readings" : "more");
  useEffect(() => {
    if (TABS.some((x) => x.key === page)) tab.current = page as Tab;
  }, [page]);
  // the category scrolled into view on Readings (null: its top)
  const [inView, setInView] = useState<string | null>(null);
  // a file dropped or chosen from the menu, for the import screen it opened (#/data/file); gone once that screen is
  // (closed, not merely under another), so coming back to Data sources neither jumps to it nor reads it again
  const [dropped, setDropped] = useState<{ path: string; at: string }>();
  useEffect(() => {
    if (dropped && !stack.entries.some((e) => parts(e.path).join("/") === dropped.at)) {
      unstageFile(dropped.path);
      setDropped(undefined);
    }
  }, [stack]);
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
        </>,
        hint,
        page === p.key ? "page" : undefined,
      )}
    </li>
  );
  const railHead = "px-3 pb-1 text-[13px] font-semibold text-black/45 dark:text-white/45";
  // other devices: pages of their own with no section above them
  const deviceItem = (want: string, label: string, icon: string, asking = false) => {
    const on = page === "account" && (route[1] ?? "sync") === want;
    return (
      <li key={want}>
        {navButton(
          on,
          label,
          <Icon k={icon} />,
          () => setPage("account", want),
          asking ? <span className="inline-block h-2 w-2 rounded-full bg-brand-red align-middle" role="img" aria-label={t("Waiting for you")} /> : undefined,
          undefined,
          on ? "page" : undefined,
        )}
      </li>
    );
  };
  const hint = (k: Page) => {
    const i = PAGES.findIndex((x) => x.key === k);
    return `${t(PAGES[i]!.label)} (${MOD}${i + 1})`;
  };
  const dash = page === "readings";
  /** A page of the stack: its top bar and what its address shows. Each renders from its own address, so the pages
   *  under the top one keep showing what they showed. */
  const screen = (e: Entry, active: boolean, titles: Titles, title: string) => {
    const r = parts(e.path);
    const { page, want, metric, rest } = fromRoute(r);
    const here = r.join("/");
    const isTab = TABS.some((x) => x.key === page);
    return (
      <>
        <TopBar
          title={title}
          photo={page === "readings"}
          // the dashboard's scanner (a phone's: a computer has no camera to scan with)
          // the dashboard's: the identity code (as the web's 身份码 at its top right), and on a phone the scanner (a
          // computer has no camera to scan with)
          right={
            page === "readings" && !metric && r[0] !== "report" ? (
              <>
                {isMobile && <ScanButton />}
                <IdButton />
              </>
            ) : undefined
          }
          className={r.length > 1 ? "" : "wide:hidden"}
          back={r.length > 1 || !isTab ? () => goBack(parentOf(r, pathOf(tab.current))) : undefined}
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
              find={find && active}
              found={() => setFind(false)}
              onSection={active ? setInView : noSection}
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
          {page === "account" && <HealthAccount want={want} />}
          {page === "id" && <IdentityPage />}
          {page === "about" && <About version={status?.version} want={want} />}
          {page === "more" && (
            <More
              go={(p, w) => {
                setPage(p, w);
              }}
              status={status}
            />
          )}
        </div>
        </TitleContext.Provider>
      </>
    );
  };
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
                          document.querySelector(`[data-page="${stack.entries.at(-1)?.key}"] #g-${g.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
            {navItem(PAGES[4]!, hint("id"))}
          </ul>
        </div>
        <div>
          <p className={railHead}>{t("Other devices")}</p>
          <ul className="flex flex-col gap-0.5">
            {deviceItem("sync", t("Local network sync"), "wifi", syncAsking)}
            {deviceItem("connect", t("Connect another device"), "link")}
            {deviceItem("history", t("Connection history"), "list")}
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
      {/* the pages, one over another as a native navigation stack has them: those under the top one stay as they
          were left (scrolled, opened, typed into), out of sight and out of reach */}
      <main className="relative h-dvh min-w-0 overflow-hidden">
        {[...stack.entries, ...shown.leaving].map((e, i) => {
          const at = i < stack.entries.length ? (i === stack.entries.length - 1 ? "top" : "under") : "leaving";
          return (
            <StackPage key={e.key} entry={e} at={at} came={at === "top" && (stack.move === "push" || stack.move === "pop") ? stack.move : undefined} photo={fromRoute(parts(e.path)).page === "readings" ? (dark ? meadowDark : meadowLight) : undefined}>
              {(titles, title) => screen(e, at === "top", titles, title)}
            </StackPage>
          );
        })}
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

/** The dashboard's way to the identity code, at the top bar's end (the web's 身份码 button). */
function IdButton() {
  return (
    <button
      type="button"
      aria-label={t("Identity code")}
      onClick={() => nav("id")}
      className="grid h-11 shrink-0 select-none place-items-center px-2 text-primary transition-opacity active:opacity-60"
    >
      <Icon k="id" className="h-6 w-6" />
    </button>
  );
}

/** A page under another's notice of the category in view: none (the rail marks the top page's) */
const noSection = () => {};

/** How long a page takes to come or go (narrow screens; none with reduced motion) */
const LEAVE_MS = 400;

/** Where a page of the stack is: on top, under it, or leaving (closed, on its way out). How each comes and goes,
 *  as each platform has it: iOS pushes from the right edge, the page under moving a third of the way left; Material
 *  fades in rising a little. Only on a narrow screen: a wide window's pages swap in place. The wrapper moves, not the
 *  scroller (a moved scroller leaves stale tiles in Android's web view). */
const PLACE = {
  top: "translate-x-0 translate-y-0 opacity-100",
  under: "invisible ios:max-wide:-translate-x-1/3",
  leaving: "pointer-events-none wide:hidden ios:translate-x-full material:translate-y-[8%] material:opacity-0",
} as const;
const CAME = {
  push: "ios:starting:translate-x-full material:starting:translate-y-[8%] material:starting:opacity-0",
  pop: "ios:max-wide:starting:-translate-x-1/3",
} as const;

/** One page of the stack: Konsta's Page (its own scroller, the top bar following its scrolling), its own name for
 *  the top bar, its layers. Under the top one it stays mounted as it was left, but hidden and out of reach (not
 *  `display: none`, which would lose where it was scrolled to). Its background is its own on a narrow screen, so
 *  pages passing over each other don't show through; a wide window's is the shell's, behind the side panel too. */
function StackPage({ entry, at, came, photo, children }: { entry: Entry; at: keyof typeof PLACE; came?: keyof typeof CAME; photo?: string; children: (titles: Titles, title: string) => ReactNode }) {
  const active = at === "top";
  const [title, titles] = useTitles();
  const scroller = useRef<HTMLDivElement | null>(null);
  const layers = useRef<HTMLDivElement | null>(null);
  const info: PageInfo = useMemo(() => ({ active, scroller: () => scroller.current, layers: () => layers.current }), [active]);
  // Android: the page's own rubber band (overscroll.ts); iOS bounces scrolling content natively
  useEffect(() => (isAndroid && scroller.current ? rubberBand(scroller.current) : undefined), []);
  // made anew from history (past the pages kept, after a reload): back where it was scrolled to
  useLayoutEffect(() => (entry.scroll && scroller.current ? scrollBack(scroller.current, entry.scroll) : undefined), []);
  // the control that opened the page over this one has the focus again when this one is back on top
  const focused = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      const f = document.activeElement;
      if (f instanceof HTMLElement && scroller.current?.contains(f)) focused.current = f;
    } else if (focused.current?.isConnected) {
      focused.current.focus({ preventScroll: true });
      focused.current = null;
    }
  }, [active]);
  return (
    <div
      data-page={entry.key}
      inert={!active}
      className={`absolute inset-0 max-wide:bg-cover max-wide:bg-center max-wide:transition-[translate,opacity,visibility] max-wide:duration-[400ms] max-wide:ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none ios:max-wide:bg-[#f2f2f7] ios:max-wide:dark:bg-black material:max-wide:bg-md-light-surface-2 material:max-wide:dark:bg-md-dark-surface ${PLACE[at]} ${came ? CAME[came] : ""} ${photo ? "max-wide:bg-(image:--photo) max-wide:bg-[length:100%_100%]" : ""}`}
      style={photo ? ({ "--photo": `url(${photo})` } as React.CSSProperties) : undefined}
    >
      <KPage
        ref={scroller}
        // the background is the shell's (the dashboard's photo, else the grouped colour)
        colors={{ bgIos: "", bgMaterial: "" }}
        className={`px-4 pb-[calc(var(--k-safe-area-bottom)+108px)] wide:px-9 wide:pt-6 wide:pb-16 ${MAC && isDesktop ? "wide:pt-[4.4rem]" : ""}`}
        data-photo={photo || undefined}
      >
        <PageContext.Provider value={info}>{children(titles, title)}</PageContext.Provider>
      </KPage>
      <div ref={layers} />
    </div>
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
  // narrow: the page's name is the bar's large title, Konsta's (its size and spacing as each platform has them),
  // shrinking into the bar as the page scrolls; a wide window's pages show their own heading
  const wide = useWide();
  return (
    <Navbar
      large={!wide}
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
