// Scanning a QR code on a phone: the camera behind the web view (the scanner plugin's windowed mode), and over it this
// page's own screen with the way out (a close button, the system's back, the swipe from the edge), which the
// plugin's full-screen camera doesn't have.
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { OpError } from "./api";
import { t } from "./i18n";
import { useLayer } from "./router";

let scanning = false;
const subs = new Set<() => void>();
const set = (v: boolean) => {
  scanning = v;
  for (const f of subs) f();
};

// while scanning, the app is out of sight and the page clear, so the camera shows through (the classes are named
// here in full so Tailwind makes them)
const CLEAR = ["bg-transparent!"];
const HIDDEN = ["invisible"];
function clear(on: boolean) {
  for (const el of [document.documentElement, document.body]) el.classList.toggle(CLEAR[0]!, on);
  document.getElementById("root")?.classList.toggle(HIDDEN[0]!, on);
}

/** Opens the camera and returns the first QR code it sees; null when the person closes it. */
export async function scanCode(): Promise<string | null> {
  const { scan, cancel, Format, checkPermissions, requestPermissions } = await import("@tauri-apps/plugin-barcode-scanner");
  let p = await checkPermissions();
  if (p !== "granted") p = await requestPermissions();
  if (p !== "granted") throw new OpError("camera", t("Allow the camera in Settings to scan codes."));
  set(true);
  clear(true);
  try {
    const r = await scan({ windowed: true, formats: [Format.QRCode] });
    return r.content || null;
  } catch {
    await cancel().catch(() => {});
    return null;
  } finally {
    clear(false);
    set(false);
  }
}

/** Closes the camera: the scan returns null. */
async function stop() {
  const { cancel } = await import("@tauri-apps/plugin-barcode-scanner");
  await cancel().catch(() => {});
}

/** The screen over the camera while a scan runs: a frame to aim with, what to scan, and the way out. Mounted once,
 *  at the app's root (outside the app it hides). */
export function ScannerOverlay() {
  const on = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => scanning,
  );
  return on ? createPortal(<Overlay />, document.body) : null;
}

function Overlay() {
  // a step of history: Android's back and the swipe back close it, as they close any layer
  const close = useLayer(() => void stop());
  return (
    <div className="fixed inset-0 z-[100] text-white select-none" role="dialog" aria-modal="true" aria-label={t("Scan a code")}>
      {/* the frame: clear in the middle, the rest dimmed (one shadow around it) */}
      <div className="absolute top-1/2 left-1/2 aspect-square w-[min(70vw,300px)] -translate-x-1/2 -translate-y-1/2 rounded-3xl border-2 border-white/90 shadow-[0_0_0_100vmax_rgba(0,0,0,0.55)]" />
      <button
        type="button"
        onClick={close}
        aria-label={t("Close")}
        className="absolute top-[calc(env(safe-area-inset-top)+12px)] left-4 grid h-11 w-11 place-items-center rounded-full bg-black/45 backdrop-blur-md active:opacity-60"
      >
        <svg viewBox="0 0 16 16" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
        </svg>
      </button>
      <p className="absolute inset-x-6 bottom-[calc(env(safe-area-inset-bottom)+15vh)] text-center text-[15px] leading-snug text-white/90">
        {t("Point the camera at the QR code on a lab device, or at the connection code another device of yours shows.")}
      </p>
    </div>
  );
}
