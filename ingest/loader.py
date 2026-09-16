"""Load parsed FAA records into Postgres, idempotently."""

INSERT_SQL = """
INSERT INTO observations (
    update_time, airport, delay_type, direction, reason,
    min_delay_minutes, max_delay_minutes, trend,
    start_text, reopen_text, raw
) VALUES (
    %(update_time)s, %(airport)s, %(delay_type)s, %(direction)s, %(reason)s,
    %(min_delay_minutes)s, %(max_delay_minutes)s, %(trend)s,
    %(start_text)s, %(reopen_text)s, %(raw)s
)
ON CONFLICT DO NOTHING
"""

RUN_SQL = """
INSERT INTO ingest_runs (
    status, records_seen, records_new, feed_update_time, error, duration_ms
) VALUES (
    %(status)s, %(records_seen)s, %(records_new)s,
    %(feed_update_time)s, %(error)s, %(duration_ms)s
)
"""


def load_observations(conn, update_time, records):
    """Insert observations, skipping any already stored.

    Returns the number of rows actually inserted. Re-loading an unchanged
    snapshot returns 0 — the property that makes a 5-minute cron safe
    against a feed that updates less often.
    """
    if not records:
        return 0

    inserted = 0
    with conn.cursor() as cur:
        for record in records:
            payload = dict(record)
            payload["update_time"] = update_time
            cur.execute(INSERT_SQL, payload)
            inserted += cur.rowcount
    conn.commit()
    return inserted


def log_run(conn, status, records_seen=0, records_new=0,
            feed_update_time=None, error=None, duration_ms=None):
    """Record the outcome of an ingestion attempt."""
    with conn.cursor() as cur:
        cur.execute(RUN_SQL, {
            "status": status,
            "records_seen": records_seen,
            "records_new": records_new,
            "feed_update_time": feed_update_time,
            "error": error[:2000] if error else None,
            "duration_ms": duration_ms,
        })
    conn.commit()
