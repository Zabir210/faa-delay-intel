#!/usr/bin/env bash
# Full prod-dump parity run, end to end (local Docker; production is only read).
#   DATABASE_URL=<owner url> bash worker/test/replay_prod.sh [n_replay=300] [workdir]
# 1. pg_dump production (custom format) into WORKDIR
# 2. start a throwaway postgres container "faa-parity" on 127.0.0.1:55440
# 3. rebuild every stored snapshot's XML; parse each with the Python and TS
#    parsers and require identical output; same for edge_cases.py (+ live feed)
# 4. replay the last N snapshots through the Python pipeline into db "py",
#    then run replay_verify.sh (Worker pipeline vs that reference)
# Exit 0 only if every check matches. The container is removed at the end.
set -euo pipefail
N=${1:-300}
WORK=${2:-$(mktemp -d)}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
PY="$REPO/.venv/bin/python"
DSN=postgresql://postgres:dev@127.0.0.1:55440
: "${DATABASE_URL:?set DATABASE_URL to the production owner URL (it is only read)}"
PROD_URL=$DATABASE_URL; unset DATABASE_URL   # nothing below may touch prod
mkdir -p "$WORK"; echo "workdir: $WORK"

pg_dump "$PROD_URL" -Fc --no-owner --no-acl -f "$WORK/prod.dump"
SERVER_MAJOR=$(psql "$PROD_URL" -Atc "SHOW server_version_num" | cut -c1-2)
unset PROD_URL

docker rm -f faa-parity >/dev/null 2>&1 || true
docker run -d --name faa-parity -e POSTGRES_PASSWORD=dev -p 127.0.0.1:55440:5432 \
  "postgres:${SERVER_MAJOR}-alpine" >/dev/null
trap 'docker rm -f faa-parity >/dev/null 2>&1 || true' EXIT
for _ in $(seq 60); do docker exec faa-parity pg_isready -U postgres -q && break; sleep 1; done
sleep 1

restore() { docker exec faa-parity createdb -U postgres "$1"
            docker exec -i faa-parity pg_restore -U postgres -d "$1" --no-owner --no-acl < "$WORK/prod.dump"; }
restore src
"$PY" "$REPO/worker/test/parity_py.py" snapshots "$DSN/src" "$WORK/snaps.jsonl"
TOTAL=$(wc -l < "$WORK/snaps.jsonl" | tr -d ' ')

same() {  # label py.jsonl ts.jsonl
  python3 - "$@" <<'EOF'
import json, sys
label, a, b = sys.argv[1], *[[json.loads(l) for l in open(p)] for p in sys.argv[2:]]
diff = [x["id"] for x, y in zip(a, b) if x != y]
ok = len(a) == len(b) and not diff
print(f"{'MATCH' if ok else 'DIFFER'} parser {label}: {len(a)} docs, "
      f"{sum(len(x.get('records', [])) for x in a)} records, "
      f"{sum('error' in x for x in a)} rejected by both" + ("" if ok else f", differing {diff[:5]}"))
sys.exit(0 if ok else 1)
EOF
}
fail=0
"$PY" "$REPO/worker/test/parity_py.py" parse "$WORK/snaps.jsonl" "$WORK/parse_py.jsonl"
(cd "$REPO/worker" && node test/parity_ts.ts parse "$WORK/snaps.jsonl" "$WORK/parse_ts.jsonl")
same "stored snapshots" "$WORK/parse_py.jsonl" "$WORK/parse_ts.jsonl" || fail=1
curl -sf -m 30 -o "$WORK/live.xml" https://nasstatus.faa.gov/api/airport-status-information
"$PY" "$REPO/worker/test/edge_cases.py" "$WORK/edge.jsonl" "$WORK/live.xml"
"$PY" "$REPO/worker/test/parity_py.py" parse "$WORK/edge.jsonl" "$WORK/edge_py.jsonl"
(cd "$REPO/worker" && node test/parity_ts.ts parse "$WORK/edge.jsonl" "$WORK/edge_ts.jsonl")
same "edge cases" "$WORK/edge_py.jsonl" "$WORK/edge_ts.jsonl" || fail=1

FIRST=$((TOTAL - N))
CUT=$(sed -n "$((FIRST + 1))p" "$WORK/snaps.jsonl" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
restore py
docker exec -i faa-parity psql -U postgres -v ON_ERROR_STOP=1 -q -d py <<SQL
DELETE FROM observations WHERE update_time >= '$CUT';
DELETE FROM ingest_runs WHERE ran_at >= '$CUT';
CREATE TABLE fake_clock (t timestamptz NOT NULL);
INSERT INTO fake_clock VALUES ('$CUT');
CREATE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS 'SELECT t FROM public.fake_clock';
ALTER DATABASE py SET search_path = public, pg_catalog;
SQL
"$PY" "$REPO/worker/test/parity_py.py" replay "$DSN/py" "$WORK/snaps.jsonl" "$FIRST" "$WORK/replay_py.jsonl"
echo "replaying snapshots $FIRST..$((TOTAL - 1)) of $TOTAL (from $CUT)"
(cd "$REPO/worker" && bash test/replay_verify.sh "$WORK/prod.dump" "$WORK/snaps.jsonl" "$FIRST") || fail=1
[ $fail = 0 ] && echo "replay_prod: ALL MATCH" || echo "replay_prod: DIFFERENCES FOUND"
exit $fail
