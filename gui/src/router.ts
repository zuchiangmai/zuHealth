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
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", changed);
  window.addEventListener("popstate", changed);
}

/** How many steps of history this app opened under the current one: going back stays in the app while there are
 *  some. Kept in the entry itself, so a reload or an address typed in by hand (none) reads it right. */
const depth = (): number => (history.state as { depth?: number } | null)?.depth ?? 0;

/** The address now, followed live. */
export function useRoute(): string[] {
  const hash = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => location.hash,
  );
  return parts(hash);
}

/** Opens a page. `replace`: in place of this one (switching tabs), so going back skips it. */
export function go(path: string, replace = false) {
  const hash = `#/${path}`;
  if (location.hash === hash) return;
  if (replace) history.replaceState(history.state, "", hash);
  else history.pushState({ depth: depth() + 1 }, "", hash);
  changed();
}

/** Closes this page: back through history when this session opened it, else up to `parent` (an address opened
 *  directly has nothing behind it). */
export function back(parent: string) {
  if (depth() > 0) history.back();
  else go(parent, true);
}

/** Ends a flow `steps` screens deep (a form under a list): back over all of them when this session opened them,
 *  else to `parent`. */
export function backBy(steps: number, parent: string) {
  if (depth() >= steps) history.go(-steps);
  else go(parent, true);
}

/** A layer with no address of its own (a choice, a confirmation): it still takes one step of history, so going back
 *  (Android's button too) closes it. Returns the way to close it from inside, which goes back over that step. */
export function useLayer(close: () => void, on = true): () => void {
  const closing = useRef(close);
  closing.current = close;
  const gone = useRef(false);
  useEffect(() => {
    if (!on) return;
    history.pushState({ depth: depth() + 1, layer: true }, "", location.href);
    const pop = () => {
      gone.current = true;
      closing.current();
    };
    window.addEventListener("popstate", pop, { once: true });
    return () => window.removeEventListener("popstate", pop);
  }, [on]);
  return () => (!on || gone.current ? closing.current() : history.back());
}
