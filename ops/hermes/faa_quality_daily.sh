#!/usr/bin/env bash
# faa_quality_daily.sh — daily production data-quality check for faa-delay-intel.
#
# Canonical copy: ~/workspace/faa-delay-intel/ops/hermes/faa_quality_daily.sh
# Installed copy: ~/.hermes/scripts/faa_quality_daily.sh (re-copy after edits)
# Run by Hermes cron job "faa-quality-daily" (no-agent, deliver telegram).
# Empty stdout = nothing sent.
#
# Dispatches the read-only quality.yml workflow (tests/test_data_quality.py
# against production: no future rows, no duplicate keys, >=90% of last-24h
# ingest runs ok, ...) and waits for THAT run. Alerts when the run fails, and
# also when it can't be dispatched or doesn't finish in time, so a broken
# check can never look like a passing one. GitHub Actions `schedule` is not
# used (it runs hours late); Hermes is the clock.
#
# Test hooks: GH=<fake gh>, POLL_S, MAX_WAIT_S.

set -u

REPO="Zabir210/faa-delay-intel"
GH="${GH:-/opt/homebrew/bin/gh}"
POLL_S="${POLL_S:-15}"
MAX_WAIT_S="${MAX_WAIT_S:-600}"

alert() { printf '🚨 FAA data quality: %s\n' "$*"; exit 0; }

# Newer gh prints the run URL on dispatch; fall back to the newest
# workflow_dispatch run created after we asked.
SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUT="$("$GH" workflow run quality.yml -R "$REPO" 2>&1)" \
  || alert "could not dispatch quality.yml: $(echo "$OUT" | tail -1)"
ID="$(echo "$OUT" | grep -oE 'actions/runs/[0-9]+' | head -1 | cut -d/ -f3)"
for _ in $(seq 1 12); do
  [ -n "$ID" ] && break
  sleep 5
  ID="$("$GH" run list -R "$REPO" --workflow quality.yml --event workflow_dispatch --limit 1 \
        --json databaseId,createdAt --jq ".[] | select(.createdAt >= \"$SINCE\") | .databaseId" 2>/dev/null)"
done
[ -n "$ID" ] || alert "dispatched quality.yml but could not find the run"
URL="https://github.com/$REPO/actions/runs/$ID"

waited=0
while :; do
  STATE="$("$GH" run view "$ID" -R "$REPO" --json status,conclusion --jq '.status + " " + .conclusion' 2>/dev/null)"
  case "$STATE" in
    "completed success") exit 0 ;;
    completed*) break ;;
  esac
  [ "$waited" -ge "$MAX_WAIT_S" ] && alert "run did not finish within ${MAX_WAIT_S}s (state: ${STATE:-unknown}). $URL"
  sleep "$POLL_S"; waited=$((waited + POLL_S))
done

# Failed: name the failing checks and their assertion messages.
DETAIL="$("$GH" run view "$ID" -R "$REPO" --log-failed 2>/dev/null \
  | grep -E 'FAILED|AssertionError|Error:' | sed -E 's/^.*Z //; s/^E +//' \
  | awk '!seen[$0]++' | head -6)"
alert "run ${STATE#completed } — ${DETAIL:-no failure detail in log}
$URL"
