// Builds the web-parity fixture with the web version's own code (synthetic data only):
//   crates/health-core/tests/fixtures/web-backup.zuhealth   backup made by the web export (password "fixture-pass")
//   crates/health-core/tests/fixtures/web-expected.json     v_daily / v_observation as the web code computes them
// Usage: bun scripts/web-fixture.ts [web repo path]   (records the web commit in tests/fixtures/README.md)
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { plugin } from "bun";

const web = process.argv[2] ?? join(homedir(), "Documents/GitHub/pre-pol/market/health");
plugin({
  name: "raw",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: join(dirname(a.importer), a.path.replace(/\?raw$/, "")), namespace: "raw" }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, (a) => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, "utf8"))}`, loader: "js" }));
  },
});
const lib = join(web, "src/client/lib/health");
const { txPair } = await import(join(lib, "db/engine.ts"));
const { initDb } = await import(join(lib, "db/open.ts"));
const { begin, write, finish } = await import(join(lib, "db/write.ts"));
const { enterManual, removeManual } = await import(join(lib, "db/manual.ts"));
const { correct } = await import(join(lib, "db/correction.ts"));
const { Hlc } = await import(join(lib, "db/hlc.ts"));
const { confirmReview } = await import(join(lib, "db/review.ts"));
const { exportPlain } = await import(join(lib, "db/merge.ts"));
const { packExport } = await import(join(lib, "export/pack.ts"));

const tmp = join(tmpdir(), `health-fixture-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const raw = new Database(join(tmp, "web.db"));
const bind = (p: readonly unknown[] = []) => p.map((v) => (typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : v)) as never[];
const db = {
  exec: (sql: string, p?: readonly unknown[]) => (p?.length ? raw.query(sql).run(...bind(p)) : raw.exec(sql)),
  all: (sql: string, p?: readonly unknown[]) => raw.query(sql).all(...bind(p)),
  prepare: (sql: string) => {
    const st = raw.query(sql);
    return { run: (p?: unknown[]) => void st.run(...bind(p)), all: (p?: unknown[]) => st.all(...bind(p)), finalize() {} };
  },
  ...txPair((s: string) => raw.exec(s)),
};

const NOW = Date.UTC(2026, 10, 20, 12); // 2026-11-20 12:00Z
const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 10) - 8 * H; // 2026-11-10 00:00 local (+08:00)
const TZ = 480;
initDb(db);
db.exec("INSERT INTO metric (code, name, unit, agg) VALUES ('x:room_co2', 'Room CO2', 'ppm', 'level')");

// device export: heart rate, steps (two sources), deep sleep with overlap, a censored glucose, CO2 levels
const dev = { connector: "apple_export", externalId: "watch:1", name: "Watch" };
const phone = { connector: "apple_export", externalId: "phone:1", name: "Phone", priority: 100 };
const a = begin(db, dev, "apple-export@3", null, { uid: "0193a5c2-7e1f-7b3a-9c4d-000000000001" });
write(db, a.importId, [
  ...[60, 72, 80, 65].map((v, i) => ({ metric: "loinc:8867-4", start_ms: T0 + (8 + i) * H, tz_min: TZ, value: v })),
  { metric: "loinc:8867-4", start_ms: T0 + 24 * H + 9 * H, tz_min: TZ, value: 70 },
  { metric: "loinc:8867-4", start_ms: T0 + 24 * H + 20 * H, tz_min: 540, value: 66 }, // travelled to +09:00
  { metric: "loinc:55423-8", start_ms: T0 + 9 * H, end_ms: T0 + 10 * H, tz_min: TZ, value: 1200 },
  { metric: "loinc:55423-8", start_ms: T0 + 15 * H, end_ms: T0 + 16 * H, tz_min: TZ, value: 3400 },
  { metric: "loinc:93831-6", start_ms: T0 - 2 * H, end_ms: T0 + 1 * H, tz_min: TZ, value: null },
  { metric: "loinc:93831-6", start_ms: T0, end_ms: T0 + 2 * H, tz_min: TZ, value: null },
  { metric: "loinc:2345-7", start_ms: T0 + 7 * H, tz_min: TZ, value: 2.0, unit: "mmol/L", detail: { comparator: "<" } },
  { metric: "loinc:2345-7", start_ms: T0 + 8 * H, tz_min: TZ, value: 5.5, unit: "mmol/L" },
]);
finish(db, a.importId, { now: NOW });
const p = begin(db, phone, "apple-export@3", null, { uid: "0193a5c2-7e1f-7b3a-9c4d-000000000002" });
write(db, p.importId, [{ metric: "loinc:55423-8", start_ms: T0 + 9 * H, end_ms: T0 + 18 * H, tz_min: TZ, value: 9999 }]);
finish(db, p.importId, { now: NOW });
const room = { connector: "home_assistant", externalId: "ha-1/sensor.co2", name: "Bedroom CO2" };
const r = begin(db, room, "ha@1", null, { uid: "0193a5c2-7e1f-7b3a-9c4d-000000000003" });
write(db, r.importId, [
  { metric: "x:room_co2", start_ms: T0 + 22 * H, tz_min: TZ, value: 600 },
  { metric: "x:room_co2", start_ms: T0 + 25 * H, tz_min: TZ, value: 900 },
  { metric: "x:room_co2", start_ms: T0 + 30 * H, tz_min: TZ, value: null },
  { metric: "x:room_co2", start_ms: T0 + 31 * H, tz_min: TZ, value: 700 },
]);
finish(db, r.importId, { now: NOW });

// manual entries; one removed (tombstone)
enterManual(db, [{ metric: "loinc:29463-7", value: 70.5, unit: "kg", at: { date: "2026-11-10", tz_min: TZ } }], { uid: "0193a5c2-7e1f-7b3a-9c4d-000000000004", now: NOW });
enterManual(db, [{ metric: "loinc:29463-7", value: 160, unit: "[lb_av]", at: { ms: T0 + 33 * H, tz_min: TZ } }], { uid: "0193a5c2-7e1f-7b3a-9c4d-000000000005", now: NOW });
removeManual(db, { code: "loinc:29463-7", start_ms: T0 + 33 * H }, { now: NOW });

// corrections on device data: one change, one delete
const hlc = new Hlc({ now: () => NOW });
const hr = Number((db.all("SELECT id FROM metric WHERE code = 'loinc:8867-4'")[0] as { id: number }).id);
const src = Number((db.all("SELECT id FROM source WHERE external_id = 'watch:1'")[0] as { id: number }).id);
correct(db, hlc, { metricId: hr, sourceId: src, start_ms: T0 + 9 * H }, 75, { now: NOW });
correct(db, hlc, { metricId: hr, sourceId: src, start_ms: T0 + 11 * H }, null, { now: NOW });

// a confirmed lab report (with full text) and one still waiting for review
const lab = { connector: "ocr", externalId: "photo", name: "OCR" };
const rv = begin(db, lab, "ocr-ppv5@2", "a".repeat(64), { uid: "0193a5c2-7e1f-7b3a-9c4d-000000000006", review: { candidates: { kind: "ocr", items: [] } } });
confirmReview(db, rv.importId, [{ metric: "loinc:2093-3", start_ms: T0, tz_min: TZ, value: 5.2, unit: "mmol/L", detail: { precision: "day" } }], "總膽固醇 5.2 mmol/L 結論：未見異常", { now: NOW });
begin(db, lab, "ocr-ppv5@2", "b".repeat(64), { uid: "0193a5c2-7e1f-7b3a-9c4d-000000000007", review: { candidates: { kind: "ocr", items: [] } } });

// a user-made lab metric (printed unit spelling kept)
db.exec("INSERT INTO metric (code, name, unit, agg) VALUES ('x:ocr/ferritin.ng-ml', 'Ferritin', 'ng/ml', 'instant')");
const lab2 = begin(db, { connector: "ocr", externalId: "photo", name: "OCR" }, "ocr-ppv5@2", "c".repeat(64), { uid: "0193a5c2-7e1f-7b3a-9c4d-000000000008", review: { candidates: { kind: "ocr", items: [] } } });
confirmReview(db, lab2.importId, [{ metric: "x:ocr/ferritin.ng-ml", start_ms: T0 + 24 * H, tz_min: TZ, value: 88 }], undefined, { now: NOW });

// expected results, keyed by global identities
const daily = db.all(`SELECT m.code, d.day, s.connector, s.external_id, d.n, d.sum, d.min, d.max, d.seconds
  FROM v_daily d JOIN metric m ON m.id = d.metric_id JOIN source s ON s.id = d.source_id ORDER BY m.code, d.day`);
const obs = db.all(`SELECT m.code, o.start_ms, s.connector, s.external_id, o.end_ms, o.tz_min, o.value, i.uid, o.detail, o.corrected
  FROM v_observation o JOIN metric m ON m.id = o.metric_id JOIN source s ON s.id = o.source_id JOIN import i ON i.id = o.import_id
  ORDER BY m.code, o.start_ms, s.connector, s.external_id`);
const imports = db.all("SELECT uid, status, parser FROM import ORDER BY uid");

exportPlain(db, join(tmp, "plain.db"));
const bytes = new Uint8Array(readFileSync(join(tmp, "plain.db")));
const manifest = new TextEncoder().encode(JSON.stringify({ fmt: "zu-health-backup", v: 1, at: NOW }));
const parts: Uint8Array[] = [];
for await (const c of packExport(
  [
    { name: "db.sqlite", data: bytes, store: true },
    { name: "manifest.json", data: manifest },
  ],
  "fixture-pass",
  { iter: 1000, chunk: 65536 },
))
  parts.push(c);

const out = new URL("../crates/health-core/tests/fixtures/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "web-backup.zuhealth"), Buffer.concat(parts));
const big = (_: string, v: unknown) => (typeof v === "bigint" ? Number(v) : v);
writeFileSync(join(out, "web-expected.json"), JSON.stringify({ now: NOW, daily, obs, imports }, big, 1) + "\n");
raw.close();
rmSync(tmp, { recursive: true, force: true });
const rev = Bun.spawnSync(["git", "-C", web, "rev-parse", "HEAD"]).stdout.toString().trim();
writeFileSync(join(out, "README.md"), `Generated by \`bun scripts/web-fixture.ts\` from the web version at commit ${rev}.\nSynthetic data only. Backup password: \`fixture-pass\`.\n`);
console.log(`daily ${daily.length}, obs ${obs.length}, imports ${imports.length}`);
