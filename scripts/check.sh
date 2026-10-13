#!/usr/bin/env bash
# check.sh — the full local test gate (replaces GitHub Actions CI, which
# cannot start jobs while the account is billing-locked).
#
#   bash scripts/check.sh [tree]     # tree defaults to this checkout
#
# Runs against <tree> (the pre-push hook passes a temporary worktree of the
# exact commit being pushed), using this checkout's worker/node_modules and
# .venv so nothing is reinstalled:
#   1. worker typecheck            (tsc --noEmit)
#   2. worker tests incl. DB tests  (node --test, throwaway Postgres)
#   3. Python tests incl. DB tests  (pytest tests/, same Postgres)
#   4. Hermes job scenarios         (ops/hermes/test_*.sh)
# tests/test_data_quality.py is excluded: it reads PRODUCTION, never from a hook.
#
# Needs Docker running. Exits non-zero on any failure.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# When run from a temporary worktree, deps live in the main checkout.
MAIN="$(cd "$(git -C "$REPO" rev-parse --git-common-dir)/.." && pwd)"
TREE="$(cd "${1:-$REPO}" && pwd)"
PY="$MAIN/.venv/bin/python"
PG_IMAGE="postgres:16-alpine"

fail() { echo "check: $*" >&2; exit 1; }
[ -x "$PY" ] || fail "missing $PY (python3 -m venv .venv && .venv/bin/pip install -r requirements.txt)"
[ -d "$MAIN/worker/node_modules" ] || fail "missing worker/node_modules (cd worker && npm ci)"
docker info >/dev/null 2>&1 || fail "Docker is not running (start Docker Desktop, or push with --no-verify to skip)"

if [ ! -e "$TREE/worker/node_modules" ]; then
  ln -s "$MAIN/worker/node_modules" "$TREE/worker/node_modules"
fi

# Throwaway Postgres on a random free localhost port; always removed.
PG="faa-check-$$"
cleanup() { docker rm -f "$PG" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --name "$PG" -e POSTGRES_PASSWORD=check \
  -p 127.0.0.1::5432 "$PG_IMAGE" >/dev/null
PORT="$(docker port "$PG" 5432/tcp | head -1 | sed 's/.*://')"
for _ in $(seq 1 60); do
  # -h forces TCP: the init-time server only listens on the unix socket.
  docker exec "$PG" pg_isready -q -U postgres -h 127.0.0.1 && break
  sleep 0.5
done
docker exec "$PG" pg_isready -q -U postgres -h 127.0.0.1 || fail "Postgres did not become ready"
docker exec "$PG" createdb -U postgres worker_t
docker exec "$PG" createdb -U postgres py_t
DB="postgresql://postgres:check@127.0.0.1:$PORT"

step() { printf '\n== %s\n' "$1"; }
# Quiet on success (summary lines only), full output on failure.
run_quiet() {  # summary-regex cmd...
  local re=$1; shift
  local log; log="$(mktemp)"
  if "$@" >"$log" 2>&1; then grep -E "$re" "$log" || true; rm -f "$log"
  else cat "$log"; rm -f "$log"; return 1; fi
}

step "worker typecheck"
(cd "$TREE/worker" && npx --no-install tsc --noEmit -p .)

step "worker tests (DB on :$PORT)"
(cd "$TREE/worker" && run_quiet '^# (tests|pass|fail|skipped)' \
  env TEST_DATABASE_URL="$DB/worker_t" node --test test/pipeline.test.ts)

step "python tests (DB on :$PORT)"
(cd "$TREE" && env -u DATABASE_URL TEST_DATABASE_URL="$DB/py_t" \
  "$PY" -m pytest tests/ -q --ignore=tests/test_data_quality.py -p no:cacheprovider)

step "hermes watchdog scenarios"
run_quiet '^FAIL' bash "$TREE/ops/hermes/test_faa_ingest_staleness.sh"
echo "watchdog scenarios: all ok"
run_quiet '^FAIL' bash "$TREE/ops/hermes/test_faa_quality_daily.sh"
echo "quality-daily scenarios: all ok"

printf '\ncheck: all suites passed\n'
