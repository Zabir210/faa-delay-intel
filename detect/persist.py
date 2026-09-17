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

DEFAULT_LOOKBACK = timedelta(hours=24)


def refresh_events(conn, lookback=DEFAULT_LOOKBACK):
    """Recompute and reconcile delay_events from recent observations.

    Returns the number of events processed (updated or inserted).
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
            cur.execute(UPDATE_OPEN_SQL, event)
            if cur.rowcount == 0:
                cur.execute(INSERT_SQL, event)
            count += 1
    conn.commit()
    return count
