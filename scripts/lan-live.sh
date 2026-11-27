#!/usr/bin/env bash
# LAN sync S6 live test (docs/lan-sync.md §15): two throwaway profiles on this Mac with synthetic data, linked
# through the DEV backend (https://api-dev-health.4seas.xyz), each running `health serve`, sync over this Mac's
# real LAN addresses with signalling through the dev backend's /h/1/lan. Prints PASS or FAIL, then cleans up.
set -uo pipefail
B="$(cd "$(dirname "$0")/.." && pwd)/target/debug/health"
W=$(mktemp -d /tmp/health-s6-XXXXXX)
h() { local who=$1; shift; HEALTH_DATA_DIR="$W/$who" HEALTH_ROOT_KEY_FILE="$W/$who.key" HEALTH_NO_BROWSER=1 "$B" "$@"; }
pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null; done; rm -rf "$W"; }
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }

h a init >/dev/null && h b init >/dev/null || fail "init"
h a --json account register >/dev/null || fail "account register on a (dev backend reachable?)"
echo "1/6 account made on a"

# link: b joins, a gives (both answer yes)
mkfifo "$W/in"
h b --json link join < "$W/in" > "$W/join.out" 2> "$W/join.err" & pids+=($!)
exec 3> "$W/in"
for _ in $(seq 1 60); do grep -q ZUHL1: "$W/join.err" 2>/dev/null && break; sleep 0.5; done
CODE=$(grep -o 'ZUHL1:[^ ]*' "$W/join.err" | head -1)
[ -n "$CODE" ] || fail "no link code"
echo y | h a --json link give "$CODE" >/dev/null || fail "link give"
echo y >&3; exec 3>&-
for _ in $(seq 1 60); do [ -s "$W/join.out" ] && break; sleep 0.5; done
grep -q '"id"' "$W/join.out" || fail "link join: $(cat "$W/join.out")"
echo "2/6 b linked to a's account"

h a add loinc:29463-7 70.1 --unit kg >/dev/null || fail "add on a"
h b add loinc:8867-4 61 >/dev/null || fail "add on b"
echo "3/6 one synthetic reading on each"

h a serve > "$W/a.out" 2> "$W/a.err" & pids+=($!)
h b serve > "$W/b.out" 2> "$W/b.err" & pids+=($!)
sleep 2
op() { # op <who> <name> <json>
  local f="$W/$1/profiles/default/serve.json"
  local port token
  port=$(python3 -c "import json;print(json.load(open('$f'))['port'])")
  token=$(python3 -c "import json;print(json.load(open('$f'))['token'])")
  curl -s -m 10 -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d "$3" "http://127.0.0.1:$port/v1/op/$2"
}
state() { op "$1" sync.live '{}' | python3 -c "import json,sys;p=json.load(sys.stdin)['value']['peers'];print(p[0]['state'] if p else 'none')"; }
device() { op "$1" sync.live '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['value']['peers'][0]['device'])"; }

for _ in $(seq 1 90); do
  [ "$(state a)" = asking ] && [ "$(state b)" = asking ] && break
  sleep 1
done
[ "$(state a)" = asking ] || fail "a never saw b (a: $(state a), b: $(state b)); live: $(op a sync.live '{}')"
echo "4/6 the two serves found each other through the dev relay and both ask to join"

op a sync.answer "{\"device\":\"$(device a)\",\"allow\":true}" >/dev/null
op b sync.answer "{\"device\":\"$(device b)\",\"allow\":true}" >/dev/null
for _ in $(seq 1 90); do
  [ "$(state a)" = up_to_date ] && [ "$(state b)" = up_to_date ] && break
  sleep 1
done
[ "$(state a)" = up_to_date ] && [ "$(state b)" = up_to_date ] || fail "not up to date (a: $(state a), b: $(state b))"
echo "5/6 both up to date"

n() { op "$1" obs.latest '{}' | python3 -c "import json,sys;print(len(json.load(sys.stdin)['value']))"; }
[ "$(n a)" = 2 ] && [ "$(n b)" = 2 ] || fail "readings: a $(n a), b $(n b) (want 2 each)"
echo "6/6 each has both readings"
echo PASS
