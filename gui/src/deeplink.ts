// A lab device's address opened from the system camera or a link (Universal Links / App Links): the page it names,
// held until the data is open (a link can arrive while Health is still locked or starting) and then opened once.
import { isMobile } from "./api";
import { codeTarget } from "./codes";

/** Where a link leads: a lab device's page, WHOOP's sign-in coming back (its query), or an address the app can't
 *  open */
export type LinkTarget = { path: string } | { whoop: string } | { unknown: true };

/** WHOOP's sign-in returning to the phone: the site's page (an App Link / Universal Link) or the scheme that page
 *  hands on to (`physimind://whoop?code=…&state=…`); the query, else null */
function whoopReturn(url: string): string | null {
  try {
    const u = new URL(url.trim());
    const site = u.protocol === "https:" && u.hostname === "zuchiangmai.com" && u.pathname === "/health/whoop/app";
    const scheme = u.protocol === "physimind:" && (u.hostname === "whoop" || u.pathname.replace(/^\/+/, "") === "whoop");
    return site || scheme ? u.search.replace(/^\?/, "") : null;
  } catch {
    return null;
  }
}

let pending: LinkTarget | undefined;
/** The pages links opened, each until the person has gone on from it (it waits for a tap before contacting the
 *  service: a link on any web page must not register anyone by itself). Kept for the session, so a reload of the
 *  web view (iOS may restart it in the background) still holds them. */
const HELD = "deep-link-held";
const held = (): string[] => {
  try {
    return JSON.parse(sessionStorage.getItem(HELD) ?? "[]") as string[];
  } catch {
    return [];
  }
};
const heldHere = new Set<string>(held());
const keep = () => {
  try {
    sessionStorage.setItem(HELD, JSON.stringify([...heldHere]));
  } catch {
    // no storage: held for as long as this page lives
  }
};
const subs = new Set<() => void>();
const LAST = "deep-link-last";

function take(url: string, replay: boolean) {
  // the plugin hands the launch link over again after a reload: only that is skipped, never a new open (scanning
  // the same device again is normal)
  try {
    if (replay && sessionStorage.getItem(LAST) === url) return;
    sessionStorage.setItem(LAST, url);
  } catch {
    // no storage: at worst a reload reopens the page
  }
  const back = whoopReturn(url);
  if (back !== null) {
    pending = { whoop: back };
    for (const f of subs) f();
    return;
  }
  const c = codeTarget(url);
  pending = c.kind === "device" && url.trim().startsWith("https://") ? { path: `data/lab/${c.page}/${c.device}` } : { unknown: true };
  for (const f of subs) f();
}

if (isMobile)
  import("@tauri-apps/plugin-deep-link").then(async ({ getCurrent, onOpenUrl }) => {
    await onOpenUrl((urls) => {
      for (const u of urls) take(u, false);
    });
    for (const u of (await getCurrent()) ?? []) take(u, true);
  }, () => {});

/** The link waiting to be opened, taken (once). */
export function takeLink(): LinkTarget | undefined {
  const p = pending;
  pending = undefined;
  if (p && "path" in p) {
    heldHere.add(p.path);
    keep();
  }
  return p;
}

/** Calls `f` when a link arrives. */
export function onLink(f: () => void): () => void {
  subs.add(f);
  return () => void subs.delete(f);
}

/** Whether the page at `path` was opened by a link and hasn't been let through yet. */
export const openedByLink = (path: string) => heldHere.has(path);
/** The person has seen where the link leads and goes on. */
export const letThrough = (path: string) => {
  heldHere.delete(path);
  keep();
};
