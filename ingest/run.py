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


def main():
    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2

    started = time.monotonic()
    conn = None
    try:
        conn = psycopg.connect(dsn, connect_timeout=15)
    except Exception as exc:
        print(f"error: cannot connect to database: {exc}", file=sys.stderr)
        return 1

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

    except Exception as exc:
        duration_ms = int((time.monotonic() - started) * 1000)
        try:
            log_run(conn, "error", 0, 0, None, f"{type(exc).__name__}: {exc}",
                    duration_ms)
        except Exception:
            pass  # logging the failure must not mask the original failure
        print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    finally:
        if conn:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
