// The Traditional Chinese interface text and measure names from the Simplified (gui/src/locales/zh-Hans.json and
// names-desktop.json): OpenCC's s2t, characters only, as the web version's Traditional pack is; then FIX: the
// character forms that pack uses, and s2t's wrong picks.
// Run: bun scripts/gen-zh-hant.ts   (opencc-js from the pre-pol repo next to this one)

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OpenCC = await import(join(homedir(), "Documents/GitHub/pre-pol/node_modules/opencc-js/dist/esm/cn2t.js"));
const s2t = OpenCC.Converter({ from: "cn", to: "t" });
// the forms the web's Traditional pack uses (為 裡 核 啟 著 眾; it keeps 臺 檯), and s2t's wrong picks
const FIX: [RegExp, string][] = [
  [/爲/g, "為"],
  [/裏/g, "裡"],
  [/覈/g, "核"],
  [/啓/g, "啟"],
  [/着/g, "著"],
  [/衆/g, "眾"],
  [/讀數里/g, "讀數裡"],
  [/顯示錶格/g, "顯示表格"],
];
const dir = new URL("../gui/src/locales/", import.meta.url);
const hans = JSON.parse(readFileSync(new URL("zh-Hans.json", dir), "utf8")) as Record<string, string>;
const out: Record<string, string> = {};
for (const [k, v] of Object.entries(hans)) out[k] = FIX.reduce((s, [re, to]) => s.replace(re, to), s2t(v));
writeFileSync(new URL("zh-Hant.json", dir), `${JSON.stringify(out, null, 1)}\n`);
console.log(`${Object.keys(out).length} texts`);

// the desktop's own measure names (names-desktop.json): fill in zh-Hant the same way
const extra = JSON.parse(readFileSync(new URL("names-desktop.json", dir), "utf8")) as { names: Record<string, Record<string, string>> };
for (const n of Object.values(extra.names)) n["zh-Hant"] = FIX.reduce((s, [re, to]) => s.replace(re, to), s2t(n["zh-Hans"]!));
writeFileSync(new URL("names-desktop.json", dir), `${JSON.stringify(extra, null, 1)}\n`);
console.log(`${Object.keys(extra.names).length} measure names`);
