// Two charts, one series color (Pulse, validated for both themes).
// Spark: the reading's last 30 days, latest point dotted. DailyChart: one value per day, hover crosshair + tooltip,
// min–max band for instant metrics, and a table view so identity never rests on the picture alone.
import { useMemo, useState } from "react";
import { t } from "./i18n";
import { Btn } from "./ui";

export interface Pt {
  day: string;
  v: number;
  lo?: number | null;
  hi?: number | null;
}

function scale(pts: Pt[], w: number, h: number, pad: number, left = pad) {
  const vs = pts.flatMap((p) => [p.v, p.lo ?? p.v, p.hi ?? p.v]);
  let min = Math.min(...vs);
  let max = Math.max(...vs);
  if (min === max) [min, max] = [min - 1, max + 1];
  const t0 = Date.parse(pts[0]!.day);
  const t1 = Date.parse(pts[pts.length - 1]!.day);
  const span = Math.max(t1 - t0, 1);
  const x = (d: string) => left + ((Date.parse(d) - t0) / span) * (w - left - pad);
  const y = (v: number) => h - pad - ((v - min) / (max - min)) * (h - 2 * pad);
  return { x, y, min, max };
}

/** `latest`: the newest value as the page shows it (formatted, with its unit), for the accessible name. */
export function Spark({ pts, label, latest }: { pts: Pt[]; label: string; latest?: string }) {
  const w = 120;
  const h = 28;
  if (pts.length < 2) return <svg className="ms-auto h-[26px] w-24" width={w} height={h} role="img" aria-label={t("{{name}}: not enough days for a trend", { name: label })} />;
  const { x, y } = scale(pts, w, h, 4);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.day).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const last = pts[pts.length - 1]!;
  return (
    <svg className="ms-auto h-[26px] w-24" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={t("{{name}}: {{count}} days, latest {{v}}", { name: label, count: pts.length, v: latest ?? last.v })}>
      <path d={d} className="fill-none stroke-primary [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:2]" />
      <circle cx={x(last.day)} cy={y(last.v)} r={4} className="fill-primary stroke-white [stroke-width:2] dark:stroke-black" />
    </svg>
  );
}

export function DailyChart({ pts, unit, fmt }: { pts: Pt[]; unit: string; fmt: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const w = 720;
  const h = 240;
  const pad = 28;
  const left = 56;
  const s = useMemo(() => (pts.length ? scale(pts, w, h, pad, left) : null), [pts]);
  if (!pts.length || !s) return <p className="text-black/55 dark:text-white/55">No daily values in this range yet.</p>;
  const band = pts.some((p) => p.lo != null && p.hi != null && p.lo !== p.hi);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${s.x(p.day).toFixed(1)},${s.y(p.v).toFixed(1)}`).join("");
  const area = band
    ? `M${pts.map((p) => `${s.x(p.day).toFixed(1)},${s.y(p.hi ?? p.v).toFixed(1)}`).join("L")}L${[...pts]
        .reverse()
        .map((p) => `${s.x(p.day).toFixed(1)},${s.y(p.lo ?? p.v).toFixed(1)}`)
        .join("L")}Z`
    : "";
  const ticks = [s.min, (s.min + s.max) / 2, s.max];
  const near = (clientX: number, rect: DOMRect) => {
    const px = ((clientX - rect.left) / rect.width) * w;
    let best = 0;
    pts.forEach((p, i) => {
      if (Math.abs(s.x(p.day) - px) < Math.abs(s.x(pts[best]!.day) - px)) best = i;
    });
    return best;
  };
  const hp = hover === null ? null : pts[hover]!;
  return (
    <figure className="relative mt-4 mb-6">
      <div className="flex justify-end">
        <Btn type="button" link onClick={() => setTable(!table)} aria-pressed={table}>
          {table ? t("Show chart") : t("Show table")}
        </Btn>
      </div>
      {table ? (
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th>{t("Day")}</th>
              <th className="font-semibold tabular-nums">{unit ? t("Value ({{unit}})", { unit }) : t("Value")}</th>
              {band && <th className="font-semibold tabular-nums">{t("Range")}</th>}
            </tr>
          </thead>
          <tbody>
            {[...pts].reverse().map((p) => (
              <tr key={p.day}>
                <td>{p.day}</td>
                <td className="font-semibold tabular-nums">{fmt(p.v)}</td>
                {band && <td className="font-semibold tabular-nums">{p.lo != null && p.hi != null ? `${fmt(p.lo)}–${fmt(p.hi)}` : ""}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="block h-auto w-full"
          role="img"
          aria-label={t("Daily values, {{count}} days", { count: pts.length })}
          onMouseMove={(e) => setHover(near(e.clientX, e.currentTarget.getBoundingClientRect()))}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={w - pad} y1={s.y(t)} y2={s.y(t)} className="stroke-black/10 dark:stroke-white/10" />
              <text x={left - 8} y={s.y(t) + 4} className="fill-black/55 text-xs dark:fill-white/55" textAnchor="end">
                {fmt(t)}
              </text>
            </g>
          ))}
          <text x={left} y={h - 6} className="fill-black/55 text-xs dark:fill-white/55">
            {pts[0]!.day}
          </text>
          <text x={w - pad} y={h - 6} className="fill-black/55 text-xs dark:fill-white/55" textAnchor="end">
            {pts[pts.length - 1]!.day}
          </text>
          {band && <path d={area} className="fill-primary opacity-15" />}
          <path d={line} className="fill-none stroke-primary [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:2]" />
          <circle cx={s.x(pts[pts.length - 1]!.day)} cy={s.y(pts[pts.length - 1]!.v)} r={4} className="fill-primary stroke-white [stroke-width:2] dark:stroke-black" />
          {hp && (
            <g>
              <line x1={s.x(hp.day)} x2={s.x(hp.day)} y1={pad / 2} y2={h - pad} className="stroke-black/50 [stroke-dasharray:2_3] dark:stroke-white/50" />
              <circle cx={s.x(hp.day)} cy={s.y(hp.v)} r={5} className="fill-primary stroke-white [stroke-width:2] dark:stroke-black" />
            </g>
          )}
        </svg>
      )}
      {hp && !table && (
        <figcaption className="ms-14 mt-1 text-black/55 dark:text-white/55 [&_strong]:text-black dark:[&_strong]:text-white" role="status">
          {hp.day}: <strong>{fmt(hp.v)}</strong> {unit}
          {band && hp.lo != null && hp.hi != null ? ` (range ${fmt(hp.lo)}–${fmt(hp.hi)})` : ""}
        </figcaption>
      )}
    </figure>
  );
}
