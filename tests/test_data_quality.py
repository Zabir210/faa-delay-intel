"""Data-quality checks (Task 12, brief version) against the REAL Neon DB.

These checks are read-only SELECTs — safe to run against DATABASE_URL
directly. They do NOT use TEST_DATABASE_URL and do NOT truncate anything.
See the faa-delay-intel-db-safety skill for why that distinction matters.

Skipped entirely if DATABASE_URL isn't set (e.g. sandboxed CI runners).
"""
import os

import pytest
from dotenv import load_dotenv

psycopg = pytest.importorskip("psycopg")

load_dotenv(".env.local")
DSN = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="DATABASE_URL not set")

from detect.data_quality import (  # noqa: E402
    check_ingest_runs_recent,
    check_no_delay_events_natural_key_dupes,
    check_no_duplicate_natural_keys,
    check_no_future_observations,
    check_no_short_airport_codes_violation,
    run_all_checks,
)


@pytest.fixture()
def conn():
    connection = psycopg.connect(DSN)
    yield connection
    connection.close()


def test_no_observation_has_future_update_time(conn):
    ok, detail = check_no_future_observations(conn)
    assert ok, detail


def test_no_duplicate_natural_keys_in_observations(conn):
    ok, detail = check_no_duplicate_natural_keys(conn)
    assert ok, detail


def test_no_airport_code_over_4_chars(conn):
    ok, detail = check_no_short_airport_codes_violation(conn)
    assert ok, detail


def test_no_duplicate_delay_events_natural_keys(conn):
    ok, detail = check_no_delay_events_natural_key_dupes(conn)
    assert ok, detail


def test_run_all_checks_reports_every_check(conn):
    """Structural test: run_all_checks must return one result per
    registered check, regardless of pass/fail, so a silent check
    omission can never hide behind an aggregate True."""
    _, results = run_all_checks(conn)
    names = {r["name"] for r in results}
    assert names == {
        "no_future_observations",
        "no_duplicate_natural_keys",
        "airport_code_length",
        "ingest_runs_recent",
        "ingest_runs_mostly_ok",
        "no_delay_events_dupes",
    }
