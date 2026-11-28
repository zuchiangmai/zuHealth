import { type ReactNode, useState } from "react";
import { type FdSession, type Measurement } from "../api";
import { num, shortDate, unitLabel, when } from "../format";
import { t } from "../i18n";
import { nameOf } from "../names";
import { Btn, C, fdBest, fdStart, figure, fixed, Group } from "../ui";

/** The figure each test's best jump is picked by (the core's labs::key_of) */
const FD_KEY: Record<string, string> = { cmj: "x:fd/cmj/jump_height_imp_mom" };

/** A test's rows, in the web's order (FD_BY_TEST), with their unit */
const FD_ROWS: Record<string, [string, string][]> = {
  cmj: [
    ["x:fd/cmj/jump_height_imp_mom", "cm"],
    ["x:fd/cmj/jump_height_flight_time", "cm"],
    ["x:fd/cmj/rsi_modified", "m/s"],
    ["x:fd/cmj/flight_time", "ms"],
    ["x:fd/cmj/contraction_time", "ms"],
    ["x:fd/cmj/eccentric_duration", "ms"],
    ["x:fd/cmj/concentric_duration", "ms"],
    ["x:fd/cmj/peak_power", "W"],
    ["x:fd/cmj/peak_power_bm", "W/kg"],
    ["x:fd/cmj/concentric_mean_force_bm", "N/kg"],
    ["x:fd/cmj/concentric_impulse", "N.s"],
    ["x:fd/cmj/countermovement_depth", "cm"],
    ["x:fd/cmj/concentric_peak_velocity", "m/s"],
    ["x:fd/cmj/eccentric_braking_rfd", "N/s"],
    ["x:fd/cmj/body_mass", "kg"],
  ],
};

/** Trends need this many sessions: two points look like a broken divider (the web's TREND_MIN) */
const TREND_MIN = 3;

const testLabel = (test: string) => (test === "cmj" ? t("Countermovement jump (CMJ)") : test.toUpperCase());

/** A jump's key figure with its unit, as lists tell jumps apart */
function keyText(s: FdSession, k: number): string {
  const code = FD_KEY[s.test];
  const v = code ? figure(s.trials[k], code) : null;
  const unit = FD_ROWS[s.test]?.find(([c]) => c === code)?.[1] ?? "";
  return v === null ? "–" : `${num(v)} ${unitLabel(unit)}`.trim();
}

/** The session before session i of the same test and device (sessions newest first) */
const previousOf = (list: FdSession[], i: number) => list.slice(i + 1).find((p) => p.test === list[i]!.test && p.device === list[i]!.device);

function deltaOf(list: FdSession[], i: number, code: string): number | null {
  const p = previousOf(list, i);
  const a = figure(fdBest(list[i]!), code);
  const b = p ? figure(fdBest(p), code) : null;
  return a === null || b === null ? null : a - b;
}

function trendOf(list: FdSession[], i: number, code: string): { v: number; at: number }[] {
  const s = list[i]!;
  const out: { v: number; at: number }[] = [];
  for (let k = list.length - 1; k >= i; k--) {
    const p = list[k]!;
    if (p.test !== s.test || p.device !== s.device) continue;
    const v = figure(fdBest(p), code);
    if (v !== null) out.push({ v, at: fdStart(p) });
  }
  return out;
}

function Delta({ d, unit }: { d: number | null; unit: string }) {
  if (d === null || num(Math.abs(d)).replace(/[0.,\s]/g, "") === "") return null;
  const text = `${d > 0 ? "↑" : "↓"} ${num(Math.abs(d))}`;
  return (
    <span className="ms-2.5 text-xs font-normal text-black/55 dark:text-white/55" role="img" aria-label={t("Compared with last time: {{d}}", { d: `${d > 0 ? "+" : "−"}${num(Math.abs(d))} ${unit}`.trim() })}>
      {t("vs last time")} {text}
    </span>
  );
}

function FdTrend({ list, i, code }: { list: FdSession[]; i: number; code: string }) {
  const pts = trendOf(list, i, code);
  if (pts.length < TREND_MIN) return null;
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const xy = pts.map((p, k) => ({ x: (k / (pts.length - 1)) * 100, y: hi === lo ? 50 : 90 - ((p.v - lo) / (hi - lo)) * 80 }));
  return (
    <figure className="mt-2 text-primary" aria-label={t("Trend over {{count}} tests", { count: pts.length })}>
      <div className="relative mx-1 h-16 [&_svg]:h-full [&_svg]:w-full [&_svg]:overflow-visible">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={xy.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* round dots over the stretched line, this test's filled */}
        {xy.map((p, k) => (
          <span key={pts[k]!.at} className={`absolute -ms-[3.5px] -mt-[3.5px] h-[7px] w-[7px] rounded-full border-[1.5px] border-current ${k === xy.length - 1 ? "bg-current" : "bg-white dark:bg-neutral-900"}`} style={{ left: `${p.x}%`, top: `${p.y}%` }} />
        ))}
      </div>
      <figcaption className="text-[13px] text-black/55 dark:text-white/55">
        <span>{shortDate(pts[0]!.at)}</span>
        <span>{t("This test")}</span>
      </figcaption>
    </figure>
  );
}

/** VALD ForceDecks tests: the latest by default; each jump can be opened; the best jump against the previous
 *  best of the same test; a trend from three tests; every test in History. `names`: the catalog's names of the
 *  measures (from the dashboard's readings), for the English list. */
export function FdReport({ sessions, names }: { sessions: FdSession[]; names?: Record<string, string> }) {
  const [i, setI] = useState(0);
  const [jump, setJump] = useState<number | null>(null);
  const [hist, setHist] = useState(false);
  const at = Math.min(i, Math.max(0, sessions.length - 1));
  const cur = sessions[at];
  if (!cur)
    return (
      <div className="flex flex-col gap-3">
        <h3 className="mb-2 text-[17px] font-semibold">{t("No VALD ForceDecks tests yet")}</h3>
        <p className="text-[13px] text-black/55 dark:text-white/55">{t("After a test on VALD ForceDecks at the lab, the results show here.")}</p>
      </div>
    );
  const k = jump !== null && jump < cur.trials.length ? jump : cur.best;
  const tr = cur.trials[k]!;
  const onBest = k === cur.best;
  const pick = (n: number) => {
    setI(n);
    setJump(null);
    setHist(false);
  };
  return (
    <div className="[&_h4]:mt-3 [&_h4]:mb-1">
      <header className="mb-3 flex items-start justify-between gap-4 [&_h3]:m-0 [&_p]:m-0">
        <div>
          <h3 className="mb-2 text-[17px] font-semibold">{t("VALD ForceDecks tests")}</h3>
          <p className="text-[13px] text-black/55 dark:text-white/55">VALD ForceDecks · {when(fdStart(cur))}</p>
        </div>
        <Btn type="button" aria-expanded={hist} onClick={() => setHist(!hist)}>
          {t("History")}
        </Btn>
      </header>
      {hist && (
        <Group aria-label={t("Test history")}>
          {sessions.map((s, n) => (
            <li key={`${s.device}|${s.test}|${fdStart(s)}`}>
              <button type="button" className="select-none flex w-full items-center gap-3 px-4 py-3 text-start" aria-current={n === at ? "true" : undefined} onClick={() => pick(n)}>
                <span className="me-auto grid min-w-0 gap-px">
                  <strong>{when(fdStart(s))}</strong>
                  <span className="text-[13px] text-black/55 dark:text-white/55">
                    {testLabel(s.test)} · {t("{{count}} jumps", { count: s.trials.length })} · {keyText(s, s.best)}
                  </span>
                </span>
                {n === 0 && <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs whitespace-nowrap text-black/60 dark:bg-white/10 dark:text-white/60">{t("Latest")}</span>}
                {n === at && <span aria-hidden="true">✓</span>}
              </button>
            </li>
          ))}
        </Group>
      )}
      {at > 0 && (
        <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px] flex items-center justify-between gap-4" role="status">
          <span>{t("Viewing the test of {{date}}", { date: when(fdStart(cur)) })}</span>
          <Btn type="button" onClick={() => pick(0)}>
            {t("Back to the latest")}
          </Btn>
        </p>
      )}
      <section aria-label={testLabel(cur.test)}>
        <h4 className="mb-1 text-[15px] font-semibold">
          {testLabel(cur.test)} <span className="text-[13px] text-black/55 dark:text-white/55">{t("{{count}} jumps", { count: cur.trials.length })}</span>
        </h4>
        <p className="text-[13px] text-black/55 dark:text-white/55">
          {onBest
            ? cur.trials.length > 1
              ? t("Below is this test's best jump (jump {{k}})", { k: k + 1 })
              : t("One jump this time")
            : t("Below is jump {{k}}, at {{time}}", { k: k + 1, time: new Date(tr.start_ms).toLocaleTimeString([], { timeStyle: "short" }) })}
        </p>
        {cur.trials.length > 1 && (
          <div className="my-2.5 flex flex-wrap gap-1.5" role="group" aria-label={t("Each jump")}>
            {cur.trials.map((x, n) => (
              <Btn key={x.start_ms} type="button" aria-pressed={n === k} on={n === k} onClick={() => setJump(n === cur.best ? null : n)}>
                {t("Jump {{k}}", { k: n + 1 })} · {keyText(cur, n)}
                {n === cur.best && <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs whitespace-nowrap text-black/60 dark:bg-white/10 dark:text-white/60">{t("Best")}</span>}
              </Btn>
            ))}
          </div>
        )}
      </section>
      <dl className="my-3 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2 [&>div]:rounded-2xl [&>div]:bg-white [&>div]:px-3 [&>div]:py-2.5 [&>div]:shadow-sm dark:[&>div]:bg-neutral-900 [&>div.key]:col-span-full [&_dt]:text-xs [&_dt]:text-black/55 [&_dd]:mt-0.5 [&_dd]:text-lg [&_dd]:font-semibold [&_dd]:tabular-nums [&_dd_small]:text-xs [&_dd_small]:font-normal" aria-label={t("Each measure")}>
        {(FD_ROWS[cur.test] ?? []).map(([code, unit]) => {
          const v = figure(tr, code);
          const u = unitLabel(unit);
          return (
            <div key={code} className={code === FD_KEY[cur.test] ? "col-span-full" : ""}>
              <dt>{nameOf(code, names?.[code] ?? code)}</dt>
              <dd>
                {v === null ? "–" : num(v)}
                {v !== null && u ? <small> {u}</small> : null}
                {onBest && <Delta d={deltaOf(sessions, at, code)} unit={u} />}
              </dd>
              {onBest && code === FD_KEY[cur.test] && <FdTrend list={sessions} i={at} code={code} />}
            </div>
          );
        })}
      </dl>
      <p className="text-[13px] text-black/55 dark:text-white/55">{t("Each test is compared by its best jump with the previous test's best jump.")}</p>
    </div>
  );
}

// ---- seca mBCA Pro body composition report (as the web's seca.tsx and seca-model.ts) ------------------------------
// Values only: seca's reference ranges, ratings and age percentiles aren't in the exported data, so none are drawn.

type Seg = "torso" | "rightArm" | "leftArm" | "rightLeg" | "leftLeg";

const SSMM: Record<Seg, string> = {
  torso: "x:skeletal_muscle_mass_torso",
  rightArm: "x:skeletal_muscle_mass_right_arm",
  leftArm: "x:skeletal_muscle_mass_left_arm",
  rightLeg: "x:skeletal_muscle_mass_right_leg",
  leftLeg: "x:skeletal_muscle_mass_left_leg",
};

const SSMM_BI: Record<Seg, string> = {
  torso: "x:seca/ssmm_torso_bmi_independent",
  rightArm: "x:seca/ssmm_right_arm_bmi_independent",
  leftArm: "x:seca/ssmm_left_arm_bmi_independent",
  rightLeg: "x:seca/ssmm_right_leg_bmi_independent",
  leftLeg: "x:seca/ssmm_left_leg_bmi_independent",
};

const WEIGHT_LEVELS = ["LowWeight", "NormalWeight", "HighWeight", "VeryHighWeight"];

const MUSCLE_LEVELS = ["LowMuscle", "NormalMuscle", "HighMuscle", "VeryHighMuscle"];

const KCAL_TO_MJ = 0.004184;
/* weight, height and BMI stay on the body card even when seca measured them last */

const textOf = (m: Measurement | undefined, code: string): string | null => {
  const v = m?.values[code];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

type SecaCtx = { scans: Measurement[]; i: number };

function SecaDelta({ ctx, code, digits, scale = 1, unit, label = true }: { ctx: SecaCtx; code: string; digits: number; scale?: number; unit?: string; label?: boolean }) {
  const now = figure(ctx.scans[ctx.i], code);
  const before = figure(ctx.scans[ctx.i + 1], code);
  const d = now === null || before === null ? null : Number(((now - before) * scale).toFixed(digits));
  if (d === null || d === 0) return null;
  return (
    <span className="ms-2.5 text-xs font-normal text-black/55 dark:text-white/55" role="img" aria-label={t("Compared with last time: {{d}}", { d: `${d > 0 ? "+" : "−"}${fixed(Math.abs(d), digits)} ${unit ?? ""}`.trim() })}>
      {label ? `${t("vs last time")} ` : ""}
      {d > 0 ? "↑" : "↓"} {fixed(Math.abs(d), digits)}
    </span>
  );
}

function SecaTrend({ ctx, code }: { ctx: SecaCtx; code: string }) {
  const pts: { v: number; at: number }[] = [];
  for (let k = ctx.scans.length - 1; k >= ctx.i; k--) {
    const v = figure(ctx.scans[k], code);
    if (v !== null) pts.push({ v, at: ctx.scans[k]!.start_ms });
  }
  if (pts.length < TREND_MIN) return null;
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const xy = pts.map((p, k) => ({ x: (k / (pts.length - 1)) * 100, y: hi === lo ? 50 : 90 - ((p.v - lo) / (hi - lo)) * 80 }));
  return (
    <figure className="mt-2 text-primary" aria-label={t("Trend over {{count}} measurements", { count: pts.length })}>
      <div className="relative mx-1 h-16 [&_svg]:h-full [&_svg]:w-full [&_svg]:overflow-visible">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={xy.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
        {xy.map((p, k) => (
          <span key={pts[k]!.at} className={`absolute -ms-[3.5px] -mt-[3.5px] h-[7px] w-[7px] rounded-full border-[1.5px] border-current ${k === xy.length - 1 ? "bg-current" : "bg-white dark:bg-neutral-900"}`} style={{ left: `${p.x}%`, top: `${p.y}%` }} />
        ))}
      </div>
      <figcaption className="text-[13px] text-black/55 dark:text-white/55">
        <span>{shortDate(pts[0]!.at)}</span>
        <span>{t("This measurement")}</span>
      </figcaption>
    </figure>
  );
}

type SecaMain = { code: string; unit: string; digits: number; scale?: number };

type SecaSub = { label: string; code: string; unit: string; digits: number; scale?: number; pct?: string };

function SecaCard({ ctx, title, abbr, main, subs = [], missing, children }: { ctx: SecaCtx; title: string; abbr: string; main?: SecaMain; subs?: SecaSub[]; missing?: string; children?: ReactNode }) {
  const s = ctx.scans[ctx.i];
  const v = main ? figure(s, main.code) : null;
  return (
    <section className="rounded-2xl bg-white shadow-sm dark:bg-neutral-900 p-3.5 [&_h4]:m-0 [&_h4]:text-[13px] [&_header]:flex [&_header]:items-baseline [&_header]:justify-between [&_header]:gap-2" aria-label={title}>
      <header>
        <h4 className="mb-1 text-[15px] font-semibold">{title}</h4>
        <span className="text-[13px] text-black/55 dark:text-white/55">{abbr}</span>
      </header>
      {main &&
        (v !== null ? (
          <p className="my-1 tabular-nums [&_b]:text-xl [&_small]:text-black/55 dark:[&_small]:text-white/55">
            <b>{fixed(v * (main.scale ?? 1), main.digits)}</b>
            {main.unit && <small> {main.unit}</small>}
            <SecaDelta ctx={ctx} code={main.code} digits={main.digits} scale={main.scale ?? 1} unit={main.unit} />
          </p>
        ) : (
          <p className="text-[13px] text-black/55 dark:text-white/55">{missing ?? t("No data")}</p>
        ))}
      {children}
      {subs.length > 0 && (
        <dl className="mt-1.5 grid gap-0.5 text-xs [&_dd]:m-0 [&_dd]:tabular-nums [&_div]:flex [&_div]:justify-between [&_div]:gap-2 [&_dt]:text-black/55 dark:[&_dt]:text-white/55">
          {subs.map((x) => {
            const sv = figure(s, x.code);
            const pv = x.pct ? figure(s, x.pct) : null;
            return (
              <div key={x.code}>
                <dt>{x.label}</dt>
                <dd>
                  {sv === null ? "–" : `${fixed(sv * (x.scale ?? 1), x.digits)}${x.unit ? ` ${x.unit}` : ""}`}
                  {pv !== null ? ` (${fixed(pv, 1)} %)` : ""}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {main && v !== null && <SecaTrend ctx={ctx} code={main.code} />}
    </section>
  );
}

function ZScale({ z }: { z: number | null }) {
  if (z === null) return null;
  const pos = Math.min(1, Math.max(0, (z + 3) / 6));
  return (
    <div className="my-2" role="img" aria-label={t("Muscle mass z-score {{z}}", { z: fixed(z, 2) })}>
      <div className="relative h-1.5 rounded-full bg-gradient-to-r from-primary/20 to-primary [&_span]:absolute [&_span]:-top-[3px] [&_span]:-ms-1.5 [&_span]:h-3 [&_span]:w-3 [&_span]:rounded-full [&_span]:border-2 [&_span]:border-primary [&_span]:bg-white">
        <span style={{ left: `${pos * 100}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[13px] text-black/55 dark:text-white/55">
        <span>{t("Less muscle")}</span>
        <span>{t("More muscle")}</span>
      </div>
    </div>
  );
}

/** Where each limb sits around the figure (facing the person) */
const AREA: Record<Seg, string> = { rightArm: "ra", leftArm: "la", torso: "tr", rightLeg: "rl", leftLeg: "ll" };

function Segments({ ctx, codes }: { ctx: SecaCtx; codes: Record<Seg, string> }) {
  const s = ctx.scans[ctx.i];
  const label: Record<Seg, string> = { torso: t("Torso"), rightArm: t("Right arm"), leftArm: t("Left arm"), rightLeg: t("Right leg"), leftLeg: t("Left leg") };
  // the right limbs on the left, as when facing the person
  const order: Seg[] = ["rightArm", "leftArm", "torso", "rightLeg", "leftLeg"];
  return (
    <div className="my-2 grid grid-cols-[1fr_5rem_1fr] items-center gap-x-2.5 gap-y-1 [grid-template-areas:'ra_fig_la'_'tr_fig_.'_'rl_fig_ll']">
      {order.map((seg) => {
        const v = figure(s, codes[seg]);
        return (
          <div key={seg} className="flex flex-col tabular-nums" style={{ gridArea: AREA[seg] }}>
            <span className="text-[13px] text-black/55 dark:text-white/55">{label[seg]}</span>
            <b>
              {v === null ? "–" : fixed(v, 2)}
              {v !== null && <small> kg</small>}
            </b>
            <SecaDelta ctx={ctx} code={codes[seg]} digits={2} unit="kg" label={false} />
          </div>
        );
      })}
      <svg className="w-20 fill-primary/20 [grid-area:fig]" viewBox="0 0 120 200" aria-hidden="true">
        <circle cx="60" cy="18" r="13" />
        <rect x="38" y="36" width="44" height="74" rx="10" />
        <rect x="18" y="38" width="16" height="72" rx="8" />
        <rect x="86" y="38" width="16" height="72" rx="8" />
        <rect x="40" y="114" width="18" height="82" rx="9" />
        <rect x="62" y="114" width="18" height="82" rx="9" />
      </svg>
    </div>
  );
}

function WaterBar({ tbw, ecw }: { tbw: number | null; ecw: number | null }) {
  if (tbw === null || ecw === null || tbw <= 0 || ecw < 0 || ecw > tbw) return null;
  const share = (ecw / tbw) * 100;
  return (
    <div>
      <div className="mt-2 mb-1 flex h-2.5 overflow-hidden rounded-full" role="img" aria-label={t("Extracellular water is {{p}} % of total body water", { p: fixed(share, 1) })}>
        <span className="bg-primary" style={{ width: `${share}%` }} />
        <span className="bg-primary/30" style={{ width: `${100 - share}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[13px] text-black/55 dark:text-white/55">
        <span>
          {t("Extracellular water")} {fixed(ecw, 1)} L
        </span>
        <span>
          {t("Intracellular water")} {fixed(tbw - ecw, 1)} L
        </span>
      </div>
    </div>
  );
}

function Biva({ zr, zxc }: { zr: number | null; zxc: number | null }) {
  if (zr === null || zxc === null) return null;
  const S = 160;
  const clip = (z: number) => Math.min(4, Math.max(-4, z));
  const x = ((clip(zr) + 4) / 8) * S;
  const y = (1 - (clip(zxc) + 4) / 8) * S;
  const g = (z: number) => ((z + 4) / 8) * S;
  return (
    <svg className="mx-auto my-1.5 block w-full max-w-56 [&_text]:fill-black/55 [&_text]:text-[10px]" viewBox={`-24 -8 ${S + 32} ${S + 30}`} role="img" aria-label={`Z(R/H) ${fixed(zr, 2)}, Z(Xc/H) ${fixed(zxc, 2)}`}>
      <rect x="0" y="0" width={S} height={S} className="fill-black/5 dark:fill-white/5" />
      {[-2, 2].map((z) => (
        <g key={z} className="stroke-black/10 dark:stroke-white/10">
          <line x1={g(z)} y1="0" x2={g(z)} y2={S} />
          <line x1="0" y1={S - g(z)} x2={S} y2={S - g(z)} />
        </g>
      ))}
      <line className="stroke-black/55 [stroke-width:0.6] dark:stroke-white/55" x1={S / 2} y1="0" x2={S / 2} y2={S} />
      <line className="stroke-black/55 [stroke-width:0.6] dark:stroke-white/55" x1="0" y1={S / 2} x2={S} y2={S / 2} />
      <circle cx={x} cy={y} r="5" className="fill-primary" />
      <text x={S / 2} y={S + 18} textAnchor="middle">
        Z(R/H)
      </text>
      <text x="-14" y={S / 2} textAnchor="middle" transform={`rotate(-90 -14 ${S / 2})`}>
        Z(Xc/H)
      </text>
    </svg>
  );
}

function bccLabel(v: string): string {
  switch (v.replace(/[\s_-]+/g, "").toLowerCase()) {
    case "average":
      return t("Average build");
    case "overweight":
      return t("Overweight");
    case "underweight":
      return t("Underweight");
    case "active":
      return t("Active");
    case "athletic":
      return t("Athletic");
    case "obese":
    case "obesity":
      return t("Obese");
    case "sarcopenic":
    case "sarcopenia":
      return t("Sarcopenic");
    case "sarcopenicobesity":
      return t("Sarcopenic obesity");
    default:
      // a type not seen before: split the camel case so it reads
      return v.replace(/([a-z])([A-Z])/g, "$1 $2");
  }
}

function Bcc({ ctx }: { ctx: SecaCtx }) {
  const s = ctx.scans[ctx.i];
  const cls = textOf(s, C.bcc);
  const w = textOf(s, C.bccWeight);
  const m = textOf(s, C.bccMuscle);
  if (!cls && !w && !m) return <p className="text-[13px] text-black/55 dark:text-white/55">{t("No data")}</p>;
  const levels = [t("Low"), t("Normal"), t("High"), t("Very high")];
  const row = (label: string, all: string[], v: string | null) => {
    const k = v === null ? -1 : all.indexOf(v);
    return (
      <div className="my-1 flex items-center justify-between gap-2">
        <span className="text-[13px] text-black/55 dark:text-white/55">{label}</span>
        {k >= 0 ? (
          <ol className="m-0 flex list-none gap-0.5 p-0 text-[11px] [&_li]:rounded [&_li]:bg-black/5 [&_li]:px-1.5 [&_li]:py-0.5 [&_li]:text-black/55 [&_li[aria-current=true]]:bg-primary [&_li[aria-current=true]]:text-white">
            {all.map((lv, j) => (
              <li key={lv} aria-current={j === k ? "true" : undefined}>
                {levels[j]}
              </li>
            ))}
          </ol>
        ) : (
          <b>{v ?? "–"}</b>
        )}
      </div>
    );
  };
  return (
    <div>
      {cls && <p className="my-1 tabular-nums [&_b]:text-xl [&_small]:text-black/55 dark:[&_small]:text-white/55">{bccLabel(cls)}</p>}
      {row(t("Weight"), WEIGHT_LEVELS, w)}
      {row(t("Muscle"), MUSCLE_LEVELS, m)}
    </div>
  );
}

function SecaCards({ ctx }: { ctx: SecaCtx }) {
  const s = ctx.scans[ctx.i];
  const ree = figure(s, C.ree);
  const kg = "kg";
  const kgm2 = "kg/m²";
  const L = "L";
  const kcal = "kcal/d";
  const pts = t("points");
  return (
    <div className="my-3 grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-2.5">
      <SecaCard ctx={ctx} title={t("Fat mass index")} abbr="FMI" main={{ code: C.fmi, unit: kgm2, digits: 1 }} subs={[{ label: t("Fat mass"), code: C.fm, unit: kg, digits: 2 }, { label: t("Body fat percentage"), code: C.fmp, unit: "%", digits: 1 }]} />
      <SecaCard ctx={ctx} title={t("Fat-free mass index")} abbr="FFMI" main={{ code: C.ffmi, unit: kgm2, digits: 1 }} subs={[{ label: t("Fat-free mass"), code: C.ffm, unit: kg, digits: 2, pct: C.ffmp }]} />
      <SecaCard ctx={ctx} title={t("Body fat percentage")} abbr="FM %" main={{ code: C.fmp, unit: "%", digits: 1 }} subs={[{ label: t("Fat mass"), code: C.fm, unit: kg, digits: 2 }, { label: t("Fat mass index"), code: C.fmi, unit: kgm2, digits: 1 }]} />
      <SecaCard ctx={ctx} title={t("Skeletal muscle mass")} abbr="SMM" main={{ code: C.smm, unit: kg, digits: 2 }} subs={[{ label: t("Skeletal muscle share of weight"), code: C.smmp, unit: "%", digits: 1 }, { label: t("Body mass index"), code: C.bmi, unit: kgm2, digits: 1 }]}>
        <ZScale z={figure(s, C.zsmi)} />
      </SecaCard>
      <SecaCard ctx={ctx} title={t("Skeletal muscle index (MRI)")} abbr="SMI" main={{ code: C.smi, unit: kgm2, digits: 1 }} subs={[{ label: t("Skeletal muscle mass"), code: C.smm, unit: kg, digits: 2 }]} />
      <SecaCard ctx={ctx} title={t("Skeletal muscle mass for age")} abbr="SMM" main={{ code: C.smoa, unit: kg, digits: 2 }} />
      <SecaCard ctx={ctx} title={t("Phase angle")} abbr="PhA" main={{ code: C.pha, unit: "°", digits: 1 }} />
      <SecaCard ctx={ctx} title={t("Water ratio")} abbr="ECW / TBW" main={{ code: C.wr, unit: "%", digits: 1 }} subs={[{ label: t("Total body water"), code: C.tbw, unit: L, digits: 1, pct: C.tbwp }, { label: t("Extracellular water"), code: C.ecw, unit: L, digits: 1, pct: C.ecwp }]} />
      <SecaCard ctx={ctx} title={t("Visceral fat")} abbr="VAT" main={{ code: C.vat, unit: L, digits: 1 }} missing={t("No waist measurement, so it can't be calculated")} />
      <SecaCard ctx={ctx} title={t("Appendicular skeletal muscle index (DXA)")} abbr="ASMI" main={{ code: C.asmi, unit: kgm2, digits: 1 }} subs={[{ label: t("Appendicular skeletal muscle mass"), code: C.asmm, unit: kg, digits: 2, pct: C.asmp }]} />
      <SecaCard ctx={ctx} title={t("Waist circumference")} abbr="WC" main={{ code: C.wc, unit: "cm", digits: 1, scale: 100 }} />
      <SecaCard ctx={ctx} title={t("Body composition chart")} abbr="BCC">
        <Bcc ctx={ctx} />
      </SecaCard>
      <SecaCard ctx={ctx} title={t("Segmental skeletal muscle")} abbr="SSMM" subs={[{ label: t("Total skeletal muscle"), code: C.smm, unit: kg, digits: 2 }]}>
        <Segments ctx={ctx} codes={SSMM} />
      </SecaCard>
      <SecaCard ctx={ctx} title={t("Body water")} abbr="TBW / ECW" subs={[{ label: t("Total body water"), code: C.tbw, unit: L, digits: 1, pct: C.tbwp }, { label: t("Extracellular water"), code: C.ecw, unit: L, digits: 1, pct: C.ecwp }]}>
        <WaterBar tbw={figure(s, C.tbw)} ecw={figure(s, C.ecw)} />
      </SecaCard>
      <SecaCard ctx={ctx} title={t("Skeletal muscle mass for age (BMI-independent)")} abbr="SMM" main={{ code: C.smoaBi, unit: kg, digits: 2 }} />
      <SecaCard ctx={ctx} title={t("Segmental skeletal muscle (BMI-independent)")} abbr="SSMM">
        <Segments ctx={ctx} codes={SSMM_BI} />
      </SecaCard>
      <SecaCard ctx={ctx} title={t("Bioelectrical impedance vector analysis")} abbr="BIVA" subs={[{ label: t("Resistance"), code: C.r, unit: "Ω", digits: 1 }, { label: t("Reactance"), code: C.xc, unit: "Ω", digits: 1 }]}>
        <Biva zr={figure(s, C.bivaR)} zxc={figure(s, C.bivaXc)} />
      </SecaCard>
      <SecaCard ctx={ctx} title={t("TRU body score")} abbr="TBS" main={{ code: C.tbs, unit: pts, digits: 0 }} subs={[{ label: t("Muscle score"), code: C.tbsMuscle, unit: pts, digits: 0 }, { label: t("Fat score"), code: C.tbsFat, unit: pts, digits: 0 }]} />
      <SecaCard ctx={ctx} title={t("Resting energy expenditure")} abbr="REE" main={{ code: C.ree, unit: kcal, digits: 0 }} subs={[{ label: t("Total energy expenditure"), code: C.tee, unit: kcal, digits: 0 }]}>
        {ree !== null && <p className="text-[13px] text-black/55 dark:text-white/55">{t("About {{mj}} MJ a day", { mj: fixed(ree * KCAL_TO_MJ, 2) })}</p>}
        {figure(s, C.tee) === null && <p className="text-[13px] text-black/55 dark:text-white/55">{t("No activity level (PAL), so total energy expenditure can't be calculated")}</p>}
      </SecaCard>
      <SecaCard ctx={ctx} title={t("Body mass index")} abbr="BMI" main={{ code: C.bmi, unit: kgm2, digits: 1 }} subs={[{ label: t("Weight"), code: C.weight, unit: kg, digits: 1 }, { label: t("Height"), code: C.height, unit: "cm", digits: 1, scale: 100 }]} />
      <SecaCard ctx={ctx} title={t("Weight")} abbr="Weight" main={{ code: C.weight, unit: kg, digits: 1 }} />
    </div>
  );
}

/** seca mBCA Pro body composition (as the web's seca.tsx): the latest measurement, History for the others. */
export function SecaReport({ scans }: { scans: Measurement[] }) {
  const [i, setI] = useState(0);
  const [hist, setHist] = useState(false);
  const at = Math.min(i, Math.max(0, scans.length - 1));
  const cur = scans[at];
  if (!cur)
    return (
      <div className="flex flex-col gap-3">
        <h3 className="mb-2 text-[17px] font-semibold">{t("No body composition data yet")}</h3>
        <p className="text-[13px] text-black/55 dark:text-white/55">{t("After a seca mBCA Pro measurement at the lab, the results show here.")}</p>
      </div>
    );
  return (
    <div className="[&_h4]:mt-3 [&_h4]:mb-1">
      <header className="mb-3 flex items-start justify-between gap-4 [&_h3]:m-0 [&_p]:m-0">
        <div>
          <h3 className="mb-2 text-[17px] font-semibold">{t("Body composition")}</h3>
          <p className="text-[13px] text-black/55 dark:text-white/55">seca mBCA Pro · {when(cur.start_ms)}</p>
        </div>
        <Btn type="button" aria-expanded={hist} onClick={() => setHist(!hist)}>
          {t("History")}
        </Btn>
      </header>
      {hist && (
        <Group aria-label={t("Measurement history")}>
          {scans.map((s, k) => (
            <li key={`${s.device}|${s.start_ms}`}>
              <button
                type="button"
                className="select-none flex w-full items-center gap-3 px-4 py-3 text-start"
                aria-current={k === at ? "true" : undefined}
                onClick={() => {
                  setI(k);
                  setHist(false);
                }}
              >
                <span className="me-auto grid min-w-0 gap-px">
                  <strong>{when(s.start_ms)}</strong>
                </span>
                {k === 0 && <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs whitespace-nowrap text-black/60 dark:bg-white/10 dark:text-white/60">{t("Latest")}</span>}
                {k === at && <span aria-hidden="true">✓</span>}
              </button>
            </li>
          ))}
        </Group>
      )}
      {at > 0 && (
        <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px] flex items-center justify-between gap-4" role="status">
          <span>{t("Viewing the measurement of {{date}}", { date: when(cur.start_ms) })}</span>
          <Btn type="button" onClick={() => setI(0)}>
            {t("Back to the latest")}
          </Btn>
        </p>
      )}
      <SecaCards ctx={{ scans, i: at }} />
      <p className="text-[13px] text-black/55 dark:text-white/55">{t("For reference ranges and ratings, go by the report the lab gives you.")}</p>
    </div>
  );
}
