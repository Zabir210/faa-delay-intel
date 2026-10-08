/**
 * Worker pipeline tests. Run: TEST_DATABASE_URL=postgresql://...@127.0.0.1:.../db npm test
 * DB tests refuse any non-local host and are skipped when the URL is unset.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { deriveEvents, OUTAGE_GAP_MS, type EventObservation } from "../src/events.ts";
import { parseDurationMinutes, parseNasStatus } from "../src/parser.ts";
import { loadObservations, refreshEvents, runIngest, type Deps } from "../src/pipeline.ts";

const REPO = join(import.meta.dirname, "..", "..");
const FIXTURE = readFileSync(join(REPO, "tests/fixtures/nas_status_sample.xml"), "utf8");
const SCHEMA = readFileSync(join(REPO, "db/schema.sql"), "utf8");
const DSN = process.env.TEST_DATABASE_URL;
if (DSN && !["127.0.0.1", "localhost"].includes(new URL(DSN).hostname)) {
  throw new Error("TEST_DATABASE_URL must point at a local database");
}
const dbTest = DSN ? test : test.skip;

async function freshDb(): Promise<pg.Client> {
  const c = new pg.Client(DSN);
  await c.connect();
  await c.query("DROP TABLE IF EXISTS observations, delay_events, ingest_runs CASCADE");
  await c.query(SCHEMA);
  return c;
}

const asDb = (c: pg.Client) => ({ query: (t: string, p?: unknown[]) => c.query(t, p as any[]) });

// --------------------------------------------------------------------------
// parser (mirrors tests/test_parser.py)
// --------------------------------------------------------------------------
test("duration parsing", () => {
  const cases: [string | null, number | null][] = [
    ["15 minutes", 15], ["1 minute", 1], ["1 hour", 60], ["2 hours", 120],
    ["1 hour and 30 minutes", 90], ["1 hour 30 minutes", 90], ["", null], [null, null], ["garbage", null],
  ];
  for (const [input, want] of cases) assert.equal(parseDurationMinutes(input), want, String(input));
});

test("fixture parses like the Python parser", () => {
  const r = parseNasStatus(FIXTURE);
  assert.equal(r.update_time?.toISOString(), "2026-09-16T01:57:58.000Z");
  const delays = r.records.filter((x) => x.delay_type === "delay");
  assert.deepEqual(delays.map((d) => d.airport).sort(), ["DFW", "ORD"]);
  const ord = delays.find((d) => d.airport === "ORD")!;
  assert.equal(ord.max_delay_minutes, 60);
  // Both "Airport Closures" blocks are read (dispatch on list element, not <Name>).
  assert.deepEqual(
    r.records.filter((x) => x.delay_type === "closure").map((x) => x.airport),
    ["ALO", "BGR", "LAX", "SAN", "DCA"]
  );
});

test("malformed XML throws instead of silently returning nothing", () => {
  for (const bad of ["<html><body>503</body>", "<A><B></A>", "", "<A>&nbsp;</A>"]) {
    assert.throws(() => parseNasStatus(bad));
  }
});

// --------------------------------------------------------------------------
// outage rule
// --------------------------------------------------------------------------
test("an outage gap closes open events instead of stretching them across it", () => {
  const t0 = Date.UTC(2026, 8, 27, 12);
  const snaps = [0, 5, 10].map((m) => new Date(t0 + m * 60_000));
  const after = new Date(t0 + 10 * 60_000 + OUTAGE_GAP_MS);
  const obs = (t: Date): EventObservation => ({
    airport: "JFK", delay_type: "ground_delay", direction: null, reason: "wx",
    update_time: t, min_delay_minutes: 30, max_delay_minutes: 60,
  });
  const ev = deriveEvents([...snaps, after].map(obs), [...snaps, after]);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].ended_at?.getTime(), snaps[2].getTime());
  assert.equal(ev[1].started_at.getTime(), after.getTime());
  assert.equal(ev[1].ended_at, null);
});

// --------------------------------------------------------------------------
// incremental refreshEvents == deriveEvents over full history (property test)
// --------------------------------------------------------------------------
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

function synthHistory(seed: number) {
  const r = rng(seed);
  const keys = [
    ["JFK", "ground_delay", null], ["ORD", "delay", "Arrival"], ["ORD", "delay", "Departure"],
    ["SFO", "ground_stop", null], ["LAX", "closure", null],
  ] as const;
  const snaps: Date[] = [];
  let t = Date.UTC(2026, 8, 1);
  for (let i = 0; i < 160; i++) {
    const x = r();
    t += x < 0.03 ? OUTAGE_GAP_MS + 60_000 : x < 0.08 ? 60 * 60_000 : 5 * 60_000;
    snaps.push(new Date(t));
  }
  const active = keys.map(() => r() < 0.5);
  const obs: EventObservation[] = [];
  for (const s of snaps) {
    keys.forEach((k, j) => {
      if (r() < 0.15) active[j] = !active[j];
      if (active[j] && r() > 0.12) {
        const mn = r() < 0.2 ? null : Math.floor(r() * 90);
        obs.push({
          airport: k[0], delay_type: k[1], direction: k[2],
          reason: r() < 0.2 ? null : `r${Math.floor(r() * 3)}`,
          update_time: s, min_delay_minutes: mn,
          max_delay_minutes: mn === null ? null : mn + Math.floor(r() * 60),
        });
      }
    });
  }
  return { snaps, obs };
}

const norm = (rows: any[]) =>
  rows
    .map((e) => JSON.stringify({
      a: e.airport, t: e.delay_type, d: e.direction ?? null, r: e.reason ?? null,
      s: +e.started_at, l: +e.last_seen_at, e: e.ended_at ? +e.ended_at : null,
      p: e.peak_delay_minutes ?? null, n: e.observation_count,
    }))
    .sort();

dbTest("incremental refresh equals full-history derivation (randomized, with outages)", async () => {
  const c = await freshDb();
  try {
    for (let seed = 1; seed <= 25; seed++) {
      await c.query("TRUNCATE observations, delay_events, ingest_runs");
      const { snaps, obs } = synthHistory(seed);
      const r = rng(seed * 7);
      // Ingest snapshots in random batches, refreshing after each batch,
      // like cron runs that sometimes skip.
      let i = 0;
      while (i < snaps.length) {
        const batch = snaps.slice(i, i + 1 + Math.floor(r() * 4));
        for (const s of batch) {
          const recs = obs.filter((o) => +o.update_time === +s).map((o) => ({
            ...o, trend: null, start_text: null, reopen_text: null, raw: "<x/>",
          }));
          await loadObservations(asDb(c), s, recs as any);
        }
        await c.query("BEGIN");
        await refreshEvents(asDb(c));
        await c.query("COMMIT");
        i += batch.length;
      }
      const usedSnaps = [...new Set(obs.map((o) => +o.update_time))].sort((a, b) => a - b).map((x) => new Date(x));
      const want = deriveEvents(obs, usedSnaps);
      const got = (await c.query("SELECT * FROM delay_events")).rows;
      assert.deepEqual(norm(got), norm(want), `seed ${seed}`);
      // A second refresh with no new data is a no-op.
      await c.query("BEGIN");
      assert.equal(await refreshEvents(asDb(c)), 0);
      await c.query("COMMIT");
    }
  } finally {
    await c.end();
  }
});

// --------------------------------------------------------------------------
// runIngest behaviour and failure handling
// --------------------------------------------------------------------------
function deps(over: Partial<Deps> = {}): Deps {
  return {
    connect: async () => {
      const c = new pg.Client(DSN);
      await c.connect();
      return { ...asDb(c), end: () => c.end() };
    },
    fetchXml: async () => FIXTURE,
    sleep: async () => {},
    log: () => {},
    warn: () => {},
    ...over,
  };
}

dbTest("happy path, then idempotent re-run", async () => {
  const c = await freshDb();
  try {
    const a = await runIngest(deps());
    assert.equal(a.status, "ok");
    assert.equal(a.records_seen, 7);
    assert.equal(a.records_new, 7);
    const b = await runIngest(deps());
    assert.equal(b.status, "ok");
    assert.equal(b.records_new, 0);
    const runs = (await c.query("SELECT status, error FROM ingest_runs ORDER BY id")).rows;
    assert.deepEqual(runs, [{ status: "ok", error: null }, { status: "ok", error: null }]);
  } finally {
    await c.end();
  }
});

dbTest("feed failure is retried, then logged as an error run (never throws)", async () => {
  const c = await freshDb();
  try {
    let calls = 0;
    const s = await runIngest(deps({ fetchXml: async () => { calls++; throw new Error("boom"); } }));
    assert.equal(s.status, "error");
    assert.equal(calls, 3);
    const row = (await c.query("SELECT status, error FROM ingest_runs")).rows[0];
    assert.equal(row.status, "error");
    assert.match(row.error, /boom/);
  } finally {
    await c.end();
  }
});

dbTest("HTML error page from the FAA is an error run, not a silent empty snapshot", async () => {
  const c = await freshDb();
  try {
    const s = await runIngest(deps({ fetchXml: async () => "<html><body>Service Unavailable</body></html>" }));
    assert.equal(s.status, "error");
    assert.equal((await c.query("SELECT count(*)::int n FROM observations")).rows[0].n, 0);
  } finally {
    await c.end();
  }
});

test("database unreachable: returns error, never throws", async () => {
  const s = await runIngest({
    connect: async () => { throw new Error("ECONNREFUSED"); },
    fetchXml: async () => FIXTURE,
    sleep: async () => {},
    log: () => {},
    warn: () => {},
  });
  assert.equal(s.status, "error");
  assert.match(s.error!, /ECONNREFUSED/);
});

dbTest("a failing derived step keeps the run ok and records the warning", async () => {
  const c = await freshDb();
  try {
    await c.query("ALTER TABLE delay_events RENAME TO delay_events_x");
    const s = await runIngest(deps());
    assert.equal(s.status, "ok");
    assert.equal(s.records_new, 7);
    assert.ok(s.warnings && s.warnings.length === 2);
    const row = (await c.query("SELECT status, error FROM ingest_runs")).rows[0];
    assert.equal(row.status, "ok");
    assert.match(row.error, /^warning: event refresh failed/);
    await c.query("ALTER TABLE delay_events_x RENAME TO delay_events");
  } finally {
    await c.end();
  }
});

dbTest("mid-run connection drop: whole cycle retried on a fresh connection", async () => {
  const c = await freshDb();
  try {
    let n = 0;
    const s = await runIngest(deps({
      connect: async () => {
        const cl = new pg.Client(DSN);
        await cl.connect();
        const first = n++ === 0;
        return {
          query: (t: string, p?: unknown[]) => {
            if (first && t.startsWith("INSERT INTO observations")) {
              return Promise.reject(new Error("Connection terminated unexpectedly"));
            }
            return cl.query(t, p as any[]);
          },
          end: () => cl.end(),
        };
      },
    }));
    assert.equal(s.status, "ok");
    assert.equal(s.records_new, 7);
    assert.equal((await c.query("SELECT count(*)::int n FROM ingest_runs")).rows[0].n, 1);
  } finally {
    await c.end();
  }
});
