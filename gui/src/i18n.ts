// The interface language (i18next): English, Simplified or Traditional Chinese. The English text is the key
// (no key or namespace separators), so untranslated text shows in English. locales/<lang>.json hold the
// translations; zh-Hant is made from zh-Hans by scripts/gen-zh-hant.ts (characters only, as the web version's
// Traditional pack is). English plurals are `<key>_one` / `<key>_other` in locales/en.json. The language follows
// the system unless the person picks one.

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zhHans from "./locales/zh-Hans.json";
import zhHant from "./locales/zh-Hant.json";

export type Lang = "en" | "zh-Hans" | "zh-Hant";
export const LANGS: { key: Lang | "system"; label: string }[] = [
  { key: "system", label: "System" },
  { key: "en", label: "English" },
  { key: "zh-Hans", label: "简体中文" },
  { key: "zh-Hant", label: "繁體中文" },
];

/** What the system asks for: zh-TW, zh-HK, zh-MO and zh-Hant* are Traditional, other zh Simplified. */
export function fromSystem(list: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages): Lang {
  for (const l of list) {
    const x = l.toLowerCase();
    if (x.startsWith("zh")) return /hant|-tw|-hk|-mo/.test(x) ? "zh-Hant" : "zh-Hans";
    if (x.startsWith("en")) return "en";
  }
  return "en";
}

const KEY = "lang";
/** The saved choice: a language, or "system" (a convenience: storage may be unavailable). */
export function choice(): Lang | "system" {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "en" || v === "zh-Hans" || v === "zh-Hant") return v;
  } catch {}
  return "system";
}

i18next.use(initReactI18next).init({
  resources: { en: { translation: en }, "zh-Hans": { translation: zhHans }, "zh-Hant": { translation: zhHant } },
  lng: (() => {
    const c = choice();
    return c === "system" ? fromSystem() : c;
  })(),
  fallbackLng: "en",
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false }, // React escapes
  returnEmptyString: false,
  initAsync: false,
});

/** Marks text translated later, where it is shown (tables of labels): the extractor finds it. */
export const tk = (s: string): string => s;

export const lang = (): Lang => i18next.language as Lang;
export const t = i18next.t.bind(i18next) as (key: string, vars?: Record<string, unknown>) => string;
/** The locale for dates and numbers. */
export const locale = (): string =>
  lang() === "zh-Hant" ? "zh-TW" : lang() === "zh-Hans" ? "zh-CN" : typeof navigator === "undefined" ? "en" : navigator.language;

const mark = () => {
  if (typeof document !== "undefined") document.documentElement.lang = lang();
};
mark();
i18next.on("languageChanged", mark);

/** Keeps the choice and switches to it (the app redraws on `languageChanged`). */
export async function choose(c: Lang | "system"): Promise<void> {
  try {
    if (c === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, c);
  } catch {}
  await i18next.changeLanguage(c === "system" ? fromSystem() : c);
}
