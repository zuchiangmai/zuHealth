// Android's web view stretches only the whole page at a scroll edge, which drags the tab bar along. The page doesn't
// scroll on a phone (only the content does: App's <main>), so the content gets this rubber band of its own instead.

/** Pulling past the top or the bottom of `el` moves its content a damped distance with the finger; letting go
 *  springs back. The content moves, not `el`: a scroller moved by a transform leaves stale tiles in Android's
 *  web view (ghost text along the edges). */
export function rubberBand(el: HTMLElement): () => void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
  let last = 0;
  let from: number | null = null; // where the finger was when the pull past the edge began
  const shift = (transform: string, transition: string) => {
    for (const c of el.children) {
      (c as HTMLElement).style.transition = transition;
      (c as HTMLElement).style.transform = transform;
    }
  };
  const start = (e: TouchEvent) => {
    last = e.touches[0]!.clientY;
    from = null;
  };
  const move = (e: TouchEvent) => {
    const y = e.touches[0]!.clientY;
    const down = y > last;
    last = y;
    // only where the content scrolls by itself (a narrow screen)
    if (getComputedStyle(el).overflowY !== "auto") return;
    const top = el.scrollTop <= 0;
    const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if (from === null && ((top && down) || (bottom && !down))) from = y;
    if (from === null) return;
    const d = y - from;
    if ((top && d >= 0) || (bottom && d <= 0)) shift(`translateY(${Math.sign(d) * Math.min(120, Math.abs(d) * 0.35)}px)`, "none");
    else {
      from = null;
      shift("", "none");
    }
  };
  const end = () => {
    if (from !== null) shift("", "transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)");
    from = null;
  };
  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchmove", move, { passive: true });
  el.addEventListener("touchend", end);
  el.addEventListener("touchcancel", end);
  return () => {
    el.removeEventListener("touchstart", start);
    el.removeEventListener("touchmove", move);
    el.removeEventListener("touchend", end);
    el.removeEventListener("touchcancel", end);
  };
}
