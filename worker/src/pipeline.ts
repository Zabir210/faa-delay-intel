/**
 * Ingestion pipeline: fetch -> parse -> load -> derive events -> score
 * anomalies -> log. Port of ingest/run.py + ingest/loader.py +
 * detect/persist.py + detect/anomaly.py.
 *
 * SQL statements are copied verbatim from the Python modules (psycopg's
 * %(name)s placeholders are rewritten to $n by `named()`), so behaviour is
 * identical by construction. Anomaly scoring is the one deliberate change:
 * it runs as a single set-based UPDATE instead of fetching 30 days of rows
 * and updating events one by one, which keeps the Worker's CPU time tiny.
 */
import { MISSING_TOLERANCE, OUTAGE_GAP_MS, type EventObservation } from "./events.ts";
import { parseNasStatus, type ObservationRecord } from "./parser.ts";

export const FEED_URL = "https://nasstatus.faa.gov/api/airport-status-information";
export const USER_AGENT = "faa-delay-intel/1.0 (portfolio data pipeline)";
const FETCH_TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 3;

export interface QueryResult {
  rows: any[];
  rowCount: number | null;
}
export interface Db {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}
export interface Deps {
  connect: () => Promise<Db & { end: () => Promise<void> }>;
  fetchXml?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Rewrite psycopg-style %(name)s placeholders to $1..$n. */
export function named(sql: string, params: Record<string, unknown>): [string, unknown[]] {
  const values: unknown[] = [];
  const text = sql.replace(/%\((\w+)\)s/g, (_m, name: string) => {
    if (!(name in params)) throw new Error(`KeyError: '${name}'`);
    values.push(params[name]);
    return `$${values.length}`;
  });
  return [text, values];
}

async function q(db: Db, sql: string, params: Record<string, unknown> = {}) {
  const [text, values] = named(sql, params);
  return db.query(text, values);
}

function errText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `Error: ${String(err)}`;
}

// ---------------------------------------------------------------------------
// fetch (ingest/fetch.py)
// ---------------------------------------------------------------------------
export async function fetchNasStatus(
  attempts = 3,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(FEED_URL, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/xml" },
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTPStatusError: ${res.status} ${res.statusText} for ${FEED_URL}`);
      if (!body.trim()) throw new Error("ValueError: FAA feed returned an empty body");
      return body;
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) await sleep(2000 * (attempt + 1));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// loader (ingest/loader.py)
// ---------------------------------------------------------------------------
const OBS_COLUMNS = [
  "update_time", "airport", "delay_type", "direction", "reason",
  "min_delay_minutes", "max_delay_minutes", "trend",
  "start_text", "reopen_text", "raw",
] as const;

/**
 * Insert observations, skipping any already stored; returns rows inserted.
 * One multi-row INSERT ... ON CONFLICT DO NOTHING in a single transaction —
 * same result and atomicity as the Python per-row loop + commit, one round
 * trip instead of N. (DO NOTHING also skips in-batch duplicates.)
 */
export async function loadObservations(
  db: Db,
  updateTime: Date,
  records: ObservationRecord[]
): Promise<number> {
  let inserted = 0;
  // Chunked to stay far below Postgres' 65535 bind-parameter limit.
  for (let start = 0; start < records.length; start += 500) {
    const values: unknown[] = [];
    const tuples = records.slice(start, start + 500).map((rec) => {
      const row: Record<string, unknown> = { ...rec, update_time: updateTime };
      const ph = OBS_COLUMNS.map((c) => {
        values.push(row[c] ?? null);
        return `$${values.length}`;
      });
      return `(${ph.join(", ")})`;
    });
    const sql =
      `INSERT INTO observations (${OBS_COLUMNS.join(", ")}) VALUES ` +
      `${tuples.join(", ")} ON CONFLICT DO NOTHING`;
    const res = await db.query(sql, values);
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

const RUN_SQL = `
INSERT INTO ingest_runs (
    status, records_seen, records_new, feed_update_time, error, duration_ms
) VALUES (
    %(status)s, %(records_seen)s, %(records_new)s,
    %(feed_update_time)s, %(error)s, %(duration_ms)s
)
`;

export async function logRun(
  db: Db,
  status: "ok" | "error",
  recordsSeen = 0,
  recordsNew = 0,
  feedUpdateTime: Date | null = null,
  error: string | null = null,
  durationMs: number | null = null
): Promise<void> {
  await q(db, RUN_SQL, {
    status,
    records_seen: recordsSeen,
    records_new: recordsNew,
    feed_update_time: feedUpdateTime,
    // Python slices by code point: error[:2000]
    error: error ? Array.from(error).slice(0, 2000).join("") : null,
    duration_ms: durationMs,
  });
}

// ---------------------------------------------------------------------------
// Event derivation — incremental.
//
// The Python refresh_events() re-derived a rolling 24h window and matched
// results to stored rows with "UPDATE ... WHERE ended_at IS NULL". Any event
// longer than the window gets truncated at the window edge, and that UPDATE
// then hits whatever open row shares the key — sometimes a *different*,
// newer event. In production that corrupted rows and then failed every
// refresh with a uq_closed_event violation (98 of the last 300 runs before
// ingestion stopped on 2026-09-27; failures were only printed as warnings).
//
// Here the open rows in delay_events are the state machine's state, and
// each run feeds it only the snapshots newer than the watermark
// (max(last_seen_at)). Each step applies exactly the rules of
// detect/events.py (close after MISSING_TOLERANCE consecutive absent
// snapshots, peak = max(peak or 0, new), latest truthy reason, plus the
// OUTAGE_GAP_MS break), so the
// table always equals derive_events() over the *entire* history — there is
// no window edge. Verified against the Python derive_events() in
// test/pipeline.test.ts and the parity replay.
// ---------------------------------------------------------------------------
interface StateEvent {
  id: number | null;
  airport: string;
  delay_type: string;
  direction: string | null;
  reason: string | null;
  started_at: Date;
  last_seen_at: Date;
  ended_at: Date | null;
  peak_delay_minutes: number | null;
  observation_count: number;
  lastIdx: number;
  dirty: boolean;
}

const keyOf = (o: { airport: string; delay_type: string; direction: string | null }) =>
  JSON.stringify([o.airport, o.delay_type, o.direction ?? null]);

function obsPeak(o: EventObservation): number | null {
  const vals = [o.min_delay_minutes, o.max_delay_minutes].filter(
    (v): v is number => v !== null && v !== undefined
  );
  return vals.length ? Math.max(...vals) : null;
}

/** Index of the last snapshot <= t (snapshots sorted ascending). */
function snapshotIndexAtOrBefore(snaps: number[], t: number): number {
  let lo = 0, hi = snaps.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snaps[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Caller owns the transaction. Returns the number of events written. */
export async function refreshEvents(db: Db): Promise<number> {
  const wmRes = await db.query("SELECT max(last_seen_at) AS wm FROM delay_events");
  const watermark: Date | null = wmRes.rows[0].wm;

  const openRes = await db.query(
    `SELECT id, airport, delay_type, direction, reason, started_at, last_seen_at,
            peak_delay_minutes, observation_count
     FROM delay_events WHERE ended_at IS NULL`
  );

  // Snapshot timeline: from the oldest open event's last sighting (needed to
  // count missed snapshots) up to now. Open events are by definition seen
  // within the last MISSING_TOLERANCE snapshots, so this stays tiny.
  let from: Date | null = watermark;
  for (const o of openRes.rows) {
    if (from === null || o.last_seen_at < from) from = o.last_seen_at;
  }
  const snapRes = await db.query(
    `SELECT DISTINCT update_time FROM observations
     WHERE $1::timestamptz IS NULL OR update_time >= $1 ORDER BY update_time`,
    [from]
  );
  const snaps: number[] = snapRes.rows.map((r) => (r.update_time as Date).getTime());
  const wmMs = watermark ? watermark.getTime() : -Infinity;
  const firstNew = snaps.findIndex((t) => t > wmMs);
  if (firstNew === -1) return 0; // nothing new since the last refresh

  const obsRes = await db.query(
    `SELECT airport, delay_type, direction, reason, update_time,
            min_delay_minutes, max_delay_minutes
     FROM observations
     WHERE $1::timestamptz IS NULL OR update_time > $1
     ORDER BY update_time, id`,
    [watermark]
  );
  const bySnapshot = new Map<number, EventObservation[]>();
  for (const o of obsRes.rows as EventObservation[]) {
    const t = o.update_time.getTime();
    let list = bySnapshot.get(t);
    if (!list) bySnapshot.set(t, (list = []));
    list.push(o);
  }

  const state = new Map<string, StateEvent>(); // current event per key
  const finished: StateEvent[] = []; // closed during this run
  for (const o of openRes.rows) {
    state.set(keyOf(o), {
      ...o,
      id: Number(o.id),
      ended_at: null,
      lastIdx: snapshotIndexAtOrBefore(snaps, o.last_seen_at.getTime()),
      dirty: false,
    });
  }

  const close = (e: StateEvent) => {
    e.ended_at = e.last_seen_at;
    e.dirty = true;
    finished.push(e);
  };

  for (let i = firstNew; i < snaps.length; i++) {
    if (i > 0 && snaps[i] - snaps[i - 1] >= OUTAGE_GAP_MS) {
      // Pipeline outage: nothing open can be assumed to have continued.
      for (const cur of state.values()) close(cur);
      state.clear();
    }
    for (const o of bySnapshot.get(snaps[i]) ?? []) {
      const key = keyOf(o);
      const cur = state.get(key);
      const peak = obsPeak(o);
      if (cur && i - cur.lastIdx - 1 < MISSING_TOLERANCE) {
        cur.last_seen_at = o.update_time;
        cur.lastIdx = i;
        cur.observation_count += 1;
        if (peak !== null) cur.peak_delay_minutes = Math.max(cur.peak_delay_minutes || 0, peak);
        if (o.reason) cur.reason = o.reason;
        cur.dirty = true;
      } else {
        if (cur) close(cur);
        state.set(key, {
          id: null,
          airport: o.airport,
          delay_type: o.delay_type,
          direction: o.direction ?? null,
          reason: o.reason ?? null,
          started_at: o.update_time,
          last_seen_at: o.update_time,
          ended_at: null,
          peak_delay_minutes: peak,
          observation_count: 1,
          lastIdx: i,
          dirty: true,
        });
      }
    }
    for (const [key, cur] of state) {
      if (i - cur.lastIdx >= MISSING_TOLERANCE) {
        close(cur);
        state.delete(key);
      }
    }
  }

  const all = [...finished, ...state.values()].filter((e) => e.dirty);
  // Updates first (they close rows), then inserts, so the partial unique
  // index on open events never sees two open rows for one key.
  let written = 0;
  for (const e of all.filter((x) => x.id !== null)) {
    await db.query(
      `UPDATE delay_events SET reason = $2, last_seen_at = $3, ended_at = $4,
              peak_delay_minutes = $5, observation_count = $6
       WHERE id = $1`,
      [e.id, e.reason, e.last_seen_at, e.ended_at, e.peak_delay_minutes, e.observation_count]
    );
    written += 1;
  }
  for (const e of all.filter((x) => x.id === null)) {
    await db.query(
      `INSERT INTO delay_events (airport, delay_type, direction, reason, started_at,
              ended_at, last_seen_at, peak_delay_minutes, observation_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [e.airport, e.delay_type, e.direction, e.reason, e.started_at,
       e.ended_at, e.last_seen_at, e.peak_delay_minutes, e.observation_count]
    );
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// score_and_persist_anomalies (detect/anomaly.py) as one set-based UPDATE.
//
// Same semantics as the Python:
//  * delay baseline per (airport, UTC hour) from delay/ground_delay
//    observations in the window; value = max(min, max) ignoring NULLs
//    (GREATEST ignores NULLs); bucket kept only if n >= min_samples.
//  * duration baseline per airport from closed events in the window.
//  * mean / sample stdev (stddev_samp == statistics.stdev); stdev 0 -> NULL.
//  * score = the larger-|z| of the two (delay wins ties, like max()),
//    is_anomaly = either |z| > threshold. Every event in the window is
//    (re)written, including NULL/false for thin data.
// ---------------------------------------------------------------------------
const ANOMALY_SQL = `
WITH since AS (
    SELECT now() - make_interval(days => $1::int) AS t
),
obs AS (
    SELECT o.airport,
           extract(hour FROM o.update_time AT TIME ZONE 'UTC')::int AS hr,
           GREATEST(o.min_delay_minutes, o.max_delay_minutes) AS v
    FROM observations o, since
    WHERE o.update_time >= since.t
      AND o.delay_type IN ('delay', 'ground_delay')
),
delay_bl AS (
    SELECT airport, hr, avg(v) AS mean, stddev_samp(v) AS sd
    FROM obs WHERE v IS NOT NULL
    GROUP BY airport, hr
    HAVING count(*) >= $2::int AND count(*) >= 2
),
dur_bl AS (
    SELECT e.airport,
           avg(extract(epoch FROM (e.ended_at - e.started_at)) / 60.0) AS mean,
           stddev_samp(extract(epoch FROM (e.ended_at - e.started_at)) / 60.0) AS sd
    FROM delay_events e, since
    WHERE e.ended_at IS NOT NULL AND e.started_at >= since.t
    GROUP BY e.airport
    HAVING count(*) >= $2::int AND count(*) >= 2
),
z AS (
    SELECT e.id,
           CASE WHEN e.peak_delay_minutes IS NULL OR d.sd IS NULL OR d.sd = 0 THEN NULL
                ELSE (e.peak_delay_minutes - d.mean) / d.sd END AS zd,
           CASE WHEN e.ended_at IS NULL OR u.sd IS NULL OR u.sd = 0 THEN NULL
                ELSE (extract(epoch FROM (e.ended_at - e.started_at)) / 60.0 - u.mean) / u.sd
           END AS zu
    FROM delay_events e
    CROSS JOIN since
    LEFT JOIN delay_bl d
           ON d.airport = e.airport
          AND d.hr = extract(hour FROM e.started_at AT TIME ZONE 'UTC')::int
    LEFT JOIN dur_bl u ON u.airport = e.airport
    WHERE e.started_at >= since.t
),
upd AS (
    UPDATE delay_events t SET
        anomaly_score = CASE
            WHEN z.zd IS NULL THEN z.zu
            WHEN z.zu IS NULL THEN z.zd
            WHEN abs(z.zd) >= abs(z.zu) THEN z.zd
            ELSE z.zu
        END,
        is_anomaly = COALESCE(abs(z.zd) > $3::numeric, false)
                  OR COALESCE(abs(z.zu) > $3::numeric, false)
    FROM z
    WHERE t.id = z.id
    RETURNING t.anomaly_score, t.is_anomaly
)
SELECT count(*) FILTER (WHERE anomaly_score IS NOT NULL)::int AS scored,
       count(*) FILTER (WHERE is_anomaly)::int AS flagged,
       count(*) FILTER (WHERE anomaly_score IS NULL)::int AS skipped_thin_data
FROM upd
`;

export async function scoreAndPersistAnomalies(
  db: Db,
  baselineDays = 30,
  minSamples = 20,
  zThreshold = 2.5
): Promise<{ scored: number; flagged: number; skipped_thin_data: number }> {
  const res = await db.query(ANOMALY_SQL, [baselineDays, minSamples, zThreshold]);
  return res.rows[0];
}

// ---------------------------------------------------------------------------
// run (ingest/run.py)
// ---------------------------------------------------------------------------
async function connectWithRetry(deps: Deps, sleep: (ms: number) => Promise<void>) {
  let last: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await deps.connect();
    } catch (err) {
      last = err;
      if (attempt < MAX_ATTEMPTS - 1) await sleep(1500 * (attempt + 1));
    }
  }
  throw last ?? new Error("RuntimeError: connect failed");
}

export interface RunSummary {
  status: "ok" | "error";
  warnings?: string[];
  records_seen: number;
  records_new: number;
  events: number;
  anomalies_flagged: number;
  feed_update_time: string | null;
  duration_ms: number;
  error?: string;
}

async function runOnce(deps: Deps, started: number): Promise<RunSummary> {
  const sleep = deps.sleep ?? defaultSleep;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const db = await connectWithRetry(deps, sleep);
  try {
    const xml = await (deps.fetchXml ?? (() => fetchNasStatus(3, sleep)))();
    const parsed = parseNasStatus(xml);
    const records = parsed.records;
    const updateTime = parsed.update_time;
    if (updateTime === null) throw new Error("ValueError: feed had no parsable Update_Time");

    await db.query("BEGIN");
    let added: number;
    try {
      added = await loadObservations(db, updateTime, records);
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      throw err;
    }

    // Event derivation is best-effort: observations are already stored.
    // A transaction-scoped advisory lock stops two overlapping runs from
    // reconciling the same events concurrently (the GitHub workflow had a
    // concurrency group for this); a run that loses the race just skips.
    let eventsTouched = 0;
    let anomaliesFlagged = 0;
    const problems: string[] = [];
    try {
      await db.query("BEGIN");
      const lock = await db.query("SELECT pg_try_advisory_xact_lock(724150001) AS got");
      if (lock.rows[0].got) {
        eventsTouched = await refreshEvents(db);
        await db.query("COMMIT");
      } else {
        await db.query("ROLLBACK");
        warn("warning: event refresh skipped: another run holds the lock");
      }
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      problems.push(`event refresh failed: ${errText(err)}`);
      warn(`warning: event refresh failed: ${errText(err)}`);
    }

    try {
      await db.query("BEGIN");
      const lock = await db.query("SELECT pg_try_advisory_xact_lock(724150002) AS got");
      if (lock.rows[0].got) {
        anomaliesFlagged = (await scoreAndPersistAnomalies(db)).flagged;
        await db.query("COMMIT");
      } else {
        await db.query("ROLLBACK");
        warn("warning: anomaly scoring skipped: another run holds the lock");
      }
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      problems.push(`anomaly scoring failed: ${errText(err)}`);
      warn(`warning: anomaly scoring failed: ${errText(err)}`);
    }

    const durationMs = Math.round(Date.now() - started);
    // Observations were stored, so the run is "ok"; a failed derived step is
    // recorded in the error column so it is visible, not just a log line.
    await logRun(db, "ok", records.length, added, updateTime,
                 problems.length ? "warning: " + problems.join("; ") : null, durationMs);
    return {
      status: "ok",
      records_seen: records.length,
      records_new: added,
      events: eventsTouched,
      anomalies_flagged: anomaliesFlagged,
      feed_update_time: updateTime.toISOString(),
      duration_ms: durationMs,
      ...(problems.length ? { warnings: problems } : {}),
    };
  } finally {
    await db.end().catch(() => {});
  }
}

/** Full cycle with whole-cycle retry; never throws. */
export async function runIngest(deps: Deps): Promise<RunSummary> {
  const sleep = deps.sleep ?? defaultSleep;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const log = deps.log ?? ((m: string) => console.log(m));
  const started = Date.now();
  let last: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const s = await runOnce(deps, started);
      log(
        `ok: ${s.records_seen} seen, ${s.records_new} new, ${s.events} events, ` +
          `${s.anomalies_flagged} anomalies, feed=${s.feed_update_time}, ${s.duration_ms}ms`
      );
      return s;
    } catch (err) {
      last = err;
      if (attempt < MAX_ATTEMPTS - 1) {
        warn(`warning: attempt ${attempt + 1} failed: ${errText(err)}; retrying`);
        await sleep(1500 * (attempt + 1));
      }
    }
  }

  const durationMs = Math.round(Date.now() - started);
  const message = errText(last);
  try {
    const db = await deps.connect();
    try {
      await logRun(db, "error", 0, 0, null, message, durationMs);
    } finally {
      await db.end().catch(() => {});
    }
  } catch {
    // logging the failure must not mask the original failure
  }
  console.error(`error: ${message}`);
  return {
    status: "error", records_seen: 0, records_new: 0, events: 0,
    anomalies_flagged: 0, feed_update_time: null, duration_ms: durationMs, error: message,
  };
}
