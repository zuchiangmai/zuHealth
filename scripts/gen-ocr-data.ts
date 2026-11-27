// OCR data and fixtures from the web code (W = ~/Documents/GitHub/pre-pol/market/health), as gen-catalog.ts does
// for the catalog. The test pages (tests/fixtures/*.png, synthetic reports from the owner) first go through W's own
// engine (onnxruntime-web, the pinned models) into <page>.web.json; this script reads them. Writes crates/health-ocr/data/ (tables the Rust port loads) and tests/fixtures/web-*.json
// (what the web functions return on the same inputs). Run: bun scripts/gen-ocr-data.ts
import { execSync } from "node:child_process";
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const web = join(homedir(), "Documents/GitHub/pre-pol/market/health");
const ocr = join(web, "src/client/lib/health/ocr");
const out = new URL("../crates/health-ocr/", import.meta.url).pathname;
const commit = execSync("git rev-parse --short HEAD", { cwd: web }).toString().trim();

/** A module's top-level `const NAME = [...]` (not exported), evaluated. */
function constOf(file: string, name: string): unknown {
  const src = readFileSync(join(ocr, file), "utf8");
  const start = src.search(new RegExp(`const ${name}\\b[^=]*=`));
  if (start < 0) throw new Error(`${name} not in ${file}`);
  const from = src.indexOf("=", start) + 1;
  const end = src.indexOf("\n];", from) + 2;
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`export default ${src.slice(from, end)};`);
  return eval(js.replace("export default", "(") .replace(/;\s*$/, ")"));
}

const { OCR_METRICS } = await import(join(ocr, "metrics.ts"));
const meta = JSON.parse(readFileSync(join(ocr, "catalog-vectors.json"), "utf8"));
if (meta.count !== OCR_METRICS.length) throw new Error("vectors and metrics differ");
writeFileSync(join(out, "data/ocr-metrics.txt"), `# OCR_METRICS order of catalog-vectors.bin (W ${commit}); model ${meta.model}\n${OCR_METRICS.map((r: string[]) => r[0]).join("\n")}\n`);
copyFileSync(join(ocr, "catalog-vectors.bin"), join(out, "data/catalog-vectors.bin"));
writeFileSync(new URL("../crates/health-core/data/ocr-codes.json", import.meta.url).pathname, JSON.stringify({ w: commit, rows: constOf("codes.ts", "ROWS") }));
writeFileSync(join(out, "data/lexicon.json"), JSON.stringify({ w: commit, rows: constOf("lexicon.ts", "ROWS") }));

// fixtures: the web functions on fixed inputs
const { readTable, parseValue, isRef, refText, unitText, skewOf } = await import(join(ocr, "rows.ts"));
const { reportDate, parseYmd } = await import(join(ocr, "date.ts"));
const { unitKey, pickUnit } = await import(join(ocr, "unit.ts"));
const { codeFor } = await import(join(ocr, "codes.ts"));
const { englishFor } = await import(join(ocr, "lexicon.ts"));
const { queriesOf, preselected } = await import(join(ocr, "match.ts"));
const { newMetricOf } = await import(join(web, "src/client/lib/health/db/ocr.ts"));
const { detSize } = await import(join(ocr, "det.ts"));

// <page>.web.json: the web engine's lines on each test page (scripts header: produced by running W's engine.ts on the PNGs)
const pages = readdirSync(join(out, "tests/fixtures")).filter((f) => f.endsWith(".web.json")).sort();
const tables = Object.fromEntries(
  pages.map((f) => {
    const lines = JSON.parse(readFileSync(join(out, "tests/fixtures", f), "utf8"));
    const t = readTable(lines);
    return [f.replace(".web.json", ""), { items: t.items.map(({ box: _b, ...i }: { box: unknown }) => i), header: t.header, date: reportDate(lines), skew: skewOf(lines) }];
  }),
);
const values = ["6.52", "<0.5", "≥ 10", "4,260", "4,260 L", "1O.5", "128↑", "阴性(-)", "(+)", "Positive", "Few", "Straw yellow", "0-1", "2-5", "5,6", "abc def ghi jkl mno pqr stu", "12.0 H", "-1.5", "1+"];
const units = ["10^9/L", "x10^9/L", "10*9/l", "µmol/L", "μmol/L", "umol/L", "mlU/mL", "cells/uL", "g/100mL", "次/分", "mmHg", "[IU]/L", "10^3/uL"];
const names = [
  ["白细胞计数 WBC", 6.5, undefined, undefined], ["WBC", 3, undefined, "urine"], ["Glucose", "Negative", undefined, undefined],
  ["AST (SGOT)", 20, undefined, undefined], ["葡萄糖", 5.1, undefined, undefined], ["HbA1c", 5.6, undefined, undefined],
  ["Albumin (urine)", 12, undefined, undefined], ["Protein", "Negative", "Urinalysis", undefined], ["LDL (calculate)", 3.1, undefined, undefined],
  ["Occult blood stool", "Negative", undefined, undefined], ["Unknown thing", 1, undefined, undefined],
];
const fixtures = {
  w: commit,
  tables,
  parseValue: values.flatMap((v) => [{ in: v, col: false, out: parseValue(v, false) }, { in: v, col: true, out: parseValue(v, true) }]),
  isRef: ["3.5-9.5", "<5.2", "(57-111)", "130–175", "4,260", "6.5", "≥ 1.0", "5至10"].map((v) => ({ in: v, out: isRef(v), text: refText(v) })),
  unitText: ["f", "μmol / L", "—", "9/dL", "10^6/ uL"].map((v) => ({ in: v, out: unitText(v) })),
  unitKey: units.map((u) => ({ in: u, out: unitKey(u) })),
  pickUnit: [
    [["mmol/L", "mg/dL"], "mmol/L"], [["10*3/uL"], "/µL"], [["10*3/uL"], ""], [["{ratio}"], "mg/dL"], [["mmol/L", "mg/dL"], ""], [["umol/L"], "µmol/L"],
  ].map(([us, p]) => ({ units: us, printed: p, out: pickUnit(us as string[], p as string) })),
  codeFor: names.map(([name, v, panel, specimen]) => ({ name, v, panel, specimen, out: codeFor({ name, v, ...(panel ? { panel } : {}), ...(specimen ? { specimen } : {}) }) })),
  englishFor: ["葡萄糖", "空腹血糖", "ALT", "alt phosphatase", "白细胞计数 WBC", "hemoglobin", "Something"].map((n) => ({ in: n, out: englishFor(n), queries: queriesOf(n) })),
  parseYmd: ["2021-11-07", "2021/11/7", "2021年11月7日", "07/11/2021", "13/11/2021", "11/13/2021", "09/09/26", "01/02/69", "1989-01-01"].map((s) => ({ in: s, out: parseYmd(s, 2026) })),
  preselected: [[{ code: "a", score: 0.92 }, { code: "b", score: 0.9 }], [{ code: "a", score: 0.92 }, { code: "b", score: 0.915 }], [{ code: "a", score: 0.88 }], []].map((s) => ({ in: s, out: preselected(s) })),
  newMetric: [{ name: "Ferritin", unit: "ng/mL", v: 12 }, { name: "尿胆原", unit: "", v: "Negative" }, { name: "Neutrophils %", unit: "%", v: 60 }, { name: "B12", unit: "µg/L", v: 1 }].map((it) => ({ in: it, out: newMetricOf(it) })),
  detSize: [[4000, 3000], [1000, 600], [300, 100], [10, 10]].map(([w, h]) => ({ in: [w, h], out: detSize(w, h) })),
};
writeFileSync(join(out, "tests/fixtures/web-ocr.json"), JSON.stringify(fixtures, null, 1));
console.log("W", commit, "metrics", OCR_METRICS.length, "pages", Object.entries(tables).map(([k, t]) => `${k}:${(t as { items: unknown[] }).items.length}`).join(" "));
