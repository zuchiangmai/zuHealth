import { useState } from "react";
import { type Metric, type MetricInfo, op } from "../api";
import { unitLabel } from "../format";
import { t, tk } from "../i18n";
import { nameOf } from "../names";
import { isTouch } from "../pickers";
import { Btn, errText, Group, GroupIcon, Heading, MetricPicker, type Page, parseNumber, Problem, Row } from "../ui";
import { Import } from "./import";

/** Add (a tab on a phone), as the web's 记录: a lab report from the camera or a file, or a reading entered by hand
 *  after a search. The other ways in (WHOOP, Apple Health, backups, lab devices) are in Data sources. */
export function AddPage({ go, done }: { go: (p: Page, want?: string) => void; done: (code: string) => void }) {
  const [file, setFile] = useState<string>();
  return (
    <section className="mx-auto w-full max-w-3xl">
      <Heading>{t("Add")}</Heading>
      <Import file={file} onFile={setFile} go={go} kind="report" title={t("Lab report")} part />
      {!file && (
        <>
          <Group className="mt-5">
            <Row color="#43a047" icon={<GroupIcon k="infectious" />} label={t("Lab self-service")} sub={t("A code for a lab device")} onClick={() => go("data", "lab")} />
          </Group>
          <Enter done={done} part />
        </>
      )}
    </section>
  );
}

/** Common measures, one tap away (as the web version's record page). */
const QUICK: [string, string][] = [
  ["loinc:29463-7", tk("Weight")],
  ["loinc:8480-6", tk("Blood pressure, systolic")],
  ["loinc:8462-4", tk("Blood pressure, diastolic")],
  ["loinc:8867-4", tk("Heart rate")],
  ["loinc:2339-0", tk("Blood glucose")],
  ["loinc:8310-5", tk("Body temperature")],
];

function localNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function Enter({ done, part }: { done: (code: string) => void; part?: boolean }) {
  const [m, setM] = useState<MetricInfo>();
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [at, setAt] = useState(localNow());
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pick = async (x: Metric) => {
    let info: MetricInfo;
    try {
      info = await op<MetricInfo>("metric.show", { code: x.code });
    } catch (e) {
      return setErr(errText(e));
    }
    setM(info);
    setUnit(info.units.length === 1 ? (info.units[0] ?? "") : "");
    // a fresh form: now, no value, no old error
    setAt(localNow());
    setValue("");
    setErr(undefined);
  };
  const save = async () => {
    if (!m) return;
    const local = new Date(at);
    const text = m.agg === "none";
    const trimmed = value.trim();
    if (!trimmed) return setErr(t("Type a value."));
    const v = text ? trimmed : parseNumber(trimmed);
    if (!text && !Number.isFinite(v)) return setErr(t("Type a number, such as 72 or 36.6."));
    if (busy) return;
    setBusy(true);
    try {
      await op("manual.enter", {
        entries: [{ metric: m.code, value: v, ...(unit ? { unit } : {}), at: { ms: local.getTime(), tz_min: -local.getTimezoneOffset() } }],
      });
      done(m.code);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="[&_h3]:mt-6">
      {part ? <h3 className="mt-6 mb-1.5 text-[17px] font-semibold">{t("Or enter by hand")}</h3> : <Heading>{t("Enter by hand")}</Heading>}
      {!m ? (
        <>
          <MetricPicker placeholder={t("What did you measure?")} onPick={pick} manual />
          <Problem text={err} />
          <div className="my-3 mb-6 flex flex-wrap gap-2" role="group" aria-label={t("Common measures")}>
            {QUICK.map(([code, label]) => (
              <Btn key={code} type="button" small onClick={() => pick({ code, name: label, unit: "", agg: "instant" })}>
                {t(label)}
              </Btn>
            ))}
          </div>
        </>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <p>
            <strong>{nameOf(m.code, m.name)}</strong>{" "}
            <Btn type="button" link onClick={() => setM(undefined)}>
              {t("Change")}
            </Btn>
          </p>
          <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
            {t("Value")}
            <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" inputMode={m.agg === "none" ? "text" : "decimal"} value={value} onChange={(e) => setValue(e.target.value)} required />
          </label>
          {m.agg !== "none" && value.includes(",") && Number.isFinite(parseNumber(value)) && (
            <p className="text-[13px] text-black/55 dark:text-white/55" role="status">
              {t("Read as {{n}}", { n: parseNumber(value).toLocaleString(undefined, { maximumFractionDigits: 6 }) })}
            </p>
          )}
          {m.units.length > 1 &&
            (isTouch && m.units.length <= 4 ? (
            <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0 [&_legend]:mb-1.5 [&_legend]:text-[13px]">
              <legend>{t("Unit")}</legend>
              {m.units.map((u) => (
                <Btn key={u} type="button" on={unit === u} aria-pressed={unit === u} onClick={() => setUnit(u)}>
                  {unitLabel(u) || u}
                </Btn>
              ))}
            </fieldset>
          ) : (
            <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
              {t("Unit")}
              <select className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={unit} onChange={(e) => setUnit(e.target.value)} required>
                <option value="">{t("Choose the unit on your device")}</option>
                {m.units.map((u) => (
                  <option key={u} value={u}>
                    {unitLabel(u) || u}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
            {t("When")}
            <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required />
          </label>
          <Problem text={err} />
          <Btn type="submit" primary disabled={busy}>
            {t("Save reading")}
          </Btn>
        </form>
      )}
    </section>
  );
}
