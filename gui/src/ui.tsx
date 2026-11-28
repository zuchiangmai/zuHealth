// The UI's building blocks on Konsta UI (owner, 2026-11-27: Konsta only, no custom CSS for now): the look chosen,
// buttons, grouped lists and cards, so every screen draws them the same way.
import { Button, Navbar, NavbarBackLink, Page as KPage, Popup, Toggle } from "konsta/react";
import { type ComponentProps, createContext, type ReactNode, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { type Day, type FdSession, inBackground, inBackgroundNow, isAndroid, type Measurement, type Metric, onChange, op, openLink, OpError, type Point, type Source } from "./api";
import { type Pt } from "./charts";
import { dayValue, explain, sourceKind, unitLabel } from "./format";
import { choice, choose, LANGS, locale as i18nLocale, t } from "./i18n";
import { codesNamed, nameOf } from "./names";
import { useLayer } from "./router";
import { useBackOnTop, usePage } from "./page";

const darkQuery = typeof matchMedia !== "undefined" ? matchMedia("(prefers-color-scheme: dark)") : null;
/** The system's dark mode, followed live. */
function useDark(): boolean {
  const [dark, setDark] = useState(!!darkQuery?.matches);
  useEffect(() => {
    if (!darkQuery) return;
    const on = () => setDark(darkQuery.matches);
    darkQuery.addEventListener("change", on);
    return () => darkQuery.removeEventListener("change", on);
  }, []);
  return dark;
}

/** How the app looks (More › Appearance): the platform's own look and the system's dark mode, or one chosen to
 *  review the other on the same device. Remembered on this device (a convenience: may be unavailable). */
export type Look = "auto" | "ios-light" | "ios-dark" | "material-light" | "material-dark";
const LOOKS: Look[] = ["auto", "ios-light", "ios-dark", "material-light", "material-dark"];
let look: Look = (() => {
  try {
    const v = localStorage.getItem("look") as Look | null;
    return v && LOOKS.includes(v) ? v : "auto";
  } catch {
    return "auto";
  }
})();
const lookSubs = new Set<() => void>();
export function setLook(v: Look) {
  look = v;
  try {
    localStorage.setItem("look", v);
  } catch {}
  for (const f of lookSubs) f();
}
export const useLook = () =>
  useSyncExternalStore(
    (f) => (lookSubs.add(f), () => lookSubs.delete(f)),
    () => look,
  );
/** The theme and dark mode in use: the chosen ones, or the platform's and the system's. */
export function useAppearance(): { theme: "ios" | "material"; dark: boolean } {
  const l = useLook();
  const system = useDark();
  if (l === "auto") return { theme: isAndroid ? "material" : "ios", dark: system };
  return { theme: l.startsWith("ios") ? "ios" : "material", dark: l.endsWith("dark") };
}

const wideQuery = typeof matchMedia !== "undefined" ? matchMedia("(min-width: 761px)") : null;
/** A wide window (the side panel, not the tab bar): the same 761 px as the `wide:` classes. */
export function useWide(): boolean {
  const [wide, setWide] = useState(!!wideQuery?.matches);
  useEffect(() => {
    if (!wideQuery) return;
    const on = () => setWide(wideQuery.matches);
    wideQuery.addEventListener("change", on);
    return () => wideQuery.removeEventListener("change", on);
  }, []);
  return wide;
}


/** Tailwind classes by role (the names the screens used before). */

type BtnProps = Omit<ComponentProps<"button">, "ref"> & {
  /** the page's main action: filled */
  primary?: boolean;
  /** deletes or discards: red */
  danger?: boolean;
  /** text only, inline (a link in a sentence or a row) */
  link?: boolean;
  /** pressed: a choice among several (segmented look) */
  on?: boolean;
  /** smaller, for choices inside a list */
  small?: boolean;
};

/** A button as Konsta draws it: full width on a phone (a thumb's target), its own width on a wide screen. */
export function Btn({ primary, danger, link, on, small, className = "", children, ...rest }: BtnProps) {
  const red = danger ? "k-color-brand-red" : "";
  if (link)
    return (
      <Button clear inline small className={`${red} w-auto whitespace-nowrap ${className}`} {...rest}>
        {children}
      </Button>
    );
  if (small || on !== undefined)
    return (
      <Button inline small rounded tonal={!on} className={`${red} w-auto px-3 whitespace-nowrap ${className}`} {...rest}>
        {children}
      </Button>
    );
  return (
    <Button large rounded tonal={!primary} className={`${red} sm:w-auto sm:px-6 ${className}`} {...rest}>
      {children}
    </Button>
  );
}



// ---- Material 3 Expressive / iOS grouped lists (class names are written out whole: Tailwind finds them in the source) (owner, 2026-11-27: the system Settings' look) ----

/** The groups' rows and cards: each theme's own surface. */
export const rowBg = "ios:bg-white ios:dark:bg-[#1c1c1e] material:bg-md-light-surface material:dark:bg-md-dark-surface-2";

/** A group of rows: one rounded card with hairlines on iOS, separate rounded tiles 2 px apart on Material. */
export function Group({ title, after, children, className = "", ...rest }: { title?: ReactNode; after?: ReactNode; children: ReactNode; className?: string } & Omit<ComponentProps<"div">, "title">) {
  return (
    <div className={`mb-5 ${className}`}>
      {(title || after) && (
        <div className="mb-1.5 flex items-center justify-between gap-3 px-4 text-[14px] font-medium ios:text-black/55 ios:dark:text-white/55 material:text-primary">
          <span className="flex min-w-0 items-center gap-2">{title}</span>
          {after}
        </div>
      )}
      <div
        className={`flex flex-col overflow-hidden ios:rounded-[26px] ios:divide-y ios:divide-black/10 ios:dark:divide-white/10 material:gap-0.5 material:rounded-3xl ios:[&>*]:bg-white ios:dark:[&>*]:bg-[#1c1c1e] material:[&>*]:bg-md-light-surface material:dark:[&>*]:bg-md-dark-surface-2`}
        {...rest}
      >
        {children}
      </div>
    </div>
  );
}

/** A coloured circle behind an icon, as Settings draws its rows' symbols. */
export const IconDot = ({ color = "#0a7397", children, className = "" }: { color?: string; children: ReactNode; className?: string }) => (
  <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${className}`} style={{ background: `${color}26`, color }}>
    {children}
  </span>
);

/** One row: its symbol, a title and a line under it (its state, in words), something at the end; a tap opens it. */
export function Item({
  icon,
  color,
  title,
  text,
  after,
  onClick,
  chevron = true,
  className = "",
  ...rest
}: {
  icon?: ReactNode;
  color?: string;
  title: ReactNode;
  text?: ReactNode;
  after?: ReactNode;
  onClick?: () => void;
  /** iOS's mark of a row that opens something (not on a row that switches something) */
  chevron?: boolean;
  className?: string;
} & Omit<ComponentProps<"button">, "title" | "onClick">) {
  const body = (
    <>
      {icon && <IconDot color={color}>{icon}</IconDot>}
      <span className="min-w-0 flex-1">
        <span className="block text-[17px] leading-snug material:text-[16px]">{title}</span>
        {text && <span className="mt-0.5 block text-[14px] leading-snug text-black/55 dark:text-white/55">{text}</span>}
      </span>
      {after !== undefined && <span className="shrink-0 text-end text-[15px] text-black/55 dark:text-white/55">{after}</span>}
      {onClick && chevron && <RowChevron />}
    </>
  );
  const cls = `flex w-full min-h-[64px] items-center gap-4 px-4 py-3 text-start ${className}`;
  if (!onClick) return <div className={cls}>{body}</div>;
  return (
    <button type="button" className={`select-none ${cls} transition-colors active:bg-black/5 dark:active:bg-white/10`} onClick={onClick} {...rest}>
      {body}
    </button>
  );
}

/** iOS marks a row that opens something; Material doesn't. */
const RowChevron = () => (
  <svg className="h-4 w-4 shrink-0 text-black/30 material:hidden dark:text-white/30" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3.5 10.5 8 6 12.5" />
  </svg>
);

/** Settings' search: a pill across the page. */
export const SearchPill = ({ className = "", ...rest }: ComponentProps<"input">) => (
  <label className={`flex h-14 w-full items-center gap-3 rounded-full px-5 ${rowBg} ios:h-11 ios:rounded-xl ios:bg-black/5 ios:px-3 ios:dark:bg-white/10 material:border material:border-black/30 material:dark:border-white/30 ${className}`}>
    <svg className="h-5 w-5 shrink-0 text-black/55 dark:text-white/55" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
    <input type="search" className="min-w-0 flex-1 bg-transparent text-[17px] outline-none placeholder:text-black/45 dark:placeholder:text-white/45" {...rest} />
  </label>
);

/** Something waiting for the person: a tinted card that opens it. */
export const Callout = ({ icon, title, text, onClick }: { icon: ReactNode; title: ReactNode; text?: ReactNode; onClick: () => void }) => (
  <button
    type="button"
    className="select-none mb-5 flex w-full items-center gap-4 rounded-3xl bg-amber-400/20 px-4 py-3.5 text-start transition-colors active:bg-amber-400/30"
    onClick={onClick}
  >
    <IconDot color="#b45309">{icon}</IconDot>
    <span className="min-w-0 flex-1">
      <span className="block text-[16px] font-semibold">{title}</span>
      {text && <span className="block text-[14px] text-black/60 dark:text-white/60">{text}</span>}
    </span>
    <svg className="h-4 w-4 shrink-0 opacity-50" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  </button>
);

/** A card (a form, a code to show, a step): each theme's surface, rounded as its groups. */
export const card = `mb-4 rounded-3xl p-4 ${rowBg}`;

export type Page = "readings" | "add" | "data" | "backup" | "profile" | "id" | "account" | "agents" | "about" | "review" | "more";

export const MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

export const MOD = MAC ? "⌘" : "Ctrl+";

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
  scan: <path d="M2 5.5v-2A1.5 1.5 0 0 1 3.5 2h2M10.5 2h2A1.5 1.5 0 0 1 14 3.5v2M14 10.5v2a1.5 1.5 0 0 1-1.5 1.5h-2M5.5 14h-2A1.5 1.5 0 0 1 2 12.5v-2M4.5 8h7" />,
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

export const Icon = ({ k, className = "h-5 w-5" }: { k: string; className?: string }) => (
  <svg className={`shrink-0 ${className}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICON[k]}
  </svg>
);

/** Loads `fn` now and after every committed write; returns [data, error, reload]. */
export function useOp<T>(fn: () => Promise<T>, deps: unknown[]): [T | undefined, string | undefined, () => void] {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState<string>();
  const [tick, setTick] = useState(0);
  // a reload from a poll or an event (inside inBackground) fetches as the app's own call too
  const quietNext = useRef(false);
  const reload = useCallback(() => {
    quietNext.current = inBackgroundNow();
    setTick((t) => t + 1);
  }, []);
  // biome-ignore lint: deps are the caller's
  useEffect(() => {
    let live = true;
    const quiet = quietNext.current;
    quietNext.current = false;
    (quiet ? inBackground(fn) : fn()).then(
      (d) => live && (setData(d), setErr(undefined)),
      (e: unknown) => live && setErr(e instanceof OpError ? `${e.code}: ${e.message}` : String(e)),
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  useEffect(() => onChange(reload), [reload]);
  // a page back on top asks again: what it shows may have changed meanwhile without an event (an account made)
  useBackOnTop(reload);
  return [data, err, reload];
}

/** One choice among a few: a touch screen gets a page of them with a tick (as Settings' lists), a mouse the menu. */
export function Choice<K extends string>({
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
          <Heading space="mb-4">{label}</Heading>
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
export function LangSelect({ small }: { small?: boolean }) {
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

export const Chevron = ({ open }: { open: boolean }) => (
  <svg
    className={`h-3 w-3 shrink-0 fill-none stroke-current transition-transform [stroke-width:1.8] ${open ? "rotate-90" : ""}`}
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <path d="M6 4l4 4-4 4" />
  </svg>
);

/** A link to a web page, opened in the default browser (never inside the app window). */
export function WebLink({ url, label }: { url: string; label?: string }) {
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

/** Where a screen's heading tells the top bar its name: the headings on the page, in the order they appeared (the
 *  first is the name). Null inside a sheet, whose headings aren't the page's. */
export type Titles = { set: (key: object, text: string | null) => void; isTitle: (key: object) => boolean };
export const TitleContext = createContext<Titles | null>(null);

/** The page's titles, for the shell: the first heading's text, and the context its headings report to. */
export function useTitles(): [string, Titles] {
  const [title, setTitle] = useState("");
  const titles = useMemo(() => {
    const all = new Map<object, string>();
    return {
      set: (key: object, text: string | null) => {
        if (text === null) all.delete(key);
        else all.set(key, text);
        setTitle(all.values().next().value ?? "");
      },
      isTitle: (key: object) => all.keys().next().value === key,
    };
  }, []);
  return [title, titles];
}

/** A screen's large heading (`space`: the margin under it). Its text is the screen's name in the top bar. On a
 *  narrow screen the page's name is the top bar's large title (Konsta's, as iOS and Material have it), so the
 *  heading naming the page is there for screen readers only; a wide window shows it. */
export function Heading({ space = "mb-1", children }: { space?: string; children: ReactNode }) {
  const titles = useContext(TitleContext);
  const el = useRef<HTMLHeadingElement>(null);
  const key = useRef({}).current;
  useLayoutEffect(() => titles?.set(key, el.current?.textContent ?? ""));
  useLayoutEffect(() => () => titles?.set(key, null), [titles, key]);
  return (
    <h2 ref={el} className={`${space} text-[28px] leading-tight font-bold tracking-tight ${titles?.isTitle(key) ? "max-wide:sr-only" : ""}`}>
      {children}
    </h2>
  );
}

/** A screen's heading, and the screen under it. */
export function Screen({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-3xl">
      <Heading space="mb-4">{title}</Heading>
      {children}
    </section>
  );
}

/** A layer over the screen with no address of its own (a choice, a confirmation): the whole screen on a phone, a
 *  large window on a wide one, with the same way back at the top. Escape, the backdrop and the system's back
 *  (Android) close it too. */
export function Sheet({ label, close: done, children }: { label: string; close: () => void; children: ReactNode }) {
  // a history step only while its page is on top (a hidden page's sheet takes none)
  const close = useLayer(done, usePage().active);
  // slides in once it's on the page
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setOpened(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const closing = useRef(close);
  closing.current = close;
  // its page's: hidden with it while another page is on top, and deaf to Escape meanwhile
  const page = usePage();
  useEffect(() => {
    if (!page.active) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && closing.current();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [page.active]);
  const wide = useWide();
  const { theme } = useAppearance();
  const body = (
    <KPage>
      <Navbar transparent title={label} left={<NavbarBackLink text={t("Back")} showText={theme === "ios"} onClick={close} />} />
      <div className="px-4 pt-2 pb-[calc(var(--k-safe-area-bottom)+32px)] md:px-6">
        <TitleContext.Provider value={null}>{children}</TitleContext.Provider>
      </div>
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
    // with its page (inside Konsta's App, as its sheets are meant to be: its look and safe areas apply)
    page.layers() ?? document.querySelector(".k-app") ?? document.body,
  );
}

/** "code: message" from the core, in words a person can act on. */
function human(text: string): string {
  const m = /^([a-z_]+): ?(.*)$/s.exec(text);
  return m ? explain(m[1]!, m[2]) : text;
}

/** What went wrong, in words: the core's errors, and the shell's (Tauri rejects with a plain `{ code, message }`
 *  object, or a string) */
export const errText = (e: unknown): string => {
  if (e instanceof OpError) return explain(e.code, e.message);
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (typeof message === "string" || typeof code === "string") return explain(String(code ?? "error"), typeof message === "string" ? message : "");
  }
  return String(e);
};

export function Problem({ text }: { text?: string }) {
  return text ? (
    <p className="text-[15px] text-brand-red" role="alert">
      {human(text)}
    </p>
  ) : null;
}

/** A screen that couldn't load what it shows: why, and a second try. */
export function Failed({ text, retry }: { text: string; retry: () => void }) {
  return (
    <section className="mx-auto w-full max-w-3xl">
      <Problem text={text} />
      <Btn type="button" primary className="mt-3" onClick={retry}>
        {t("Try again")}
      </Btn>
    </section>
  );
}

export function Copy({ text, label }: { text: string; label: string }) {
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

export function PasswordField({ label, value, onChange, auto }: { label: string; value: string; onChange: (v: string) => void; auto: string }) {
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

/** A grouped row with a switch on the right (System Settings); the whole row toggles it. */
export function SwitchRow({ icon, label, sub, on, set }: { icon?: ReactNode; label: string; sub?: string; on: boolean; set: (on: boolean) => void }) {
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
export function Row({ icon, color, label, sub, value, onClick }: { icon: ReactNode; color?: string; label: string; sub?: string; value?: ReactNode; onClick: () => void }) {
  return <Item icon={icon} color={color} title={label} text={sub} after={value} onClick={onClick} />;
}

export const DAY = 86_400_000;

export const toPts = (agg: string, days: Day[]): Pt[] =>
  days.flatMap((d) => {
    const v = dayValue(agg, d);
    return v === null ? [] : [{ day: d.day, v, lo: agg === "instant" ? d.min : null, hi: agg === "instant" ? d.max : null }];
  });

/** Generic device names ("OCR", "photo") read better as their kind. */
export function sourceLabel(src?: Source): string {
  if (!src) return t("Source");
  if (src.connector === "manual") return t("Entered by you");
  const generic = ["ocr", "photo", src.connector].includes(src.name.toLowerCase());
  return generic ? sourceKind(src.connector) : src.name;
}

/** Out-of-range mark from a lab sheet (H/L printed next to the value). */
export function Flag({ p }: { p: Point }) {
  const f = (p.detail?.flag ?? (p.detail?.printed as { flag?: string } | undefined)?.flag) as string | undefined;
  if (p.corrected || (f !== "H" && f !== "L")) return null;
  return (
    <span className="ms-1 text-xs font-semibold text-amber-600" title={f === "H" ? t("Above the reference range") : t("Below the reference range")}>
      {f === "H" ? t("↑ high") : t("↓ low")}
    </span>
  );
}

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
export const TINT: Record<string, string> = {
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

export const GroupIcon = ({ k }: { k: string }) => (
  <svg className="h-5 w-5 shrink-0" style={{ color: TINT[k] ?? TINT.other }} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {GROUP_ICON[k] ?? <rect x="3" y="3" width="10" height="10" rx="2.5" />}
  </svg>
);

/** Finds a measure by the name shown (any language on screen), the catalog's English, its code or a name printed on
 *  a report. `manual`: only measures entered as one number. */
export function MetricPicker({ onPick, placeholder, manual }: { onPick: (m: Metric) => void; placeholder: string; manual?: boolean }) {
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

/** A typed number: "10,000" and "10 000" are ten thousand; "36,6" and "0,125" use a decimal comma; anything
 *  else that isn't a plain number is NaN. The form shows how it was read before saving (see `Enter`). */
export function parseNumber(s: string): number {
  const t = s.replace(/[\s\u00a0']/g, "");
  if (/^-?0\d*,\d+$/.test(t)) return Number(t.replace(",", ".")); // a leading 0 is never a thousands group
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replaceAll(",", ""));
  if (/^-?\d+,\d+$/.test(t)) return Number(t.replace(",", "."));
  return /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : Number.NaN;
}

export const writeText = (w: "none" | "propose" | "derived") =>
  ({ none: t("read only"), propose: t("read and write"), derived: t("full read and write") })[w];

export type WhoopStatus = { state: "none" | "pending" | "reauth" } | { state: "connected"; last_sync: number | null };

export type Personal = { sex?: "Male" | "Female"; age?: number; birth?: string };

export const sexLabel = (s?: string) => (s === "Male" ? t("Male") : s === "Female" ? t("Female") : undefined);

export const birthLabel = (b: string) =>
  new Intl.DateTimeFormat(i18nLocale(), { year: "numeric", month: "long", timeZone: "UTC" }).format(Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, 1));

export type SyncShown = {
  enabled: boolean;
  joined: boolean;
  paused: boolean;
  account: boolean;
  device: string;
  peers: { device: string; name: string; last_seen: number; last_synced?: number; up_to_date: boolean; skipped: number }[];
};

export const fdStart = (s: FdSession) => s.trials[0]!.start_ms;

export const fdBest = (s: FdSession) => s.trials[s.best]!;

export const figure = (m: Measurement | undefined, code: string): number | null => {
  const v = m?.values[code];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

export const C = {
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

export const fixed = (v: number, digits: number) => v.toLocaleString(i18nLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
