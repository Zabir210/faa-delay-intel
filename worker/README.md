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
`test/replay_verify.sh`.
