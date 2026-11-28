import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Day, type FdSession, isDesktop, isMobile, type Measurement, op, type Point, type Source } from "../api";
import { Spark } from "../charts";
import { ago, asDuration, day, dayMs, GROUPS, HOME_GROUPS, num, shortDate, shown, unitLabel, when } from "../format";
import { t } from "../i18n";
import { KEY, nameOf } from "../names";
import { go as nav } from "../router";
import { Btn, C, Callout, DAY, fdBest, fdStart, figure, fixed, Flag, Group, GroupIcon, Heading, Icon, IconDot, MOD, type Page, Problem, Row, Screen, SearchPill, sourceLabel, TINT, toPts, useOp } from "../ui";
import { FdReport, SecaReport } from "./reports";

/** The last 30 days of a measure, reaching back to its latest reading's day when that is older
 *  (one request per tile, refreshed after writes). */
function useMonth(p: Point): Day[] | undefined {
  const from = day(Math.min(Date.now() - 30 * DAY, p.start_ms));
  return useOp(() => op<Day[]>("daily.query", { metric: p.metric, from }), [p.metric, from])[0];
}

function Trend({ p, days, latest }: { p: Point; days?: Day[]; latest: string }) {
  const pts = days ? toPts(p.agg, days) : [];
  return pts.length >= 2 ? <Spark pts={pts} label={nameOf(p.metric, p.name)} latest={latest} /> : null;
}

/** What to show for a reading. Summed measures (steps, energy) show their latest day's total, not the last slice. */
function display(p: Point, days?: Day[]): { value: string; unit: string; note?: string } {
  if (p.agg === "cumulative" && days?.length) {
    const last = days[days.length - 1]!;
    const today = last.day === day(Date.now());
    const note = today ? t("today") : ago(dayMs(last.day));
    const asTime = asDuration(last.sum ?? 0, p.unit, true);
    return asTime ? { value: asTime, unit: "", note } : { value: num(last.sum ?? 0), unit: unitLabel(p.unit), note };
  }
  return shown(p);
}

const STALE_DAYS = 60;

const isStale = (p: Point) => Date.now() - p.start_ms > STALE_DAYS * DAY;

/** One measure as a tile: its name, the value large, and the month's trend or when it was taken. */
function Tile({ p, open }: { p: Point; open: (code: string) => void }) {
  return p.agg === "cumulative" ? <SummedTile p={p} open={open} /> : <TileBody p={p} open={open} s={shown(p)} days={undefined} />;
}

function SummedTile({ p, open }: { p: Point; open: (code: string) => void }) {
  const days = useMonth(p);
  return <TileBody p={p} open={open} s={display(p, days)} days={days} />;
}

function TrendTile({ p, open, s }: { p: Point; open: (code: string) => void; s: { value: string; unit: string; note?: string } }) {
  const days = useMonth(p);
  return <TileBody p={p} open={open} s={s} days={days} />;
}

function TileBody({
  p,
  open,
  s,
  days,
}: { p: Point; open: (code: string) => void; s: { value: string; unit: string; note?: string }; days?: Day[] }) {
  const old = isStale(p);
  // a trend where there is one (everyday measures); the date otherwise (lab values, old or sparse ones)
  const trend = !old && !!days && toPts(p.agg, days).length >= 2;
  const note = s.note ?? ago(p.start_ms);
  return (
    <button type="button" className="select-none flex w-full min-h-[64px] items-center gap-3 px-4 py-2.5 text-start transition-colors active:bg-black/5 dark:active:bg-white/10" onClick={() => open(p.metric)}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] leading-snug">{nameOf(p.metric, p.name)}</span>
        <span className="block text-[13px] text-black/55 dark:text-white/55">
          {note}
          <Flag p={p} />
        </span>
      </span>
      {trend && <Trend p={p} days={days} latest={s.unit ? `${s.value} ${s.unit}` : s.value} />}
      <span className={`shrink-0 text-end text-[20px] font-semibold tracking-tight tabular-nums ${old ? "text-black/55 dark:text-white/55" : ""}`}>
        {s.value}
        {s.unit && <span className="ms-0.5 text-[13px] font-medium text-black/55 dark:text-white/55">{s.unit}</span>}
      </span>
    </button>
  );
}

/** Key, everyday measures show their month's trend; lab and old values show their date instead. */
function AnyTile({ p, open, lab }: { p: Point; open: (code: string) => void; lab: boolean }) {
  if (!lab && !isStale(p) && p.agg !== "cumulative" && typeof p.value === "number") return <TrendTile p={p} open={open} s={shown(p)} />;
  return <Tile p={p} open={open} />;
}

function Section({
  g,
  rows,
  sources,
  open,
  all,
}: { g: (typeof GROUPS)[number]; rows: Point[]; sources: Source[]; open: (code: string) => void; all: boolean }) {
  const [more, setMore] = useState(false);
  const key = KEY[g.key] ?? [];
  // key measures first, then everyday ones, then detailed body-composition analysis, newest first within each
  const detailed = (p: Point) => /^x:(seca\/|fat_|ecw|extracellular|total_body_water|skeletal_muscle|appendicular|bia_|phase_angle|visceral|resting_energy|total_energy)/.test(p.metric);
  const ranked = [...rows].sort((a, b) => {
    const ka = key.indexOf(a.metric);
    const kb = key.indexOf(b.metric);
    if (ka >= 0 || kb >= 0) return (ka < 0 ? 99 : ka) - (kb < 0 ? 99 : kb);
    return Number(detailed(a)) - Number(detailed(b)) || b.start_ms - a.start_ms;
  });
  const lab = g.key === "lab" || g.sensitive;
  // collapsed: the first few rows (more for a big category), the rest on request
  const fold = rows.length > 12 ? 6 : 4;
  const shownRows = all || more ? ranked : ranked.slice(0, fold);
  // where these numbers come from, newest first
  const bySource = new Map<number, number>();
  for (const p of rows) bySource.set(p.source_id, Math.max(bySource.get(p.source_id) ?? 0, p.start_ms));
  const from = [...bySource.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => sourceLabel(sources.find((x) => x.id === id)));
  return (
    <section className="mb-2 scroll-mt-10 break-inside-avoid" id={`g-${g.key}`} aria-labelledby={`h-${g.key}`}>
      <Group
        title={
          <span id={`h-${g.key}`} className="flex items-center gap-2 text-[15px] font-semibold text-black dark:text-white">
            <IconDot color={TINT[g.key] ?? TINT.other} className="h-7! w-7!">
              <GroupIcon k={g.key} />
            </IconDot>
            {t(g.label)}
          </span>
        }
        after={
          !all && rows.length > fold ? (
            <Btn type="button" link aria-expanded={more} onClick={() => setMore(!more)}>
              {more ? t("Show fewer") : t("Show all {{n}}", { n: rows.length })}
            </Btn>
          ) : undefined
        }
      >
        {shownRows.map((p) => (
          <AnyTile key={p.metric} p={p} open={open} lab={lab} />
        ))}
      </Group>
      {from.length > 0 && (
        <p className="-mt-3 mb-5 px-4 text-[13px] text-black/55 dark:text-white/55">
          {new Set(from).size > 3
            ? t("From {{list}} and {{n}} more", { list: [...new Set(from)].slice(0, 3).join(t(", ")), n: new Set(from).size - 3 })
            : t("From {{list}}", { list: [...new Set(from)].slice(0, 3).join(t(", ")) })}
        </p>
      )}
    </section>
  );
}

/** Nothing recorded yet: where data comes in on this computer (as the web's dashboard getting-started card) */
function Start({ start }: { start: (p: Page, want: string) => void }) {
  return (
    <section className="mx-auto w-full max-w-5xl">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Heading>{t("Dashboard")}</Heading>
          <p className="text-[13px] text-black/55 dark:text-white/55">{(isMobile ? t("Your data is stored encrypted on this device") : t("Your data is stored encrypted on this computer"))}</p>
        </div>
      </div>
      <div className="max-w-[640px] overflow-hidden rounded-3xl bg-white/80 shadow-sm dark:bg-neutral-900/80">
        <div className="px-4.5 pt-4.5 pb-1.5 [&_h3]:m-0 [&_h3]:text-[17px]">
          <h3 id="h-start" className="mb-2 text-[17px] font-semibold">{t("Start recording your health")}</h3>
          <p className="text-[13px] text-black/55 dark:text-white/55">{t("Choose a way to add your first data")}</p>
        </div>
        <Group aria-labelledby="h-start">
          <Row icon={<GroupIcon k="lab" />} label={t("Lab report")} sub={t("A photo or a PDF")} onClick={() => start("data", "report")} />
          <Row icon={<GroupIcon k="activity" />} label={t("Apple Health")} sub={t("Export from your iPhone")} onClick={() => start("data", "apple")} />
          <Row icon={<Icon k="backup" />} label={t("Restore a backup")} sub={t("A .zuhealth file")} onClick={() => start("data", "restore")} />
          <Row icon={<GroupIcon k="body" />} label={t("Enter by hand")} sub={t("Write down a reading")} onClick={() => start("data", "manual")} />
          <Row icon={<Icon k="link" />} label={t("Connect another device")} onClick={() => start("account", "connect")} />
        </Group>
      </div>
      {/* dropping a file on the window is the desktop's */}
      {isDesktop && <p className="text-[13px] text-black/55 dark:text-white/55 mt-3 text-[13px]">{t("You can also drop a file anywhere on this window.")}</p>}
    </section>
  );
}

export function Readings({
  latest,
  err,
  open,
  go,
  want,
  reviews,
  find,
  found,
  onSection,
  start,
}: {
  latest?: Point[];
  err?: string;
  open: (code: string) => void;
  go: (p: Page) => void;
  /** The lab report open (#/report/seca, #/report/forcedecks). */
  want?: string;
  reviews: number;
  find: boolean;
  found: () => void;
  /** The category now in view (null: the top), for the sidebar */
  onSection: (key: string | null) => void;
  /** Opens a page at a way in (the getting-started card) */
  start: (p: Page, want: string) => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  const [sources] = useOp(() => op<Source[]>("source.list"), []);
  const [fd] = useOp(() => op<FdSession[]>("labs.forcedecks"), []);

  const [scans] = useOp(() => op<Measurement[]>("labs.body_scans"), []);

  const [q, setQ] = useState("");
  useEffect(() => {
    if (find && search.current) {
      search.current.focus();
      found();
    }
  }, [find, latest, found]);
  // which category is under the page's top edge: the sidebar marks it
  useEffect(() => {
    if (!latest?.length) return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const x of entries) seen.set(x.target.id.slice(2), x.isIntersecting);
        const first = HOME_GROUPS.find((g) => seen.get(g.key));
        onSection(window.scrollY < 40 ? null : (first?.key ?? null));
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    for (const el of document.querySelectorAll("section[id^='g-']")) io.observe(el);
    const top = () => window.scrollY < 40 && onSection(null);
    window.addEventListener("scroll", top, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", top);
      onSection(null);
    };
  }, [latest, onSection]);
  if (err) return <Problem text={err} />;
  if (!latest) return <section aria-busy="true" aria-label={t("Loading your readings…")} />;
  // the lab devices' reports, each a screen of its own (#/report/seca, #/report/forcedecks)
  if (want === "seca") return <Screen title={t("Body composition")}>{scans && <SecaReport scans={scans} />}</Screen>;
  if (want === "forcedecks")
    return <Screen title={t("VALD ForceDecks tests")}>{fd && <FdReport sessions={fd} names={Object.fromEntries(latest.map((p) => [p.metric, p.name]))} />}</Screen>;
  if (!latest.length) return <Start start={start} />;
  const needle = q.trim().toLowerCase();
  const match = (p: Point) => !needle || nameOf(p.metric, p.name).toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle);
  // the latest time on the VALD ForceDecks plates shows its best jump, not its last one (the web's withBestJump)
  const fdLatest = fd?.[0];
  // values a seca measurement gave are in its report, not loose on the body card (weight, height, BMI stay)
  const unscanned = scans?.length ? withoutScans(latest, scans, sources ?? []) : latest;
  const rowsOf = fdLatest ? withBestJump(unscanned, fdLatest, sources ?? []) : unscanned;
  // a body composition measurement keeps the body card even when it holds nothing else (as the web's home)
  const withReport = (key: string) => (key === "body" && !!scans?.length && !needle) || (key === "force" && !!fdLatest && !needle);
  const groups = HOME_GROUPS.map((g) => ({ g, rows: rowsOf.filter((p) => p.category === g.key && match(p)) })).filter(
    (x) => x.rows.length || withReport(x.g.key),
  );
  const newest = Math.max(...latest.map((p) => p.start_ms));
  const labs = !needle && (!!scans?.[0] || !!fdLatest);
  return (
    <section className="mx-auto w-full max-w-5xl">
      <Heading space="mb-0.5">{t("Dashboard")}</Heading>
      <p className="mb-4 text-[13px] text-black/55 dark:text-white/55">{t("Updated {{when}}", { when: when(newest) })}</p>
      <SearchPill
        className="mb-5"
        ref={search}
        placeholder={isMobile ? t("Find a measure") : `${t("Find a measure")} (${MOD}F)`}
        aria-label={t("Find a measure")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setQ("")}
      />
      {reviews > 0 && (
        <Callout
          icon={<Icon k="review" />}
          title={t("{{count}} imports are waiting for you to check.", { count: reviews })}
          text={t("Nothing counts until you confirm it.")}
          onClick={() => go("review")}
        />
      )}
      {/* the lab devices' reports first: what a visit to the testing room gave, before any loose number */}
      {labs && (
        <Group title={t("Latest tests")}>
          {scans?.[0] && <SecaLabCard scan={scans[0]} open={() => nav("report/seca")} />}
          {fdLatest && <FdCard session={fdLatest} open={() => nav("report/forcedecks")} />}
        </Group>
      )}
      {!groups.length && <p className="text-black/55 dark:text-white/55">{t("No measure matches “{{q}}”.", { q })}</p>}
      <div className="wide:columns-2 wide:gap-6">
        {groups.map(({ g, rows }) => (
          <Section key={g.key} g={g} rows={rows} sources={sources ?? []} open={open} all={!!needle} />
        ))}
      </div>
    </section>
  );
}

/** The home page's rows with the latest time on the plates' best jump in place of the latest jump (same device) */
function withBestJump(rows: Point[], s: FdSession, sources: Source[]): Point[] {
  const best = fdBest(s);
  const device = (id: number) => sources.find((x) => x.id === id);
  return rows.map((p) => {
    const src = device(p.source_id);
    return src?.connector === "lab" && src.external_id === s.device && p.metric in best.values
      ? { ...p, value: best.values[p.metric] ?? null, start_ms: best.start_ms, tz_min: best.tz_min }
      : p;
  });
}

/** The latest VALD ForceDecks session as the dashboard's card: its best jump's height, RSI and power. */
function FdCard({ session, open }: { session: FdSession; open: () => void }) {
  const best = session.trials[session.best];
  const v = (code: string, digits: number) => {
    const x = figure(best, code);
    return x === null ? "–" : `${fixed(x, digits)}`;
  };
  return (
    <LabCard
      color={TINT.force!}
      icon={<GroupIcon k="force" />}
      title={t("VALD ForceDecks test record")}
      text={`${shortDate(fdStart(session))} · ${t("{{count}} jumps", { count: session.trials.length })}`}
      stats={[
        [t("Jump height"), v("x:fd/cmj/jump_height_imp_mom", 1), "cm"],
        ["RSI", v("x:fd/cmj/rsi_modified", 2), ""],
        [t("Peak power"), v("x:fd/cmj/peak_power_bm", 1), "W/kg"],
      ]}
      open={open}
    />
  );
}

/** A lab device's report on the dashboard: what it is and when, its key figures side by side; a tap opens it. */
function LabCard({ color, icon, title, text, stats, open }: { color: string; icon: ReactNode; title: string; text: string; stats: [string, string, string][]; open: () => void }) {
  return (
    <button type="button" className="select-none flex w-full flex-col gap-3 px-4 py-3.5 text-start transition-colors active:bg-black/5 dark:active:bg-white/10" onClick={open}>
      <span className="flex w-full items-center gap-3">
        <IconDot color={color}>{icon}</IconDot>
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-semibold leading-snug">{title}</span>
          <span className="block text-[13px] text-black/55 dark:text-white/55">{text}</span>
        </span>
        <svg className="h-4 w-4 shrink-0 text-black/30 dark:text-white/30" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 3.5 10.5 8 6 12.5" />
        </svg>
      </span>
      <span className="grid w-full grid-cols-3 gap-2">
        {stats.map(([label, value, unit]) => (
          <span key={label} className="min-w-0">
            <span className="block truncate text-[13px] text-black/55 dark:text-white/55">{label}</span>
            <span className="block text-[22px] font-semibold tracking-tight tabular-nums">
              {value}
              {unit && value !== "–" && <span className="ms-0.5 text-[13px] font-medium text-black/55 dark:text-white/55">{unitLabel(unit)}</span>}
            </span>
          </span>
        ))}
      </span>
    </button>
  );
}

const BASIC = new Set([C.weight, C.height, C.bmi]);

/** The home page's rows without the values a seca measurement gave (they're in its report); weight, height, BMI stay */
function withoutScans(rows: Point[], scans: Measurement[], sources: Source[]): Point[] {
  const keys = new Set(scans.map((s) => `${s.device}|${s.start_ms}`));
  return rows.filter((p) => {
    if (BASIC.has(p.metric as (typeof C)["weight"])) return true;
    const src = sources.find((x) => x.id === p.source_id);
    return !(src?.connector === "lab" && keys.has(`${src.external_id}|${p.start_ms}`));
  });
}

/** The latest seca measurement as the dashboard's card: body fat, skeletal muscle, weight. */
function SecaLabCard({ scan, open }: { scan: Measurement; open: () => void }) {
  const v = (code: string, digits: number) => {
    const x = figure(scan, code);
    return x === null ? "–" : fixed(x, digits);
  };
  return (
    <LabCard
      color={TINT.body!}
      icon={<GroupIcon k="body" />}
      title={t("Body composition report")}
      text={`seca mBCA Pro · ${shortDate(scan.start_ms)}`}
      stats={[
        [t("Body fat"), v(C.fmp, 1), "%"],
        [t("Skeletal muscle"), v(C.smm, 1), "kg"],
        [t("Weight"), v(C.weight, 1), "kg"],
      ]}
      open={open}
    />
  );
}
