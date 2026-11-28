import { type ReactNode, useState } from "react";
import { op, type Point } from "../api";
import { locale as i18nLocale, t } from "../i18n";
import { BirthWheels, isTouch } from "../pickers";
import { back as goBack, go as nav } from "../router";
import { birthLabel, Btn, errText, Failed, Group, Heading, Item, parseNumber, type Personal, Problem, sexLabel, useOp } from "../ui";

const HEIGHT = "loinc:8302-2";

const WEIGHT = "loinc:29463-7";

type ProfileField = "sex" | "birth" | "height" | "weight";

export function ProfilePage({ want }: { want?: string }) {
  const [me, meErr, reloadMe] = useOp(() => op<Personal>("profile.get"), []);
  const [latest, , reloadLatest] = useOp(() => op<Point[]>("obs.latest"), []);
  const edit = (["sex", "birth", "height", "weight"] as const).find((f) => f === want);
  const setEdit = (f: ProfileField) => nav(`profile/${f}`);
  // the form starts from what is saved: not before it's known (an address opened directly)
  if (edit && !me) return meErr ? <Failed text={meErr} retry={reloadMe} /> : <section aria-busy="true" />;
  if (edit && me)
    return (
      <ProfileEdit
        field={edit}
        me={me}
        done={() => {
          goBack("profile");
          reloadMe();
          reloadLatest();
        }}
      />
    );
  const latestOf = (code: string) => {
    const v = latest?.find((p) => p.metric === code)?.value;
    return typeof v === "number" ? v : undefined;
  };
  const h = latestOf(HEIGHT);
  const w = latestOf(WEIGHT);
  const unset = <span className="text-[13px] text-black/55 dark:text-white/55">{t("Not set")}</span>;
  // as the web shows them: one decimal at most
  const one = (v: number) => (Math.round(v * 10) / 10).toLocaleString(i18nLocale(), { maximumFractionDigits: 1 });
  const rows: { k: ProfileField; label: string; value: ReactNode }[] = [
    { k: "sex", label: t("Sex"), value: sexLabel(me?.sex) ?? unset },
    { k: "birth", label: t("Birth month"), value: me?.birth ? `${birthLabel(me.birth)} · ${t("{{count}} years old", { count: me.age ?? 0 })}` : unset },
    { k: "height", label: t("Height"), value: h !== undefined ? `${one(h * 100)} cm` : unset },
    { k: "weight", label: t("Weight"), value: w !== undefined ? `${one(w)} kg` : unset },
  ];
  return (
    <section className="mx-auto w-full max-w-3xl">
      <Heading>{t("Profile")}</Heading>
      <Group>
        {rows.map((x) => (
          <Item key={x.k} title={x.label} after={x.value} onClick={() => setEdit(x.k)} />
        ))}
      </Group>
    </section>
  );
}

function ProfileEdit({ field, me, done }: { field: ProfileField; me: Personal; done: () => void }) {
  const [year, setYear] = useState(me.birth?.slice(0, 4) ?? "");
  const [month, setMonth] = useState(me.birth ? String(Number(me.birth.slice(5, 7))) : "");
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const now = new Date();
  const run = async (f: () => Promise<unknown>) => {
    setErr(undefined);
    setBusy(true);
    try {
      await f();
      done();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  const measure = (metric: string, unit: string, min: number, max: number) => {
    const v = parseNumber(value);
    if (!Number.isFinite(v) || v < min || v > max) return setErr(t("Type a number between {{min}} and {{max}}.", { min, max }));
    const d = new Date();
    run(() => op("manual.enter", { entries: [{ metric, value: v, unit, at: { ms: d.getTime(), tz_min: -d.getTimezoneOffset() } }] }));
  };
  const title = { sex: t("Sex"), birth: t("Birth month"), height: t("Height"), weight: t("Weight") }[field];
  return (
    <section className="[&_h3]:mt-6">
      <Heading>{title}</Heading>
      {field === "sex" && (
        <>
          <Group role="radiogroup" aria-label={t("Sex")}>
            {(["Female", "Male"] as const).map((s) => (
              <li key={s}>
                <button
                  type="button"
                  className="select-none flex w-full items-center gap-3 px-4 py-3 text-start"
                  role="radio"
                  aria-checked={me.sex === s}
                  disabled={busy}
                  onClick={() => run(() => op("profile.set", { sex: s }))}
                >
                  <span className="me-auto grid min-w-0 gap-px">
                    <strong>{sexLabel(s)}</strong>
                  </span>
                  <span className="min-w-4 text-end font-semibold text-primary" aria-hidden="true">
                    {me.sex === s ? "✓" : ""}
                  </span>
                </button>
              </li>
            ))}
          </Group>
          {me.sex && (
            <Btn type="button" link disabled={busy} onClick={() => run(() => op("profile.set", { sex: null }))}>
              {t("Clear")}
            </Btn>
          )}
        </>
      )}
      {field === "birth" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!year || !month) return setErr(t("Choose a year and a month."));
            run(() => op("profile.set", { birth: `${year}-${month.padStart(2, "0")}` }));
          }}
        >
          {isTouch ? (
            <BirthWheels year={year} month={month} setYear={setYear} setMonth={setMonth} />
          ) : (
            <>
            <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
              {t("Year")}
              <select className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={year} onChange={(e) => setYear(e.target.value)} required>
                <option value="">{t("Choose…")}</option>
                {Array.from({ length: now.getFullYear() - 1900 + 1 }, (_, i) => now.getFullYear() - i).map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
              {t("Month")}
              <select className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={month} onChange={(e) => setMonth(e.target.value)} required>
                <option value="">{t("Choose…")}</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>
                    {new Intl.DateTimeFormat(i18nLocale(), { month: "long", timeZone: "UTC" }).format(Date.UTC(2000, m - 1, 1))}
                  </option>
                ))}
              </select>
            </label>
            </>
          )}
          <Problem text={err} />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="submit" primary disabled={busy}>
              {t("Save")}
            </Btn>
            {me.birth && (
              <Btn type="button" link disabled={busy} onClick={() => run(() => op("profile.set", { birth: null }))}>
                {t("Clear")}
              </Btn>
            )}
          </div>
        </form>
      )}
      {(field === "height" || field === "weight") && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (field === "height") measure(HEIGHT, "cm", 30, 272);
            else measure(WEIGHT, "kg", 1, 650);
          }}
        >
          <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
            {field === "height" ? t("Height (cm)") : t("Weight (kg)")}
            <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus required />
          </label>
          <p className="text-[13px] text-black/55 dark:text-white/55">{t("Saved as a new reading now, entered by you.")}</p>
          <Problem text={err} />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="submit" primary disabled={busy}>
              {t("Save")}
            </Btn>
          </div>
        </form>
      )}
      {field === "sex" && <Problem text={err} />}
    </section>
  );
}
