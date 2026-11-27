#!/usr/bin/env bash
# A demo profile with synthetic data only (for README screenshots and trying the app): 60 days of made-up
# wearable and scale readings, two of the synthetic lab-report pages read by OCR (one confirmed, one waiting
# for review), and an agent grant. Usage: scripts/demo-profile.sh <dir> [ocr-models-dir]
# Then: HEALTH_DATA_DIR=<dir>/data HEALTH_ROOT_KEY_FILE=<dir>/root.key target/debug/health serve
set -euo pipefail
dir=${1:?usage: demo-profile.sh <dir> [ocr-models-dir]}
models=${2:-}
root=$(cd "$(dirname "$0")/.." && pwd)
bin="$root/target/debug/health"
export HEALTH_DATA_DIR="$dir/data" HEALTH_ROOT_KEY_FILE="$dir/root.key"
rm -rf "$dir" && mkdir -p "$dir"
"$bin" init >/dev/null
python3 - "$dir" <<'PY'
import json, math, random, sys, time
random.seed(7)
day = 86_400_000
now = int(time.time() * 1000) // day * day
watch, scale = [], []
for d in range(60, 0, -1):
    t = now - d * day
    w = lambda m, v, at=t + 7 * 3_600_000, **k: watch.append({"metric": m, "start_ms": at, "tz_min": 480, "value": v, **k})
    w("loinc:40443-4", round(58 + 3 * math.sin(d / 6) + random.uniform(-1.5, 1.5)))
    w("x:hrv_rmssd", round(52 + 8 * math.sin(d / 9) + random.uniform(-4, 4), 1), unit="ms")
    w("loinc:59408-5", round(random.uniform(95.5, 98.5), 1))
    w("x:daily_deep_sleep", int(random.uniform(55, 95) * 60_000), unit="ms")
    w("x:daily_rem_sleep", int(random.uniform(70, 115) * 60_000), unit="ms")
    w("x:daily_light_sleep", int(random.uniform(180, 250) * 60_000), unit="ms")
    for h in (9, 13, 18):
        w("loinc:55423-8", int(random.uniform(1200, 4200)), at=t + h * 3_600_000)
    if d % 2 == 0:
        scale.append({"metric": "loinc:29463-7", "start_ms": t + 7 * 3_600_000, "tz_min": 480, "value": round(74.5 - d * 0.03 + random.uniform(-0.4, 0.4), 1), "unit": "kg"})
        scale.append({"metric": "loinc:41982-0", "start_ms": t + 7 * 3_600_000, "tz_min": 480, "value": round(21 - d * 0.01 + random.uniform(-0.3, 0.3), 1)})
for name, rows in (("watch", watch), ("scale", scale)):
    with open(f"{sys.argv[1]}/{name}.jsonl", "w") as f:
        f.write("\n".join(json.dumps(r) for r in rows) + "\n")
PY
"$bin" import rows "$dir/watch.jsonl" --source "Demo watch" >/dev/null
"$bin" import rows "$dir/scale.jsonl" --source "Demo scale" >/dev/null
"$bin" add loinc:8480-6 118 --unit 'mm[Hg]' --at "$(date +%Y-%m-%d)" >/dev/null
"$bin" add loinc:8462-4 76 --unit 'mm[Hg]' --at "$(date +%Y-%m-%d)" >/dev/null
if [ -n "$models" ]; then
  fx="$root/crates/health-ocr/tests/fixtures"
  "$bin" component install ocr --from "$models" >/dev/null
  "$bin" --json ocr "$fx/cbc.png" >/dev/null
  "$bin" --json review list | python3 -c "
import json,sys
b=json.load(sys.stdin)[0]
print(json.dumps({'id':b['import_id'],'tz_min':480,'choices':[{'code':i['code']} if i.get('code') else {'skip':True} for i in b['candidates']['items']]}))" \
    | "$bin" op review.confirm_ocr - >/dev/null
  "$bin" --json ocr "$fx/chem-1.png" >/dev/null
fi
"$bin" grant create --name "Claude Desktop" --groups body,cardio,sleep,activity --days 90 --write propose >/dev/null
echo "demo profile in $dir"
