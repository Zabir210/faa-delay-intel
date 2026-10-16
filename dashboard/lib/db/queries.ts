import {
  DELAY_TYPES,
  MINUTE_TYPES,
  SPAN_TYPES,
  type AirportTimeline,
  type DailyActivity,
  type DelayType,
} from "@/lib/delay-types";

import { sql } from "./client";

export type PipelineHealth = {
  lastRunAt: string | null;
  lastStatus: string | null;
  minutesSinceLastRun: number | null;
  runsLast24h: number;
  observationCount: number;
  eventCount: number;
  oldestObservationAt: string | null;
};

/** Pipeline liveness. A calm NAS inserts zero observations, so this table
 * is what distinguishes "healthy and quiet" from "the cron stopped". */
export async function getPipelineHealth(): Promise<PipelineHealth> {
  const [lastRun] = await sql`
    SELECT status, ran_at,
           EXTRACT(EPOCH FROM (now() - ran_at)) / 60 AS minutes_since
    FROM ingest_runs ORDER BY ran_at DESC LIMIT 1
  `;
  const [runsRow] = await sql`
    SELECT count(*)::int AS n FROM ingest_runs
    WHERE ran_at > now() - interval '24 hours' AND status = 'ok'
  `;
  const [obsRow] = await sql`
    SELECT count(*)::int AS n, min(update_time) AS oldest FROM observations
  `;
  const [eventRow] = await sql`SELECT count(*)::int AS n FROM delay_events`;

  return {
    lastRunAt: lastRun?.ran_at ?? null,
    lastStatus: lastRun?.status ?? null,
    minutesSinceLastRun:
      lastRun?.minutes_since != null ? Math.round(lastRun.minutes_since) : null,
    runsLast24h: runsRow?.n ?? 0,
    observationCount: obsRow?.n ?? 0,
    eventCount: eventRow?.n ?? 0,
    oldestObservationAt: obsRow?.oldest ?? null,
  };
}

export type CurrentDisruption = {
  airport: string;
  delayType: string;
  direction: string | null;
  reason: string | null;
  startedAt: string;
  peakDelayMinutes: number | null;
  observationCount: number;
};

/** Airports with an OPEN event right now. */
export async function getCurrentDisruptions(): Promise<CurrentDisruption[]> {
  const rows = await sql`
    SELECT airport, delay_type, direction, reason, started_at,
           peak_delay_minutes, observation_count
    FROM delay_events
    WHERE ended_at IS NULL
    ORDER BY peak_delay_minutes DESC NULLS LAST, started_at ASC
  `;
  return rows.map((r) => ({
    airport: r.airport,
    delayType: r.delay_type,
    direction: r.direction,
    reason: r.reason,
    startedAt: r.started_at,
    peakDelayMinutes: r.peak_delay_minutes,
    observationCount: r.observation_count,
  }));
}

export type AirportHistoryPoint = {
  updateTime: string;
  delayType: string;
  direction: string | null;
  minDelayMinutes: number | null;
  maxDelayMinutes: number | null;
  trend: string | null;
};

/** Raw observation time series for one airport, most recent first. */
export async function getAirportHistory(
  airport: string,
  days: number
): Promise<AirportHistoryPoint[]> {
  const clampedDays = Math.min(Math.max(days, 1), 90);
  const rows = await sql`
    SELECT update_time, delay_type, direction,
           min_delay_minutes, max_delay_minutes, trend
    FROM observations
    WHERE airport = ${airport.toUpperCase()}
      AND update_time > now() - (${clampedDays} || ' days')::interval
    ORDER BY update_time DESC
    LIMIT 500
  `;
  return rows.map((r) => ({
    updateTime: r.update_time,
    delayType: r.delay_type,
    direction: r.direction,
    minDelayMinutes: r.min_delay_minutes,
    maxDelayMinutes: r.max_delay_minutes,
    trend: r.trend,
  }));
}

export type WorstAirport = {
  airport: string;
  eventCount: number;
  totalDelayMinutes: number;
  maxDelayMinutes: number | null;
};

/** Airports ranked by cumulative disruption over a trailing window. */
export async function getWorstAirports(days: number): Promise<WorstAirport[]> {
  const clampedDays = Math.min(Math.max(days, 1), 90);
  const rows = await sql`
    SELECT airport,
           count(*)::int AS event_count,
           COALESCE(sum(peak_delay_minutes), 0)::int AS total_delay_minutes,
           max(peak_delay_minutes)::int AS max_delay_minutes
    FROM delay_events
    WHERE started_at > now() - (${clampedDays} || ' days')::interval
    GROUP BY airport
    ORDER BY total_delay_minutes DESC
    LIMIT 25
  `;
  return rows.map((r) => ({
    airport: r.airport,
    eventCount: r.event_count,
    totalDelayMinutes: r.total_delay_minutes,
    maxDelayMinutes: r.max_delay_minutes,
  }));
}


/** Events started per UTC day by type, with that day's run count so a
 * pipeline outage renders as "no data" instead of a misleading zero. */
export async function getDailyActivity(days: number): Promise<DailyActivity[]> {
  const clampedDays = Math.min(Math.max(days, 1), 90);
  const rows = await sql`
    WITH d AS (
      SELECT generate_series(
        (now() AT TIME ZONE 'UTC')::date - (${clampedDays}::int - 1),
        (now() AT TIME ZONE 'UTC')::date, interval '1 day')::date AS day
    ),
    e AS (
      SELECT (started_at AT TIME ZONE 'UTC')::date AS day, delay_type, count(*)::int AS n
      FROM delay_events
      WHERE started_at >= (now() AT TIME ZONE 'UTC')::date - (${clampedDays}::int - 1)
      GROUP BY 1, 2
    ),
    r AS (
      SELECT (ran_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS n
      FROM ingest_runs
      WHERE ran_at >= (now() AT TIME ZONE 'UTC')::date - (${clampedDays}::int - 1)
      GROUP BY 1
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
           COALESCE(r.n, 0) AS runs,
           COALESCE(json_object_agg(e.delay_type, e.n) FILTER (WHERE e.delay_type IS NOT NULL), '{}') AS counts
    FROM d
    LEFT JOIN e ON e.day = d.day
    LEFT JOIN r ON r.day = d.day
    GROUP BY d.day, r.n
    ORDER BY d.day
  `;
  return rows.map((r) => ({
    day: r.day,
    runs: r.runs,
    counts: Object.fromEntries(
      DELAY_TYPES.map((t) => [t, Number(r.counts?.[t] ?? 0)])
    ) as Record<DelayType, number>,
  }));
}

export type HourlyRuns = { hour: string; ok: number; total: number };

/** Ingest runs per hour for the last 24 hours (12/hour when healthy). */
export async function getHourlyRuns(): Promise<HourlyRuns[]> {
  const rows = await sql`
    WITH h AS (
      SELECT generate_series(date_trunc('hour', now()) - interval '23 hours',
                             date_trunc('hour', now()), interval '1 hour') AS hour
    )
    SELECT h.hour,
           count(r.*) FILTER (WHERE r.status = 'ok')::int AS ok,
           count(r.*)::int AS total
    FROM h
    LEFT JOIN ingest_runs r
      ON r.ran_at >= h.hour AND r.ran_at < h.hour + interval '1 hour'
    GROUP BY h.hour
    ORDER BY h.hour
  `;
  return rows.map((r) => ({ hour: r.hour, ok: r.ok, total: r.total }));
}

export type AirportEvent = {
  id: number;
  delayType: string;
  direction: string | null;
  reason: string | null;
  startedAt: string;
  endedAt: string | null;
  peakDelayMinutes: number | null;
  observationCount: number;
  isAnomaly: boolean;
  /** to ended_at, or to now while open */
  durationMinutes: number;
};

/** Most recent delay events for one airport, open ones first. */
export async function getAirportEvents(airport: string, limit = 25): Promise<AirportEvent[]> {
  const rows = await sql`
    SELECT id, delay_type, direction, reason, started_at, ended_at,
           peak_delay_minutes, observation_count, is_anomaly,
           round(extract(epoch FROM COALESCE(ended_at, now()) - started_at) / 60)::int AS duration_minutes
    FROM delay_events
    WHERE airport = ${airport.toUpperCase()}
    ORDER BY (ended_at IS NULL) DESC, started_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 100)}
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    delayType: r.delay_type,
    direction: r.direction,
    reason: r.reason,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    peakDelayMinutes: r.peak_delay_minutes,
    observationCount: r.observation_count,
    isAnomaly: r.is_anomaly,
    durationMinutes: r.duration_minutes,
  }));
}

export type AirportSummary = {
  eventCount: number;
  totalDelayMinutes: number;
  worst: { minutes: number; delayType: string; startedAt: string } | null;
  lastEventAt: string | null;
};

/** 30-day KPIs for one airport, same definitions as the home page's
 * "Most disrupted" list (sum and max of per-event peak delay). */
export async function getAirportSummary(airport: string, days: number): Promise<AirportSummary> {
  const clampedDays = Math.min(Math.max(days, 1), 90);
  const code = airport.toUpperCase();
  const [agg] = await sql`
    SELECT count(*)::int AS event_count,
           COALESCE(sum(peak_delay_minutes), 0)::int AS total_delay_minutes
    FROM delay_events
    WHERE airport = ${code}
      AND started_at > now() - (${clampedDays} || ' days')::interval
  `;
  const [worst] = await sql`
    SELECT peak_delay_minutes, delay_type, started_at
    FROM delay_events
    WHERE airport = ${code} AND peak_delay_minutes IS NOT NULL
      AND started_at > now() - (${clampedDays} || ' days')::interval
    ORDER BY peak_delay_minutes DESC, started_at DESC
    LIMIT 1
  `;
  const [last] = await sql`
    SELECT max(started_at) AS last FROM delay_events WHERE airport = ${code}
  `;
  return {
    eventCount: agg?.event_count ?? 0,
    totalDelayMinutes: agg?.total_delay_minutes ?? 0,
    worst: worst
      ? { minutes: worst.peak_delay_minutes, delayType: worst.delay_type, startedAt: worst.started_at }
      : null,
    lastEventAt: last?.last ?? null,
  };
}

/** Bucketed observation series for one airport. Minute-bearing types keep
 * the worst max_delay_minutes per bucket (directions merged); stops and
 * closures are presence flags. Buckets with no ok ingest run are flagged
 * offline so an outage never reads as a calm stretch. */
export async function getAirportTimeline(airport: string, days: number): Promise<AirportTimeline> {
  const clampedDays = Math.min(Math.max(days, 1), 30);
  const bucketMinutes = clampedDays <= 7 ? 30 : 120;
  const rows = await sql`
    WITH b AS (
      SELECT generate_series(
        to_timestamp(floor(extract(epoch FROM now() - (${clampedDays} || ' days')::interval)
                           / (${bucketMinutes}::int * 60)) * (${bucketMinutes}::int * 60)),
        now(), (${bucketMinutes} || ' minutes')::interval) AS t
    ),
    o AS (
      SELECT to_timestamp(floor(extract(epoch FROM update_time) / (${bucketMinutes}::int * 60))
                          * (${bucketMinutes}::int * 60)) AS t,
             delay_type, max(max_delay_minutes) AS mx
      FROM observations
      WHERE airport = ${airport.toUpperCase()}
        AND update_time > now() - (${clampedDays} || ' days')::interval - (${bucketMinutes} || ' minutes')::interval
      GROUP BY 1, 2
    ),
    r AS (
      SELECT to_timestamp(floor(extract(epoch FROM ran_at) / (${bucketMinutes}::int * 60))
                          * (${bucketMinutes}::int * 60)) AS t,
             count(*) FILTER (WHERE status = 'ok')::int AS ok
      FROM ingest_runs
      WHERE ran_at > now() - (${clampedDays} || ' days')::interval - (${bucketMinutes} || ' minutes')::interval
      GROUP BY 1
    )
    SELECT b.t,
           COALESCE(r.ok, 0) AS ok,
           COALESCE(json_object_agg(o.delay_type, o.mx) FILTER (WHERE o.delay_type IS NOT NULL), '{}') AS types
    FROM b
    LEFT JOIN o ON o.t = b.t
    LEFT JOIN r ON r.t = b.t
    GROUP BY b.t, r.ok
    ORDER BY b.t
  `;
  const timeline: AirportTimeline = {
    buckets: [],
    bucketMinutes,
    minutes: { delay: [], ground_delay: [] },
    active: { ground_stop: [], closure: [] },
    offline: [],
  };
  for (const r of rows) {
    const types = (r.types ?? {}) as Record<string, number | null>;
    timeline.buckets.push(new Date(r.t).toISOString());
    for (const t of MINUTE_TYPES) {
      timeline.minutes[t].push(t in types ? Number(types[t] ?? 0) : null);
    }
    for (const t of SPAN_TYPES) timeline.active[t].push(t in types);
    timeline.offline.push(r.ok === 0 && Object.keys(types).length === 0);
  }
  return timeline;
}
