# Ingestion Worker

The whole FAA ingestion pipeline runs on a Cloudflare Worker Cron Trigger
(`*/5 * * * *`): fetch NAS feed → parse → insert `observations` → update
`delay_events` → rescore anomalies → log `ingest_runs`.

- `src/parser.ts`: port of `ingest/parser.py`, verified identical on every stored snapshot
- `src/events.ts`: port of `detect/events.py`, plus an outage rule (a gap of 6h or more closes open events)
- `src/pipeline.ts`: load / incremental event refresh / set-based anomaly scoring / run log
- `src/index.ts`: cron handler; `GET /` health; `POST /run` (Bearer `TRIGGER_TOKEN`)

Secrets: `DATABASE_URL`, `TRIGGER_TOKEN` (`npx wrangler secret put <NAME>`).

```bash
npm test                      # TEST_DATABASE_URL=<local postgres> enables DB tests
npm run typecheck
npx wrangler deploy
curl -X POST https://faa-delay-intel-scheduler.zabir1.workers.dev/run \
  -H "Authorization: Bearer $(cat ../.worker-trigger-token)"
node scripts/rebuild-events.ts "$DATABASE_URL"   # dry run; --apply to commit
```

Parity harness (local Docker only): `test/parity_py.py`, `test/parity_ts.ts`,
`test/replay_verify.sh`. To run all of it against a fresh production dump
(production is only read; everything else happens in a throwaway container on
:55440):

```bash
DATABASE_URL=<owner url> bash test/replay_prod.sh 300   # from the repo root: worker/test/...
```

It checks Python vs TS parsing on every stored snapshot and on `edge_cases.py`,
then replays the last 300 snapshots through both pipelines. Last run 2026-10-14:
all checks matched (4,985 snapshots, 611 events). The Python events reference
applies the Worker's 6h outage rule (`outage_segments` in `parity_py.py`),
because `detect/events.py` predates that rule.

## Test gate (replaces GitHub Actions CI)

GitHub Actions can't start jobs while the account is billing-locked, so tests
run locally on every `git push` via `.githooks/pre-push`. It checks out the exact
commit being pushed in a temporary worktree and runs `scripts/check.sh`: worker
typecheck, worker and Python tests against a throwaway Postgres container, and
the Hermes watchdog scenarios (about 11s, Docker required).

```bash
git config core.hooksPath .githooks   # once per clone
bash scripts/check.sh                 # run the same gate by hand
git push --no-verify                  # emergency skip
```

