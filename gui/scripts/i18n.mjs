// The interface's translations, checked: every text the code marks (t("…"), tr("…"), tk("…")) must be in
// src/locales/zh-Hans.json and zh-Hant.json, and every text passed a `count` needs its English `_one` / `_other`
// in en.json and `_other` in Chinese (i18next plurals). Unused entries are reported too.
// `node scripts/i18n.mjs` checks (exit 1 on a gap); `--missing` / `--unused` print those keys as JSON.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const src = new URL("../src/", import.meta.url).pathname;
const files = readdirSync(src).filter((f) => /\.(ts|tsx)$/.test(f));
const keys = new Set();
const plural = new Set();
for (const f of files) {
  const s = readFileSync(join(src, f), "utf8");
  for (const m of s.matchAll(/\b(?:t|tr|tk)\(\s*"((?:[^"\\]|\\.)*)"(\s*,\s*\{[^}]*\bcount\b)?/g)) {
    const k = JSON.parse(`"${m[1]}"`);
    keys.add(k);
    if (m[2]) plural.add(k);
  }
}
const load = (l) => JSON.parse(readFileSync(join(src, "locales", `${l}.json`), "utf8"));
const en = load("en");
const packs = { "zh-Hans": load("zh-Hans"), "zh-Hant": load("zh-Hant") };
const want = (lang) => [...keys].flatMap((k) => (plural.has(k) ? (lang === "en" ? [`${k}_one`, `${k}_other`] : [`${k}_other`]) : lang === "en" ? [] : [k]));
const missing = {};
for (const [lang, pack] of [["en", en], ...Object.entries(packs)]) {
  const gaps = want(lang).filter((k) => !(k in pack));
  if (gaps.length) missing[lang] = gaps;
}
const unused = {};
for (const [lang, pack] of Object.entries({ en, ...packs })) {
  const all = new Set(want(lang));
  const extra = Object.keys(pack).filter((k) => !all.has(k));
  if (extra.length) unused[lang] = extra;
}
// words the owner ruled out (2026-11), as the web's copy-words test: "读数" is inaccurate (a reading is 数据, or 指标
// for a measure); staff are 工作人员, never 服务人员; device names stay English (ForceDecks, never 力板)
const banned = { "zh-Hans": ["读数", "服务人员", "力板"], "zh-Hant": ["讀數", "服務人員", "力板"] };
const bad = Object.entries(banned).flatMap(([l, ws]) =>
  Object.entries(packs[l]).filter(([, v]) => ws.some((w) => v.includes(w))).map(([k]) => `${l}: ${k}`),
);
if (bad.length) {
  console.log(`banned words in:\n${bad.join("\n")}`);
  process.exit(1);
}
if (process.argv.includes("--unused")) {
  console.log(JSON.stringify(unused, null, 1));
  process.exit(0);
}
if (process.argv.includes("--missing")) {
  console.log(JSON.stringify(missing, null, 1));
} else {
  console.log(`${keys.size} texts (${plural.size} with plurals)`);
  for (const [l, g] of Object.entries(missing)) console.log(`${l}: ${g.length} missing, e.g. ${JSON.stringify(g.slice(0, 3))}`);
  for (const [l, g] of Object.entries(unused)) console.log(`${l}: ${g.length} unused, e.g. ${JSON.stringify(g.slice(0, 3))}`);
  if (Object.keys(missing).length || Object.keys(unused).length) process.exit(1);
}
