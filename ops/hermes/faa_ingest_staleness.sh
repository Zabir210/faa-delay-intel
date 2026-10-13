#!/usr/bin/env bash
# faa_ingest_staleness.sh — watchdog for the faa-delay-intel ingest Worker.
#
# Canonical copy: ~/workspace/faa-delay-intel/ops/hermes/faa_ingest_staleness.sh
# Installed copy: ~/.hermes/scripts/faa_ingest_staleness.sh (re-copy after edits)
# Run by Hermes cron job "faa-ingest-staleness" (no-agent, deliver telegram)
# every 10 minutes. Empty stdout = nothing sent.
#
# Reads the Worker's public GET / health JSON and alerts when it reports
#   stale   - no ingest_runs row of any status in 30 min (cron not firing:
#             how 2026-09-28..2026-10-07 was lost with no alert), or
#   failing - runs are logged but none ok in 30 min (e.g. FAA 403s), or
# when the endpoint itself is down for 2 consecutive checks (one network
# blip on this Mac is not worth a page).
#
# Runs off-Cloudflare on purpose: a check inside the same Worker dies with it.
# Dedup: one alert when a problem starts, a reminder every 2h while it lasts,
# one "recovered" message when it clears. State lives in STATE_FILE.
#
# Test hooks: HEALTH_JSON_FILE=<file> skips the network; NOW=<epoch> pins time.

set -u

HEALTH_URL="${HEALTH_URL:-https://faa-delay-intel-scheduler.zabir1.workers.dev/}"
STATE_FILE="${STATE_FILE:-$HOME/.hermes/state/faa_ingest_staleness.json}"
mkdir -p "$(dirname "$STATE_FILE")"

if [ -n "${HEALTH_JSON_FILE:-}" ]; then
  BODY="$(cat "$HEALTH_JSON_FILE")"; CODE=200
else
  RESP="$(curl -s -m 25 -w $'\n%{http_code}' "$HEALTH_URL" 2>&1)"
  CODE="${RESP##*$'\n'}"; BODY="${RESP%$'\n'*}"
fi

BODY="$BODY" CODE="$CODE" STATE_FILE="$STATE_FILE" HEALTH_URL="$HEALTH_URL" \
python3 -I - <<'PY'
import json, os, time
from datetime import datetime

STALE_S, REMIND_S = 1800, 7200
now = float(os.environ.get("NOW") or time.time())
url, state_path = os.environ["HEALTH_URL"], os.environ["STATE_FILE"]

try:
    state = json.load(open(state_path))
except Exception:
    state = {}

def ts(v):
    return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()

def fmt_age(s):
    s = int(s)
    return f"{s // 3600}h{s % 3600 // 60:02d}m" if s >= 3600 else f"{s // 60} min"

problem, unreachable = None, False
try:
    if os.environ["CODE"] != "200":
        raise ValueError(f"HTTP {os.environ['CODE']}: {os.environ['BODY'][:200]}")
    h = json.loads(os.environ["BODY"])
    last = h.get("last_run") or {}
    if "healthy" not in h:
        # Older Worker build without the flags: derive staleness ourselves.
        age = now - ts(last["ran_at"]) if last.get("ran_at") else None
        h = {"healthy": age is not None and age <= STALE_S, "stale": age is None or age > STALE_S,
             "failing": False, "age_seconds": age}
    if not h["healthy"]:
        if h["stale"]:
            age = h.get("age_seconds")
            problem = ("STALE: no ingest run at all in " + fmt_age(age) if age is not None
                       else "STALE: ingest_runs is empty") + " (cron not firing?)"
        else:
            okage = h.get("ok_age_seconds")
            problem = ("FAILING: runs are logging but none ok in "
                       + (fmt_age(okage) if okage is not None else "recorded history"))
        if last:
            problem += f". Last run {last.get('ran_at')} status={last.get('status')}"
            if last.get("error"):
                problem += f" error={last['error'][:200]}"
except Exception as e:
    unreachable = True
    problem = f"health endpoint unreachable ({type(e).__name__}: {str(e)[:200]})"

msg = None
if problem and unreachable:
    state["unreachable_streak"] = state.get("unreachable_streak", 0) + 1
    if state["unreachable_streak"] < 2:
        problem = None  # wait for a second consecutive failure
else:
    state["unreachable_streak"] = 0

if problem:
    if not state.get("alerting"):
        state.update(alerting=True, since=now, last_alert=now)
        msg = f"🚨 FAA ingest {problem}.\nHealth: {url}\nCheck: cd ~/workspace/faa-delay-intel/worker && npx wrangler deployments list"
    elif now - state.get("last_alert", 0) >= REMIND_S:
        state["last_alert"] = now
        msg = f"🚨 FAA ingest still down ({fmt_age(now - state['since'])}): {problem}.\nHealth: {url}"
elif state.get("alerting") and not (unreachable and state["unreachable_streak"] < 2):
    msg = f"✅ FAA ingest recovered after {fmt_age(now - state['since'])}."
    state.update(alerting=False, since=None, last_alert=None)

tmp = state_path + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f)
os.replace(tmp, state_path)
if msg:
    print(msg)
PY
