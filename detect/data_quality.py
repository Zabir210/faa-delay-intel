"""Brief data-quality checks (Task 12), run before trusting anomaly output.

Each check returns (ok: bool, detail: str). `run_all_checks` aggregates
them and is meant to be called both in CI (tests/test_data_quality.py)
and, optionally, as a pre-flight gate before reporting on anomalies.
"""
from datetime import timedelta


def check_no_future_observations(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM observations WHERE update_time > now()")
        n = cur.fetchone()[0]
    return n == 0, f"{n} observation(s) with update_time in the future"


def check_no_duplicate_natural_keys(conn):
    """The UNIQUE INDEX already prevents this at write time; this check
    re-verifies it directly so a schema regression (e.g. someone drops the
    index) is caught by data, not just by trusting the DDL."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT count(*) FROM (
                SELECT airport, update_time, delay_type, COALESCE(direction, '')
                FROM observations
                GROUP BY 1, 2, 3, 4
                HAVING count(*) > 1
            ) dupes
        """)
        n = cur.fetchone()[0]
    return n == 0, f"{n} duplicate natural key(s) in observations"


def check_no_short_airport_codes_violation(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM observations WHERE length(airport) > 4")
        n = cur.fetchone()[0]
    return n == 0, f"{n} observation(s) with airport code longer than 4 chars"


def check_ingest_runs_recent(conn, max_age=timedelta(hours=1)):
    """Proves the pipeline is alive: the most recent ingest_runs row must
    be recent, regardless of whether the NAS is calm (0 records) or not."""
    with conn.cursor() as cur:
        cur.execute("SELECT max(ran_at), now() FROM ingest_runs")
        last_ran, now = cur.fetchone()
    if last_ran is None:
        return False, "ingest_runs is empty — pipeline has never run"
    age = now - last_ran
    ok = age <= max_age
    return ok, f"last ingest_runs row is {age} old (threshold {max_age})"


def check_ingest_runs_mostly_ok(conn, lookback=timedelta(hours=24), min_success_rate=0.9):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT count(*) FILTER (WHERE status = 'ok'), count(*)
            FROM ingest_runs WHERE ran_at >= now() - %(lookback)s
        """, {"lookback": lookback})
        ok_count, total = cur.fetchone()
    if total == 0:
        return False, "no ingest_runs rows in lookback window"
    rate = ok_count / total
    return rate >= min_success_rate, f"{ok_count}/{total} runs ok ({rate:.1%}) in last {lookback}"


def check_no_delay_events_natural_key_dupes(conn):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT count(*) FROM (
                SELECT airport, delay_type, COALESCE(direction, ''), started_at,
                       (ended_at IS NULL) AS is_open
                FROM delay_events
                GROUP BY 1, 2, 3, 4, 5
                HAVING count(*) > 1
            ) dupes
        """)
        n = cur.fetchone()[0]
    return n == 0, f"{n} duplicate delay_events natural key(s)"


ALL_CHECKS = [
    ("no_future_observations", check_no_future_observations),
    ("no_duplicate_natural_keys", check_no_duplicate_natural_keys),
    ("airport_code_length", check_no_short_airport_codes_violation),
    ("ingest_runs_recent", check_ingest_runs_recent),
    ("ingest_runs_mostly_ok", check_ingest_runs_mostly_ok),
    ("no_delay_events_dupes", check_no_delay_events_natural_key_dupes),
]


def run_all_checks(conn):
    """Returns (all_ok: bool, results: list[dict]) — one dict per check
    with name/ok/detail."""
    results = []
    all_ok = True
    for name, fn in ALL_CHECKS:
        ok, detail = fn(conn)
        results.append({"name": name, "ok": ok, "detail": detail})
        all_ok = all_ok and ok
    return all_ok, results
