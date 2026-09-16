"""Loader tests against a real Postgres.

Skipped unless TEST_DATABASE_URL is set:
    docker run -d --name faa-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=faa \
        -p 55432:5432 postgres:16-alpine
    export TEST_DATABASE_URL=postgresql://postgres:dev@127.0.0.1:55432/faa
"""
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")

from ingest.loader import load_observations, log_run  # noqa: E402
from ingest.parser import parse_nas_status  # noqa: E402

DSN = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL not set")

FIXTURE = (Path(__file__).parent / "fixtures" / "nas_status_sample.xml").read_text()
SCHEMA = (Path(__file__).parent.parent / "db" / "schema.sql").read_text()


@pytest.fixture()
def conn():
    connection = psycopg.connect(DSN)
    with connection.cursor() as cur:
        cur.execute(SCHEMA)
        cur.execute("TRUNCATE observations, delay_events, ingest_runs")
    connection.commit()
    yield connection
    connection.close()


def test_loads_all_records_from_snapshot(conn):
    parsed = parse_nas_status(FIXTURE)
    inserted = load_observations(conn, parsed["update_time"], parsed["records"])
    assert inserted == len(parsed["records"]) == 7  # 2 delays + 5 closures

    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM observations")
        assert cur.fetchone()[0] == 7


def test_reloading_same_snapshot_is_a_noop(conn):
    """THE critical property: polling every 5 minutes while the FAA updates
    less often must not create duplicate rows."""
    parsed = parse_nas_status(FIXTURE)
    first = load_observations(conn, parsed["update_time"], parsed["records"])
    second = load_observations(conn, parsed["update_time"], parsed["records"])
    third = load_observations(conn, parsed["update_time"], parsed["records"])

    assert first == 7
    assert second == 0, "re-ingesting an unchanged snapshot must insert nothing"
    assert third == 0

    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM observations")
        assert cur.fetchone()[0] == 7


def test_new_update_time_creates_new_rows(conn):
    """A genuinely newer snapshot must be stored, not deduped away."""
    parsed = parse_nas_status(FIXTURE)
    load_observations(conn, parsed["update_time"], parsed["records"])
    later = parsed["update_time"] + timedelta(minutes=5)
    inserted = load_observations(conn, later, parsed["records"])

    assert inserted == 7
    with conn.cursor() as cur:
        cur.execute("SELECT count(DISTINCT update_time) FROM observations")
        assert cur.fetchone()[0] == 2


def test_arrival_and_departure_are_stored_separately(conn):
    """One airport with both legs must produce two rows — the reason
    `direction` is part of the unique key."""
    now = datetime.now(timezone.utc)
    base = {
        "airport": "ATL", "delay_type": "delay", "reason": "WX",
        "min_delay_minutes": 20, "max_delay_minutes": 40, "trend": "Increasing",
        "start_text": None, "reopen_text": None, "raw": "<Delay/>",
    }
    records = [
        {**base, "direction": "Arrival"},
        {**base, "direction": "Departure"},
    ]
    inserted = load_observations(conn, now, records)
    assert inserted == 2, "arrival and departure must not collide"


def test_empty_record_list_inserts_nothing(conn):
    """A calm NAS produces zero records and must not error."""
    assert load_observations(conn, datetime.now(timezone.utc), []) == 0


def test_log_run_records_success_and_error(conn):
    log_run(conn, "ok", records_seen=7, records_new=7, duration_ms=120)
    log_run(conn, "error", error="Boom: it broke", duration_ms=50)
    with conn.cursor() as cur:
        cur.execute("SELECT status, count(*) FROM ingest_runs GROUP BY status "
                    "ORDER BY status")
        assert cur.fetchall() == [("error", 1), ("ok", 1)]


def test_log_run_truncates_long_errors(conn):
    log_run(conn, "error", error="x" * 5000)
    with conn.cursor() as cur:
        cur.execute("SELECT length(error) FROM ingest_runs")
        assert cur.fetchone()[0] <= 2000
