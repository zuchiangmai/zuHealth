// The phone's health store (Apple Health on iPhone, Health Connect on Android): connecting it, its state, and the
// syncs the app runs by itself. What is read and written, and how, is the runtime's (health-runtime/src/syshealth.rs).
import { Dialog, DialogButton } from "konsta/react";
import { useCallback, useEffect, useState } from "react";
import { inBackground, op } from "../api";
import { when } from "../format";
import { t } from "../i18n";
import { Btn, card, errText, Problem } from "../ui";

type Status = {
  kind: "healthkit" | "health_connect" | null;
  available?: boolean;
  on?: boolean;
  last_sync_ms?: number;
  history_left?: boolean;
  other_reader?: { id: string; name: string; at: number };
  last_error?: string | null;
};
type Report = { days?: number; written?: number; more?: boolean; moved_to?: string; busy?: boolean; write_error?: string };

export const storeName = (kind: Status["kind"]) => (kind === "health_connect" ? "Health Connect" : t("Apple Health"));

/** Syncs by itself while the app is in use: when it opens, and back in front after a quarter of an hour; history
 *  still to read goes on step by step. Nothing happens unless the person connected the store on this device. */
export function useSystemHealthSync() {
  useEffect(() => {
    let last = 0;
    let running = false;
    const tick = async () => {
      if (running || document.hidden || Date.now() - last < 15 * 60_000) return;
      running = true;
      try {
        const s = await inBackground(() => op<Status>("syshealth.status"));
        if (!s.kind || !s.on) return;
        last = Date.now();
        // a few steps of history at a time, so a first read of years doesn't hold the app for long
        // and not once the app is put away (Android refuses reading in the background)
        for (let i = 0; i < 4 && !document.hidden; i++) {
          const r = await inBackground(() => op<Report>("syshealth.sync"));
          if (!r.more) break;
        }
      } catch {
        // locked, or the store refused: the card shows the error (the runtime keeps it); the next time round tries again
      } finally {
        running = false;
      }
    };
    void tick();
    document.addEventListener("visibilitychange", tick);
    return () => document.removeEventListener("visibilitychange", tick);
  }, []);
}

/** Connecting this phone's health store, and its state once connected. Nothing on a computer. */
export function SystemHealthCard() {
  const [st, setSt] = useState<Status>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [note, setNote] = useState<string>();
  const [other, setOther] = useState<string>();
  const load = useCallback(() => op<Status>("syshealth.status").then(setSt, (e) => setErr(errText(e))), []);
  useEffect(() => void load(), [load]);
  const run = async (f: () => Promise<void>) => {
    setErr(undefined);
    setNote(undefined);
    setBusy(true);
    try {
      await f();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
      void load();
    }
  };
  const told = (r: Report) => {
    if (r.moved_to) return setNote(t("{{device}} reads it now, so this device stopped.", { device: r.moved_to }));
    if (r.busy) return setNote(t("A sync is already running."));
    const read = r.written ? t("{{count}} new readings.", { count: r.written }) : t("Nothing new.");
    setNote(r.write_error ? `${read} ${t("Lab results couldn't be added: {{why}}", { why: r.write_error })}` : read);
  };
  const connect = (takeOver: boolean) =>
    run(async () => {
      const r = await op<Report & { other_reader?: string }>("syshealth.connect", { take_over: takeOver });
      if (r.other_reader) return setOther(r.other_reader);
      told(r);
    });
  if (!st?.kind) return null;
  const name = storeName(st.kind);
  return (
    <div className={`${card} flex flex-col gap-3`}>
      {st.available === false ? (
        <p className="text-[15px]">
          {st.kind === "health_connect"
            ? t("Install Health Connect from Google Play, then come back here to connect it.")
            : t("Apple Health isn't available on this device.")}
        </p>
      ) : st.on ? (
        <>
          <p className="text-[15px]">
            {st.last_sync_ms ? t("Connected. Last synced {{when}}.", { when: when(st.last_sync_ms) }) : t("Connected.")}
            {st.history_left ? ` ${t("Earlier history is still being read, a part at each sync.")}` : ""}
          </p>
          {st.last_error && !err && <Problem text={t("The last sync failed: {{why}}", { why: st.last_error })} />}
          <p className="text-[13px] text-black/55 dark:text-white/55">
            {t("{{name}} syncs when PhysiMind opens and while you use it. Body composition measured in the lab is added to {{name}}.", { name })}
          </p>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" primary disabled={busy} onClick={() => run(async () => told(await op<Report>("syshealth.sync")))}>
              {busy ? t("Syncing…") : t("Sync now")}
            </Btn>
            <Btn type="button" disabled={busy} onClick={() => run(async () => void (await op("syshealth.disconnect")))}>
              {t("Disconnect")}
            </Btn>
          </div>
          <p className="text-[13px] text-black/55 dark:text-white/55">
            {t("Disconnecting stops syncing here; what was read and written stays. To take back the access itself, use the system's Settings.")}
          </p>
        </>
      ) : (
        <>
          <p className="text-[15px]">
            {t("Read steps, heart rate, sleep, body measurements and more from {{name}}, and add the body composition measured in the lab to it.", { name })}
          </p>
          <p className="text-[13px] text-black/55 dark:text-white/55">
            {t("One device of yours reads it; your other devices get the data by syncing. Agents get it only if you allow it for them.")}
          </p>
          {st.other_reader && <p className="text-[13px] text-black/55 dark:text-white/55">{t("{{device}} reads it now.", { device: st.other_reader.name })}</p>}
          <Btn type="button" primary disabled={busy} onClick={() => connect(false)}>
            {busy ? t("Connecting…") : t("Connect {{name}}", { name })}
          </Btn>
        </>
      )}
      {note && <p className="text-[13px] text-black/55 dark:text-white/55" role="status">{note}</p>}
      <Problem text={err} />
      <Dialog
        opened={!!other}
        onBackdropClick={() => setOther(undefined)}
        title={t("Read it on this device?")}
        content={t("{{device}} reads {{name}} now. Reading it here instead stops it there; what it already read stays.", { device: other, name })}
        buttons={
          <>
            <DialogButton onClick={() => setOther(undefined)}>{t("Cancel")}</DialogButton>
            <DialogButton
              strong
              onClick={() => {
                setOther(undefined);
                void connect(true);
              }}
            >
              {t("Read here")}
            </DialogButton>
          </>
        }
      />
    </div>
  );
}

/** Above the export's import once Apple Health syncs here: an export is then rarely needed (owner, 2026-11-28: say
 *  so, still allow it). */
export function ExportNote() {
  const [on, setOn] = useState(false);
  useEffect(() => void op<Status>("syshealth.status").then((s) => setOn(!!s.on), () => {}), []);
  return on ? <p className="mt-4 text-[13px] text-black/55 dark:text-white/55">{t("Apple Health syncs here already, so an export is usually not needed. Importing one is still fine.")}</p> : null;
}
