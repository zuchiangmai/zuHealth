#!/usr/bin/env bash
# LAN sync S6, part 2: the web app and the desktop on this Mac, through the DEV backend. A throwaway desktop
# profile with synthetic data joins the account the web shows (the web: Health account → Link a new device),
# then `health serve` runs until both sides show "up to date". Needs LuLu to allow target/debug/health.
set -uo pipefail
B="$(cd "$(dirname "$0")/.." && pwd)/target/debug/health"
W=$(mktemp -d /tmp/health-s6web-XXXXXX)
h() { HEALTH_DATA_DIR="$W/d" HEALTH_ROOT_KEY_FILE="$W/d.key" HEALTH_NO_BROWSER=1 "$B" "$@"; }
pids=()
trap 'for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null; done; rm -rf "$W"' EXIT
h init >/dev/null
h add loinc:29463-7 69.9 --unit kg >/dev/null
echo "1. The desktop shows a link code. On the web: Health account → Link a new device, scan or paste it."
echo y | h link join 2>&1 | tee "$W/join.log" || { echo "FAIL: link"; exit 1; }
h serve > "$W/out" 2> /tmp/health-s6web-serve.err & pids+=($!)
sleep 2
f="$W/d/profiles/default/serve.json"
port=$(python3 -c "import json;print(json.load(open('$f'))['port'])"); token=$(python3 -c "import json;print(json.load(open('$f'))['token'])")
op() { curl -s -m 10 -H "Authorization: Bearer $token" -d "$2" "http://127.0.0.1:$port/v1/op/$1"; }
echo "2. Waiting for the web on this network (open the web's Health account page; allow its first-sync question)…"
for _ in $(seq 1 180); do
  live=$(op sync.live '{}')
  st=$(python3 -c "import json,sys;p=json.loads(sys.argv[1])['value']['peers'];print(p[0]['state'] if p else 'none')" "$live")
  if [ "$st" = asking ]; then
    dev=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['value']['peers'][0]['device'])" "$live")
    op sync.answer "{\"device\":\"$dev\",\"allow\":true}" >/dev/null; echo "   desktop allowed the first sync"
  fi
  [ "$st" = up_to_date ] && { echo "3. desktop: up to date"; op obs.latest '{}' | python3 -c "import json,sys;[print('  ',p['metric'],p['value'],p['unit']) for p in json.load(sys.stdin)['value']]"; echo PASS; exit 0; }
  sleep 1
done
echo "FAIL: not up to date: $live"; exit 1
