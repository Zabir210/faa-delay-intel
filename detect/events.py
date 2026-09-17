"""Derive delay_events from the append-only observations table.

An "event" is a disruption with a start, a peak, and (eventually) an end.
Observations arrive every ~5 minutes; an event is considered ended when an
airport/type/direction combination is absent from TWO consecutive snapshots
in a row (tolerates one dropped poll without fragmenting one real event into
several).

This module is pure logic over plain dicts so it can be unit-tested with
synthetic sequences, independent of Postgres.
"""
from collections import defaultdict

MISSING_TOLERANCE = 2  # consecutive absent snapshots before an event closes


def derive_events(observations, snapshot_times):
    """Group a time-ordered stream of observations into events.

    observations: iterable of dicts with keys airport, delay_type, direction,
        reason, update_time, min_delay_minutes, max_delay_minutes.
    snapshot_times: sorted list of every distinct update_time seen in the
        ingestion window, INCLUDING snapshots with zero matching records —
        needed to detect "absent for N consecutive snapshots" rather than
        just "absent between two records that happen to exist".

    Returns a list of event dicts:
        {airport, delay_type, direction, reason, started_at, ended_at,
         last_seen_at, peak_delay_minutes, observation_count}
    ended_at is None for an event still open at the end of the window.
    """
    snapshot_index = {t: i for i, t in enumerate(snapshot_times)}

    by_key = defaultdict(list)
    for obs in observations:
        key = (obs["airport"], obs["delay_type"], obs.get("direction"))
        by_key[key].append(obs)

    events = []
    last_snapshot_idx = len(snapshot_times) - 1

    for key, obs_list in by_key.items():
        airport, delay_type, direction = key
        obs_list.sort(key=lambda o: o["update_time"])

        current = None
        for obs in obs_list:
            idx = snapshot_index[obs["update_time"]]
            peak = _peak_minutes(obs)

            if current is None:
                current = _new_event(obs, airport, delay_type, direction, idx, peak)
                continue

            gap = idx - current["_last_idx"]
            if gap - 1 >= MISSING_TOLERANCE:
                # Too many missed snapshots: close the open event, start a new one.
                current["ended_at"] = current["last_seen_at"]
                events.append(_finalize(current))
                current = _new_event(obs, airport, delay_type, direction, idx, peak)
            else:
                current["last_seen_at"] = obs["update_time"]
                current["_last_idx"] = idx
                current["observation_count"] += 1
                if peak is not None:
                    current["peak_delay_minutes"] = max(
                        current["peak_delay_minutes"] or 0, peak
                    )
                if obs.get("reason"):
                    current["reason"] = obs["reason"]  # keep latest known reason

        if current is not None:
            # Still open only if its last sighting is within tolerance of the
            # end of the observation window.
            if last_snapshot_idx - current["_last_idx"] >= MISSING_TOLERANCE:
                current["ended_at"] = current["last_seen_at"]
            events.append(_finalize(current))

    events.sort(key=lambda e: (e["airport"], e["started_at"]))
    return events


def _peak_minutes(obs):
    values = [v for v in (obs.get("min_delay_minutes"), obs.get("max_delay_minutes"))
              if v is not None]
    return max(values) if values else None


def _new_event(obs, airport, delay_type, direction, idx, peak):
    return {
        "airport": airport,
        "delay_type": delay_type,
        "direction": direction,
        "reason": obs.get("reason"),
        "started_at": obs["update_time"],
        "last_seen_at": obs["update_time"],
        "ended_at": None,
        "peak_delay_minutes": peak,
        "observation_count": 1,
        "_last_idx": idx,
    }


def _finalize(event):
    return {k: v for k, v in event.items() if not k.startswith("_")}
