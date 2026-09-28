"""Anomaly detection for delay_events: z-score + duration outlier checks.

Task 11 of the implementation plan. Two independent checks, each gated by
a minimum sample count so thin data returns NULL (not scored) rather than
a false positive:

1. Delay-magnitude z-score: an event's peak_delay_minutes compared against
   the trailing-N-day distribution of delay minutes for that airport AND
   hour-of-day (a 40-min delay at ORD at 6pm is normal; at 3am it isn't).
   The baseline is built from `observations` (not `delay_events`) because
   raw observations are far denser — with ~11 days of data there are 160+
   airport/hour buckets with n>=20 at the observation level, vs. only a
   handful at the event level. An event's peak is then compared to the
   observation-level distribution for its airport and the hour it started.

2. Duration outlier: a closed event's duration (ended_at - started_at)
   compared against that airport's trailing-N-day distribution of event
   durations (all delay_types pooled — splitting further starves the
   sample size at current data volumes).

Both checks require n >= MIN_SAMPLES in a bucket before scoring it; below
that, the bucket is omitted from the baseline entirely and any event
depending on it scores as (None, False) -- not anomalous, not a
false-positive fabricated from noise.

Pure functions operate on plain dicts/lists so they're unit-testable with
synthetic data, independent of Postgres. `score_and_persist_anomalies`
is the only function that touches the DB.
"""
from collections import defaultdict
from statistics import mean, stdev

MIN_SAMPLES = 20
Z_THRESHOLD = 2.5


# --------------------------------------------------------------------
# Delay-magnitude z-score, keyed by (airport, hour-of-day)
# --------------------------------------------------------------------

def _obs_delay_minutes(obs):
    values = [v for v in (obs.get("min_delay_minutes"), obs.get("max_delay_minutes"))
              if v is not None]
    return max(values) if values else None


def build_delay_baseline(observations, min_samples=MIN_SAMPLES):
    """Build a per-(airport, hour-of-day) baseline of delay minutes from
    raw observations.

    observations: iterable of dicts with airport, update_time (datetime,
        tz-aware), min_delay_minutes, max_delay_minutes.

    Returns {(airport, hour): {"n": int, "mean": float, "stdev": float}}.
    Buckets with fewer than min_samples observations, or with zero
    variance in <2 usable samples, are omitted entirely.
    """
    buckets = defaultdict(list)
    for obs in observations:
        val = _obs_delay_minutes(obs)
        if val is None:
            continue
        key = (obs["airport"], obs["update_time"].hour)
        buckets[key].append(val)

    baseline = {}
    for key, values in buckets.items():
        if len(values) < min_samples:
            continue
        if len(values) < 2:
            continue
        s = stdev(values)
        baseline[key] = {"n": len(values), "mean": mean(values), "stdev": s}
    return baseline


def score_delay_zscore(event, baseline, z_threshold=Z_THRESHOLD):
    """Score one event's peak_delay_minutes against the baseline for its
    (airport, hour-of-started_at) bucket.

    Returns (z_score, is_anomaly). Returns (None, False) when:
      - the event has no peak_delay_minutes (e.g. a closure),
      - its bucket isn't in the baseline (insufficient samples upstream),
      - the bucket has zero variance (a z-score would be undefined/infinite).
    """
    peak = event.get("peak_delay_minutes")
    if peak is None:
        return None, False

    key = (event["airport"], event["started_at"].hour)
    bucket = baseline.get(key)
    if bucket is None:
        return None, False
    if bucket["stdev"] == 0:
        return None, False

    z = (peak - bucket["mean"]) / bucket["stdev"]
    return z, abs(z) > z_threshold


# --------------------------------------------------------------------
# Duration outlier, keyed by airport
# --------------------------------------------------------------------

def _duration_minutes(event):
    if event.get("started_at") is None or event.get("ended_at") is None:
        return None
    delta = event["ended_at"] - event["started_at"]
    return delta.total_seconds() / 60.0


def build_duration_baseline(closed_events, min_samples=MIN_SAMPLES):
    """Build a per-airport baseline of closed-event durations (minutes).

    closed_events: iterable of dicts with airport, started_at, ended_at
        (both required — only events that have actually closed contribute
        to "historical distribution").

    Returns {airport: {"n", "mean", "stdev"}}, omitting airports with
    fewer than min_samples closed events.
    """
    buckets = defaultdict(list)
    for event in closed_events:
        dur = _duration_minutes(event)
        if dur is None:
            continue
        buckets[event["airport"]].append(dur)

    baseline = {}
    for airport, values in buckets.items():
        if len(values) < min_samples or len(values) < 2:
            continue
        s = stdev(values)
        baseline[airport] = {"n": len(values), "mean": mean(values), "stdev": s}
    return baseline


def score_duration_outlier(event, baseline, z_threshold=Z_THRESHOLD):
    """Score one closed event's duration against its airport's baseline.

    Returns (z_score, is_outlier); (None, False) if the event is still
    open, its airport has no baseline (insufficient samples), or the
    baseline has zero variance.
    """
    dur = _duration_minutes(event)
    if dur is None:
        return None, False

    bucket = baseline.get(event["airport"])
    if bucket is None:
        return None, False
    if bucket["stdev"] == 0:
        return None, False

    z = (dur - bucket["mean"]) / bucket["stdev"]
    return z, abs(z) > z_threshold


# --------------------------------------------------------------------
# Combined scoring
# --------------------------------------------------------------------

def score_event(event, delay_baseline, duration_baseline, z_threshold=Z_THRESHOLD):
    """Combine both checks for one event.

    Returns (anomaly_score, is_anomaly). is_anomaly is true if EITHER
    check fires. anomaly_score is whichever z had the larger magnitude
    among the checks that actually produced a score (sign preserved);
    None if neither check could be scored (thin data on both fronts).
    """
    z_delay, flag_delay = score_delay_zscore(event, delay_baseline, z_threshold)
    z_dur, flag_dur = score_duration_outlier(event, duration_baseline, z_threshold)

    candidates = [z for z in (z_delay, z_dur) if z is not None]
    if not candidates:
        return None, False

    score = max(candidates, key=abs)
    return score, (flag_delay or flag_dur)


# --------------------------------------------------------------------
# DB orchestration
# --------------------------------------------------------------------

FETCH_OBS_SQL = """
SELECT airport, update_time, min_delay_minutes, max_delay_minutes
FROM observations
WHERE update_time >= %(since)s
  AND delay_type IN ('delay', 'ground_delay')
"""

FETCH_CLOSED_EVENTS_SQL = """
SELECT id, airport, started_at, ended_at
FROM delay_events
WHERE ended_at IS NOT NULL AND started_at >= %(since)s
"""

FETCH_SCORABLE_EVENTS_SQL = """
SELECT id, airport, delay_type, started_at, ended_at, peak_delay_minutes
FROM delay_events
WHERE started_at >= %(since)s
"""

UPDATE_SCORE_SQL = """
UPDATE delay_events SET anomaly_score = %(score)s, is_anomaly = %(flag)s
WHERE id = %(id)s
"""


def score_and_persist_anomalies(conn, baseline_days=30, min_samples=MIN_SAMPLES,
                                 z_threshold=Z_THRESHOLD):
    """Recompute baselines from the trailing `baseline_days` of data and
    (re)score every delay_event in that window, persisting is_anomaly /
    anomaly_score.

    Returns a dict summary: {scored, flagged, skipped_thin_data}.
    """
    from datetime import timedelta

    with conn.cursor() as cur:
        cur.execute("SELECT now() - %(lookback)s",
                     {"lookback": timedelta(days=baseline_days)})
        since = cur.fetchone()[0]

        cur.execute(FETCH_OBS_SQL, {"since": since})
        cols = [d.name for d in cur.description]
        observations = [dict(zip(cols, row)) for row in cur.fetchall()]

        cur.execute(FETCH_CLOSED_EVENTS_SQL, {"since": since})
        cols = [d.name for d in cur.description]
        closed_events = [dict(zip(cols, row)) for row in cur.fetchall()]

        cur.execute(FETCH_SCORABLE_EVENTS_SQL, {"since": since})
        cols = [d.name for d in cur.description]
        events = [dict(zip(cols, row)) for row in cur.fetchall()]

    delay_baseline = build_delay_baseline(observations, min_samples)
    duration_baseline = build_duration_baseline(closed_events, min_samples)

    scored = 0
    flagged = 0
    skipped = 0
    with conn.cursor() as cur:
        for event in events:
            score, flag = score_event(event, delay_baseline, duration_baseline,
                                       z_threshold)
            cur.execute(UPDATE_SCORE_SQL,
                        {"score": score, "flag": flag, "id": event["id"]})
            if score is None:
                skipped += 1
            else:
                scored += 1
            if flag:
                flagged += 1
    conn.commit()

    return {
        "scored": scored,
        "flagged": flagged,
        "skipped_thin_data": skipped,
        "delay_baseline_buckets": len(delay_baseline),
        "duration_baseline_airports": len(duration_baseline),
    }
