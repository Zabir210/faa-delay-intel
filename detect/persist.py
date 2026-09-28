"""Persist derived events to delay_events.

Strategy: after each ingestion, recompute events over a rolling lookback
window (default 24h) from `observations`, then reconcile them into
`delay_events`. Reconciliation is an explicit update-then-insert per event
(not a single ON CONFLICT) because an event can transition from open to
closed between two refresh calls, and that transition must UPDATE the
existing open row rather than insert a second, duplicate closed row.
"""
from datetime import timedelta

from detect.events import derive_events

FETCH_OBS_SQL = """
SELECT airport, delay_type, direction, reason, update_time,
       min_delay_minutes, max_delay_minutes
FROM observations
WHERE update_time >= %(since)s
ORDER BY update_time
"""

FETCH_SNAPSHOTS_SQL = """
SELECT DISTINCT update_time FROM observations
WHERE update_time >= %(since)s
ORDER BY update_time
"""

# Close/refresh an OPEN event for this natural key, if one exists.
UPDATE_OPEN_SQL = """
UPDATE delay_events SET
    last_seen_at = %(last_seen_at)s,
    ended_at = %(ended_at)s,
    peak_delay_minutes = CASE
        WHEN peak_delay_minutes IS NULL THEN %(peak_delay_minutes)s
        WHEN %(peak_delay_minutes)s::int IS NULL THEN peak_delay_minutes
        ELSE GREATEST(peak_delay_minutes, %(peak_delay_minutes)s::int)
    END,
    observation_count = %(observation_count)s,
    reason = %(reason)s
WHERE airport = %(airport)s
  AND delay_type = %(delay_type)s
  AND COALESCE(direction, '') = COALESCE(%(direction)s, '')
  AND ended_at IS NULL
"""

# No open row matched: this is either a brand new event, or an event that
# started and ended entirely within one lookback window (never observed
# open by a previous run). ON CONFLICT DO NOTHING guards replay of the
# latter across runs.
INSERT_SQL = """
INSERT INTO delay_events (
    airport, delay_type, direction, reason,
    started_at, ended_at, last_seen_at,
    peak_delay_minutes, observation_count
) VALUES (
    %(airport)s, %(delay_type)s, %(direction)s, %(reason)s,
    %(started_at)s, %(ended_at)s, %(last_seen_at)s,
    %(peak_delay_minutes)s, %(observation_count)s
)
ON CONFLICT DO NOTHING
"""

# An event that outlives the lookback window gets recomputed from a
# truncated slice of its observations on every run. When it is finally
# closed, the locally-derived chunk can carry a started_at that collides
# with an *already-closed* row for the same natural key stored by an
# earlier, narrower recompute (uq_closed_event). Detect that before
# UPDATE_OPEN_SQL runs, so a real collision merges into the existing row
# instead of raising UniqueViolation (which the caller then has to eat,
# silently freezing event derivation — see 2026-09-25 incident).
FIND_CLOSED_DUP_SQL = """
SELECT id, peak_delay_minutes, observation_count, last_seen_at
FROM delay_events
WHERE airport = %(airport)s
  AND delay_type = %(delay_type)s
  AND COALESCE(direction, '') = COALESCE(%(direction)s, '')
  AND started_at = %(started_at)s
  AND ended_at IS NOT NULL
"""

FIND_OPEN_ID_SQL = """
SELECT id FROM delay_events
WHERE airport = %(airport)s
  AND delay_type = %(delay_type)s
  AND COALESCE(direction, '') = COALESCE(%(direction)s, '')
  AND ended_at IS NULL
"""

MERGE_INTO_CLOSED_SQL = """
UPDATE delay_events SET
    last_seen_at = GREATEST(last_seen_at, %(last_seen_at)s),
    ended_at = GREATEST(ended_at, %(ended_at)s),
    peak_delay_minutes = CASE
        WHEN peak_delay_minutes IS NULL THEN %(peak_delay_minutes)s
        WHEN %(peak_delay_minutes)s::int IS NULL THEN peak_delay_minutes
        ELSE GREATEST(peak_delay_minutes, %(peak_delay_minutes)s::int)
    END,
    observation_count = observation_count + %(added_count)s,
    reason = %(reason)s
WHERE id = %(dup_id)s
"""

DELETE_EVENT_SQL = "DELETE FROM delay_events WHERE id = %(id)s"

DEFAULT_LOOKBACK = timedelta(hours=24)


def refresh_events(conn, lookback=DEFAULT_LOOKBACK):
    """Recompute and reconcile delay_events from recent observations.

    Returns the number of events processed (updated, inserted, or merged).
    """
    with conn.cursor() as cur:
        cur.execute("SELECT now() - %(lookback)s", {"lookback": lookback})
        since = cur.fetchone()[0]

        cur.execute(FETCH_OBS_SQL, {"since": since})
        cols = [d.name for d in cur.description]
        observations = [dict(zip(cols, row)) for row in cur.fetchall()]

        cur.execute(FETCH_SNAPSHOTS_SQL, {"since": since})
        snapshot_times = [row[0] for row in cur.fetchall()]

    if not observations or not snapshot_times:
        return 0

    events = derive_events(observations, snapshot_times)

    count = 0
    with conn.cursor() as cur:
        for event in events:
            if event["ended_at"] is not None:
                cur.execute(FIND_CLOSED_DUP_SQL, event)
                dup = cur.fetchone()
                if dup is not None:
                    dup_id, dup_peak, dup_count, dup_last_seen = dup
                    # This local chunk is the tail of an event whose true
                    # history already lives in `dup`. Fold it in and drop
                    # whatever open row this run's recompute would have
                    # tried to close, rather than duplicating.
                    cur.execute(FIND_OPEN_ID_SQL, event)
                    open_row = cur.fetchone()
                    added = event["observation_count"] if open_row else 0
                    cur.execute(MERGE_INTO_CLOSED_SQL, {
                        **event, "dup_id": dup_id, "added_count": added,
                    })
                    if open_row is not None:
                        cur.execute(DELETE_EVENT_SQL, {"id": open_row[0]})
                    count += 1
                    continue

            cur.execute(UPDATE_OPEN_SQL, event)
            if cur.rowcount == 0:
                cur.execute(INSERT_SQL, event)
            count += 1
    conn.commit()
    return count
