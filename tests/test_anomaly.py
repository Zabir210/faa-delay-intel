"""Unit tests for detect/anomaly.py using synthetic data — no DB.

Core property under test: the minimum-sample gate must suppress scoring
(return None/not-anomalous) on thin buckets rather than fabricate a
z-score from noise.
"""
from datetime import datetime, timedelta, timezone

from detect.anomaly import (
    MIN_SAMPLES,
    build_delay_baseline,
    build_duration_baseline,
    score_delay_zscore,
    score_duration_outlier,
    score_event,
)

T0 = datetime(2026, 9, 16, 12, 0, tzinfo=timezone.utc)


def obs(airport, hour, day_offset, delay_minutes):
    """A synthetic observation on a distinct day, same hour-of-day —
    distinct days matter because build_delay_baseline treats each sample
    independently regardless of day; day_offset just keeps timestamps
    unique without ever crossing into a different hour bucket."""
    return {
        "airport": airport,
        "update_time": (T0 + timedelta(days=day_offset)).replace(hour=hour),
        "min_delay_minutes": delay_minutes,
        "max_delay_minutes": delay_minutes,
    }


def event(airport, hour, peak, started_offset_days=0):
    started = T0.replace(hour=hour) + timedelta(days=started_offset_days)
    return {"airport": airport, "started_at": started, "peak_delay_minutes": peak}


def closed_event(airport, duration_minutes, started_offset_days=0):
    started = T0 + timedelta(days=started_offset_days)
    return {
        "airport": airport,
        "started_at": started,
        "ended_at": started + timedelta(minutes=duration_minutes),
    }


# --------------------------------------------------------------------
# Minimum-sample gate: the critical property
# --------------------------------------------------------------------

def test_thin_bucket_is_omitted_from_delay_baseline():
    """Fewer than MIN_SAMPLES observations in a bucket must not produce a
    baseline entry at all."""
    observations = [obs("DFW", 14, i, 20) for i in range(MIN_SAMPLES - 1)]
    baseline = build_delay_baseline(observations)
    assert ("DFW", 14) not in baseline


def test_bucket_at_exactly_min_samples_is_included():
    observations = [obs("DFW", 14, i, 20) for i in range(MIN_SAMPLES)]
    baseline = build_delay_baseline(observations)
    assert ("DFW", 14) in baseline
    assert baseline[("DFW", 14)]["n"] == MIN_SAMPLES


def test_scoring_against_thin_bucket_returns_none_not_false_positive():
    """This is the pitfall called out in the plan: with <30 days of data,
    an extreme-looking event must NOT be flagged just because its bucket
    is thin — it must come back unscored."""
    observations = [obs("DFW", 14, i, 20) for i in range(5)]  # well under MIN_SAMPLES
    baseline = build_delay_baseline(observations)

    extreme_event = event("DFW", 14, peak=500)  # would look wildly anomalous
    z, flag = score_delay_zscore(extreme_event, baseline)

    assert z is None, "thin bucket must not yield a numeric z-score"
    assert flag is False, "thin bucket must never be flagged anomalous"


def test_scoring_with_sufficient_samples_correctly_flags_true_outlier():
    """Sanity check the gate doesn't just always return None — sufficient
    data must still be able to flag a genuine outlier."""
    # 25 calm observations of ~20 min delay (small jitter for nonzero stdev)
    observations = [obs("DFW", 14, i, 18 + (i % 5)) for i in range(25)]
    baseline = build_delay_baseline(observations)

    normal_event = event("DFW", 14, peak=22)
    z, flag = score_delay_zscore(normal_event, baseline)
    assert z is not None
    assert flag is False

    extreme_event = event("DFW", 14, peak=500)
    z2, flag2 = score_delay_zscore(extreme_event, baseline)
    assert z2 is not None
    assert flag2 is True
    assert z2 > 2.5


def test_zero_variance_bucket_does_not_score():
    """A bucket where every sample is identical has stdev 0 — dividing by
    it would be a bug (inf/nan), not a valid z-score. The baseline may
    legitimately store a stdev-0 bucket (n>=min_samples); scoring against
    it must still refuse rather than divide by zero."""
    observations = [obs("DFW", 14, i, 20) for i in range(30)]  # all identical
    baseline = build_delay_baseline(observations)
    assert baseline[("DFW", 14)]["stdev"] == 0.0
    z, flag = score_delay_zscore(event("DFW", 14, peak=999), baseline)
    assert z is None
    assert flag is False


def test_missing_peak_delay_is_not_scored():
    observations = [obs("DFW", 14, i, 18 + (i % 5)) for i in range(25)]
    baseline = build_delay_baseline(observations)
    closure_event = {"airport": "DFW", "started_at": T0.replace(hour=14),
                      "peak_delay_minutes": None}
    z, flag = score_delay_zscore(closure_event, baseline)
    assert z is None
    assert flag is False


def test_different_hour_bucket_is_independent():
    """A 3am delay must be judged against 3am history, not 6pm history —
    the whole point of bucketing by hour-of-day."""
    calm_evening = [obs("ORD", 18, i, 40 + (i % 5)) for i in range(25)]
    baseline = build_delay_baseline(calm_evening)
    assert ("ORD", 3) not in baseline  # no 3am data at all
    z, flag = score_delay_zscore(event("ORD", 3, peak=40), baseline)
    assert z is None and flag is False


# --------------------------------------------------------------------
# Duration outlier
# --------------------------------------------------------------------

def test_duration_baseline_requires_min_samples():
    events = [closed_event("BOS", 60, started_offset_days=i) for i in range(MIN_SAMPLES - 1)]
    baseline = build_duration_baseline(events)
    assert "BOS" not in baseline


def test_duration_outlier_flags_genuinely_long_event():
    normal = [closed_event("BOS", 60 + (i % 10), started_offset_days=i) for i in range(25)]
    baseline = build_duration_baseline(normal)

    long_event = closed_event("BOS", 2000, started_offset_days=30)
    z, flag = score_duration_outlier(long_event, baseline)
    assert z is not None
    assert flag is True


def test_open_event_has_no_duration_score():
    normal = [closed_event("BOS", 60 + (i % 10), started_offset_days=i) for i in range(25)]
    baseline = build_duration_baseline(normal)
    open_event = {"airport": "BOS", "started_at": T0, "ended_at": None}
    z, flag = score_duration_outlier(open_event, baseline)
    assert z is None
    assert flag is False


# --------------------------------------------------------------------
# Combined score_event
# --------------------------------------------------------------------

def test_score_event_returns_none_when_both_checks_are_thin():
    score, flag = score_event(
        event("XYZ", 5, peak=30), delay_baseline={}, duration_baseline={},
    )
    assert score is None
    assert flag is False


def test_score_event_flags_if_either_check_fires():
    delay_obs = [obs("DFW", 14, i, 18 + (i % 5)) for i in range(25)]
    delay_baseline = build_delay_baseline(delay_obs)

    ev = event("DFW", 14, peak=500)
    ev["ended_at"] = None  # duration check will be skipped (no ended_at)
    score, flag = score_event(ev, delay_baseline, duration_baseline={})
    assert score is not None
    assert flag is True
