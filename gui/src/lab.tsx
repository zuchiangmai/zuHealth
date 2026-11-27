// Lab self-service (the web's self-device, seca-self, fd-self and self pages). A device carries a QR code with
// `…/health/s/<device>` (seca mBCA Pro, VALD ForceDecks) or `…/health/d/<device>` (a short code): the phone scans
// it, a computer types the id beside it. The core asks the backend what the device is (lab.device) and runs each
// flow (seca.*, fd.*, self.code); this file is the pages. Results land like any lab result.
import { useCallback, useEffect, useRef, useState } from "react";
import forcedecksPhoto from "./devices/forcedecks.webp";
import secaPhoto from "./devices/seca-mbca.webp";
import { OpError, deviceFromCode, isMobile, op, scanCode } from "./api";
import { when } from "./format";
import { BirthWheels, isTouch } from "./pickers";
import { go } from "./router";
import { t } from "./i18n";
import { Btn, card } from "./ui";

type Kind = { kind: "seca" | "forcedecks" | "lab"; name: string; state?: string; since?: number };
type Fail = (e: unknown) => string;

const SECA_POLL_MS = 5_000;
const SECA_WAIT_MS = 10 * 60_000;
const FD_POLL_MS = 3_000;
const FD_BACKOFF_MS = [3_000, 6_000, 12_000, 30_000];
/** After a ForceDecks lease ends, results may still come in for this long */
const FD_GRACE_MS = 5 * 60_000;
const ETHNICITIES = ["Asian", "Caucasian", "AfroAmerican", "Hispanic", "Japanese", "Other"] as const;
const ethnicityLabel = (e: string) =>
  ({ Asian: t("Asian"), Caucasian: t("Caucasian"), AfroAmerican: t("African descent"), Hispanic: t("Hispanic"), Japanese: t("Japanese"), Other: t("Other") })[e] ?? e;

/** The device's photo, to set beside the device in front of the person: a wrong code shows at a glance (no caption). */
function DevicePhoto({ kind }: { kind: "seca" | "forcedecks" }) {
  const p = kind === "seca" ? { src: secaPhoto, alt: "seca mBCA Pro", w: 344, h: 640 } : { src: forcedecksPhoto, alt: "VALD ForceDecks", w: 720, h: 403 };
  return (
    <figure className="my-3 [&_img]:block [&_img]:h-auto [&_img]:max-h-60 [&_img]:w-auto [&_img]:max-w-full [&_img]:rounded-2xl">
      <img src={p.src} alt={p.alt} width={p.w} height={p.h} decoding="async" />
    </figure>
  );
}

function Problem({ text }: { text?: string }) {
  return text ? (
    <p className="text-[15px] text-brand-red" role="alert">
      {text}
    </p>
  ) : null;
}

/** Runs one async action at a time: a double tap must not start (or register) twice. */
function useOnce() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const once = useCallback(async (f: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await f();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, once };
}

/** Lab self-service: scan or type a device, then its page, a screen of its own (#/data/lab/s/<device>).
 *  `showResults` opens the readings once results arrived. */
export function LabSelfService({
  errText,
  showResults,
  showIdentity,
  pollFast,
  path: [page, id],
}: {
  errText: Fail;
  showResults: () => void;
  showIdentity: () => void;
  pollFast: () => void;
  /** the device open: its page ("s" a lab device, "d" a short code) and id */
  path: string[];
}) {
  const [typed, setTyped] = useState("");
  const device = id && (page === "s" || page === "d") ? { id, page } : undefined;
  const [kind, setKind] = useState<Kind>();
  const [err, setErr] = useState<string>();
  const { busy, once } = useOnce();
  // a lab device's page needs what the device is (asked here when its address was opened directly)
  useEffect(() => {
    if (device?.page !== "s" || kind) return;
    op<Kind>("lab.device", { device: device.id }).then(setKind, (e) => setErr(errText(e)));
  }, [device?.page, device?.id]);
  const setDevice = (d: { id: string; page: "s" | "d" }) => go(`data/lab/${d.page}/${encodeURIComponent(d.id)}`);

  const open = (id: string, page: "s" | "d") =>
    once(async () => {
      setErr(undefined);
      if (page === "d") return setDevice({ id, page });
      try {
        setKind(await op<Kind>("lab.device", { device: id }));
        setDevice({ id, page });
      } catch (e) {
        setErr(errText(e));
      }
    });

  const scan = () =>
    once(async () => {
      setErr(undefined);
      try {
        const text = await scanCode();
        if (!text) return;
        const d = deviceFromCode(text);
        if (!d) return setErr(t("That isn't a lab device's code."));
        if (d.page === "s") setKind(await op<Kind>("lab.device", { device: d.device }));
        setDevice({ id: d.device, page: d.page });
      } catch (e) {
        setErr(errText(e));
      }
    });

  if (device?.page === "s" && !kind) return err ? <Problem text={err} /> : <p aria-busy="true" />;
  if (device && kind?.kind === "seca") return <SecaSelf device={device.id} errText={errText} showResults={showResults} />;
  if (device && kind?.kind === "forcedecks") return <FdSelf device={device.id} kind={kind} errText={errText} showResults={showResults} />;
  if (device) return <ShortCode device={device.id} errText={errText} pollFast={pollFast} />;
  return (
    <section className="[&_h3]:mt-6">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Lab self-service")}</h2>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">
        {isMobile
          ? t("Scan the code on the lab device. Your results are stored here, on this device.")
          : t("Type the id beside the lab device's code. Your results are stored here, on this computer.")}
      </p>
      {isMobile && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Btn type="button" primary disabled={busy} onClick={() => void scan()}>
            {t("Scan the device's code")}
          </Btn>
        </div>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const d = deviceFromCode(typed);
          void open(d?.device ?? typed.trim(), d?.page ?? "s");
        }}
      >
        <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
          {t("Device id (beside its QR code)")}
          <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="seca-mbca-01" spellCheck={false} autoCapitalize="none" required />
        </label>
        <Problem text={err} />
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Btn type="submit" primary={!isMobile} disabled={busy}>
            {busy ? t("Contacting the service…") : t("Open")}
          </Btn>
        </div>
      </form>
      <p className="text-[13px] text-black/55 dark:text-white/55">
        {t("Staff can also scan your identity code instead.")}{" "}
        <Btn type="button" link onClick={showIdentity}>
          {t("Show my identity code")}
        </Btn>
      </p>
    </section>
  );
}

/** A device without its own page: a 6-digit code to type at it; the result comes through the inbox. */
function ShortCode({ device, errText, pollFast }: { device: string; errText: Fail; pollFast: () => void }) {
  const [code, setCode] = useState<{ code: string; until: number }>();
  const [err, setErr] = useState<string>();
  const { busy, once } = useOnce();
  const get = () =>
    once(async () => {
      setErr(undefined);
      try {
        setCode(await op<{ code: string; until: number }>("self.code", { device }));
        pollFast();
      } catch (e) {
        setErr(errText(e));
      }
    });
  useEffect(() => {
    void get();
    // once per device
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);
  return (
    <section className="[&_h3]:mt-6">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Lab self-service")}</h2>
      {code ? (
        <div className={`${card} flex flex-col gap-3`}>
          <p className="text-[34px] font-semibold tracking-[0.1em] tabular-nums" aria-label={t("Code {{code}}", { code: code.code })}>
            {code.code}
          </p>
          <p className="text-[13px] text-black/55 dark:text-white/55">{t("Valid until {{when}}.", { when: when(code.until) })}</p>
          <ol className="list-decimal ps-5 leading-relaxed [&_li+li]:mt-3">
            <li>{t("Type this code at the device.")}</li>
            <li>{t("Do the measurement.")}</li>
            <li>{t("The result arrives here within minutes.")}</li>
          </ol>
        </div>
      ) : (
        <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{busy ? t("Contacting the service…") : ""}</p>
      )}
      <Problem text={err} />
      {err && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Btn type="button" onClick={() => void get()}>
            {t("Try again")}
          </Btn>
        </div>
      )}
    </section>
  );
}

/** Birth year, month and sex, asked only when the profile lacks them. */
function BirthAndSex({
  year,
  month,
  gender,
  setYear,
  setMonth,
  setGender,
}: {
  year: string;
  month: string;
  gender: string;
  setYear: (v: string) => void;
  setMonth: (v: string) => void;
  setGender: (v: string) => void;
}) {
  const thisYear = new Date().getFullYear();
  return (
    <>
      {isTouch ? (
        // the wheels take months as "1"…"12"; this form keeps "01"…"12"
        <BirthWheels year={year} month={month ? String(Number(month)) : ""} setYear={setYear} setMonth={(m) => setMonth(m.padStart(2, "0"))} />
      ) : (
        <>
          <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
            {t("Birth year")}
            <select className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">{t("Choose")}</option>
              {Array.from({ length: thisYear - 1900 + 1 }, (_, k) => thisYear - k).map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
            {t("Birth month")}
            <select className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="">{t("Choose")}</option>
              {Array.from({ length: 12 }, (_, k) => k + 1).map((m) => (
                <option key={m} value={String(m).padStart(2, "0")}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0 [&_legend]:mb-1.5 [&_legend]:text-[13px]">
        <legend>{t("Sex")}</legend>
        {(["Male", "Female"] as const).map((g) => (
          <Btn key={g} type="button" on={gender === g} aria-pressed={gender === g} onClick={() => setGender(g)}>
            {g === "Male" ? t("Male") : t("Female")}
          </Btn>
        ))}
      </fieldset>
    </>
  );
}

type SecaState =
  | { s: "loading" }
  | { s: "form"; err?: string }
  | { s: "registering" }
  | { s: "ready"; note?: string; err?: string }
  | { s: "confirm"; queue: number }
  | { s: "waiting"; since: number }
  | { s: "done" };

/** seca mBCA Pro: register once (birth month, sex, ethnicity), start, stand on the device, wait for the report. */
function SecaSelf({ device, errText, showResults }: { device: string; errText: Fail; showResults: () => void }) {
  const [st, setSt] = useState<SecaState>({ s: "loading" });
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [gender, setGender] = useState("");
  const [eth, setEth] = useState("");
  const [known, setKnown] = useState({ birth: false, gender: false });
  const [now, setNow] = useState(Date.now());
  const { busy, once } = useOnce();

  const register = useCallback(
    async (p: { birth: string; gender: string; ethnicity: string }) => {
      setSt({ s: "registering" });
      try {
        await op("seca.register", p);
        setSt({ s: "ready" });
      } catch (e) {
        // the device didn't take these: show every field (filled in) to change and retry
        setKnown({ birth: false, gender: false });
        setSt({ s: "form", err: errText(e) });
      }
    },
    [errText],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      const s = await op<{ registered: boolean; pending?: { device: string }; birth?: string; gender?: string; ethnicity?: string }>("seca.show");
      if (!live) return;
      if (s.birth) {
        setYear(s.birth.slice(0, 4));
        setMonth(s.birth.slice(5, 7));
      }
      if (s.gender) setGender(s.gender);
      if (s.ethnicity) setEth(s.ethnicity);
      setKnown({ birth: !!s.birth, gender: !!s.gender });
      if (s.pending?.device === device) return setSt({ s: "waiting", since: Date.now() });
      if (s.registered) return setSt({ s: "ready" });
      if (s.birth && s.gender && s.ethnicity) return void register({ birth: s.birth, gender: s.gender, ethnicity: s.ethnicity });
      setSt({ s: "form" });
    })().catch((e) => live && setSt({ s: "form", err: errText(e) }));
    return () => {
      live = false;
    };
  }, [device, register, errText]);

  // waiting: ask every 5 s, 10 minutes at most; leaving the page stops asking (the ticket stays for next time)
  const waiting = st.s === "waiting" ? st.since : null;
  useEffect(() => {
    if (waiting === null) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const r = await op<{ state: string }>("seca.poll").catch(() => ({ state: "error" }));
      if (stop) return;
      setNow(Date.now());
      if (r.state === "ready") return setSt({ s: "done" });
      if (r.state === "waiting" || r.state === "error") {
        if (Date.now() - waiting > SECA_WAIT_MS) return setSt({ s: "ready", note: "timeout" });
        timer = setTimeout(() => void tick(), SECA_POLL_MS);
        return;
      }
      setSt(r.state === "cancelled" ? { s: "ready" } : { s: "ready", note: r.state === "none" ? "failed" : r.state });
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [waiting]);

  const go = () =>
    once(async () => {
      try {
        await op("seca.start", { device });
        setSt({ s: "waiting", since: Date.now() });
      } catch (e) {
        setSt(e instanceof OpError && e.code === "noprofile" ? { s: "form" } : { s: "ready", err: errText(e) });
      }
    });
  const begin = () =>
    once(async () => {
      const w = await op<{ warn: boolean; queue: number }>("seca.state").catch(() => ({ warn: true, queue: 0 }));
      if (w.warn) setSt({ s: "confirm", queue: w.queue });
      else {
        try {
          await op("seca.start", { device });
          setSt({ s: "waiting", since: Date.now() });
        } catch (e) {
          setSt(e instanceof OpError && e.code === "noprofile" ? { s: "form" } : { s: "ready", err: errText(e) });
        }
      }
    });
  const cancel = async () => {
    setSt({ s: "ready" });
    await op("seca.cancel").catch(() => {});
  };
  const ready = /^\d{4}$/.test(year) && /^\d{2}$/.test(month) && !!gender && !!eth;
  const mins = st.s === "waiting" ? Math.max(0, Math.floor((now - st.since) / 60_000)) : 0;
  return (
    <section className="[&_h3]:mt-6">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("Body composition")}</h2>
      <p className="text-[13px] text-black/55 dark:text-white/55">seca mBCA Pro</p>
      <DevicePhoto kind="seca" />
      {st.s === "loading" && <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Opening…")}</p>}
      {st.s === "registering" && (
        <div className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]" role="status">
          <p>{t("Registering, one moment…")}</p>
          <p className="text-[13px] text-black/55 dark:text-white/55">{t("The first time, your details are registered on the device. This usually takes a few seconds.")}</p>
        </div>
      )}
      {st.s === "form" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void once(() => register({ birth: `${year}-${month}`, gender, ethnicity: eth }));
          }}
        >
          <h3 className="mb-2 text-[17px] font-semibold">{t("Before measuring")}</h3>
          <p className="text-[13px] text-black/55 dark:text-white/55">{t("Used to work out your body composition. Asked only once.")}</p>
          {!(known.birth && known.gender) && <BirthAndSex year={year} month={month} gender={gender} setYear={setYear} setMonth={setMonth} setGender={setGender} />}
          <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0 [&_legend]:mb-1.5 [&_legend]:text-[13px]">
            <legend>{t("Ethnicity")}</legend>
            {ETHNICITIES.map((e) => (
              <Btn key={e} type="button" on={eth === e} aria-pressed={eth === e} onClick={() => setEth(e)}>
                {ethnicityLabel(e)}
              </Btn>
            ))}
          </fieldset>
          <Problem text={st.err} />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="submit" primary disabled={!ready || busy}>
              {t("Save")}
            </Btn>
          </div>
        </form>
      )}
      {(st.s === "ready" || st.s === "confirm") && (
        <>
          {st.s === "ready" && st.note === "timeout" && <p className="text-[15px] text-brand-red">{t("No new measurement arrived.")}</p>}
          {st.s === "ready" && st.note === "replaced" && <p className="text-[15px] text-brand-red">{t("You started again elsewhere, so this wait ended.")}</p>}
          {st.s === "ready" && (st.note === "failed" || st.note === "error") && <p className="text-[15px] text-brand-red">{t("This result couldn't be fetched.")}</p>}
          <Problem text={st.s === "ready" ? st.err : undefined} />
          {st.s === "confirm" ? (
            <div className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]" role="alertdialog">
              <p>{t("Someone may still be measuring. Check nobody is on the device before you start.")}</p>
              {st.queue > 0 && <p className="text-[13px] text-black/55 dark:text-white/55">{t("{{count}} people are waiting for results ahead of you: please measure in turn.", { count: st.queue })}</p>}
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Btn type="button" onClick={() => setSt({ s: "ready" })}>
                  {t("Cancel")}
                </Btn>
                <Btn type="button" primary disabled={busy} onClick={() => void go()}>
                  {t("Continue")}
                </Btn>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <Btn type="button" primary disabled={busy} onClick={() => void begin()}>
                {busy ? t("Starting…") : t("Start measuring")}
              </Btn>
            </div>
          )}
        </>
      )}
      {st.s === "waiting" && (
        <div className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]">
          <p>
            <strong>{t("Take off your socks: stand on the device barefoot.")}</strong>
          </p>
          <ol className="list-decimal ps-5 leading-relaxed [&_li+li]:mt-3">
            <li>{t("Stand on the device.")}</li>
            <li>{t("After about ten seconds the screen shows BIA: tap the tick at the bottom right.")}</li>
            <li>{t("When it says “Authorized personnel only”, tap the tick at the bottom right.")}</li>
            <li>{t("On “Date of birth”, enter your date of birth and tap the tick below; the device submits the data (Submitting data).")}</li>
            <li>{t("About 30 seconds after it finishes, the report appears here.")}</li>
          </ol>
          <p className="text-[13px] text-black/55 dark:text-white/55">{t("Waiting for the result: {{count}} min so far (10 at most).", { count: mins })}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" onClick={() => void cancel()}>
              {t("Stop waiting")}
            </Btn>
          </div>
        </div>
      )}
      {st.s === "done" && (
        <div className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]">
          <p>{t("Your body composition report is here.")}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" primary onClick={showResults}>
              {t("Show the results")}
            </Btn>
          </div>
        </div>
      )}
    </section>
  );
}

type FdView = {
  profile: { state: "creating" | "ready" | "failed"; label: string; name?: string | null; code?: string | null };
  lease: { state: "opening" | "open" | "closed" | "failed"; since: number; code?: string | null } | null;
};
type FdState = { s: "loading" } | { s: "form"; err?: string } | { s: "registering" } | { s: "profile"; view?: FdView; err?: string };

/** VALD ForceDecks: a profile per device (birth month and sex), start, then the person works the device's screen. */
function FdSelf({ device, kind, errText, showResults }: { device: string; kind: Kind; errText: Fail; showResults: () => void }) {
  const [st, setSt] = useState<FdState>({ s: "loading" });
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [gender, setGender] = useState("");
  const [devState, setDevState] = useState(kind.state ?? null);
  const [taken, setTaken] = useState(0);
  const [started, setStarted] = useState(false);
  const ended = useRef<number | null>(null);
  const { busy, once } = useOnce();

  const register = useCallback(
    async (p?: { birth: string; gender: string }) => {
      setSt({ s: "registering" });
      try {
        await op("fd.register", { device, ...p });
        setSt({ s: "profile" });
      } catch (e) {
        setSt({ s: "form", err: errText(e) });
      }
    },
    [device, errText],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      const s = await op<{ label?: string | null; birth?: string; gender?: string }>("fd.show", { device });
      if (!live) return;
      if (s.birth) {
        setYear(s.birth.slice(0, 4));
        setMonth(s.birth.slice(5, 7));
      }
      if (s.gender) setGender(s.gender);
      if (s.label) return setSt({ s: "profile" });
      if (s.birth && s.gender) return void register();
      setSt({ s: "form" });
    })().catch((e) => live && setSt({ s: "form", err: errText(e) }));
    return () => {
      live = false;
    };
  }, [device, register, errText]);

  // the profile's and lease's state and new results: every 3 s while something moves, backing off after errors
  const following = st.s === "profile";
  useEffect(() => {
    if (!following) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let errors = 0;
    const moving = (v: FdView) => {
      if (v.profile.state === "creating") return true;
      const l = v.lease;
      if (!l) return false;
      if (l.state === "opening" || l.state === "open") {
        ended.current = null;
        return true;
      }
      ended.current ??= Date.now();
      return Date.now() - ended.current < FD_GRACE_MS;
    };
    const tick = async () => {
      if (stop || document.hidden) return;
      try {
        const r = await op<FdView & { taken: number }>("fd.check", { device });
        if (stop) return;
        errors = 0;
        if (r.taken) setTaken((n) => n + r.taken);
        setSt({ s: "profile", view: { profile: r.profile, lease: r.lease } });
        if (moving(r)) timer = setTimeout(() => void tick(), FD_POLL_MS);
      } catch (e) {
        if (stop) return;
        setSt((s) => (s.s === "profile" ? { ...s, err: errText(e) } : s));
        timer = setTimeout(() => void tick(), FD_BACKOFF_MS[Math.min(errors++, FD_BACKOFF_MS.length - 1)]);
      }
    };
    const visible = () => {
      if (!document.hidden && !timer) void tick();
    };
    document.addEventListener("visibilitychange", visible);
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [following, device, errText, started]);

  // the device's own state while a test runs
  const leaseOpen = st.s === "profile" && (st.view?.lease?.state === "opening" || st.view?.lease?.state === "open");
  useEffect(() => {
    if (!leaseOpen) return;
    const i = setInterval(() => {
      if (!document.hidden) op<Kind>("lab.device", { device }).then((k) => setDevState(k.state ?? null), () => {});
    }, FD_POLL_MS);
    return () => clearInterval(i);
  }, [leaseOpen, device]);

  const start = () =>
    once(async () => {
      try {
        await op("fd.start", { device });
        ended.current = null;
        setStarted((x) => !x);
      } catch (e) {
        setSt((s) => (s.s === "profile" ? { ...s, err: errText(e) } : s));
      }
    });
  const view = st.s === "profile" ? st.view : undefined;
  const lease = view?.lease;
  const ready = /^\d{4}$/.test(year) && /^\d{2}$/.test(month) && !!gender;
  return (
    <section className="[&_h3]:mt-6">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("VALD ForceDecks self-service")}</h2>
      <DevicePhoto kind="forcedecks" />
      {devState === "unavailable" && <p className="text-[15px] text-brand-red">{t("The device is offline for now: please ask the staff for help.")}</p>}
      {st.s === "loading" && <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Opening…")}</p>}
      {st.s === "form" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void once(() => register({ birth: `${year}-${month}`, gender }));
          }}
        >
          <p className="text-[13px] text-black/55 dark:text-white/55">{t("The test needs your birth month and sex.")}</p>
          <BirthAndSex year={year} month={month} gender={gender} setYear={setYear} setMonth={setMonth} setGender={setGender} />
          <Problem text={st.err} />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="submit" primary disabled={!ready || busy}>
              {t("Next")}
            </Btn>
          </div>
        </form>
      )}
      {(st.s === "registering" || view?.profile.state === "creating") && <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55" role="status">{t("Making your profile on the device, about half a minute…")}</p>}
      {view?.profile.state === "failed" && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <p className="text-[15px] text-brand-red">{t("The profile wasn't made. Please try again.")}</p>
          <Btn type="button" onClick={() => void once(() => register())}>
            {t("Try again")}
          </Btn>
        </div>
      )}
      {st.s === "profile" && view?.profile.state !== "creating" && view?.profile.state !== "failed" && (
        <>
          {devState === "in_use" && !(lease && (lease.state === "opening" || lease.state === "open")) && <p className="text-[15px] text-brand-red">{t("The device is in use: please try again shortly.")}</p>}
          {lease?.state === "failed" && <p className="text-[15px] text-brand-red">{t("The device can't be used right now: please ask the staff.")}</p>}
          {lease && (lease.state === "opening" || lease.state === "open") ? (
            <div className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]">
              {lease.state === "opening" && <p role="status">{t("Opening the test on the device…")}</p>}
              <p>
                <strong>{t("Work on the device's screen")}</strong>
              </p>
              <ol className="list-decimal ps-5 leading-relaxed [&_li+li]:mt-3">
                <li>{t("Don't stand on VALD ForceDecks yet: tap Zero Platforms.")}</li>
                <li>{t("Stand on VALD ForceDecks and keep still.")}</li>
                <li>{t("Tap Start Recording, do your test, then stand still.")}</li>
                <li>{t("Tap Stop Recording, then Analyse & Save.")}</li>
              </ol>
              {view?.profile.name && <p>{t("Check that the name at the top of the screen is {{name}}.", { name: view.profile.name })}</p>}
              <p className="text-[13px] text-black/55 dark:text-white/55">{t("The test type is your choice: pick it on the device's screen, or keep Auto Detect and let the device tell.")}</p>
              <p className="text-[13px] text-black/55 dark:text-white/55">{t("Once saved, the results appear here.")}</p>
            </div>
          ) : (
            <>
              {lease && <p className="text-[13px] text-black/55 dark:text-white/55">{t("The test has ended.")}</p>}
              <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("You can start the test now.")}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Btn type="button" primary disabled={busy || devState === "in_use"} onClick={() => void start()}>
                  {t("Start the test")}
                </Btn>
              </div>
            </>
          )}
          {taken > 0 && (
            <div className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]">
              <p>{t("Results from {{count}} tests arrived.", { count: taken })}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Btn type="button" primary onClick={showResults}>
                  {t("Show the results")}
                </Btn>
              </div>
            </div>
          )}
          <Problem text={st.err} />
        </>
      )}
    </section>
  );
}
