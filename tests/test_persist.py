"""Tests for detect/persist.py against real Postgres.

Skipped unless TEST_DATABASE_URL is set (see tests/test_loader.py header).
"""
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")

from detect.persist import refresh_events  # noqa: E402
from ingest.loader import load_observations  # noqa: E402

DSN = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL not set")

SCHEMA = (Path(__file__).parent.parent / "db" / "schema.sql").read_text()
# Must stay within refresh_events' 24h lookback window relative to whenever
# the suite actually runs — a fixed calendar date drifts out of range and
# silently zeroes every event (see 2026-09-17 CI failure).
T0 = datetime.now(timezone.utc) - timedelta(hours=1)


@pytest.fixture()
def conn():
    connection = psycopg.connect(DSN)
    with connection.cursor() as cur:
        cur.execute(SCHEMA)
        cur.execute("TRUNCATE observations, delay_events, ingest_runs")
    connection.commit()
    yield connection
    connection.close()


def snap(n):
    return T0 + timedelta(minutes=5 * n)


def record(airport="DFW", delay_type="delay", direction="Departure",
           reason="WX:Thunderstorms", min_m=10, max_m=20):
    return {
        "airport": airport, "delay_type": delay_type, "direction": direction,
        "reason": reason, "min_delay_minutes": min_m, "max_delay_minutes": max_m,
        "trend": None, "start_text": None, "reopen_text": None, "raw": "<r/>",
    }


def test_ongoing_event_is_stored_open(conn):
    load_observations(conn, snap(0), [record()])
    load_observations(conn, snap(1), [record()])

    n = refresh_events(conn)
    assert n == 1

    with conn.cursor() as cur:
        cur.execute("SELECT airport, ended_at, observation_count FROM delay_events")
        rows = cur.fetchall()
    assert len(rows) == 1
    assert rows[0][0] == "DFW"
    assert rows[0][1] is None  # still open
    assert rows[0][2] == 2


def test_refresh_is_idempotent_and_extends_existing_open_event(conn):
    """THE state-transition property: calling refresh_events again after
    more data arrives must UPDATE the existing open row, never insert a
    second one for the same disruption."""
    load_observations(conn, snap(0), [record()])
    load_observations(conn, snap(1), [record()])
    refresh_events(conn)

    # more observations arrive for the same ongoing disruption
    load_observations(conn, snap(2), [record()])
    load_observations(conn, snap(3), [record(min_m=40, max_m=55)])  # new peak
    refresh_events(conn)

    with conn.cursor() as cur:
        cur.execute("SELECT count(*), max(peak_delay_minutes), "
                    "max(observation_count) FROM delay_events")
        count, peak, obs_count = cur.fetchone()

    assert count == 1, "a second refresh must update the row, not duplicate it"
    assert peak == 55
    assert obs_count == 4


def test_event_that_ends_is_closed_on_next_refresh(conn):
    """The open row must transition to closed, not spawn a duplicate."""
    load_observations(conn, snap(0), [record()])
    load_observations(conn, snap(1), [record()])
    refresh_events(conn)

    # DFW's disruption ends; two later snapshots with no DFW record.
    load_observations(conn, snap(2), [record(airport="ORD")])
    load_observations(conn, snap(3), [record(airport="ORD")])
    load_observations(conn, snap(4), [record(airport="ORD")])
    refresh_events(conn)

    with conn.cursor() as cur:
        cur.execute("SELECT airport, ended_at FROM delay_events "
                    "WHERE airport = 'DFW'")
        rows = cur.fetchall()

    assert len(rows) == 1, "closing an event must not duplicate its row"
    assert rows[0][1] is not None, "event must be marked closed"


def test_repeated_refresh_over_unchanged_window_does_not_duplicate(conn):
    load_observations(conn, snap(0), [record()])
    load_observations(conn, snap(1), [record()])
    load_observations(conn, snap(2), [record(airport="ORD")])
    load_observations(conn, snap(3), [record(airport="ORD")])
    load_observations(conn, snap(4), [record(airport="ORD")])

    refresh_events(conn)
    refresh_events(conn)
    refresh_events(conn)

    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM delay_events")
        assert cur.fetchone()[0] == 2  # DFW (closed) + ORD (open)


def test_no_observations_in_window_is_a_noop(conn):
    assert refresh_events(conn) == 0


def test_null_peak_is_not_coerced_to_zero_on_repeated_refresh(conn):
    """Regression: GREATEST(COALESCE(x,0), COALESCE(y,0)) turns a legitimate
    NULL peak (e.g. a closure, which carries no delay minutes) into a
    permanent 0. A second refresh over an unchanged open event must leave
    a NULL peak as NULL, not silently invent a numeric value."""
    closure = {
        "airport": "ALO", "delay_type": "closure", "direction": None,
        "reason": "NOTAM closure", "min_delay_minutes": None,
        "max_delay_minutes": None, "trend": None,
        "start_text": "x", "reopen_text": "y", "raw": "<r/>",
    }
    load_observations(conn, snap(0), [closure])
    refresh_events(conn)
    load_observations(conn, snap(1), [closure])  # second refresh: UPDATE path
    refresh_events(conn)

    with conn.cursor() as cur:
        cur.execute("SELECT peak_delay_minutes FROM delay_events "
                    "WHERE airport = 'ALO'")
        peak = cur.fetchone()[0]
    assert peak is None, f"expected NULL peak for a closure, got {peak}"
