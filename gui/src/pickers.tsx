// Pickers for touch screens, where a <select className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white"> opens the system's long menu: a wheel to scroll, as iOS's date picker.
import { useEffect, useLayoutEffect, useRef } from "react";
import { locale, t } from "./i18n";

/** A finger, not a mouse: phones, tablets (a narrow desktop window keeps the selects). */
export const isTouch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

const ROW = 40;

/** One scrolling column; the row in the band is the choice. */
function Wheel({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const settle = useRef<number | undefined>(undefined);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  // the choice in the band when it opens or changes from outside
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && Math.round(el.scrollTop / ROW) !== index) el.scrollTop = index * ROW;
  }, [index]);
  const settled = () => {
    const el = ref.current;
    if (!el) return;
    const o = options[Math.min(options.length - 1, Math.max(0, Math.round(el.scrollTop / ROW)))];
    if (o && o.value !== value) onChange(o.value);
  };
  return (
    <div className="min-w-0 flex-1">
      <span className="mb-1 block text-[13px] text-black/55 dark:text-white/55">{label}</span>
      <div className="relative h-[200px]">
        <div className="pointer-events-none absolute inset-x-0 top-20 h-10 rounded-[10px] bg-black/5 dark:bg-white/10" aria-hidden="true" />
        <div
          ref={ref}
          className="relative box-border h-full snap-y snap-mandatory overflow-y-auto overscroll-contain py-20 [mask-image:linear-gradient(transparent,#000_30%,#000_70%,transparent)] [scrollbar-width:none]"
          role="listbox"
          aria-label={label}
          onScroll={() => {
            window.clearTimeout(settle.current);
            settle.current = window.setTimeout(settled, 120);
          }}
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={i === index}
              className="h-10 snap-center text-center text-xl leading-10 tabular-nums"
              onClick={() => ref.current?.scrollTo({ top: i * ROW, behavior: "smooth" })}
            >
              {o.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Birth year and month on two wheels. Months are numbers ("1"…"12"); an unset choice starts at 30 years ago, January. */
export function BirthWheels({ year, month, setYear, setMonth }: { year: string; month: string; setYear: (y: string) => void; setMonth: (m: string) => void }) {
  const now = new Date().getFullYear();
  // a wheel always shows a choice: make it the value
  useEffect(() => {
    if (!year) setYear(String(now - 30));
    if (!month) setMonth("1");
  }, [year, month, now, setYear, setMonth]);
  const years = Array.from({ length: now - 1900 + 1 }, (_, k) => String(now - k)).map((y) => ({ value: y, label: y }));
  const name = new Intl.DateTimeFormat(locale(), { month: "long", timeZone: "UTC" });
  const months = Array.from({ length: 12 }, (_, k) => ({ value: String(k + 1), label: name.format(Date.UTC(2000, k, 1)) }));
  return (
    <div className="my-2 mb-4 flex gap-3">
      <Wheel label={t("Year")} value={year} options={years} onChange={setYear} />
      <Wheel label={t("Month")} value={month} options={months} onChange={setMonth} />
    </div>
  );
}
