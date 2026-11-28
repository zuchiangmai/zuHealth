// Every page has an address (#/backup/save, #/metric/loinc:29463-7): a browser shows the same page, and a page can be
// named by its address. Going back is the history's: Android's back button, the UI's own, the browser's.
import { useEffect, useRef, useSyncExternalStore } from "react";

/** The address's parts: "#/data/whoop" → ["data", "whoop"]. */
export function parts(hash = location.hash): string[] {
  return hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
}

const subs = new Set<() => void>();
const changed = () => {
  for (const f of subs) f();
};
const subscribe = (f: () => void) => (subs.add(f), () => subs.delete(f));

/** A history entry's state: its page (`key`), how many steps this app opened under it (`depth`), a layer's id, and
 *  where its page was scrolled to when another opened over it. */
type State = { key?: string; depth?: number; layer?: string; scroll?: number } | null;
const state = () => history.state as State;

/** How many steps of history this app opened under the current one: going back stays in the app while there are
 *  some. Kept in the entry itself, so a reload or an address typed in by hand (none) reads it right. */
const depth = (): number => state()?.depth ?? 0;

/** A page in the stack: the pages opened one over another, each kept as it was left while another is on top (as a
 *  native navigation stack keeps them). `scroll`: where to put it back, for a page made anew from history. */
export type Entry = { key: string; path: string; depth: number; scroll?: number };
/** How the stack last moved, for the way pages come and go */
export type Move = "push" | "pop" | "replace" | "reset";
export type Stack = { entries: readonly Entry[]; move: Move };

/** At most this many pages are kept; going back past them makes the page anew (where it was scrolled to, still) */
const KEPT = 10;
const newKey = () => Math.random().toString(36).slice(2, 10);
let stack: Stack = { entries: [], move: "reset" };
const set = (entries: Entry[], move: Move) => {
  stack = { entries: entries.slice(-KEPT), move };
};

if (typeof window !== "undefined") {
  // the app keeps the places itself: each page is its own scroller, which the browser wouldn't keep
  history.scrollRestoration = "manual";
  // the entry the app opened on: stamped once, here (not in a render or an effect, which StrictMode runs twice)
  const s = state();
  const key = s?.key ?? newKey();
  if (!s?.key) history.replaceState({ ...s, key, depth: s?.depth ?? 0 }, "", location.href);
  set([{ key, path: location.hash, depth: s?.depth ?? 0, scroll: s?.scroll }], "reset");
  window.addEventListener("hashchange", changed);
  window.addEventListener("popstate", () => {
    const s = state();
    const top = stack.entries.at(-1);
    if (!s?.key) {
      // an address typed in, or a plain link: a page over this one
      const d = (top?.depth ?? 0) + 1;
      const key = newKey();
      history.replaceState({ ...s, key, depth: d }, "", location.href);
      set([...stack.entries, { key, path: location.hash, depth: d }], "push");
    } else {
      const at = stack.entries.findIndex((e) => e.key === s.key);
      if (at >= 0) {
        // back (or onto a layer's entry over the same page): the page under comes back as it was
        if (at < stack.entries.length - 1) set(stack.entries.slice(0, at + 1) as Entry[], "pop");
      } else if ((s.depth ?? 0) > (top?.depth ?? 0)) set([...stack.entries, { key: s.key, path: location.hash, depth: s.depth ?? 0 }], "push");
      // a page no longer kept (before a reload, or past the ones kept): made anew where it was scrolled to
      else set([{ key: s.key, path: location.hash, depth: s.depth ?? 0, scroll: s.scroll }], "pop");
    }
    changed();
  });
}

/** The address's page now, followed live. */
export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return parts(hash);
}

/** The pages open, the one on top last. */
export function useStack(): Stack {
  return useSyncExternalStore(subscribe, () => stack);
}

/** One-off results a page leaves for the page it returns to (each page of the stack is its own instance, so state
 *  set before going back would land on the page that is leaving): by the receiving page's address. */
const handed = new Map<string, unknown>();
/** Leaves `value` for the page at `path` (as `go` names it), to take when it is on top. */
export function handTo(path: string, value: unknown) {
  handed.set(`#/${path}`, value);
}
/** What was left for the page at `path` (a hash), once. */
export function takeHanded(path: string): unknown {
  const v = handed.get(path);
  handed.delete(path);
  return v;
}

/** The element of a page in the stack (its scroller) */
export const scrollerOf = (key: string) => document.querySelector<HTMLElement>(`[data-page="${key}"] > .k-page`);

/** Opens a page over this one. `replace`: in place of this one (switching tabs), so going back skips it. */
export function go(path: string, replace = false) {
  const hash = `#/${path}`;
  if (location.hash === hash) return;
  const top = stack.entries.at(-1);
  const key = newKey();
  if (replace) {
    // a fresh entry: not the layer or the place the one before had
    history.replaceState({ key, depth: depth() }, "", hash);
    set([...stack.entries.slice(0, -1), { key, path: hash, depth: depth() }], "replace");
  } else {
    // where this page is scrolled to, kept in its entry for when it's made anew (past the pages kept, a reload)
    if (top) history.replaceState({ ...state(), scroll: scrollerOf(top.key)?.scrollTop ?? 0 }, "", location.href);
    const d = depth() + 1;
    history.pushState({ key, depth: d }, "", hash);
    set([...stack.entries, { key, path: hash, depth: d }], "push");
  }
  changed();
}

/** Scrolls a page made anew back to `top`. It comes back empty and fills in as its data loads, so this goes on, a
 *  frame at a time, until it can get there (or a second has passed, or the person scrolls themselves). */
export function scrollBack(el: HTMLElement, top: number) {
  let frame = 0;
  const end = performance.now() + 1000;
  const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  const stop = () => {
    cancelAnimationFrame(frame);
    for (const e of events) window.removeEventListener(e, stop, true);
  };
  const step = () => {
    el.scrollTop = top;
    if (Math.abs(el.scrollTop - top) < 2 || performance.now() > end) return stop();
    frame = requestAnimationFrame(step);
  };
  for (const e of events) window.addEventListener(e, stop, { capture: true, passive: true });
  step();
  return stop;
}

/** Closes this page: back through history when this session opened it, else up to `parent` (an address opened
 *  directly has nothing behind it). */
export function back(parent: string) {
  if (depth() > 0) history.back();
  else {
    go(parent, true);
    stack = { ...stack, move: "pop" };
  }
}

/** Ends a flow `steps` screens deep (a form under a list): back over all of them when this session opened them,
 *  else to `parent`. */
export function backBy(steps: number, parent: string) {
  if (depth() >= steps) history.go(-steps);
  else go(parent, true);
}

/** The layers on screen now, by the id their history entry carries. */
const layers = new Set<string>();
if (typeof window !== "undefined")
  // back or forward onto the entry of a layer that has closed meanwhile: step over it
  window.addEventListener("popstate", () => {
    const id = state()?.layer;
    if (id && !layers.has(id)) history.back();
  });

/** A layer with no address of its own (a choice, a confirmation): it still takes one step of history, so going back
 *  (Android's button too) closes it. Returns the way to close it from inside, which goes back over that step. Closed
 *  any other way (a choice made, its page gone), it takes that step off history itself. */
export function useLayer(close: () => void, on = true): () => void {
  const closing = useRef(close);
  closing.current = close;
  const id = useRef("");
  const gone = useRef(false);
  const live = useRef(false);
  useEffect(() => {
    if (!on) return;
    id.current ||= Math.random().toString(36).slice(2);
    const me = id.current;
    live.current = true;
    gone.current = false;
    layers.add(me);
    // once: StrictMode runs this twice in development
    // the page's own key (the layer sits over it), not its place
    if (state()?.layer !== me) history.pushState({ key: state()?.key, depth: depth() + 1, layer: me }, "", location.href);
    const mine = depth();
    // closed when history goes back under it; a page opened over it (a deeper step) leaves it open below
    const pop = () => {
      if (state()?.layer === me || depth() >= mine) return;
      gone.current = true;
      closing.current();
    };
    window.addEventListener("popstate", pop);
    return () => {
      window.removeEventListener("popstate", pop);
      live.current = false;
      if (gone.current) {
        layers.delete(me);
        return;
      }
      // a beat later, unless it came straight back (StrictMode unmounts and mounts again in development)
      setTimeout(() => {
        if (live.current) return;
        layers.delete(me);
        if (state()?.layer === me) history.back();
      }, 0);
    };
  }, [on]);
  return () => (!on || gone.current ? closing.current() : history.back());
}
