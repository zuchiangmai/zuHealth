import { useCallback, useEffect, useState } from "react";
import { codeTarget, isMobile, onSync, op, scanCode } from "../api";
import { when } from "../format";
import { t } from "../i18n";
import { back as goBack, go as nav } from "../router";
import { Btn, card, errText, Group, Heading, Icon, type Page, Problem, Screen, Sheet, SwitchRow, type SyncShown, useOp } from "../ui";

type AccountInfo = { id: string; registered: boolean; identity?: string; drops: number };

type LinkState =
  | { state: "none" | "expired" }
  | { state: "waiting"; channel: string; expires_ms: number }
  | { state: "received"; channel: string; check: string; account: string; replaces: boolean }
  | { state: "failed"; code: string };

type Polled = { status: string; saved: number; review: number; seen: number; dropped: number };

/** Fast inbox polling (every 30 s) for an hour after the identity code was shown (protocol 3.2). */
let fastUntil = 0;

export const pollFast = () => {
  fastUntil = Date.now() + 3_600_000;
};

/** Fetches results while the app is open: at once, every 5 minutes, every 30 s in the fast hour. Sends
 *  nothing while there is no registered account (the core answers `nokey` without a request). */
export function useInbox() {
  useEffect(() => {
    let last = 0;
    let busy = false;
    let caughtUp = false;
    const tick = async () => {
      const due = Date.now() - last >= (Date.now() < fastUntil ? 30_000 : 300_000);
      if (!due || busy) return;
      busy = true;
      try {
        await op<Polled>("inbox.poll");
        last = Date.now();
        // once per opening: lab self-service results that came in meanwhile (ForceDecks in the last 7 days, a seca
        // measurement still waiting), as the web does on opening
        if (!caughtUp) {
          caughtUp = true;
          await op("fd.catch_up").catch(() => {});
          const seca = await op<{ pending?: unknown }>("seca.show").catch(() => ({ pending: undefined }));
          if (seca.pending) await op("seca.poll").catch(() => {});
        }
        // WHOOP, when connected: the core skips it if the last sync was under an hour ago
        await op("whoop.sync").catch(() => {});
      } catch {
        // the core starting or locked, or the service down: try again in a minute
        last = Date.now() - (Date.now() < fastUntil ? 0 : 240_000);
      } finally {
        busy = false;
      }
    };
    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);
}

function Qr({ text, label }: { text: string; label: string }) {
  const [svg, setSvg] = useState<string>();
  useEffect(() => {
    op<{ svg: string }>("account.qr", { text }).then((r) => setSvg(r.svg), () => setSvg(undefined));
  }, [text]);
  return svg ? <div className="h-42 w-42 flex-none rounded-xl bg-white p-2 [&_svg]:block [&_svg]:h-full [&_svg]:w-full" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="h-42 w-42 flex-none rounded-xl bg-white p-2 [&_svg]:block [&_svg]:h-full [&_svg]:w-full" />;
}

/** Other devices: connecting one (showing or scanning a connection code), LAN sync, the connection history. Each
 *  its own page, opened from More (a phone) or the side panel (a wide window); the account itself has no page
 *  (owner 2026-11-28): the identity code opens from the dashboard, lab results from Data sources. */
export function HealthAccount({ want }: { want?: string }) {
  type View = "connect" | "join" | "give" | "sync" | "history";
  const view: View = want === "connect" || want === "join" || want === "give" || want === "history" ? want : "sync";
  // join and give open from connect (back returns there); a result replaces the step it ends
  const setView = (v: View, replace = false) => nav(`account/${v}`, replace);
  // asked again whenever the page is back on top (an account made meanwhile on the identity page)
  const [shown, , load] = useOp(() => op<{ account: AccountInfo | null }>("account.show"), []);
  const acc = shown?.account;
  if (view === "connect") return <ConnectDevice hasAccount={!!acc} join={() => setView("join")} give={() => setView("give")} />;
  // joined: on to sync, the reason most people connect a device
  // a match goes on to sync in place of this step; otherwise back to where it began, without a second copy of it
  if (view === "join") return <LinkThis done={(ok) => { load(); if (ok) setView("sync", true); else goBack("account/connect"); }} />;
  if (view === "give") return <GiveAccount done={() => goBack("account/connect")} />;
  if (view === "history") return <LinkHistory />;
  return <SyncPage />;
}

/** The identity code, full screen (the web's 身份码): shown at a lab or service desk so results come here. Opening
 *  it makes the health account the first time and registers its inbox (account.register, idempotent), then fetches
 *  results quickly for an hour (protocol 3.2). */
export function IdentityPage() {
  const [st, setSt] = useState<{ s: "working" } | { s: "ok"; identity: string; id: string } | { s: "fail"; err: string }>({ s: "working" });
  const run = useCallback(async () => {
    setSt({ s: "working" });
    try {
      const r = await op<{ id: string; identity: string }>("account.register");
      setSt({ s: "ok", ...r });
      pollFast();
    } catch (e) {
      setSt({ s: "fail", err: errText(e) });
    }
  }, []);
  useEffect(() => void run(), [run]);
  return (
    <Screen title={t("Identity code")}>
      <div className={`${card} flex flex-col items-center gap-3 text-center`}>
        {st.s === "working" && <p className="text-[15px] text-black/55 dark:text-white/55" role="status">{t("Contacting the service…")}</p>}
        {st.s === "fail" && (
          <>
            <Problem text={st.err} />
            <Btn type="button" primary onClick={() => void run()}>
              {t("Try again")}
            </Btn>
          </>
        )}
        {st.s === "ok" && (
          <>
            <Qr text={st.identity} label={t("Your identity code")} />
            <p className="text-[15px] font-medium">{t("Ready to show to the staff")}</p>
            <p className="font-mono text-[13px] break-all text-black/55 dark:text-white/55">{t("Account {{id}}…", { id: st.id.slice(0, 8) })}</p>
          </>
        )}
      </div>
      <Group title={t("Where your data is")}>
        <li className="px-4 py-3 text-[15px]">{isMobile ? t("Your health data is kept entirely on this device.") : t("Your health data is kept entirely on this computer.")}</li>
        <li className="px-4 py-3 text-[15px]">{t("Results are held encrypted on the server for 7 days, and only you can open them. PhysiMind collects them when it opens.")}</li>
      </Group>
      <p className="mt-4 px-4 text-[13px] text-black/55 dark:text-white/55">
        {t("Changing phones: on the new one open PhysiMind › More › Connect another device and show the connection code, then scan it with this one. The new phone then has the same identity code.")}
      </p>
    </Screen>
  );
}

/** Lab results sent to the account: checked by themselves (on open and every few minutes); here, at once, and
 *  how many were discarded. A page of Data sources. */
export function LabResults({ go }: { go: (p: Page) => void }) {
  const [shown, loadErr, load] = useOp(() => op<{ account: AccountInfo | null }>("account.show"), []);
  const acc = shown?.account;
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [polled, setPolled] = useState<string>();
  const [waiting, setWaiting] = useState(false);
  const check = async () => {
    setErr(undefined);
    setBusy(true);
    try {
      const r = await op<Polled>("inbox.poll");
      const parts = [
        r.saved && t("{{count}} new results saved", { count: r.saved }),
        r.review && t("{{count}} waiting for you to check", { count: r.review }),
        r.dropped && t("{{count}} discarded (failed a check)", { count: r.dropped }),
      ].filter(Boolean);
      setPolled(parts.length ? `${parts.join(t(", "))}${t(".")}` : t("No new results."));
      setWaiting(r.review > 0);
      load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title={t("Lab results")}>
      <div className={`${card} flex flex-col gap-3`}>
        <p className="text-[15px]">{t("Labs and service desks send results to your health account, sealed so only your devices can open them. PhysiMind checks for new results when it opens and every few minutes while it's open.")}</p>
        {acc === null && <p className="text-[13px] text-black/55 dark:text-white/55">{t("Show your identity code (the button at the top of the dashboard) at a lab or service desk to receive results here.")}</p>}
        {acc && acc.drops > 0 && <p className="text-[13px] text-black/55 dark:text-white/55">{t("{{count}} results were discarded because they failed a check.", { count: acc.drops })}</p>}
        {acc && (
          <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" primary disabled={busy || !acc.registered} onClick={check}>
              {busy ? t("Checking…") : t("Check for results now")}
            </Btn>
            {waiting && (
              <Btn type="button" link onClick={() => go("review")}>
                {t("Check them now")}
              </Btn>
            )}
          </div>
        )}
        {polled && <p role="status" className="text-[13px] text-black/55 dark:text-white/55">{polled}</p>}
        <Problem text={err ?? loadErr} />
      </div>
    </Screen>
  );
}

/** Which devices this account was handed to or received from, on this device. */
function LinkHistory() {
  const [history] = useOp(() => op<{ state: "ok"; entries: LinkEntry[] } | { state: "unreadable" }>("link.devices"), []);
  return (
    <Screen title={t("Connection history")}>
      <LinkHistoryList history={history} />
    </Screen>
  );
}

/** The value on the LAN sync row: off, paused, waiting for you, syncing, or how many devices are up to date. */
export function SyncValue({ st, live }: { st?: SyncShown; live?: SyncLive }) {
  if (!st) return null;
  const asking = live?.peers.some((p) => p.state === "asking");
  const text = !st.enabled
    ? t("Off")
    : st.paused
      ? t("Paused")
      : asking
        ? t("Waiting for you")
        : live?.peers.some((p) => p.state === "syncing")
          ? t("Syncing")
          : st.peers.some((p) => p.up_to_date)
            ? t("Up to date · {{count}} devices", { count: st.peers.filter((p) => p.up_to_date).length })
            : t("No devices yet");
  return (
    <>
      {asking && <span className="inline-block h-2 w-2 rounded-full bg-brand-red align-middle" aria-hidden="true" />}
      {text}
    </>
  );
}

/** One entry for connecting devices (as the web's 连接其他设备): which side is this one? */
function ConnectDevice({ hasAccount, join, give }: { hasAccount: boolean; join: () => void; give: () => void }) {
  return (
    <section className="mx-auto w-full max-w-3xl">
      <Heading>{t("Connect another device")}</Heading>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Your devices can sync data with each other on the same local network.")}</p>
      <div className={`${card} flex flex-col gap-2.5 [&_h3]:m-0`}>
        <h3 className="mb-2 text-[17px] font-semibold">{t("This is a new device")}</h3>
        <p className="text-[13px] text-black/55 dark:text-white/55">{t("Get data from another device.")}</p>
        <Btn type="button" primary onClick={join}>
          {t("Show connection code")}
        </Btn>
      </div>
      <div className={`${card} flex flex-col gap-2.5 [&_h3]:m-0`}>
        <h3 className="mb-2 text-[17px] font-semibold">{t("This one is already in use")}</h3>
        <p className="text-[13px] text-black/55 dark:text-white/55">{t("Send data to another device.")}</p>
        <Btn type="button" disabled={!hasAccount} onClick={give}>
          {t("Enter connection code")}
        </Btn>
        {!hasAccount && <p className="text-[13px] text-black/55 dark:text-white/55">{(isMobile ? t("There's no health identity on this device yet, so there's nothing to hand over.") : t("There's no health identity on this computer yet, so there's nothing to hand over."))}</p>}
      </div>
    </section>
  );
}

/** This computer joins an account on another device: the code to show, then the check code (protocol 3.5). */
/** The waits before each ask for the other device's answer: the first is the usual pace, the rest after failures. */
const LINK_RETRIES = [2000, 4000, 8000, 15_000];

function LinkThis({ done }: { done: (joined: boolean) => void }) {
  const [code, setCode] = useState<string>();
  // the link this screen started: adopt only that one
  const [channel, setChannel] = useState<string>();
  const [st, setSt] = useState<LinkState>({ state: "none" });
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const start = useCallback(async () => {
    setErr(undefined);
    try {
      const j = await op<{ code: string; channel: string; expires_ms: number }>("link.join");
      setCode(j.code);
      setChannel(j.channel);
      setSt({ state: "waiting", channel: j.channel, expires_ms: j.expires_ms });
    } catch (e) {
      setErr(errText(e));
    }
  }, []);
  useEffect(() => {
    start();
    return () => {
      op("link.cancel").catch(() => {});
    };
  }, [start]);
  // asked every 2 s; a failed ask is tried again later and later, and after a few the person decides
  const [fails, setFails] = useState(0);
  useEffect(() => {
    if (st.state !== "waiting" || fails >= LINK_RETRIES.length) return;
    const t = setTimeout(async () => {
      try {
        const next = await op<LinkState>("link.poll");
        setErr(undefined);
        setFails(0);
        setSt(next);
      } catch (e) {
        if (fails + 1 >= LINK_RETRIES.length) setErr(errText(e));
        setFails(fails + 1);
      }
    }, LINK_RETRIES[fails]);
    return () => clearTimeout(t);
  }, [st, fails]);
  const adopt = async () => {
    if (st.state !== "received") return;
    setBusy(true);
    try {
      await op("link.adopt", { channel, check: st.check });
      await op("account.register").catch(() => {});
      pollFast();
      done(true);
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  const copy = () => {
    if (!code) return;
    navigator.clipboard?.writeText(code).then(
      () => setCopied(true),
      () => {},
    );
  };
  return (
    <section className="mx-auto w-full max-w-3xl">
      <Heading>{t("Show connection code")}</Heading>
      {st.state === "waiting" && code && (
        <div className={`${card} flex items-center gap-5`}>
          <Qr text={code} label={t("Connection code")} />
          <div>
            <p>{t("Use your earlier device to scan or paste this code and connect this new one. Once connected, data moves between them on the same network with Local network sync, or with Backup.")}</p>
            <p className="text-[13px] text-black/55 dark:text-white/55 font-mono text-[13px] break-all break-all select-all">{code}</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <Btn type="button" onClick={copy}>
                {copied ? t("Copied") : t("Copy code")}
              </Btn>
            </div>
            <p className="text-[13px] text-black/55 dark:text-white/55">{t("Waiting… The code works for 10 minutes.")}</p>
          </div>
        </div>
      )}
      {st.state === "received" && (
        <div className={`${card} flex flex-col gap-3`}>
          <p>{t("Check that your other device shows the same code:")}</p>
          <p className="mt-2 mb-3 text-[34px] font-semibold tracking-[0.08em] tabular-nums" aria-label={t("Check code {{code}}", { code: st.check })}>{st.check}</p>
          {st.replaces && (
            <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]">{t("This computer's identity code will change to the other device's. Results not yet received here won't arrive.")}</p>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" primary disabled={busy} onClick={adopt}>
              {busy ? t("Connecting…") : t("They match")}
            </Btn>
            <Btn type="button" disabled={busy} onClick={() => done(false)}>
              {t("They don't match")}
            </Btn>
          </div>
        </div>
      )}
      {(st.state === "expired" || st.state === "failed") && (
        <div className={`${card} flex flex-col gap-3`}>
          <p>
            {st.state === "expired" ? t("The code expired.") : t("Connecting failed.")} {(isMobile ? t("Nothing was changed on this device.") : t("Nothing was changed on this computer."))}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" primary onClick={start}>
              {t("Start again")}
            </Btn>
          </div>
        </div>
      )}
      <Problem text={err} />
      {st.state === "waiting" && fails >= LINK_RETRIES.length && (
        <Btn type="button" primary className="mt-3" onClick={() => setFails(0)}>
          {t("Try again")}
        </Btn>
      )}
    </section>
  );
}

/** A connection code the dashboard's scanner read, after the person confirmed it is their own new device: in memory
 *  only (it holds a one-time key), never in the address or history. */
let offered: string | undefined;
export const offerLinkCode = (code: string) => void (offered = code);

/** This computer hands its account to a new device showing a connection code (protocol 3.5 rule 2). */
function GiveAccount({ done }: { done: () => void }) {
  const [code, setCode] = useState(() => offered ?? "");
  // taken: gone once this screen is
  useEffect(() => () => void (offered = undefined), []);
  const [sure, setSure] = useState(false);
  const [check, setCheck] = useState<string>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const give = async () => {
    setErr(undefined);
    setBusy(true);
    try {
      const r = await op<{ check: string }>("link.give", { code: code.trim(), confirmed: true });
      setCheck(r.check);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mx-auto w-full max-w-3xl">
      <Heading>{t("Enter connection code")}</Heading>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Connect a new device. Once connected, data moves between them on the same network with Local network sync, or with Backup.")}</p>
      {check ? (
        <div className={`${card} flex flex-col gap-3`}>
          <p>{t("The new device must show the same code:")}</p>
          <p className="mt-2 mb-3 text-[34px] font-semibold tracking-[0.08em] tabular-nums" aria-label={t("Check code {{code}}", { code: check })}>{check}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" primary onClick={done}>
              {t("Done")}
            </Btn>
          </div>
        </div>
      ) : (
        <form
          className={`${card} flex flex-col gap-3`}
          onSubmit={(e) => {
            e.preventDefault();
            give();
          }}
        >
          {isMobile && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <Btn
                type="button"
                primary
                onClick={async () => {
                  setErr(undefined);
                  try {
                    const text = await scanCode();
                    if (!text) return;
                    const c = codeTarget(text);
                    if (c.kind !== "link") return setErr(t("That isn't a connection code."));
                    setCode(c.code);
                  } catch (x) {
                    setErr(errText(x));
                  }
                }}
              >
                {t("Scan the code on the new device")}
              </Btn>
            </div>
          )}
          <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
            {t("Connection code shown on the new device")}
            <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ZUHL1:…" spellCheck={false} autoComplete="off" autoFocus={!isMobile} />
          </label>
          <label className="flex items-center gap-2">
            <input className="h-4 w-4 shrink-0 accent-primary" type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
            {t("This hands my health account to the device showing this code. It is my own device.")}
          </label>
          <Problem text={err} />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="submit" primary disabled={busy || !sure || !code.trim()}>
              {busy ? t("Sending…") : t("Hand over my account")}
            </Btn>
          </div>
        </form>
      )}
    </section>
  );
}

type LinkEntry = { id: string; dir: "gave" | "got"; at: number; check: string };

/** Connection history (owner, 2026-11-22: a local record of the links this device completed; list only, as the
 *  web's 连接记录). Newest first, after this device itself. */
function LinkHistoryList({ history }: { history?: { state: "ok"; entries: LinkEntry[] } | { state: "unreadable" } }) {
  if (!history) return null;
  return (
    <>
      <Group aria-label={t("Connection history")}>
        <li className="flex items-center gap-3 px-4 py-3">
          <Icon k="account" />
          <span className="me-auto grid min-w-0 gap-px">
            <strong>{t("This device")}</strong>
          </span>
          <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs whitespace-nowrap text-black/60 dark:bg-white/10 dark:text-white/60">{t("This one")}</span>
        </li>
        {history.state === "unreadable" ? (
          <li className="flex items-center gap-3 px-4 py-3 text-[13px] text-black/55 dark:text-white/55">{t("Can't read the connection history")}</li>
        ) : history.entries.length === 0 ? (
          <li className="flex items-center gap-3 px-4 py-3 text-[13px] text-black/55 dark:text-white/55">{t("No connections recorded on this device")}</li>
        ) : (
          history.entries.map((x) => (
            <li key={x.id} className="flex items-center gap-3 px-4 py-3">
              <Icon k="account" />
              <span className="me-auto grid min-w-0 gap-px">
                <strong>{x.dir === "gave" ? t("Handed over from this device") : t("Received from another device")}</strong>
                <span className="text-[13px] text-black/55 dark:text-white/55">{t("{{date}} · Check code {{code}}", { date: when(x.at), code: x.check })}</span>
                {x.dir === "gave" && <span className="text-[13px] text-black/55 dark:text-white/55">{t("The other device may not have confirmed it")}</span>}
              </span>
            </li>
          ))
        )}
      </Group>
    </>
  );
}

type SyncQuestion = { ask: "join"; imports: number } | { ask: "erase"; imports: number; rows: number };

type LivePeer = {
  device: string;
  name: string;
  state: "connecting" | "syncing" | "up_to_date" | "partly" | "asking" | "cant_connect" | "ended";
  received?: number;
  wanted?: number;
  skipped?: number;
  asking?: SyncQuestion;
  code?: string;
  last_synced?: number;
};

type SyncLive = { idle?: string; clock_off: boolean; peers: LivePeer[] };

/** LAN sync's live state, kept fresh by the core's events. */
export function useSyncLive(): SyncLive | undefined {
  const [live, setLive] = useState<SyncLive>();
  useEffect(() => {
    let on = true;
    const load = () => op<SyncLive>("sync.live").then((l) => on && setLive(l), () => {});
    load();
    const stop = onSync(load);
    return () => {
      on = false;
      stop();
    };
  }, []);
  return live;
}

/** A device as people know it: the name another Health sends ("PhysiMind for Mac", "Health web · Chrome"). */
function deviceName(n: string): string {
  if (!n) return t("Another device");
  const web = /^Health web · (.+)$/.exec(n);
  if (web) return t("Web · {{browser}}", { browser: web[1] });
  if (n === "Health web") return t("Web");
  // what devices send stays "Health for …" (older versions and the web read it); shown under the app's name
  const os = /^Health for (Mac|Windows|Linux|iPhone|Android)$/.exec(n) ?? /^Health [\d.]+ · (macos|windows|linux)$/i.exec(n);
  if (os) {
    const k = os[1]!.toLowerCase();
    if (k === "iphone") return t("PhysiMind for iPhone");
    if (k === "android") return t("PhysiMind for Android");
    return k.startsWith("mac") ? t("PhysiMind for Mac") : k === "windows" ? t("PhysiMind for Windows") : t("PhysiMind for Linux");
  }
  return n;
}

/** Why a session ended, in words; the code itself is kept for "Details". */
function endedText(code?: string): string {
  switch (code) {
    case "paused":
      return t("Sync paused");
    case "declined":
      return t("You chose Not now. PhysiMind asks again next time.");
    case "off":
      return t("Sync is off on that device");
    case "sync_changed":
      return t("That device changed during the sync. PhysiMind syncs again shortly.");
    case "sync_proto":
      return t("That device needs an update to sync with this one.");
    case "stall":
    case "restart":
    case "closed":
    case "disconnected":
    case "webrtc":
      return t("The connection dropped. PhysiMind tries again shortly.");
    default:
      return t("Sync stopped. PhysiMind tries again shortly.");
  }
}

function peerState(p: LivePeer): string {
  switch (p.state) {
    case "up_to_date":
      return t("Up to date");
    case "syncing":
      return p.wanted ? t("Syncing · {{received}} of {{wanted}} imports", { received: p.received ?? 0, wanted: p.wanted }) : t("Syncing");
    case "partly":
      return t("Partly synced");
    case "asking":
      return t("Waiting for you");
    case "cant_connect":
      return t("On the same network but can't connect directly");
    case "ended":
      return endedText(p.code);
    default:
      return t("Connecting…");
  }
}

/** LAN sync (docs/lan-sync.md §11) on its own page: the switch, a row per device with its state, and the two
 *  questions as a dialog that says what happens. */
function SyncPage() {
  const [st, err, reload] = useOp(() => op<SyncShown>("sync.state"), []);
  const live = useSyncLive();
  const [busy, setBusy] = useState(false);
  // a question put aside with Esc comes back when it changes
  const [dismissed, setDismissed] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const run = (f: () => Promise<unknown>) => {
    setBusy(true);
    setFailed(undefined);
    f()
      .catch((e) => setFailed(errText(e)))
      .finally(() => {
        setBusy(false);
        reload();
      });
  };
  const livePeers = live?.peers ?? [];
  const known = (st?.peers ?? []).filter((p) => !livePeers.some((l) => l.device === p.device));
  const asking = livePeers.find((p) => p.asking);
  const askKey = asking ? `${asking.device}:${JSON.stringify(asking.asking)}` : undefined;
  const answer = (device: string, allow: boolean) => run(() => op("sync.answer", { device, allow }));
  return (
    <section className="mx-auto w-full max-w-3xl">
      <Heading>{t("Local network sync")}</Heading>
      <Problem text={failed ?? err} />
      {st?.paused && (
        <div className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px] flex items-center justify-between gap-4">
          <span>{t("Sync is paused: you chose Not now when another device would delete data here.")}</span>
          <Btn type="button" primary disabled={busy} onClick={() => run(() => op("sync.set", { paused: false }))}>
            {t("Continue syncing")}
          </Btn>
        </div>
      )}
      {live?.clock_off && <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]">{t("This computer's clock is off by more than 2 minutes, so other devices can't be reached.")}</p>}
      {st && (
        <Group>
          <SwitchRow
            icon={<Icon k="wifi" />}
            label={t("Sync on this network")}
            sub={t("Devices you've connected sync automatically when PhysiMind is open on the same local network.")}
            on={st.enabled}
            set={(on) => run(() => op("sync.set", { enabled: on }))}
          />
        </Group>
      )}
      {st?.enabled && live?.idle === "offline" && <p className="text-[13px] text-black/55 dark:text-white/55">{t("PhysiMind is offline, so it doesn't sync.")}</p>}
      {st?.enabled && (
        <>
          <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("Devices")}</h3>
          <Group aria-label={t("Devices on this network")}>
            {livePeers.length === 0 && known.length === 0 && (
              <li className="flex items-center gap-3 px-4 py-3 text-[13px] text-black/55 dark:text-white/55">{t("No other device seen yet. Open PhysiMind on your other device on this network.")}</li>
            )}
            {livePeers.map((p) => (
              <li key={p.device} className="flex items-center gap-3 px-4 py-3 [&_progress]:mt-1.5 [&_progress]:h-1 [&_progress]:w-full [&_progress]:accent-primary">
                <Icon k="device" />
                <span className="me-auto grid min-w-0 gap-px">
                  <strong>{deviceName(p.name)}</strong>
                  <span className="text-[13px] text-black/55 dark:text-white/55" role="status">
                    {peerState(p)}
                    {p.last_synced ? ` · ${t("Last synced {{date}}", { date: when(p.last_synced) })}` : ""}
                  </span>
                  {p.state === "syncing" && p.wanted ? (
                    <progress max={p.wanted} value={p.received ?? 0} aria-label={t("Syncing")} />
                  ) : null}
                  {p.state === "partly" && (
                    <span className="text-[13px] text-black/55 dark:text-white/55">
                      {t("{{count}} items can't be merged, for example a measure whose unit differs between the two devices. PhysiMind tries again every day.", { count: p.skipped ?? 0 })}
                    </span>
                  )}
                  {p.state === "asking" && (
                    <Btn type="button" link onClick={() => setDismissed(undefined)}>
                      {t("Answer")}
                    </Btn>
                  )}
                  {p.state === "ended" && p.code && (
                    <details className="text-[13px] text-black/55 dark:text-white/55">
                      <summary className="select-none cursor-pointer py-1.5">{t("Details")}</summary>
                      <span className="font-mono text-[13px] break-all">{p.code}</span>
                    </details>
                  )}
                </span>
                <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs whitespace-nowrap text-black/60 dark:bg-white/10 dark:text-white/60">{p.state === "up_to_date" ? "✓" : ""}</span>
              </li>
            ))}
            {known.map((p) => (
              <li key={p.device} className="flex items-center gap-3 px-4 py-3">
                <Icon k="device" />
                <span className="me-auto grid min-w-0 gap-px">
                  <strong>{deviceName(p.name)}</strong>
                  <span className="text-[13px] text-black/55 dark:text-white/55">
                    {t("Not on this network now")}
                    {p.last_synced ? ` · ${t("Last synced {{date}}", { date: when(p.last_synced) })}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </Group>
        </>
      )}
      {asking?.asking && askKey !== dismissed && (
        <Sheet label={t("Sync")} close={() => setDismissed(askKey)}>
          {asking.asking.ask === "join" ? (
            <div className="flex flex-col gap-3">
              <h3 className="mb-2 text-[17px] font-semibold">{t("Combine with {{device}}?", { device: deviceName(asking.name) })}</h3>
              <p>
                {t("This computer's data and that device's data are combined, and both then hold the same. This computer has {{count}} imports. Combining can't be undone.", {
                  count: asking.asking.imports,
                })}
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Btn type="button" primary disabled={busy} onClick={() => answer(asking.device, true)}>
                  {t("Combine")}
                </Btn>
                <Btn type="button" disabled={busy} onClick={() => answer(asking.device, false)}>
                  {t("Not now")}
                </Btn>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <h3 className="mb-2 text-[17px] font-semibold">{t("Delete here too?")}</h3>
              <p>
                {t("{{device}} deleted {{imports}} imports. Syncing deletes their {{rows}} readings on this computer too.", {
                  device: deviceName(asking.name),
                  imports: asking.asking.imports,
                  rows: asking.asking.rows,
                })}
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Btn type="button" danger disabled={busy} onClick={() => answer(asking.device, true)}>
                  {t("Delete here too")}
                </Btn>
                <Btn type="button" disabled={busy} onClick={() => answer(asking.device, false)}>
                  {t("Not now (pauses sync)")}
                </Btn>
              </div>
            </div>
          )}
        </Sheet>
      )}
    </section>
  );
}

// ---- About: privacy and open-source licenses (as the web's 更多 › 关于) --------------------------------------------
