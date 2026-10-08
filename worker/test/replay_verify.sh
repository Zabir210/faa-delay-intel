#!/usr/bin/env bash
# End-to-end replay verification against a LOCAL copy of production.
#   bash test/replay_verify.sh <prod.dump> <snaps.jsonl> <first_idx>
# 1. restore the dump into two local DBs, cut history at snapshot first_idx
# 2. rebuild delay_events with scripts/rebuild-events.ts (as in production)
# 3. replay every later real snapshot through the Worker pipeline with a
#    pinned clock (now() = feed time + 2 min)
# 4. assert: observations / ingest_runs identical to the Python pipeline
#    replay (db "py"), delay_events identical to Python derive_events() over
#    the full history, anomaly scores identical to Python
#    score_and_persist_anomalies() run on the same rows.
set -euo pipefail
DUMP=$1 SNAPS=$2 FIRST=$3
HERE=$(cd "$(dirname "$0")/.." && pwd); REPO=$(cd "$HERE/.." && pwd)
S=$(dirname "$SNAPS")
P="docker exec -i faa-parity psql -U postgres -v ON_ERROR_STOP=1 -q"
CUT=$(sed -n "$((FIRST+1))p" "$SNAPS" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

docker exec faa-parity dropdb -U postgres --if-exists ts2
docker exec faa-parity createdb -U postgres ts2
docker exec -i faa-parity pg_restore -U postgres -d ts2 --no-owner --no-acl < "$DUMP" 2>/dev/null || true
$P -d ts2 <<SQL
DELETE FROM observations WHERE update_time >= '$CUT';
DELETE FROM ingest_runs WHERE ran_at >= '$CUT';
CREATE TABLE fake_clock (t timestamptz NOT NULL);
INSERT INTO fake_clock VALUES ('$CUT');
CREATE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS 'SELECT t FROM public.fake_clock';
ALTER DATABASE ts2 SET search_path = public, pg_catalog;
SQL
DSN=postgresql://postgres:dev@127.0.0.1:55440/ts2
(cd "$HERE" && node scripts/rebuild-events.ts $DSN --apply)
$P -d ts2 -c "UPDATE delay_events SET is_anomaly=false, anomaly_score=NULL"
(cd "$HERE" && node test/parity_ts.ts replay $DSN "$SNAPS" "$FIRST" "$S/replay_ts2.jsonl")

q() { docker exec faa-parity psql -U postgres -d "$1" -At -c "$2"; }
fail=0
OBS="SELECT md5(string_agg(concat_ws('|',update_time,airport,delay_type,direction,reason,min_delay_minutes,max_delay_minutes,trend,start_text,reopen_text,raw),E'\n' ORDER BY update_time,airport,delay_type,direction))||' '||count(*) FROM observations"
a=$(q py "$OBS"); b=$(q ts2 "$OBS"); [[ $a == "$b" ]] && echo "MATCH observations $b" || { echo "DIFFER observations py=$a ts=$b"; fail=1; }
N=$(( $(wc -l < "$SNAPS") - FIRST ))
RUNS="SELECT md5(string_agg(concat_ws('|',status,records_seen,records_new,feed_update_time),E'\n' ORDER BY id))||' '||count(*) FROM (SELECT * FROM ingest_runs ORDER BY id DESC LIMIT $N) r"
a=$(q py "$RUNS"); b=$(q ts2 "$RUNS"); [[ $a == "$b" ]] && echo "MATCH ingest_runs (new rows) $b" || { echo "DIFFER ingest_runs py=$a ts=$b"; fail=1; }
BAD=$(q ts2 "SELECT count(*) FROM ingest_runs WHERE ran_at >= '$CUT' AND (status<>'ok' OR error IS NOT NULL)")
[[ $BAD == 0 ]] && echo "MATCH no failed/warning runs in Worker replay" || { echo "FAIL $BAD Worker runs had errors/warnings"; fail=1; }

# delay_events vs Python derive_events over the full (uncut) history
cd "$REPO"
.venv/bin/python worker/test/parity_py.py events postgresql://postgres:dev@127.0.0.1:55440/py "$S/ev_full_py.json"
docker exec faa-parity psql -U postgres -d ts2 -At -c "SELECT json_agg(json_build_object(
  'airport',airport,'delay_type',delay_type,'direction',direction,'reason',reason,
  'started_at',to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
  'last_seen_at',to_char(last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
  'ended_at',to_char(ended_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
  'peak_delay_minutes',peak_delay_minutes,'observation_count',observation_count)) FROM delay_events" > "$S/ev_ts2.json"
python3 - "$S/ev_full_py.json" "$S/ev_ts2.json" <<'EOF' || fail=1
import json, sys
key = lambda e: (e["airport"], e["delay_type"], e["direction"] or "", e["started_at"])
a = sorted(json.load(open(sys.argv[1])), key=key)
b = sorted(json.load(open(sys.argv[2])), key=key)
if a == b:
    print(f"MATCH delay_events == derive_events(full history): {len(a)} events, "
          f"{sum(1 for e in a if e['ended_at'] is None)} open")
else:
    print(f"DIFFER delay_events: python={len(a)} worker={len(b)}")
    sa = {json.dumps(e, sort_keys=True) for e in a}; sb = {json.dumps(e, sort_keys=True) for e in b}
    for x in sorted(sa - sb)[:3]: print("  only python:", x)
    for x in sorted(sb - sa)[:3]: print("  only worker:", x)
    sys.exit(1)
EOF

# anomaly scoring: Python implementation on an identical copy
docker exec faa-parity dropdb -U postgres --if-exists ano_py
docker exec faa-parity createdb -U postgres -T ts2 ano_py
docker exec faa-parity psql -U postgres -q -c "ALTER DATABASE ano_py SET search_path = public, pg_catalog"
.venv/bin/python - <<'EOF'
import psycopg
from detect.anomaly import score_and_persist_anomalies
with psycopg.connect("postgresql://postgres:dev@127.0.0.1:55440/ano_py") as c:
    c.execute("UPDATE delay_events SET is_anomaly=false, anomaly_score=NULL"); c.commit()
    print("python scoring:", score_and_persist_anomalies(c))
EOF
ANO="SELECT md5(string_agg(concat_ws('|',airport,delay_type,direction,started_at,is_anomaly,round(anomaly_score::numeric,3)),E'\n' ORDER BY airport,delay_type,direction,started_at))||' flagged='||count(*) FILTER (WHERE is_anomaly)||' scored='||count(anomaly_score) FROM delay_events"
a=$(q ano_py "$ANO"); b=$(q ts2 "$ANO"); [[ $a == "$b" ]] && echo "MATCH anomaly scores $b" || { echo "DIFFER anomalies py=$a ts=$b"; fail=1; }
exit $fail
