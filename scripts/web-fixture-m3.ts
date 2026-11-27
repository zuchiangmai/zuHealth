// M3 parity fixtures: synthetic Apple Health XML and a WHOOP bundle, with the rows the web code makes from them.
//   crates/health-core/tests/fixtures/apple-export.xml        input (the Rust test zips it)
//   crates/health-core/tests/fixtures/apple-expected.json     web createAppleParser output (rows by source + stats)
//   crates/health-core/tests/fixtures/whoop-bundle.json       input
//   crates/health-core/tests/fixtures/whoop-expected.json     web decode output
// Usage: bun scripts/web-fixture-m3.ts [web repo path]
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const web = process.argv[2] ?? join(homedir(), "Documents/GitHub/pre-pol/market/health");
const { createAppleParser } = await import(join(web, "src/client/lib/health/import/apple.ts"));
const { decode } = await import(join(web, "src/client/lib/health/whoop/decode.ts"));
const out = new URL("../crates/health-core/tests/fixtures/", import.meta.url).pathname;

const R = (type: string, src: string, unit: string, value: string, start: string, end = start) =>
  ` <Record type="HKQuantityTypeIdentifier${type}" sourceName="${src}" sourceVersion="17.0" unit="${unit}" creationDate="${start}" startDate="${start}" endDate="${end}" value="${value}"/>`;
const S = (stage: string, start: string, end: string) =>
  ` <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Test&apos;s Watch" sourceVersion="10" creationDate="${end}" startDate="${start}" endDate="${end}" value="HKCategoryValueSleepAnalysis${stage}"/>`;
const xml = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<!DOCTYPE HealthData [ <!ELEMENT HealthData ANY> ]>`,
  `<HealthData locale="en_US">`,
  ` <ExportDate value="2026-11-20 08:00:00 +0800"/>`,
  R("HeartRate", "Test&apos;s Watch", "count/min", "62", "2026-11-18 07:00:00 +0800"),
  R("HeartRate", "Test&apos;s Watch", "count/min", "65.5", "2026-11-18 07:05:00 +0800"),
  R("StepCount", "Test&apos;s Watch", "count", "120", "2026-11-18 07:01:00 +0800", "2026-11-18 07:03:00 +0800"),
  R("StepCount", "Test&apos;s Watch", "count", "80", "2026-11-18 07:10:00 +0800", "2026-11-18 07:12:00 +0800"),
  R("StepCount", "Test&apos;s Watch", "count", "300", "2026-11-18 07:20:00 +0800", "2026-11-18 07:25:00 +0800"),
  R("StepCount", "iPhone", "count", "500", "2026-11-18 07:02:00 +0800", "2026-11-18 07:30:00 +0800"),
  R("DistanceWalkingRunning", "iPhone", "km", "0.35", "2026-11-18 07:02:00 +0800", "2026-11-18 07:30:00 +0800"),
  R("ActiveEnergyBurned", "Test&apos;s Watch", "Cal", "12.4", "2026-11-18 07:01:00 +0800"),
  R("BodyFatPercentage", "Scale", "%", "0.29", "2026-11-18 06:50:00 +0800"),
  R("BodyMass", "Scale", "lb", "160.2", "2026-11-18 06:50:00 +0800"),
  R("BodyTemperature", "Thermo", "degF", "98.6", "2026-11-18 06:55:00 +0800"),
  R("BloodGlucose", "Meter", "mmol<180.1558800000541>/L", "5.4", "2026-11-18 06:58:00 +0800"),
  ` <Correlation type="HKCorrelationTypeIdentifierBloodPressure" sourceName="Cuff" startDate="2026-11-18 07:30:00 +0800" endDate="2026-11-18 07:30:00 +0800">`,
  R("BloodPressureSystolic", "Cuff", "mmHg", "999", "2026-11-18 07:30:00 +0800"),
  ` </Correlation>`,
  R("BloodPressureSystolic", "Cuff", "mmHg", "118", "2026-11-18 07:30:00 +0800"),
  R("BloodPressureDiastolic", "Cuff", "mmHg", "76", "2026-11-18 07:30:00 +0800"),
  R("HeartRate", "Test&apos;s Watch", "count/min", "70", "2026-02-30 07:00:00 +0800"),
  R("DietaryWater", "iPhone", "mL", "250", "2026-11-18 08:00:00 +0800"),
  S("InBed", "2026-11-17 23:10:00 +0800", "2026-11-18 06:40:00 +0800"),
  S("AsleepDeep", "2026-11-18 00:00:00 +0800", "2026-11-18 01:10:00 +0800"),
  S("AsleepREM", "2026-11-18 04:00:00 +0800", "2026-11-18 04:40:00 +0800"),
  S("AsleepCore", "2026-11-18 01:10:00 +0800", "2026-11-18 04:00:00 +0800"),
  R("HeartRate", "Test&apos;s Watch", "count/min", "58", "2026-11-19 07:00:00 -0500"),
  `</HealthData>`,
].join("\n");
writeFileSync(join(out, "apple-export.xml"), xml);

const rows: unknown[] = [];
const p = createAppleParser({ onRows: (r: unknown[]) => rows.push(...r) });
// feed in uneven chunks, as a stream would
for (let i = 0; i < xml.length; i += 97) p.push(xml.slice(i, i + 97));
p.end();
writeFileSync(join(out, "apple-expected.json"), JSON.stringify({ rows, stats: p.stats() }, null, 1) + "\n");

const t = (h: number) => new Date(Date.UTC(2026, 10, 18, h)).toISOString();
const bundle = {
  user_id: "whoop-user-1",
  tz: 480,
  sleeps: [
    { id: "s1", cycle_id: 10, start: t(15), end: t(22), timezone_offset: "+08:00", nap: false, score_state: "SCORED",
      score: { stage_summary: { total_light_sleep_time_milli: 12_000_000, total_slow_wave_sleep_time_milli: 5_400_000, total_rem_sleep_time_milli: 4_800_000, total_awake_time_milli: 1_800_000, sleep_cycle_count: 4, disturbance_count: 7 },
        respiratory_rate: 15.2, sleep_efficiency_percentage: 91.5, sleep_performance_percentage: 88, sleep_consistency_percentage: 77 } },
    { id: "s2", cycle_id: 10, start: t(6), end: t(7), timezone_offset: "+08:00", nap: true, score_state: "PENDING_SCORE" },
  ],
  recoveries: [{ cycle_id: 10, sleep_id: "s1", created_at: t(23), score_state: "SCORED",
    score: { recovery_score: 64, resting_heart_rate: 52, hrv_rmssd_milli: 48.3, spo2_percentage: 96.1, skin_temp_celsius: 33.4, user_calibrating: false } }],
  cycles: [{ id: 10, start: t(14), end: null, timezone_offset: "+08:00", score_state: "SCORED", score: { strain: 11.2, kilojoule: 8400, average_heart_rate: 68, max_heart_rate: 161 } },
    { id: 11, start: t(40), end: null, timezone_offset: "+08:00", score_state: "SCORED", score: { strain: 2, kilojoule: 900, average_heart_rate: 60, max_heart_rate: 90 } }],
  workouts: [{ id: "w1", start: t(1), end: t(2), timezone_offset: "+08:00", sport_name: "running", score_state: "SCORED", score: { strain: 9.1, max_heart_rate: 171, distance_meter: 6100 } }],
  body: { height_meter: 1.78, weight_kilogram: 72.4, max_heart_rate: 190 },
};
const NOW = Date.UTC(2026, 10, 20, 4);
writeFileSync(join(out, "whoop-bundle.json"), JSON.stringify(bundle, null, 1) + "\n");
writeFileSync(join(out, "whoop-expected.json"), JSON.stringify({ now: NOW, rows: decode(bundle, NOW) }, null, 1) + "\n");
console.log(`apple rows ${rows.length}, whoop rows ${decode(bundle, NOW).length}`);
