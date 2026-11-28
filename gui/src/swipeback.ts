// Back by swiping from the left edge, as iOS (and Framework7, Konsta's sibling) has it: the page on top follows the
// finger, the one under it comes in from a third of the way left; let go past a third of the width (or quickly)
// and it goes back, else it springs back. Konsta has no navigation, so the page stack (App.tsx) has it. Android's
// own back gesture, where the system has one, still works through history as before.
import { type RefObject, useEffect } from "react";

/** How near the left edge a swipe must start (px), and how far, or how fast, it must go to go back */
const EDGE = 24;
const FAR = 1 / 3;
const FAST = 0.5; // px per ms

/** Swipes on `main` (the stack's container) go back with `back` while `can` says the top page has a way back. */
export function useSwipeBack(main: RefObject<HTMLElement | null>, can: () => boolean, back: () => void) {
  useEffect(() => {
    const el = main.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let from: { x: number; y: number; t: number } | null = null;
    let moving = false;
    let last = { x: 0, t: 0 };
    let pages: { top: HTMLElement; under: HTMLElement } | null = null;

    const find = () => {
      const all = [...el.querySelectorAll<HTMLElement>(":scope > [data-page]")];
      const top = all.find((p) => !p.hasAttribute("inert"));
      const under = top ? all[all.indexOf(top) - 1] : undefined;
      return top && under ? { top, under } : null;
    };
    const place = (dx: number, animate: boolean) => {
      if (!pages) return;
      const w = el.clientWidth;
      const how = animate ? "transform 250ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "none";
      pages.top.style.transition = how;
      pages.under.style.transition = how;
      pages.top.style.transform = `translateX(${dx}px)`;
      // the under page moves from a third of the way left to its place (its class puts it there; this overrides)
      pages.under.style.transform = `translateX(${-w / 3 + dx / 3}px)`;
      pages.under.style.translate = "none";
      pages.under.style.visibility = "visible";
    };
    // `keep`: the page that went (it stays where the finger left it, off the edge, until the stack drops it)
    const reset = (keep?: HTMLElement) => {
      for (const p of el.querySelectorAll<HTMLElement>(":scope > [data-page]")) {
        if (p === keep) continue;
        p.style.transition = "";
        p.style.transform = "";
        p.style.translate = "";
        p.style.visibility = "";
      }
      pages = null;
    };

    const start = (e: TouchEvent) => {
      const p = e.touches[0];
      if (e.touches.length !== 1 || !p || p.clientX > EDGE || !can()) return;
      from = { x: p.clientX, y: p.clientY, t: e.timeStamp };
      last = { x: p.clientX, t: e.timeStamp };
      moving = false;
    };
    const move = (e: TouchEvent) => {
      const p = e.touches[0];
      if (!from || !p) return;
      const dx = p.clientX - from.x;
      const dy = p.clientY - from.y;
      if (!moving) {
        // a vertical scroll, not a swipe
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          from = null;
          return;
        }
        if (dx < 8) return;
        pages = find();
        if (!pages) {
          from = null;
          return;
        }
        moving = true;
      }
      e.preventDefault(); // no scrolling under the swipe
      last = { x: p.clientX, t: e.timeStamp };
      place(Math.max(0, dx), false);
    };
    const end = (e: TouchEvent) => {
      if (!from || !moving || !pages) {
        from = null;
        return;
      }
      const dx = last.x - from.x;
      const v = (last.x - from.x) / Math.max(1, last.t - from.t);
      const fast = e.timeStamp - last.t < 100 && v > FAST;
      from = null;
      moving = false;
      if (dx > el.clientWidth * FAR || fast) {
        // the rest of the way, then back: the stack's own pop finds the pages already where it puts them
        place(el.clientWidth, true);
        const gone = pages.top;
        window.setTimeout(() => {
          back();
          requestAnimationFrame(() => reset(gone));
        }, 250);
      } else {
        place(0, true);
        window.setTimeout(() => reset(), 250);
      }
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      reset();
    };
  }, [main, can, back]);
}
