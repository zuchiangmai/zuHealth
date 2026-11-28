import { useCallback, useEffect, useRef, useState } from "react";
import { type BatchDetail, type Grant, type MetricInfo, type OcrItem, op } from "../api";
import { day, resultText, unitLabel, when } from "../format";
import { t } from "../i18n";
import { nameOf } from "../names";
import { Btn, card, Chevron, errText, Group, Heading, Item, MetricPicker, Problem, useOp } from "../ui";
import { justRead } from "./import";

type OcrPick = { code?: string; new?: boolean; skip?: boolean; unit?: string };

/** One lab report waiting for review: each printed result → a measure (suggested, searched, or new) and its
 *  unit, or skipped; the test date for all of them. The core applies the rules (units, duplicates). */
function OcrReview({ b, done, discard }: { b: BatchDetail; done: (text: string) => void; discard: () => void }) {
  const c = b.candidates as { at: number; dated?: boolean; items: OcrItem[] };
  // no date on the report: the person sets it (the import time isn't the test date)
  const [date, setDate] = useState(c.dated === false ? "" : day(c.at));
  const [picks, setPicks] = useState<OcrPick[]>(() => c.items.map((it) => (it.code ? { code: it.code } : {})));
  const [other, setOther] = useState<number>();
  const [info, setInfo] = useState<Record<string, MetricInfo>>({});
  /** "<code className="font-mono text-[0.9em]"> <printed unit>" → the measure's unit the printed one maps to ("" when none fits), from the core */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  // what couldn't be looked up: not asked again (a failure written into the state would ask in a loop)
  const failed = useRef(new Set<string>());
  // names and units of every measure on offer
  useEffect(() => {
    const codes = new Set<string>();
    c.items.forEach((it, i) => {
      if (it.code) codes.add(it.code);
      for (const s of it.suggest ?? []) codes.add(s.code);
      const p = picks[i]?.code;
      if (p) codes.add(p);
    });
    const missing = [...codes].filter((x) => !info[x] && !failed.current.has(x));
    for (const x of missing) failed.current.add(x);
    if (missing.length)
      Promise.all(missing.map((code) => op<MetricInfo>("metric.show", { code }).then((m) => [code, m] as const, () => null))).then((got) => {
        const ok = got.filter((g): g is readonly [string, MetricInfo] => !!g);
        for (const [code] of ok) failed.current.delete(code);
        if (ok.length) setInfo((old) => ({ ...old, ...Object.fromEntries(ok) }));
      });
    // which unit each chosen measure would take the printed one as
    const want = c.items.flatMap((it, i) => {
      const code = picks[i]?.code;
      const key = `${code} ${it.unit}`;
      return code && picked[key] === undefined && !failed.current.has(key) ? [[code, it.unit] as const] : [];
    });
    for (const [code, unit] of want) failed.current.add(`${code} ${unit}`);
    if (want.length)
      Promise.all(
        want.map(([code, unit]) =>
          op<MetricInfo & { picked_unit?: string }>("metric.show", { code, printed_unit: unit }).then(
            (m): readonly [string, string] => [`${code} ${unit}`, m.picked_unit ?? ""],
            () => null,
          ),
        ),
      ).then((got) => {
        const ok = got.filter((g): g is readonly [string, string] => !!g);
        for (const [key] of ok) failed.current.delete(key);
        if (ok.length) setPicked((old) => ({ ...old, ...Object.fromEntries(ok) }));
      });
  }, [picks, c.items, info, picked]);
  const set = (i: number, p: OcrPick) => setPicks((old) => old.map((x, k) => (k === i ? p : x)));
  /** a numeric measure whose units don't include the printed one: the person must choose */
  const needsUnit = (i: number) => {
    const p = picks[i];
    const m = p?.code ? info[p.code] : undefined;
    if (!p?.code || !m || m.agg === "none" || m.agg === "interval" || !m.units.some((u) => u)) return false;
    return !p.unit && picked[`${p.code} ${c.items[i]!.unit}`] === "";
  };
  const count = picks.filter((p, i) => !p.skip && (p.code || p.new) && !needsUnit(i)).length;
  const save = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const choices = picks.map((p) => (p.skip ? { skip: true } : p.new ? { new: true } : p.code ? { code: p.code, ...(p.unit ? { unit: p.unit } : {}) } : {}));
      const r = await op<{ saved: number; left: number; created: number }>("review.confirm_ocr", {
        id: b.import_id,
        choices,
        date,
        tz_min: -new Date(`${date}T12:00`).getTimezoneOffset(),
      });
      done(
        (r.created
          ? t("Saved {{count}} results, with {{created}} new measures.", { count: r.saved, created: r.created })
          : t("Saved {{count}} results.", { count: r.saved })) +
          (r.left ? ` ${t("{{n}} left out: no measure, or a unit that doesn't fit it.", { n: r.left })}` : ""),
      );
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const label = (code: string) => (info[code] ? nameOf(code, info[code]!.name) : code);
  // as the web's review card: only what needs the person is listed; what matched by itself folds into one line
  const [unmatched] = useState(() => c.items.flatMap((it, i) => (it.code ? [] : [i])));
  const [open, setOpen] = useState<number>();
  const [showMatched, setShowMatched] = useState(false);
  const todo = c.items.flatMap((_, i) => (unmatched.includes(i) || needsUnit(i) ? [i] : []));
  const matched = c.items.flatMap((_, i) => (todo.includes(i) ? [] : [i]));
  const left = picks.filter((p) => !p.skip && !p.code && !p.new).length;
  const choose = (i: number, p: OcrPick) => {
    set(i, p);
    setOpen(undefined);
    setOther(undefined);
  };
  const item = (i: number) => {
    const it = c.items[i]!;
    const p = picks[i] ?? {};
    const m = p.code ? info[p.code] : undefined;
    const numeric = m && m.agg !== "none" && m.agg !== "interval";
    const offered = [...new Set([...(it.code ? [it.code] : []), ...(it.suggest ?? []).map((x) => x.code), ...(p.code ? [p.code] : [])])];
    const state = p.skip ? t("Skipped") : p.new ? t("New measure") : p.code ? label(p.code) : t("Choose a measure");
    return (
      <li key={i} className={p.skip ? "opacity-50" : ""}>
        <button type="button" className="select-none flex min-h-[64px] w-full items-center gap-3 px-4 py-2.5 text-start transition-colors active:bg-black/5 dark:active:bg-white/10" aria-expanded={open === i} onClick={() => setOpen(open === i ? undefined : i)}>
          <span className="min-w-0 flex-1">
            <strong>{it.name}</strong>
            <span className="text-[13px] text-black/55 dark:text-white/55">
              {state}
              {it.ref ? ` · ${t("Reference {{ref}}", { ref: it.ref })}` : ""}
            </span>
          </span>
          <span className="shrink-0 text-end text-[17px] font-semibold tabular-nums">
            {it.cmp ?? ""}
            {String(it.v)}
            <span className="ms-1 block text-[12px] font-normal text-black/55 dark:text-white/55">{it.unit}</span>
            {it.flag && (
              <span className="ms-1 text-xs font-semibold text-amber-600" title={it.flag === "H" ? t("Marked high") : t("Marked low")}>
                {it.flag === "H" ? "↑" : "↓"}
              </span>
            )}
          </span>
        </button>
        {open === i && (
          <div className="flex flex-wrap gap-2 px-4 pb-3 [&>label]:basis-full" role="group" aria-label={t("Measure for {{name}}", { name: it.name })}>
            {offered.map((code) => (
              <Btn key={code} type="button" on={p.code === code} aria-pressed={p.code === code} onClick={() => choose(i, { code })}>
                {label(code)}
              </Btn>
            ))}
            <Btn type="button" aria-pressed={!!p.new} on={p.new} onClick={() => choose(i, { new: true })}>
              {t("New measure “{{name}}”", { name: it.name })}
            </Btn>
            <Btn type="button" onClick={() => setOther(i)}>
              {t("Another measure…")}
            </Btn>
            <Btn type="button" onClick={() => choose(i, p.skip ? (it.code ? { code: it.code } : {}) : { skip: true })}>
              {p.skip ? t("Restore") : t("Skip")}
            </Btn>
            {other === i && <MetricPicker placeholder={t("Search measures")} onPick={(x) => choose(i, { code: x.code })} />}
            {numeric && m.units.some((u) => u) && (m.units.length > 1 || needsUnit(i)) && (
              <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
                {t("Unit")}
                <select className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" aria-label={t("Unit for {{name}}", { name: it.name })} value={p.unit ?? ""} onChange={(e) => set(i, { ...p, unit: e.target.value || undefined })}>
                  <option value="">{picked[`${p.code} ${it.unit}`] ? t("As printed ({{unit}})", { unit: it.unit }) : t("Choose the unit…")}</option>
                  {m.units.map((u) => (
                    <option key={u} value={u}>
                      {unitLabel(u) || u}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
      </li>
    );
  };
  return (
    <div className="mb-8">
      <h3 className="mb-3 text-[20px] font-semibold">{t("Lab report")}</h3>
      <Group>
        <Item
          title={t("Test date")}
          after={<input className="rounded-lg bg-black/5 px-2 py-1 text-[15px] text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}
        />
      </Group>
      {c.dated === false && <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]">{t("The date wasn't found on the report. Set the day the sample was taken.")}</p>}
      <p className="mb-4 px-1 text-[15px] text-black/55 dark:text-white/55">
        {todo.length
          ? t("{{n}} results, {{k}} matched by themselves.", { n: c.items.length, k: matched.length })
          : t("{{n}} results, all matched by themselves. Check them against the report before saving.", { n: c.items.length })}
      </p>
      {todo.length > 0 && <Group title={t("Needs you ({{n}})", { n: todo.length })}>{todo.map(item)}</Group>}
      {/* what matched by itself folds into one row (as the web's): open it to check or change */}
      {matched.length > 0 && (
        <Group>
          <button type="button" className="select-none flex min-h-[56px] w-full items-center gap-3 px-4 text-start" aria-expanded={showMatched} onClick={() => setShowMatched(!showMatched)}>
            <span className="flex-1 text-[16px] font-medium">{t("{{n}} matched", { n: matched.length })}</span>
            <span className="text-black/40 dark:text-white/40">
              <Chevron open={showMatched} />
            </span>
          </button>
          {showMatched && matched.map(item)}
        </Group>
      )}
      <Problem text={err} />
      {left > 0 && <p className="mb-2 px-1 text-[13px] text-black/55 dark:text-white/55">{t("{{n}} not handled: they won't be saved.", { n: left })}</p>}
      <Btn type="button" primary className="w-full!" disabled={busy || !count || !date} onClick={save}>
        {t("Save {{count}} results", { count })}
      </Btn>
      <div className="mt-1 flex justify-center">
        <Btn type="button" link danger onClick={discard}>
          {t("Discard this report")}
        </Btn>
      </div>
    </div>
  );
}

export function Review() {
  const [items, err, reload] = useOp(() => op<BatchDetail[]>("review.list"), []);
  const [grants] = useOp(() => op<Grant[]>("grant.list"), []);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  // one at a time: a second tap while the first is on its way would act on what is already gone
  const acting = useRef(false);
  const act = async (name: string, id: number, ok: string) => {
    if (acting.current) return;
    acting.current = true;
    try {
      await op(name, { id });
      setMsg({ ok: true, text: ok });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      acting.current = false;
    }
  };
  // which agent proposed it: its writer key (older proposals: "g<grant id>")
  const agent = (by?: unknown) => grants?.find((g) => g.writer === by || `g${g.id}` === by)?.name;
  if (err) return <Problem text={err} />;
  return (
    <section className="mx-auto w-full max-w-3xl">
      <Heading>{t("Waiting for you")}</Heading>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Nothing here is visible in your readings until you confirm it.")}</p>
      {msg &&
        (msg.ok ? (
          <p className="text-[13px] text-black/55 dark:text-white/55" role="status">
            {msg.text}
          </p>
        ) : (
          <Problem text={msg.text} />
        ))}
      {items && !items.length && <p className="text-black/55 dark:text-white/55">{t("Nothing is waiting.")}</p>}
      {[...(items ?? [])].sort((a, b) => Number(b.import_id === justRead) - Number(a.import_id === justRead)).map((b) => {
        if (b.candidates?.kind === "ocr")
          return (
            <OcrReview
              key={b.import_id}
              b={b}
              done={(text) => (setMsg({ ok: true, text }), reload())}
              discard={() => act("review.discard", b.import_id, t("Discarded."))}
            />
          );
        if (b.candidates?.kind === "result")
          return (
            <ResultReview
              key={b.import_id}
              b={b}
              done={(text) => (setMsg({ ok: true, text }), reload())}
              discard={() => act("review.discard", b.import_id, t("Discarded."))}
            />
          );
        const proposal = b.candidates?.kind === "proposal";
        const rows = (b.candidates?.rows ?? []) as { metric: string; start_ms: number; tz_min?: number; value: unknown; unit?: string }[];
        const by = proposal ? agent(b.candidates?.by) : undefined;
        return (
          <div key={b.import_id} className={`${card}`}>
            <h3 className="mb-2 text-[17px] font-semibold">{proposal ? (by ? t("Proposed by {{name}}", { name: by }) : t("Proposed by an agent")) : t("From a lab report photo")}</h3>
            {b.candidates?.note && <p>“{b.candidates.note}”</p>}
            {proposal ? (
              <table className="w-full text-sm">
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.metric}-${r.start_ms}`}>
                      <td title={r.metric}>{nameOf(r.metric, r.metric)}</td>
                      <td className="px-2 py-1.5 align-top">{when(r.start_ms, r.tz_min)}</td>
                      <td className="font-semibold tabular-nums">
                        {typeof r.value === "string" ? resultText(r.value) : String(r.value)} <span className="ms-0.5 text-[0.65em] font-medium text-black/55 dark:text-white/55">{unitLabel(r.unit ?? "")}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-[13px] text-black/55 dark:text-white/55">{t("Matching lab items to measures arrives with photo import.")}</p>
            )}
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              {proposal && (
                <Btn type="button" primary onClick={() => act("review.confirm", b.import_id, t("Added to your readings."))}>
                  {t("Add to my readings")}
                </Btn>
              )}
              <Btn type="button" onClick={() => act("review.discard", b.import_id, t("Discarded."))}>
                {t("Discard")}
              </Btn>
            </div>
          </div>
        );
      })}
    </section>
  );
}

type ResultLine = { code: string; v: unknown; u?: string; t?: number };

type LineState = { metric?: MetricInfo; unit: string; skip: boolean };

const numericAgg = (m: MetricInfo) => m.agg !== "none" && m.agg !== "interval";

/** A result sent to the account whose measure or unit Health couldn't settle (protocol 2.3 step 4): a measure
 *  and unit per line, or skip it (W review-form.ts). Known codes and fitting units come preselected. */
function ResultReview({ b, done, discard }: { b: BatchDetail; done: (text: string) => void; discard: () => void }) {
  const c = b.candidates as unknown as { src: string; at: number; tz: number; lines: ResultLine[] };
  const [lines, setLines] = useState<LineState[]>(() => c.lines.map(() => ({ unit: "", skip: false })));
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const choose = useCallback(
    async (i: number, code: string) => {
      const l = c.lines[i]!;
      const m = await op<MetricInfo & { picked_unit?: string }>("metric.show", { code, ...(l.u ? { printed_unit: l.u } : {}) });
      setLines((ls) => ls.map((s, j) => (j === i ? { metric: m, unit: numericAgg(m) ? (m.picked_unit ?? "") : "", skip: false } : s)));
    },
    [c.lines],
  );
  // codes Health knows are preselected, once per batch: a reload of the list mustn't undo the person's choices
  const preselected = useRef<number>(undefined);
  useEffect(() => {
    if (preselected.current === b.import_id) return;
    preselected.current = b.import_id;
    c.lines.forEach((l, i) => {
      choose(i, l.code).catch(() => {});
    });
  }, [b.import_id, c.lines, choose]);
  const ready = lines.every((s) => s.skip || (s.metric && (!numericAgg(s.metric) || s.metric.units.length === 0 || s.unit))) && lines.some((s) => !s.skip);
  const save = async () => {
    setErr(undefined);
    setBusy(true);
    try {
      const choices = lines.map((s) => (s.skip ? { skip: true } : { code: s.metric?.code, ...(s.unit ? { unit: s.unit } : {}) }));
      const r = await op<{ written: number }>("review.confirm_result", { id: b.import_id, choices });
      done(t("Saved {{count}} readings.", { count: r.written }));
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  const [kind, device] = [c.src.split(":")[0], c.src.split(":").slice(1).join(":")];
  const from =
    kind === "lab" ? t("Lab device {{id}}", { id: device }) : kind === "staff" ? t("Service desk {{id}}", { id: device }) : t("Room {{id}}", { id: device });
  return (
    <div className={`${card}`}>
      <h3 className="mb-2 text-[17px] font-semibold">{t("A result from {{from}}", { from })}</h3>
      <p className="text-[13px] text-black/55 dark:text-white/55">
        {when(c.at, c.tz)}
        {t(".")} {t("Choose what each line is, or skip it.")}
      </p>
      <table className="w-full text-sm">
        <tbody>
          {c.lines.map((l, i) => {
            const s = lines[i]!;
            return (
              <tr key={`${l.code}-${i}`} className={s.skip ? "opacity-50" : undefined}>
                <td className="font-mono text-[13px] break-all">{l.code}</td>
                <td className="font-semibold tabular-nums">
                  {String(l.v)} <span className="ms-0.5 text-[0.65em] font-medium text-black/55 dark:text-white/55">{unitLabel(l.u ?? "")}</span>
                </td>
                <td className="px-2 py-1.5 align-top">
                  {s.metric ? (
                    <span>
                      {nameOf(s.metric.code, s.metric.name)}{" "}
                      <Btn
                        type="button"
                        link
                        onClick={() => setLines((ls) => ls.map((x, j) => (j === i ? { unit: "", skip: false } : x)))}
                      >
                        {t("Change")}
                      </Btn>
                    </span>
                  ) : (
                    <MetricPicker placeholder={t("Which measure is this?")} onPick={(m) => choose(i, m.code)} />
                  )}
                </td>
                <td className="px-2 py-1.5 align-top">
                  {s.metric && numericAgg(s.metric) && (s.metric.units.length > 1 || (s.metric.units.length === 1 && !s.unit)) && (
                    <select className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white"
                      aria-label={t("Unit for {{name}}", { name: l.code })}
                      value={s.unit}
                      onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}
                    >
                      <option value="">{t("Unit…")}</option>
                      {s.metric.units.map((u) => (
                        <option key={u} value={u}>
                          {unitLabel(u)}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="px-2 py-1.5 align-top">
                  <label className="flex items-center gap-2">
                    <input className="h-4 w-4 shrink-0 accent-primary"
                      type="checkbox"
                      checked={s.skip}
                      onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, skip: e.target.checked } : x)))}
                    />
                    {t("Skip")}
                  </label>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Problem text={err} />
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Btn type="button" primary disabled={!ready || busy} onClick={save}>
          {busy ? t("Saving…") : t("Save to my readings")}
        </Btn>
        <Btn type="button" onClick={discard}>
          {t("Discard")}
        </Btn>
      </div>
    </div>
  );
}
