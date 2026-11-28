import { Segmented, SegmentedButton } from "konsta/react";
import { useEffect, useMemo, useState } from "react";
import { type Day, type MetricInfo, op, type Point, type Source } from "../api";
import { DailyChart } from "../charts";
import { asDuration, dateIn, dayMs, dayUnit, isLabGroup, num, PER_MS_UNITS, shown, when } from "../format";
import { t, tk } from "../i18n";
import { nameOf } from "../names";
import { Btn, DAY, Flag, MetricPicker, sourceLabel, toPts, useOp } from "../ui";

const RANGES = [
  { label: tk("30 days"), days: 30 },
  { label: tk("90 days"), days: 90 },
  { label: tk("1 year"), days: 365 },
  { label: tk("All"), days: 0 },
];

export function Record({ code, pick }: { code?: string; pick: (c: string) => void }) {
  // the shortest range with enough days to show a shape; the person can still choose
  const [range, setRange] = useState<number | null>(null);
  const [info] = useOp(() => (code ? op<MetricInfo>("metric.show", { code }) : Promise.resolve(undefined)), [code]);
  const [allDays] = useOp(() => (code ? op<Day[]>("daily.query", { metric: code }) : Promise.resolve([] as Day[])), [code]);
  // the newest 10 entries show; "Show all" asks for the rest
  const [allEntries, setAllEntries] = useState(false);
  const [points] = useOp(
    () => (code ? op<Point[]>("obs.query", { metric: code, limit: allEntries ? 100_000 : 30, newest_first: true }) : Promise.resolve([])),
    [code, allEntries],
  );
  const [sources] = useOp(() => op<Source[]>("source.list"), []);
  useEffect(() => {
    setRange(null);
    setAllEntries(false);
  }, [code]);
  const auto = useMemo(() => {
    const days = allDays ?? [];
    for (const r of [30, 90, 365]) if (days.filter((d) => dayMs(d.day) >= Date.now() - r * DAY).length >= 7) return r;
    return 0;
  }, [allDays]);
  const span = range ?? auto;
  const days = (allDays ?? []).filter((d) => !span || dayMs(d.day) >= Date.now() - span * DAY);
  const recent = points ?? [];
  if (!code)
    return (
      <section className="mx-auto w-full max-w-3xl">
        <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{t("History")}</h2>
        <MetricPicker placeholder={t("Search measures, e.g. weight")} onPick={(m) => pick(m.code)} />
      </section>
    );
  const agg = info?.agg ?? "instant";
  const pts = toPts(agg, days);
  const unit = dayUnit(agg, info?.unit ?? "");
  const vals = pts.map((p) => p.v);
  // highs and lows of every reading, not of daily means (heart rate: many readings a day)
  const lows = agg === "instant" ? days.map((d) => d.min).filter((v): v is number => v !== null) : vals;
  const highs = agg === "instant" ? days.map((d) => d.max).filter((v): v is number => v !== null) : vals;
  const lab = isLabGroup(recent[0]?.group);
  // durations read as hours and minutes everywhere: stats, axis, tooltip, table (interval days are in hours)
  // durations of a minute or more read as hours and minutes (as tiles do); HRV's 40 ms stays "40 ms"
  const big = (u: string) => vals.length > 0 && asDuration(Math.max(...vals.map(Math.abs)), u, true) !== undefined;
  const dur = agg === "interval" || ((agg === "instant" || agg === "cumulative") && PER_MS_UNITS.has(info?.unit ?? "") && big(info?.unit ?? ""));
  // lab: no more decimals than the reports printed (an average must not grow six of them)
  const places = Math.max(0, ...recent.map((p) => (typeof p.value === "number" ? (String(p.value).split(".")[1]?.length ?? 0) : 0)));
  const labNum = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: Math.min(places, 6) });
  const fmt = (v: number) =>
    !dur ? (lab ? labNum(v) : num(v)) : agg === "interval" ? (asDuration(v, "h") ?? num(v)) : (asDuration(v, info!.unit) ?? num(v));
  const shownUnit = dur ? "" : unit;
  const ref = recent.find((p) => p.detail?.ref || (p.detail?.printed as { ref?: string } | undefined)?.ref);
  const refText = (ref?.detail?.ref ?? (ref?.detail?.printed as { ref?: string } | undefined)?.ref) as string | undefined;
  const sourceName = (id: number) => {
    return sourceLabel(sources?.find((s) => s.id === id));
  };
  return (
    <section className="[&_h3]:mt-6">
      <h2 className="mb-1 text-[28px] leading-tight font-bold tracking-tight">{info ? nameOf(info.code, info.name) : code}</h2>
      <p className="text-[13px] text-black/55 dark:text-white/55" title={code}>
        {info && nameOf(info.code, info.name) !== info.name ? info.name : code}
      </p>
      <Segmented strong rounded className="mt-3" role="group" aria-label={t("Range")}>
        {RANGES.map((r) => (
          <SegmentedButton key={r.label} active={span === r.days} aria-pressed={span === r.days} onClick={() => setRange(r.days)}>
            {t(r.label)}
          </SegmentedButton>
        ))}
      </Segmented>
      {vals.length > 0 && (
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 [&_dd]:m-0 [&_dd]:text-xl [&_dd]:font-semibold [&_dt]:text-xs [&_dt]:text-black/55 dark:[&_dt]:text-white/55">
          <div>
            <dt>{t("Average")}</dt>
            <dd>
              {fmt(vals.reduce((a, b) => a + b, 0) / vals.length)} <span className="ms-0.5 text-[0.65em] font-medium text-black/55 dark:text-white/55">{shownUnit}</span>
            </dd>
          </div>
          <div>
            <dt>{t("Lowest")}</dt>
            <dd>
              {fmt(Math.min(...lows))} <span className="ms-0.5 text-[0.65em] font-medium text-black/55 dark:text-white/55">{shownUnit}</span>
            </dd>
          </div>
          <div>
            <dt>{t("Highest")}</dt>
            <dd>
              {fmt(Math.max(...highs))} <span className="ms-0.5 text-[0.65em] font-medium text-black/55 dark:text-white/55">{shownUnit}</span>
            </dd>
          </div>
          <div>
            <dt>{t("Days with data")}</dt>
            <dd>{vals.length}</dd>
          </div>
          {refText && (
            <div>
              <dt>{t("Reference range")}</dt>
              <dd>{refText}</dd>
            </div>
          )}
        </dl>
      )}
      <DailyChart pts={pts} unit={shownUnit} fmt={fmt} />
      <h3 className="mb-2 text-[17px] font-semibold">{t("Latest entries")}</h3>
      <table className="w-full text-sm">
        <tbody>
          {(allEntries ? recent : recent.slice(0, 10)).map((p) => {
            const s = shown(p);
            return (
              <tr key={`${p.start_ms}-${p.source_id}`}>
                <td className="px-2 py-1.5 align-top">{p.detail?.precision === "day" ? dateIn(p.start_ms, p.tz_min) : when(p.start_ms, p.tz_min)}</td>
                <td className="text-[13px] text-black/55 dark:text-white/55">{sourceName(p.source_id)}</td>
                <td className="font-semibold tabular-nums font-medium">
                  {s.value} <span className="ms-0.5 text-[0.65em] font-medium text-black/55 dark:text-white/55">{s.unit}</span>
                  <Flag p={p} />
                  {p.corrected && <span className="text-[13px] text-black/55 dark:text-white/55"> {t("corrected")}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!allEntries && recent.length > 10 && (
        <Btn type="button" link onClick={() => setAllEntries(true)}>
          {t("Show all entries")}
        </Btn>
      )}
    </section>
  );
}
