# Deploying the ingestion pipeline

Goal: get data accumulating. The FAA feed is a **snapshot** — it only shows
conditions right now. Every hour the pipeline isn't running is history that
cannot be recovered later.

Total time: ~10 minutes. Cost: $0.

---

## 1. Create the database (Neon free tier)

1. Sign up at https://neon.tech (GitHub login works).
2. Create a project — name it `faa-delay-intel`, pick the region closest to you.
3. Copy the connection string. It looks like:
   ```
   postgresql://USER:PASSWORD@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

Apply the schema:

```bash
cd ~/workspace/faa-delay-intel
psql "PASTE_CONNECTION_STRING_HERE" -f db/schema.sql
```

No local `psql`? Use Neon's web SQL Editor and paste the contents of
`db/schema.sql`.

Verify locally before deploying:

```bash
source .venv/bin/activate
export DATABASE_URL="PASTE_CONNECTION_STRING_HERE"
python -m ingest.run          # expect: ok: N seen, N new, ...
python -m ingest.run          # expect: ok: N seen, 0 new  <- idempotent
```

---

## 2. Push to GitHub

Public is better for a portfolio — the commit history and CI badges are
part of the artifact.

```bash
cd ~/workspace/faa-delay-intel
gh repo create faa-delay-intel --public --source=. --remote=origin --push
```

Or create the repo in the web UI and:

```bash
git remote add origin git@github.com:<you>/faa-delay-intel.git
git branch -M main
git push -u origin main
```

---

## 3. Add the database secret

```bash
gh secret set DATABASE_URL --body "PASTE_CONNECTION_STRING_HERE"
```

Or: repo → Settings → Secrets and variables → Actions → New repository secret,
named exactly `DATABASE_URL`.

---

## 4. Start ingestion

```bash
gh workflow run ingest.yml     # manual trigger
gh run watch                   # confirm it goes green
```

Or: Actions tab → `ingest` → Run workflow.

---

## 5. Verify it's alive

After ~15 minutes there should be 3+ scheduled runs:

```bash
psql "$DATABASE_URL" -c "
  SELECT status, count(*), max(ran_at) AS last_run
  FROM ingest_runs GROUP BY status;"
```

Expected: `ok | 3+ | <a timestamp minutes old>`

Check what's been captured:

```bash
psql "$DATABASE_URL" -c "
  SELECT airport, delay_type, min_delay_minutes, trend, update_time
  FROM observations ORDER BY id DESC LIMIT 10;"
```

---

## Known behaviours (not bugs)

- **Cron drift.** GitHub Actions schedules are best-effort; runs can be late
  or skipped under load. Ingestion is idempotent, so this only costs
  resolution, never correctness.
- **Zero new rows.** Normal. The FAA updates less often than every 5 minutes,
  and a calm NAS has nothing to report. `ingest_runs` is what proves the
  pipeline is alive when `observations` isn't growing.
- **Schedules disable after 60 days without commits.** Any push resets it.
- **Neon autosuspends on the free tier.** First query after idle takes ~1s.

---

## Local development

```bash
docker run -d --name faa-pg \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=faa \
  -p 55432:5432 postgres:16-alpine

docker exec -i faa-pg psql -U postgres -d faa < db/schema.sql

export TEST_DATABASE_URL="postgresql://postgres:dev@127.0.0.1:55432/faa"
python -m pytest tests/ -v
```
