"""Ingestion entry point: fetch -> parse -> load -> log.

Exits non-zero on failure so a CI scheduler marks the run red.
"""
import os
import sys
import time

import psycopg
from dotenv import load_dotenv

from detect.persist import refresh_events
from ingest.fetch import fetch_nas_status
from ingest.loader import load_observations, log_run
from ingest.parser import parse_nas_status

MAX_ATTEMPTS = 3


def _connect(dsn):
    """Connect with retries. Neon serverless can drop idle/cold connections
    (OperationalError: SSL connection has been closed unexpectedly), so a
    single failed attempt should not fail the whole run."""
    last_exc = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            return psycopg.connect(dsn, connect_timeout=15)
        except Exception as exc:
            last_exc = exc
            if attempt < MAX_ATTEMPTS - 1:
                time.sleep(1.5 * (attempt + 1))
    raise last_exc if last_exc is not None else RuntimeError("connect failed")


def _run_once(dsn, started):
    """One full attempt: connect, fetch, parse, load, log. Raises on
    failure so the caller can decide whether to retry."""
    conn = _connect(dsn)
    try:
        xml_text = fetch_nas_status()
        parsed = parse_nas_status(xml_text)
        records = parsed["records"]
        update_time = parsed["update_time"]

        if update_time is None:
            raise ValueError("feed had no parsable Update_Time")

        new = load_observations(conn, update_time, records)

        # Event derivation is best-effort: the observation is already safely
        # stored above, so a bug here must not mark a good ingestion as
        # failed. Any failure still surfaces in stdout for visibility.
        events_touched = 0
        try:
            events_touched = refresh_events(conn)
        except Exception as exc:
            conn.rollback()  # failed refresh must not poison the connection
            print(f"warning: event refresh failed: {type(exc).__name__}: {exc}",
                  file=sys.stderr)

        duration_ms = int((time.monotonic() - started) * 1000)
        log_run(conn, "ok", len(records), new, update_time, None, duration_ms)
        print(f"ok: {len(records)} seen, {new} new, {events_touched} events, "
              f"feed={update_time.isoformat()}, {duration_ms}ms")
        return 0
    finally:
        conn.close()


def main():
    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2

    started = time.monotonic()
    last_exc = None

    # Retry the whole ingest cycle: a mid-query connection drop (common on
    # Neon's serverless pooler after idle periods) poisons the existing
    # connection, so we must reconnect and redo the work, not just retry
    # the query. This is safe because load_observations is idempotent.
    for attempt in range(MAX_ATTEMPTS):
        try:
            return _run_once(dsn, started)
        except Exception as exc:
            last_exc = exc
            is_last = attempt == MAX_ATTEMPTS - 1
            if not is_last:
                print(f"warning: attempt {attempt + 1} failed: "
                      f"{type(exc).__name__}: {exc}; retrying",
                      file=sys.stderr)
                time.sleep(1.5 * (attempt + 1))

    # All attempts exhausted: log the failure (best-effort, on a fresh
    # connection since the failing one may be unusable) and exit non-zero.
    duration_ms = int((time.monotonic() - started) * 1000)
    try:
        conn = psycopg.connect(dsn, connect_timeout=15)
        try:
            log_run(conn, "error", 0, 0, None,
                    f"{type(last_exc).__name__}: {last_exc}", duration_ms)
        finally:
            conn.close()
    except Exception:
        pass  # logging the failure must not mask the original failure
    print(f"error: {type(last_exc).__name__}: {last_exc}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
