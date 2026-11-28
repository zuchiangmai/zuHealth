// What a scanned or opened code is: pure, so the scanner, the lab and connect screens and deep links share one rule.

/** What a scanned or opened code is. Lab devices' codes are the web app's addresses on its own site
 *  (`https://zuchiangmai.com/health/s/<device>` for seca and ForceDecks, `…/health/d/<device>` for a short code);
 *  `ZUHL1:` a new device's connection code; `SBH1:` someone's identity code, for staff to scan. */
export type CodeTarget =
  | { kind: "device"; page: "s" | "d"; device: string }
  | { kind: "link"; code: string }
  | { kind: "identity" }
  | { kind: "unknown" };

/** The one site whose lab-device codes the app takes (any other host could be anyone's) */
export const SITE_HOST = "zuchiangmai.com";

export function codeTarget(text: string): CodeTarget {
  const s = text.trim();
  if (s.startsWith("ZUHL1:")) return { kind: "link", code: s };
  if (s.startsWith("SBH1:")) return { kind: "identity" };
  try {
    const u = new URL(s);
    const m = /^\/health\/([sd])\/([a-z0-9-]{1,64})\/?$/.exec(u.pathname);
    if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname === SITE_HOST && m) return { kind: "device", page: m[1] as "s" | "d", device: m[2]! };
  } catch {
    // not an address
  }
  return { kind: "unknown" };
}
