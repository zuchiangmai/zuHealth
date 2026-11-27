// The UI's building blocks on Konsta UI (owner, 2026-11-27: Konsta only, no custom CSS for now): the look chosen,
// buttons, grouped lists and cards, so every screen draws them the same way.
import { Button } from "konsta/react";
import { type ComponentProps, type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { isAndroid } from "./api";

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
    <button type="button" className={`${cls} transition-colors active:bg-black/5 dark:active:bg-white/10`} onClick={onClick} {...rest}>
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
    className="mb-5 flex w-full items-center gap-4 rounded-3xl bg-amber-400/20 px-4 py-3.5 text-start transition-colors active:bg-amber-400/30"
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
