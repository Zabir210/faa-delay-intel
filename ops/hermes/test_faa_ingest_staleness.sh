#!/usr/bin/env bash
# Scenario test for faa_ingest_staleness.sh (no network, pinned clock).
#   bash ops/hermes/test_faa_ingest_staleness.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
W="$HERE/faa_ingest_staleness.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export STATE_FILE="$T/state.json"
T0=1760313600  # 2025-10-13T00:00:00Z
fail=0

health() {  # healthy stale failing age ok_age status
  printf '{"healthy":%s,"stale":%s,"failing":%s,"age_seconds":%s,"ok_age_seconds":%s,"last_run":{"ran_at":"2025-10-13T00:00:00Z","status":"%s","error":%s}}' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$([ "$6" = error ] && echo '"HTTPStatusError: 403"' || echo null)" > "$T/h.json"
}
step() {  # name now expect(regex|EMPTY) [extra env...]
  local name=$1 now=$2 want=$3; shift 3
  local out; out="$(env NOW="$now" HEALTH_JSON_FILE="$T/h.json" "$@" bash "$W")"
  if { [ "$want" = EMPTY ] && [ -z "$out" ]; } || { [ "$want" != EMPTY ] && [[ "$out" =~ $want ]]; }; then
    echo "ok   - $name"
  else
    echo "FAIL - $name: got [$out] want [$want]"; fail=1
  fi
}

health true false false 60 60 ok;           step "healthy is silent"                 $T0 EMPTY
health false true false 2820 2820 ok;       step "stale alerts once"                 $((T0+600)) "STALE: no ingest run at all in 47 min"
                                            step "stale again 10 min later: silent"  $((T0+1200)) EMPTY
                                            step "reminder after 2h"                 $((T0+600+7200)) "still down \(2h00m\)"
health true false false 60 60 ok;           step "recovery announced once"           $((T0+9000)) "recovered after 2h20m"
                                            step "then silent"                       $((T0+9600)) EMPTY
health false false true 60 2400 error;      step "failing (fresh errors) alerts"     $((T0+10200)) "FAILING: .* none ok in 40 min.*403"
health true false false 60 60 ok;           step "recovers"                          $((T0+10800)) "recovered"
printf '{"service":"x","last_run":{"ran_at":"2025-10-12T23:00:00Z","status":"ok"}}' > "$T/h.json"
                                            step "old payload: derives stale itself" $T0 "STALE: no ingest run at all in 1h00m"
printf '{"service":"x","last_run":{"ran_at":"2025-10-12T23:58:00Z","status":"ok"}}' > "$T/h.json"
                                            step "old payload fresh: recovers"       $T0 "recovered"
# Unreachable: point at a dead local port instead of the JSON file.
unreach() { local out; out="$(NOW=$1 HEALTH_URL=http://127.0.0.1:9/ bash "$W")"; echo "$out"; }
o="$(unreach $T0)"; [ -z "$o" ] && echo "ok   - one unreachable check is silent" || { echo "FAIL - unreachable 1: [$o]"; fail=1; }
o="$(unreach $((T0+600)))"; [[ "$o" =~ "unreachable" ]] && echo "ok   - second consecutive unreachable alerts" || { echo "FAIL - unreachable 2: [$o]"; fail=1; }
exit $fail
