import { useCallback, useEffect, useState } from "react";
import { type Batch, type BatchDetail, inBackground, isAndroid, isMobile, op, type Source } from "../api";
import { ago, shortDate, shown, sourceKind, when } from "../format";
import { t } from "../i18n";
import { LabSelfService } from "../lab";
import { nameOf } from "../names";
import { back as goBack, go as nav } from "../router";
import { Btn, card, Chevron, Copy, errText, Group, GroupIcon, Heading, Icon, type Page, PasswordField, Problem, Row, rowBg, Screen, useOp, WebLink, type WhoopStatus } from "../ui";
import { pollFast } from "./account";
import { Enter } from "./add";
import { Import } from "./import";
import { ExportNote, SystemHealthCard } from "./syshealth";
import { usePage } from "../page";

const WHOOP_DASHBOARD = "https://developer-dashboard.whoop.com/";

const SOURCE_SHEETS = ["manage", "whoop", "apple", "health", "report", "lab", "restore", "manual", "file"] as const;

type SourceSheet = (typeof SOURCE_SHEETS)[number];

/** Data sources (as the web's 更多 › 数据来源): managing what is here first, then one row per way data comes
 *  in, each with its live status; the steps open in a sheet. A file dropped on the window opens here. */
export function DataSources({
  file,
  onFile,
  go,
  done,
  want,
  path,
}: {
  file?: string;
  onFile: (p?: string) => void;
  go: (p: Page) => void;
  done: (code: string) => void;
  /** The way in open (#/data/whoop), and the address under it (#/data/manage/ocr/5) */
  want?: string;
  path?: string[];
}) {
  // the way in open is the address's (#/data/whoop), a screen of its own
  const sheet = SOURCE_SHEETS.find((x) => x === want);
  const setSheet = (x: SourceSheet) => nav(`data/${x}`);
  const [batches] = useOp(() => op<Batch[]>("import.list"), []);
  const [whoop] = useOp(() => op<WhoopStatus>("whoop.status"), []);
  const lastOf = (connector: string) => {
    const at = Math.max(0, ...(batches ?? []).filter((b) => b.connector === connector).map((b) => b.at ?? 0));
    return at ? t("Last import {{when}}", { when: shortDate(at) }) : batches ? t("Not imported yet") : undefined;
  };
  const whoopValue =
    whoop?.state === "connected"
      ? whoop.last_sync
        ? t("Synced {{when}}", { when: ago(whoop.last_sync) })
        : t("Connected")
      : whoop?.state === "reauth"
        ? t("Sign in again")
        : t("Not connected");
  const titles: Record<SourceSheet, string> = {
    manage: t("Manage data"),
    whoop: "WHOOP",
    apple: t("Apple Health"),
    health: "Health Connect",
    report: t("Lab report"),
    lab: t("Lab self-service"),
    restore: t("Restore a backup"),
    manual: t("Enter by hand"),
    file: t("Import a file"),
  };
  if (sheet === "manage") return <Sources go={go} path={path ?? []} />;
  if (sheet === "whoop") return <Screen title="WHOOP"><WhoopConnect /></Screen>;
  if (sheet === "lab") return <LabSelfService errText={errText} showResults={() => go("readings")} showIdentity={() => go("account")} pollFast={pollFast} path={path ?? []} />;
  if (sheet === "manual") return <Enter done={done} />;
  // the phone's own store: Health Connect on Android; on an iPhone, Apple Health connected above its export's import
  if (sheet === "health")
    return (
      <Screen title="Health Connect">
        <SystemHealthCard />
      </Screen>
    );
  if (sheet === "apple" && isMobile && !isAndroid)
    return (
      <Screen title={titles.apple}>
        <SystemHealthCard />
        <ExportNote />
        <Import file={file} onFile={onFile} go={go} kind="apple" title={t("Import an export")} part />
      </Screen>
    );
  if (sheet) return <Import file={file} onFile={onFile} go={go} kind={sheet} title={titles[sheet]} />;
  return (
    <section className="mx-auto w-full max-w-3xl">
      <Heading>{t("Data sources")}</Heading>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{(isMobile ? t("Your data on this device.") : t("Your data on this computer. Drop a file anywhere on the window to import it."))}</p>
      <Group>
        <Row
          color="#1e88e5" icon={<Icon k="data" />}
          label={t("Manage data")}
          sub={t("See and delete imports")}
          value={batches ? t("{{count}} imports", { count: batches.length }) : undefined}
          onClick={() => setSheet("manage")}
        />
      </Group>
      <Group>
        <Row color="#e53935" icon={<GroupIcon k="cardio" />} label="WHOOP" sub={whoopValue ?? t("Syncs every hour while PhysiMind is open")} onClick={() => setSheet("whoop")} />
        <Row color="#f4511e" icon={<GroupIcon k="activity" />} label={t("Apple Health")} sub={lastOf("apple_health") ?? t("Export from your iPhone")} onClick={() => setSheet("apple")} />
        {isAndroid && <Row color="#1e88e5" icon={<GroupIcon k="activity" />} label="Health Connect" sub={lastOf("health_connect") ?? t("This phone's health data")} onClick={() => setSheet("health")} />}
        <Row color="#00897b" icon={<GroupIcon k="lab" />} label={t("Lab report")} sub={lastOf("ocr") ?? t("A photo or a PDF")} onClick={() => setSheet("report")} />
        <Row color="#43a047" icon={<GroupIcon k="infectious" />} label={t("Lab self-service")} sub={t("A code for a lab device")} onClick={() => setSheet("lab")} />
        <Row color="#fb8c00" icon={<Icon k="backup" />} label={t("Restore a backup")} sub={t("A .zuhealth file")} onClick={() => setSheet("restore")} />
        <Row color="#7c4dff" icon={<GroupIcon k="body" />} label={t("Enter by hand")} sub={lastOf("manual") ?? t("Write down a reading")} onClick={() => setSheet("manual")} />
      </Group>
    </section>
  );
}

/** Sources whose imports are told apart by the device, lab or room they came from (the web's NAMED). */
const NAMED = new Set(["apple_health", "lab", "room"]);

/** Deleted only as a whole: every sync fetches the last days again, so one sync deleted would come back. */
const WHOLE_ONLY = new Set(["whoop"]);

/** A delete that can't be undone asks twice: what goes, then once more (as the web does). */
function DeleteTwice({ label, title, detail, busy, run }: { label: string; title: string; detail: string; busy: boolean; run: () => void }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  if (step === 0)
    return (
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Btn type="button" danger disabled={busy} onClick={() => setStep(1)}>
          {label}
        </Btn>
      </div>
    );
  return (
    <div className="mt-5 rounded-2xl border border-brand-red/30 bg-brand-red/10 px-4 py-3.5 [&_p]:mb-1.5" role="group" aria-label={step === 1 ? title : t("Delete for good?")}>
      <p>
        <strong>{step === 1 ? title : t("Delete for good?")}</strong>
      </p>
      <p className="text-[13px] text-black/55 dark:text-white/55">{step === 1 ? detail : t("This can't be undone. Backups you saved earlier still have this data.")}</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Btn type="button" autoFocus disabled={busy} onClick={() => setStep(0)}>
          {t("Cancel")}
        </Btn>
        <Btn type="button" danger disabled={busy} onClick={() => (step === 1 ? setStep(2) : run())}>
          {step === 1 ? t("Delete") : t("Delete for good")}
        </Btn>
      </div>
    </div>
  );
}

/** Manage data (the web's 管理数据): each kind of source with how many times data came from it; a kind lists
 *  those imports, newest first; an import shows what it holds now and can be deleted; a kind can be deleted
 *  whole. WHOOP only whole, and is disconnected with it. */
function Sources({ go, path: [kind, id] }: { go: (p: Page) => void; path: string[] }) {
  const [sources, , reloadSources] = useOp(() => op<Source[]>("source.list"), []);
  const [batches, err, reload] = useOp(() => op<Batch[]>("import.list"), []);
  const setKind = (k: string) => nav(`data/manage/${encodeURIComponent(k)}`);
  const open = id ? batches?.find((b) => String(b.import_id) === id) : undefined;
  const setOpen = (b: Batch) => nav(`data/manage/${encodeURIComponent(kind!)}/${b.import_id}`);
  const [msg, setMsg] = useState<string>();
  const [ordering, setOrdering] = useState(false);
  const [erasing, setErasing] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(undefined);
    try {
      await fn();
      setMsg(ok);
      reload();
      reloadSources();
    } catch (e) {
      setMsg(errText(e));
    }
  };
  /** Moves a source one place up by swapping it with the one above (ties included), then numbers them 10, 20, 30… */
  const moveUp = async (i: number) => {
    setOrdering(true);
    await run(async () => {
      const order = [...(sources ?? [])];
      [order[i - 1], order[i]] = [order[i]!, order[i - 1]!];
      for (const [k, s] of order.entries()) if (s.priority !== (k + 1) * 10) await op("source.update", { id: s.id, priority: (k + 1) * 10 });
    }, t("Order saved."));
    setOrdering(false);
  };
  const kinds = new Map<string, Batch[]>();
  for (const b of batches ?? []) kinds.set(b.connector, [...(kinds.get(b.connector) ?? []), b]);
  const last = (list: Batch[]) => Math.max(0, ...list.map((b) => b.at ?? 0));
  const ordered = [...kinds.entries()].sort((a, b) => last(b[1]) - last(a[1]) || a[0].localeCompare(b[0]));
  const status = msg && (
    <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]" role="status">
      {msg}
    </p>
  );

  if (kind && open)
    return (
      <ImportView
        b={open}
        kind={kind}
        device={sources?.find((s) => s.id === open.source_id)?.name}
        go={go}
        erased={() => {
          goBack(`data/manage/${encodeURIComponent(kind)}`);
          setMsg(t("Deleted."));
          reload();
          reloadSources();
        }}
      />
    );
  if (kind) {
    const list = kinds.get(kind) ?? [];
    const whole = WHOLE_ONLY.has(kind);
    const name = sourceKind(kind);
    return (
      <div>
        <Heading space="mb-4">{name}</Heading>
        {status}
        {list.length ? (
          <Group aria-label={name}>
            {list.map((b) => (
              <Row
                key={b.import_id}
                icon={null}
                label={b.at ? when(b.at) : "–"}
                value={
                  b.status === "review" ? (
                    <span className="text-amber-600">{t("waiting for you")}</span>
                  ) : NAMED.has(kind) ? (
                    sources?.find((s) => s.id === b.source_id)?.name
                  ) : (
                    t("{{count}} measures", { count: b.metrics })
                  )
                }
                onClick={() => {
                  setMsg(undefined);
                  setOpen(b);
                }}
              />
            ))}
          </Group>
        ) : (
          <p className="text-black/55 dark:text-white/55">{t("No imports yet.")}</p>
        )}
        {whole && <p className="mt-1 mb-4 px-4 text-[13px] text-black/55 dark:text-white/55">{t("WHOOP fetches the last few days again at every sync, so its data can only be deleted all at once.")}</p>}
        {list.length > 0 && (
          <DeleteTwice
            label={whole ? t("Delete all and disconnect") : t("Delete all")}
            title={t("Delete everything from {{name}}?", { name })}
            detail={
              whole
                ? t("The data of {{count}} syncs will be deleted, and WHOOP disconnected.", { count: list.length })
                : t("The data of {{count}} imports will be deleted.", { count: list.length })
            }
            busy={erasing}
            run={() => {
              if (erasing) return;
              setErasing(true);
              void run(async () => {
                await op("import.erase_source", { connector: kind });
                if (whole) await op("whoop.disconnect");
                goBack("data/manage");
              }, t("Deleted.")).finally(() => setErasing(false));
            }}
          />
        )}
      </div>
    );
  }
  return (
    <div>
      <Heading>{t("Manage data")}</Heading>
      {status}
      <Problem text={err} />
      {batches && !batches.length && <p className="text-black/55 dark:text-white/55">{t("No imports yet.")}</p>}
      {ordered.length > 0 && (
        <>
          <Group aria-label={t("Manage data")}>
            {ordered.map(([k, list]) => (
              <Row
                key={k}
                icon={null}
                label={sourceKind(k)}
                sub={last(list) ? t("Last import {{when}}", { when: shortDate(last(list)) }) : undefined}
                value={t("{{count}} imports", { count: list.length })}
                onClick={() => {
                  setMsg(undefined);
                  setKind(k);
                }}
              />
            ))}
          </Group>
          <p className="mt-1 mb-4 px-4 text-[13px] text-black/55 dark:text-white/55">{t("Open a source to see what each import brought, or to delete it.")}</p>
        </>
      )}
      <details className="group/prio mt-6 mb-4">
        <summary className={`select-none flex min-h-[56px] cursor-pointer list-none items-center gap-3 rounded-3xl px-4 [&::-webkit-details-marker]:hidden ${rowBg}`}>
          <span className="flex-1 text-[16px] font-medium">{t("Source priority")}</span>
          <span className="text-black/40 transition-transform group-open/prio:rotate-90 dark:text-white/40">
            <Chevron open={false} />
          </span>
        </summary>
        <p className="text-[13px] text-black/55 dark:text-white/55">{t("Daily summaries follow the order of this list.")}</p>
        <ol className="p-0">
          {(sources ?? []).map((s, i) => (
            <li key={s.id}>
              <span>
                {s.connector === "manual" ? t("Entered by you") : s.name} <span className="text-[13px] text-black/55 dark:text-white/55">{sourceKind(s.connector)}</span>
              </span>
              <Btn type="button" link disabled={i === 0 || ordering} aria-label={t("Prefer {{name}}", { name: s.name })} onClick={() => moveUp(i)}>
                {t("Move up")}
              </Btn>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

/** One import: what it holds now (a row belongs to the newest import that delivered it), newest first. */
function ImportView({ b, kind, device, go, erased }: { b: Batch; kind: string; device?: string; go: (p: Page) => void; erased: () => void }) {
  const [d, err] = useOp(() => op<BatchDetail>("import.show", { id: b.import_id, limit: 50 }), [b.import_id]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const name = sourceKind(kind);
  const erase = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      await op("import.erase", { id: b.import_id });
      erased();
    } catch (e) {
      setProblem(errText(e));
      setBusy(false);
    }
  };
  return (
    <div>
      <Heading>{b.at ? when(b.at) : name}</Heading>
      {NAMED.has(kind) && device && <p className="text-[13px] text-black/55 dark:text-white/55">{device}</p>}
      <Problem text={err ?? problem} />
      {b.status === "review" ? (
        <p>
          {t("Waiting for you to check. Nothing from it is in your data yet.")}{" "}
          <Btn type="button" link onClick={() => go("review")}>
            {t("Check it")}
          </Btn>
        </p>
      ) : (
        d && (
          <>
            <p className="text-[13px] text-black/55 dark:text-white/55">{t("{{count}} entries", { count: d.rows })}</p>
            {d.items.length > 0 && (
              <Group>
                {d.items.map((p) => {
                  const v = shown(p);
                  return (
                    <li key={`${p.metric}|${p.start_ms}`} className="flex items-center gap-3 px-4 py-3">
                      <span className="me-auto grid min-w-0 gap-px">
                        <strong>{nameOf(p.metric, p.name)}</strong>
                        <span className="text-[13px] text-black/55 dark:text-white/55">{when(p.start_ms, p.tz_min)}</span>
                      </span>
                      <span className="max-w-1/2 truncate text-end">
                        {v.value} {v.unit}
                      </span>
                    </li>
                  );
                })}
              </Group>
            )}
            {d.rows > d.items.length && <p className="mt-1 mb-4 px-4 text-[13px] text-black/55 dark:text-white/55">{t("Showing the newest {{count}}.", { count: d.items.length })}</p>}
          </>
        )
      )}
      {!WHOLE_ONLY.has(kind) && (
        <DeleteTwice
          label={t("Delete this import")}
          title={t("Delete this import's data?")}
          detail={b.status === "review" ? t("The import waiting for you will be deleted.") : t("{{count}} entries will be deleted.", { count: d?.rows ?? 0 })}
          busy={busy || (!d && b.status !== "review")}
          run={erase}
        />
      )}
    </div>
  );
}

/** WHOOP sync with the person's own WHOOP developer app (protocol 6, decision 67): sign-in in the browser,
 *  back to this computer, then hourly while Health is open. */
function WhoopConnect() {
  const [st, setSt] = useState<WhoopStatus>();
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [redirect, setRedirect] = useState("http://localhost:47630/whoop");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const load = useCallback(() => op<WhoopStatus>("whoop.status").then(setSt, (e) => setErr(errText(e))), []);
  useEffect(() => {
    load();
  }, [load]);
  // while this page is on top
  const { active } = usePage();
  useEffect(() => {
    if (st?.state !== "pending" || !active) return;
    const t = setInterval(() => inBackground(load), 3000);
    return () => clearInterval(t);
  }, [st, load, active]);
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
      load();
    }
  };
  const connect = () =>
    run(async () => {
      const b = await op<{ url: string; redirect: string }>("whoop.begin", { client_id: id, client_secret: secret, open: true });
      setRedirect(b.redirect);
      setSecret("");
      setNote(t("WHOOP's sign-in page opened in your browser. PhysiMind finishes when you come back."));
    });
  const sync = () =>
    run(async () => {
      const r = await op<{ written: number }>("whoop.sync", { force: true });
      setNote(r.written ? t("{{count}} new readings from WHOOP.", { count: r.written }) : t("No new WHOOP data."));
    });
  if (!st) return null;
  return (
    <div className={`${card} flex flex-col gap-3`}>
      {st.state === "connected" ? (
        <>
          <p className="text-[13px] text-black/55 dark:text-white/55">
            {st.last_sync
              ? t("Connected. PhysiMind fetches new WHOOP data every hour while it's open; last time {{when}}.", { when: when(st.last_sync) })
              : t("Connected. PhysiMind fetches new WHOOP data every hour while it's open.")}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" disabled={busy} onClick={sync}>
              {busy ? t("Syncing…") : t("Sync now")}
            </Btn>
            <Btn type="button" disabled={busy} onClick={() => run(async () => void (await op("whoop.disconnect")))}>
              {t("Disconnect")}
            </Btn>
          </div>
        </>
      ) : isMobile ? (
        // nothing on a phone opens WHOOP's sign-in or catches its redirect yet (plan D14)
        <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("WHOOP can't be connected on a phone yet. Connect it in PhysiMind on your computer; its data reaches this phone when your devices sync.")}</p>
      ) : st.state === "pending" ? (
        <p className="text-[13px] text-black/55 dark:text-white/55">{t("Waiting for the WHOOP sign-in in your browser…")}</p>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            connect();
          }}
        >
          <p className="text-[13px] text-black/55 dark:text-white/55">
            {st.state === "reauth" ? `${t("WHOOP needs you to sign in again.")} ` : ""}
            {t("Create your own app in the WHOOP developer dashboard, then copy its Client ID and Client Secret here.")}{" "}
            <WebLink url={WHOOP_DASHBOARD} label={t("Open the WHOOP developer dashboard")} />
          </p>
          <p className="text-[13px] text-black/55 dark:text-white/55">
            {t("Add this redirect URL to the app:")} <span className="font-mono text-[13px] break-all">{redirect}</span>{" "}
            <Copy text={redirect} label={t("Copy")} />
          </p>
          <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
            {t("Client ID")}
            <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <PasswordField label={t("Client Secret")} value={secret} onChange={setSecret} auto="off" />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="submit" primary disabled={busy || !id.trim() || !secret.trim()}>
              {t("Connect WHOOP")}
            </Btn>
          </div>
        </form>
      )}
      {note && <p className="text-[13px] text-black/55 dark:text-white/55" role="status">{note}</p>}
      <Problem text={err} />
    </div>
  );
}

// ---- Profile (web personal.tsx): sex and birth month kept on this computer; height and weight are the latest
// readings, and changing one here records a new reading -------------------------------------------------------
