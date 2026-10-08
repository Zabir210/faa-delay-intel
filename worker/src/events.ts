/**
 * Port of detect/events.py — derive delay events from observations.
 * Pure logic; parity with the Python version is checked by test/parity.
 *
 * An event closes once its airport/type/direction key is absent from TWO
 * consecutive snapshots (tolerates one dropped poll).
 */

export const MISSING_TOLERANCE = 2;

/**
 * A gap this long between consecutive snapshots means the pipeline was down
 * (no historical gap exceeds ~5h; normal cadence is 5 min). Events cannot be
 * assumed to have continued through an outage, so every open event ends at
 * its last sighting. Addition vs detect/events.py; history is unaffected.
 */
export const OUTAGE_GAP_MS = 6 * 60 * 60 * 1000;

/** segment[i] increments at every outage gap in the sorted snapshot list. */
export function outageSegments(snapshotMs: number[]): number[] {
  const seg: number[] = [];
  let cur = 0;
  snapshotMs.forEach((t, i) => {
    if (i > 0 && t - snapshotMs[i - 1] >= OUTAGE_GAP_MS) cur += 1;
    seg.push(cur);
  });
  return seg;
}

export interface EventObservation {
  airport: string;
  delay_type: string;
  direction: string | null;
  reason: string | null;
  update_time: Date;
  min_delay_minutes: number | null;
  max_delay_minutes: number | null;
}

export interface DerivedEvent {
  airport: string;
  delay_type: string;
  direction: string | null;
  reason: string | null;
  started_at: Date;
  last_seen_at: Date;
  ended_at: Date | null;
  peak_delay_minutes: number | null;
  observation_count: number;
}

interface Working extends DerivedEvent {
  _last_idx: number;
}

function peakMinutes(obs: EventObservation): number | null {
  const values = [obs.min_delay_minutes, obs.max_delay_minutes].filter(
    (v): v is number => v !== null && v !== undefined
  );
  return values.length ? Math.max(...values) : null;
}

function newEvent(obs: EventObservation, idx: number, peak: number | null): Working {
  return {
    airport: obs.airport,
    delay_type: obs.delay_type,
    direction: obs.direction ?? null,
    reason: obs.reason ?? null,
    started_at: obs.update_time,
    last_seen_at: obs.update_time,
    ended_at: null,
    peak_delay_minutes: peak,
    observation_count: 1,
    _last_idx: idx,
  };
}

function finalize(e: Working): DerivedEvent {
  const { _last_idx: _unused, ...rest } = e;
  return rest;
}

export function deriveEvents(
  observations: EventObservation[],
  snapshotTimes: Date[]
): DerivedEvent[] {
  const snapshotIndex = new Map<number, number>();
  snapshotTimes.forEach((t, i) => snapshotIndex.set(t.getTime(), i));
  const segment = outageSegments(snapshotTimes.map((t) => t.getTime()));

  // Map preserves insertion order, like a Python dict.
  const byKey = new Map<string, EventObservation[]>();
  for (const obs of observations) {
    const key = JSON.stringify([obs.airport, obs.delay_type, obs.direction ?? null]);
    let list = byKey.get(key);
    if (!list) byKey.set(key, (list = []));
    list.push(obs);
  }

  const events: DerivedEvent[] = [];
  const lastSnapshotIdx = snapshotTimes.length - 1;

  for (const obsList of byKey.values()) {
    // Array.prototype.sort is stable, like Python's list.sort.
    obsList.sort((a, b) => a.update_time.getTime() - b.update_time.getTime());

    let current: Working | null = null;
    for (const obs of obsList) {
      const idx = snapshotIndex.get(obs.update_time.getTime());
      if (idx === undefined) {
        throw new Error(`KeyError: observation time ${obs.update_time.toISOString()} not in snapshots`);
      }
      const peak = peakMinutes(obs);

      if (current === null) {
        current = newEvent(obs, idx, peak);
        continue;
      }

      const gap = idx - current._last_idx;
      if (gap - 1 >= MISSING_TOLERANCE || segment[idx] !== segment[current._last_idx]) {
        current.ended_at = current.last_seen_at;
        events.push(finalize(current));
        current = newEvent(obs, idx, peak);
      } else {
        current.last_seen_at = obs.update_time;
        current._last_idx = idx;
        current.observation_count += 1;
        if (peak !== null) {
          // Python: max(current["peak_delay_minutes"] or 0, peak)
          current.peak_delay_minutes = Math.max(current.peak_delay_minutes || 0, peak);
        }
        if (obs.reason) current.reason = obs.reason;
      }
    }

    if (current !== null) {
      if (
        lastSnapshotIdx - current._last_idx >= MISSING_TOLERANCE ||
        segment[lastSnapshotIdx] !== segment[current._last_idx]
      ) {
        current.ended_at = current.last_seen_at;
      }
      events.push(finalize(current));
    }
  }

  // Python: events.sort(key=lambda e: (e["airport"], e["started_at"]))
  events.sort((a, b) => {
    if (a.airport !== b.airport) return pyStrCmp(a.airport, b.airport);
    return a.started_at.getTime() - b.started_at.getTime();
  });
  return events;
}

/** Python str ordering: by code point (JS < compares UTF-16 units). */
function pyStrCmp(a: string, b: string): number {
  const ca = Array.from(a), cb = Array.from(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const d = ca[i].codePointAt(0)! - cb[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return ca.length - cb.length;
}
