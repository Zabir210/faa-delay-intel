#!/usr/bin/env bash
# faa_ingest_backup_trigger.sh — backup clock for the faa-delay-intel ingest Worker.
#
# Canonical copy: ~/workspace/faa-delay-intel/ops/hermes/faa_ingest_backup_trigger.sh
# Installed copy: ~/.hermes/scripts/faa_ingest_backup_trigger.sh (re-copy after edits)
# Run by Hermes cron job "faa-ingest-backup" (no-agent, deliver telegram) at
# 2-59/5: two minutes after each Cloudflare Cron Trigger slot (:00, :05, ...).
# Empty stdout = nothing sent.
#
# Why: on 2026-10-13 Cloudflare Cron Triggers stopped firing for re-deployed
# schedules (cloudflarestatus incident cbvocc87nsne) and we lost 40 of 288
# snapshots. The Worker's fetch handler kept working the whole time, so when
# a cron slot is missed this script calls POST /run itself. Duplicate runs are
# harmless (the pipeline is idempotent and advisory-locked).
#
# Decision per check, from the public GET / health JSON:
#   - last run older than MISS_AFTER_S (6.5 min: one 5-min slot missed) -> fire
#   - backup already active and every run since was ours -> keep firing
#     (our own runs keep the age low, so age alone can't tell cron is back)
#   - a run newer than our last fire + OURS_S that we didn't make -> cron is
#     back: stand down
# Messages: one when the backup takes over, one when it stands down, and one
# per streak of failed /run calls (repeated every 2h). The staleness watchdog
# (faa_ingest_staleness.sh) still pages if ingest stops entirely.
#
# Test hooks: HEALTH_JSON_FILE=<file> skips the GET; RUN_RESPONSE_FILE=<file>
# (first line = HTTP code, rest = body) skips the POST; NOW=<epoch> pins time.

set -u

BASE_URL="${BASE_URL:-https://faa-delay-intel-scheduler.zabir1.workers.dev}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/workspace/faa-delay-intel/.worker-trigger-token}"
STATE_FILE="${STATE_FILE:-$HOME/.hermes/state/faa_ingest_backup.json}"
mkdir -p "$(dirname "$STATE_FILE")"

if [ -n "${HEALTH_JSON_FILE:-}" ]; then
  HBODY="$(cat "$HEALTH_JSON_FILE")"; HCODE=200
else
  RESP="$(curl -s -m 25 -w $'\n%{http_code}' "$BASE_URL/" 2>&1)"
  HCODE="${RESP##*$'\n'}"; HBODY="${RESP%$'\n'*}"
fi

# Ask python whether to fire; it prints "fire" or nothing.
decide() {
  HBODY="$HBODY" HCODE="$HCODE" STATE_FILE="$STATE_FILE" python3 -I - <<'PY'
import json, os, time
from datetime import datetime
MISS_AFTER_S, OURS_S = 390, 90
now = float(os.environ.get("NOW") or time.time())
try:
    state = json.load(open(os.environ["STATE_FILE"]))
except Exception:
    state = {}
if os.environ["HCODE"] != "200":
    raise SystemExit  # health down: the staleness watchdog handles that
try:
    ran_at = json.loads(os.environ["HBODY"])["last_run"]["ran_at"]
    last = datetime.fromisoformat(ran_at.replace("Z", "+00:00")).timestamp()
except Exception:
    raise SystemExit
age = now - last
ours_only = state.get("active") and last <= state.get("last_fired", 0) + OURS_S
if age > MISS_AFTER_S or ours_only:
    print(f"fire {int(age)}")
PY
}

DECISION="$(decide)"
FIRE_AGE=""
if [ -n "$DECISION" ]; then
  FIRE_AGE="${DECISION#fire }"
  if [ -n "${RUN_RESPONSE_FILE:-}" ]; then
    RCODE="$(head -1 "$RUN_RESPONSE_FILE")"; RBODY="$(tail -n +2 "$RUN_RESPONSE_FILE")"
  elif [ ! -r "$TOKEN_FILE" ]; then
    RCODE=000; RBODY="token file $TOKEN_FILE not readable"
  else
    # Header via stdin so the token never appears in `ps` output.
    RESP="$(printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$TOKEN_FILE")" \
      | curl -s -m 60 -X POST -H @- -w $'\n%{http_code}' "$BASE_URL/run" 2>&1)"
    RCODE="${RESP##*$'\n'}"; RBODY="${RESP%$'\n'*}"
  fi
fi

FIRE_AGE="$FIRE_AGE" RCODE="${RCODE:-}" RBODY="${RBODY:-}" HBODY="$HBODY" HCODE="$HCODE" \
STATE_FILE="$STATE_FILE" python3 -I - <<'PY'
import json, os, re, time
from datetime import datetime
OURS_S, REMIND_S = 90, 7200
now = float(os.environ.get("NOW") or time.time())
path = os.environ["STATE_FILE"]
try:
    state = json.load(open(path))
except Exception:
    state = {}

def fmt_age(s):
    s = int(s)
    return f"{s // 3600}h{s % 3600 // 60:02d}m" if s >= 3600 else f"{s // 60} min"

msg = None
fire_age = os.environ["FIRE_AGE"]
if fire_age:
    code, body = os.environ["RCODE"], os.environ["RBODY"]
    try:
        summary = json.loads(body)
    except Exception:
        summary = {}
    ok = code == "200"
    if not state.get("active"):
        state.update(active=True, since=now, fired=0, fail_streak=0)
        msg = (f"⚠️ FAA ingest: Cloudflare cron missed a slot (last run {fmt_age(int(fire_age))} ago). "
               "Hermes backup trigger is calling POST /run every 5 min until cron fires again.")
    state["last_fired"] = now
    state["fired"] = state.get("fired", 0) + 1
    if ok:
        state["fail_streak"] = 0
        if msg:
            msg += f"\nFirst backup run: ok, {summary.get('records_seen', '?')} seen, {summary.get('records_new', '?')} new."
    else:
        detail = summary.get("error") or " ".join(re.sub(r"<[^>]*>", " ", body).split())[:200]
        state["fail_streak"] = state.get("fail_streak", 0) + 1
        if state["fail_streak"] == 1 or now - state.get("last_fail_msg", 0) >= REMIND_S:
            state["last_fail_msg"] = now
            msg = ((msg + "\n") if msg else "") + f"🚨 Backup POST /run failed: HTTP {code} {detail}"
elif state.get("active") and os.environ["HCODE"] == "200":
    # Not firing while active means a run we didn't make is fresh: cron is back.
    msg = (f"✅ FAA ingest: Cloudflare cron firing again. Backup stood down after "
           f"{fmt_age(now - state['since'])} ({state.get('fired', 0)} backup runs).")
    state = {"active": False}

tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f)
os.replace(tmp, path)
if msg:
    print(msg)
PY
