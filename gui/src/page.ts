// What a page knows of its place in the stack (App's pages stay mounted under the one on top, as a native
// navigation stack keeps them): whether it is on top, and its own elements.
import { createContext, useContext } from "react";

export type PageInfo = {
  /** On top: what it shows is what the person sees. Pages under it keep their state but ask for nothing (no
   *  polling, no global keys, no dropped files). */
  active: boolean;
  /** The page's scroller (Konsta's Page) */
  scroller: () => HTMLElement | null;
  /** Where its layers (sheets) go, hidden with the page */
  layers: () => HTMLElement | null;
};

/** Outside the stack (the start-up screens): always on top, no elements of its own. */
export const PageContext = createContext<PageInfo>({ active: true, scroller: () => null, layers: () => null });

export const usePage = () => useContext(PageContext);
