// Reverse parity: the web code restores a backup made by the Rust CLI and must compute the same v_daily
// as tests/fixtures/web-expected.json. Local check only (needs the W repo).
// Usage: node scripts/web-import-check.ts <backup.zuhealth> <password> [web repo path]
// Node, not Bun: the web's merge calls the SQL function utf8_ok (merge-fixes R11), which the web's own test adapter
// (W test/sqlite.ts, node:sqlite) registers; bun:sqlite can't register functions.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [file, password] = process.argv.slice(2);
const web = process.argv[4] ?? join(homedir(), "Documents/GitHub/pre-pol/market/health");
// `import x from "./schema.sql?raw"` (a Vite feature) as a module exporting the file's text
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.endsWith("?raw")) return { url: new URL(spec, ctx.parentURL).href, shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.endsWith("?raw")) {
      const text = readFileSync(fileURLToPath(url.replace(/\?raw$/, "")), "utf8");
      return { format: "module", source: `export default ${JSON.stringify(text)}`, shortCircuit: true };
    }
    return next(url, ctx);
  },
});
const lib = join(web, "src/client/lib/health");
const { nodeDb } = await import(join(web, "test/sqlite.ts"));
const { initDb } = await import(join(lib, "db/open.ts"));
const { mergeFrom } = await import(join(lib, "db/merge.ts"));
const { unpackExport, collect } = await import(join(lib, "export/pack.ts"));

const tmp = join(tmpdir(), `health-revcheck-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const files = await collect(unpackExport([new Uint8Array(readFileSync(file!))], password!));
writeFileSync(join(tmp, "plain.db"), files.get("db.sqlite")!);
const db = nodeDb(join(tmp, "web.db"));
initDb(db);
const expected = JSON.parse(readFileSync(new URL("../crates/health-core/tests/fixtures/web-expected.json", import.meta.url), "utf8"));
const rep = mergeFrom(db, join(tmp, "plain.db"), { now: expected.now });
const daily = db.all(`SELECT m.code, d.day, s.connector, s.external_id, d.n, d.sum, d.min, d.max, d.seconds
  FROM v_daily d JOIN metric m ON m.id = d.metric_id JOIN source s ON s.id = d.source_id ORDER BY m.code, d.day`);
const big = (_: string, v: unknown) => (typeof v === "bigint" ? Number(v) : v);
const same = JSON.stringify(daily, big) === JSON.stringify(expected.daily);
db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`skipped metrics: ${rep.skippedMetrics.length}, daily rows: ${daily.length}, identical to web-expected: ${same}`);
process.exit(same && rep.skippedMetrics.length === 0 ? 0 : 1);
