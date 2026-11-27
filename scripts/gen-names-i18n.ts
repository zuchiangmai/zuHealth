// Chinese measure names for the desktop UI from the web code: the Simplified source strings in W `names.ts` and
// their Traditional translations in the pol UI's l10n pack (keyed by the web's hashId of the source).
// Run: bun scripts/gen-names-i18n.ts   (needs the pre-pol repo next to this one)

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const P = join(homedir(), "Documents/GitHub/pre-pol");
const { hashId } = await import(join(P, "packages/locale/src/locale/i18n.ts"));
const hant = JSON.parse(readFileSync(join(P, "packages/locale/src/locale/l10n/packs/zh-Hant.json"), "utf8")).health as Record<string, string>;
const src = readFileSync(join(P, "market/health/src/client/names.ts"), "utf8");

const out: Record<string, { "zh-Hans": string; "zh-Hant": string }> = {};
let missing = 0;
for (const m of src.matchAll(/"([^"]+)":\s*\(\)\s*=>\s*t\("([^"]+)"\)/g)) {
  const [, code, hans] = m as unknown as [string, string, string];
  const tw = hant[hashId(hans)];
  if (!tw) missing++;
  out[code] = { "zh-Hans": hans, "zh-Hant": tw ?? hans };
}
const commit = execSync("git rev-parse --short HEAD", { cwd: P }).toString().trim();
writeFileSync(
  new URL("../gui/src/locales/names.json", import.meta.url),
  `${JSON.stringify({ about: `From the web code (pre-pol ${commit}) by scripts/gen-names-i18n.ts; do not edit`, names: out }, null, 1)}\n`,
);
console.log(`${Object.keys(out).length} names, ${missing} without a Traditional translation`);
