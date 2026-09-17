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
