from datetime import datetime, timedelta, timezone

from detect.events import derive_events

T0 = datetime(2026, 9, 16, 12, 0, tzinfo=timezone.utc)


def snap(n):
    """The nth 5-minute snapshot timestamp."""
    return T0 + timedelta(minutes=5 * n)


def obs(n, airport="DFW", delay_type="delay", direction="Departure",
        reason="WX:Thunderstorms", min_m=10, max_m=20):
    return {
        "airport": airport, "delay_type": delay_type, "direction": direction,
        "reason": reason, "update_time": snap(n),
        "min_delay_minutes": min_m, "max_delay_minutes": max_m,
    }


def test_clean_event_spanning_consecutive_snapshots():
    """DFW delayed at snapshots 0-3, gone after: one closed event."""
    observations = [obs(0), obs(1), obs(2), obs(3)]
    snapshots = [snap(i) for i in range(6)]  # window runs through snapshot 5

    events = derive_events(observations, snapshots)

    assert len(events) == 1
    e = events[0]
    assert e["airport"] == "DFW"
    assert e["started_at"] == snap(0)
    assert e["last_seen_at"] == snap(3)
    assert e["ended_at"] == snap(3)
    assert e["observation_count"] == 4


def test_flapping_event_with_one_gap_stays_one_event():
    """A single missed poll (one gap) must not fragment one real event
    into two."""
    observations = [obs(0), obs(1), obs(3), obs(4)]  # snapshot 2 missing
    snapshots = [snap(i) for i in range(7)]

    events = derive_events(observations, snapshots)

    assert len(events) == 1, f"expected one event, got {len(events)}: {events}"
    assert events[0]["started_at"] == snap(0)
    assert events[0]["last_seen_at"] == snap(4)
    assert events[0]["observation_count"] == 4


def test_two_missed_polls_splits_into_two_events():
    """Two consecutive missed polls IS enough evidence the disruption
    genuinely ended and a new one began."""
    observations = [obs(0), obs(1), obs(5), obs(6)]  # snapshots 2,3,4 missing
    snapshots = [snap(i) for i in range(8)]

    events = derive_events(observations, snapshots)

    assert len(events) == 2
    assert events[0]["started_at"] == snap(0)
    assert events[0]["ended_at"] == snap(1)
    assert events[1]["started_at"] == snap(5)


def test_event_still_open_at_end_of_window_has_no_ended_at():
    """An event seen at the LAST snapshot in the window is still ongoing —
    ended_at must be None, not a guessed end time."""
    observations = [obs(0), obs(1), obs(2)]
    snapshots = [snap(i) for i in range(3)]  # window ends exactly at snap(2)

    events = derive_events(observations, snapshots)

    assert len(events) == 1
    assert events[0]["ended_at"] is None
    assert events[0]["last_seen_at"] == snap(2)


def test_peak_delay_is_the_max_seen_across_the_event():
    observations = [
        obs(0, min_m=10, max_m=20),
        obs(1, min_m=30, max_m=45),   # peak
        obs(2, min_m=15, max_m=25),
    ]
    snapshots = [snap(i) for i in range(5)]

    events = derive_events(observations, snapshots)
    assert events[0]["peak_delay_minutes"] == 45


def test_different_airports_produce_independent_events():
    observations = [
        obs(0, airport="DFW"), obs(1, airport="DFW"),
        obs(0, airport="ORD"), obs(1, airport="ORD"),
    ]
    snapshots = [snap(i) for i in range(3)]

    events = derive_events(observations, snapshots)
    assert {e["airport"] for e in events} == {"DFW", "ORD"}
    assert len(events) == 2


def test_arrival_and_departure_are_independent_events_for_same_airport():
    """direction is part of the grouping key — an airport with both legs
    delayed must not be merged into one event."""
    observations = [
        obs(0, direction="Arrival"), obs(1, direction="Arrival"),
        obs(0, direction="Departure"), obs(1, direction="Departure"),
    ]
    snapshots = [snap(i) for i in range(3)]

    events = derive_events(observations, snapshots)
    assert len(events) == 2
    assert {e["direction"] for e in events} == {"Arrival", "Departure"}


def test_closure_events_have_no_delay_minutes():
    observations = [{
        "airport": "ALO", "delay_type": "closure", "direction": None,
        "reason": "NOTAM closure", "update_time": snap(0),
        "min_delay_minutes": None, "max_delay_minutes": None,
    }]
    snapshots = [snap(i) for i in range(2)]

    events = derive_events(observations, snapshots)
    assert len(events) == 1
    assert events[0]["peak_delay_minutes"] is None


def test_empty_observations_produce_no_events():
    assert derive_events([], [snap(0), snap(1)]) == []


def test_single_snapshot_single_observation_is_one_event():
    events = derive_events([obs(0)], [snap(0)])
    assert len(events) == 1
    assert events[0]["ended_at"] is None  # still the last snapshot in window
