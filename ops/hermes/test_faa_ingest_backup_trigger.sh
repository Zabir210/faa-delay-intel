#!/usr/bin/env bash
# Scenario test for faa_ingest_backup_trigger.sh (no network, pinned clock).
#   bash ops/hermes/test_faa_ingest_backup_trigger.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
W="$HERE/faa_ingest_backup_trigger.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export STATE_FILE="$T/state.json" RUN_RESPONSE_FILE="$T/run.txt" HEALTH_JSON_FILE="$T/h.json"
T0=1760313600  # 2025-10-13T00:00:00Z (a Cloudflare slot)
fail=0

last_run() {  # epoch of the latest ingest_runs row
  printf '{"healthy":true,"last_run":{"ran_at":"%s","status":"ok"}}' \
    "$(python3 -c "import datetime,sys;print(datetime.datetime.fromtimestamp($1,datetime.timezone.utc).isoformat())")" > "$T/h.json"
}
run_ok()  { printf '200\n{"status":"ok","records_seen":6,"records_new":2}' > "$T/run.txt"; }
run_bad() { printf '401\nunauthorized\n' > "$T/run.txt"; }
fired() { python3 -c "import json;print(json.load(open('$STATE_FILE')).get('fired',0))"; }
step() {  # name now expect(regex|EMPTY) [expected fired count]
  local name=$1 now=$2 want=$3 n=${4:-}
  local out; out="$(NOW="$now" bash "$W")"
  if { [ "$want" = EMPTY ] && [ -z "$out" ]; } || { [ "$want" != EMPTY ] && [[ "$out" =~ $want ]]; }; then
    if [ -n "$n" ] && [ "$(fired)" != "$n" ]; then
      echo "FAIL - $name: fired=$(fired) want $n"; fail=1
    else
      echo "ok   - $name"
    fi
  else
    echo "FAIL - $name: got [$out] want [$want]"; fail=1
  fi
}

run_ok
last_run $T0;                       step "cron on time: silent, no fire"          $((T0+120)) EMPTY 0
# Cron misses the :05 slot. At :07 the last run is 7 min old.
                                    step "missed slot: takes over and says so"    $((T0+420)) "Cloudflare cron missed a slot \(last run 7 min ago\).*ok, 6 seen, 2 new" 1
last_run $((T0+421))                # our own run lands
                                    step "only our run since: keeps firing"       $((T0+720)) EMPTY 2
last_run $((T0+721))
                                    step "still ours: fires silently"             $((T0+1020)) EMPTY 3
# Cloudflare fires at :20 again.
last_run $((T0+1200));              step "cron back: stands down once"            $((T0+1320)) "firing again.*after 15 min \(3 backup runs\)"
last_run $((T0+1500));              step "cron keeps firing: silent"              $((T0+1620)) EMPTY 0
# /run failures: report the first, stay quiet until the 2h reminder.
run_bad; last_run $T0
                                    step "failed /run on takeover is reported"    $((T0+3000)) "missed a slot.*Backup POST /run failed: HTTP 401 unauthorized" 1
                                    step "second failure: silent"                 $((T0+3300)) EMPTY 2
                                    step "failure reminder after 2h"              $((T0+3000+7200)) "^🚨 Backup POST /run failed"
# Health endpoint down: never fire blind (the staleness watchdog pages).
rm -f "$STATE_FILE"; out="$(NOW=$T0 HEALTH_JSON_FILE= BASE_URL=http://127.0.0.1:9 bash "$W")"
[ -z "$out" ] && [ "$(fired)" = 0 ] && echo "ok   - health unreachable: silent, no fire" || { echo "FAIL - unreachable: [$out]"; fail=1; }
exit $fail
