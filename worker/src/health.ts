/**
 * Public health payload for GET /. Pure so it can be unit-tested.
 *
 * External watchdogs (Hermes `faa-ingest-staleness`) alert when `healthy`
 * is false, which covers both ways history silently stops growing:
 *   stale   - no ingest_runs row of any status for STALE_AFTER_S: the cron
 *             is not firing at all (disabled, undeployed, or dying before it
 *             can log). This is how 2026-09-28..2026-10-07 was lost.
 *   failing - rows are being written but none ok for STALE_AFTER_S, e.g. the
 *             FAA feed 403ing every run (2026-10-08 13:31-13:46 UTC).
 */
export const STALE_AFTER_S = 30 * 60;

export interface LastRun {
  ran_at: Date | string;
  status: string;
  records_seen: number;
  records_new: number;
  feed_update_time: Date | string | null;
  duration_ms: number | null;
  error: string | null;
}

const ageS = (t: Date | string | null, now: Date) =>
  t === null ? null : Math.round((now.getTime() - new Date(t).getTime()) / 1000);

export function healthBody(
  lastRun: LastRun | null,
  lastOkAt: Date | string | null,
  now: Date = new Date()
) {
  const age = ageS(lastRun?.ran_at ?? null, now);
  const okAge = ageS(lastOkAt, now);
  const stale = age === null || age > STALE_AFTER_S;
  const failing = !stale && (okAge === null || okAge > STALE_AFTER_S);
  return {
    service: "faa-delay-intel-ingest",
    healthy: !stale && !failing,
    stale,
    failing,
    stale_after_seconds: STALE_AFTER_S,
    age_seconds: age,
    last_ok_at: lastOkAt,
    ok_age_seconds: okAge,
    last_run: lastRun,
  };
}
