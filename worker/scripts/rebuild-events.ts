/**
 * One-time rebuild of delay_events from the full observations history.
 *
 *   node scripts/rebuild-events.ts <dsn> [--apply]
 *
 * Without --apply it only reports what would change (dry run). With --apply
 * it replaces delay_events inside ONE transaction (all-or-nothing), using
 * deriveEvents(), which is verified identical to detect/events.py
 * derive_events(). observations (the raw layer) is never touched.
 * Anomaly flags are reset; the next ingest run rescores them.
 */
import pg from "pg";
import { deriveEvents } from "../src/events.ts";

const [dsn, flag] = process.argv.slice(2);
if (!dsn) {
  console.error("usage: node scripts/rebuild-events.ts <dsn> [--apply]");
  process.exit(2);
}
const apply = flag === "--apply";

const c = new pg.Client(dsn);
await c.connect();
try {
  await c.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  // Block concurrent ingest runs' event refresh for the duration.
  await c.query("SELECT pg_advisory_xact_lock(724150001)");
  await c.query("SELECT pg_advisory_xact_lock(724150002)");

  const obs = await c.query(
    `SELECT airport, delay_type, direction, reason, update_time,
            min_delay_minutes, max_delay_minutes
     FROM observations ORDER BY update_time, id`
  );
  const snaps = await c.query("SELECT DISTINCT update_time FROM observations ORDER BY update_time");
  const events = deriveEvents(obs.rows, snaps.rows.map((r) => r.update_time));

  const before = await c.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE ended_at IS NULL)::int AS open FROM delay_events`
  );
  console.log(
    `observations=${obs.rowCount} snapshots=${snaps.rowCount} | ` +
      `delay_events now: ${before.rows[0].n} (${before.rows[0].open} open) -> ` +
      `rebuilt: ${events.length} (${events.filter((e) => !e.ended_at).length} open)`
  );

  await c.query("DELETE FROM delay_events");
  for (let i = 0; i < events.length; i += 500) {
    const chunk = events.slice(i, i + 500);
    const vals: unknown[] = [];
    const tuples = chunk.map((e) => {
      const row = [e.airport, e.delay_type, e.direction, e.reason, e.started_at,
        e.ended_at, e.last_seen_at, e.peak_delay_minutes, e.observation_count];
      const ph = row.map((v) => (vals.push(v), `$${vals.length}`));
      return `(${ph.join(",")})`;
    });
    await c.query(
      `INSERT INTO delay_events (airport, delay_type, direction, reason, started_at,
         ended_at, last_seen_at, peak_delay_minutes, observation_count)
       VALUES ${tuples.join(",")}`,
      vals
    );
  }
  const after = await c.query("SELECT count(*)::int AS n FROM delay_events");
  if (after.rows[0].n !== events.length) throw new Error("row count mismatch after insert");

  if (apply) {
    await c.query("COMMIT");
    console.log(`APPLIED: delay_events now has ${after.rows[0].n} rows`);
  } else {
    await c.query("ROLLBACK");
    console.log("dry run: rolled back (pass --apply to commit)");
  }
} catch (err) {
  await c.query("ROLLBACK").catch(() => {});
  console.error("FAILED, rolled back:", err);
  process.exitCode = 1;
} finally {
  await c.end();
}
