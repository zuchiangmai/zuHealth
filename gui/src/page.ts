// What a page knows of its place in the stack (App's pages stay mounted under the one on top, as a native
// navigation stack keeps them): whether it is on top, and its own elements.
import { createContext, useContext, useEffect, useRef } from "react";
import { takeHanded } from "./router";

export type PageInfo = {
  /** Its address (a hash) */
  path: string;
  /** On top: what it shows is what the person sees. Pages under it keep their state but ask for nothing (no
   *  polling, no global keys, no dropped files). */
  active: boolean;
  /** The page's scroller (Konsta's Page) */
  scroller: () => HTMLElement | null;
  /** Where its layers (sheets) go, hidden with the page */
  layers: () => HTMLElement | null;
};

/** Outside the stack (the start-up screens): always on top, no elements of its own. */
export const PageContext = createContext<PageInfo>({ path: "", active: true, scroller: () => null, layers: () => null });

export const usePage = () => useContext(PageContext);

/** Runs `fn` each time the page is back on top after another was over it (not when it first opens). */
export function useBackOnTop(fn: () => void) {
  const { active } = usePage();
  const was = useRef(active);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (active && !was.current) latest.current();
    was.current = active;
  }, [active]);
}

/** Takes what a page closing over this one left for it (`handTo`), when this one is on top. */
export function useHanded<T>(take: (value: T) => void) {
  const { active, path } = usePage();
  const latest = useRef(take);
  latest.current = take;
  useEffect(() => {
    if (!active) return;
    const v = takeHanded(path);
    if (v !== undefined) latest.current(v as T);
  }, [active, path]);
}
