-- FAA Delay Intelligence schema
--
-- Design: append-only raw layer (observations) + derived semantic layer
-- (delay_events). Raw rows are never updated, so event logic can be
-- rewritten and replayed without data loss.

-- ---------------------------------------------------------------------
-- Raw layer: immutable record of every observation.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observations (
    id                BIGSERIAL PRIMARY KEY,
    update_time       TIMESTAMPTZ NOT NULL,          -- FAA's own timestamp
    fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    airport           TEXT        NOT NULL,
    delay_type        TEXT        NOT NULL,          -- delay|closure|ground_delay|ground_stop
    direction         TEXT,                          -- Arrival|Departure|NULL
    reason            TEXT,
    min_delay_minutes INT,
    max_delay_minutes INT,
    trend             TEXT,                          -- Increasing|Decreasing|...
    start_text        TEXT,
    reopen_text       TEXT,
    raw               TEXT        NOT NULL           -- original XML fragment
);

-- Idempotency key. direction is included because ONE airport can carry both
-- an Arrival and a Departure delay in the same snapshot; without it, the
-- second row would be silently discarded on conflict.
-- COALESCE because NULL never equals NULL in a UNIQUE constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_observation_natural_key
    ON observations (airport, update_time, delay_type, COALESCE(direction, ''));

CREATE INDEX IF NOT EXISTS idx_obs_airport_time
    ON observations (airport, update_time DESC);
CREATE INDEX IF NOT EXISTS idx_obs_time
    ON observations (update_time DESC);
CREATE INDEX IF NOT EXISTS idx_obs_type
    ON observations (delay_type, update_time DESC);

-- ---------------------------------------------------------------------
-- Semantic layer: a disruption with a start, a peak, and an end.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delay_events (
    id                 BIGSERIAL PRIMARY KEY,
    airport            TEXT        NOT NULL,
    delay_type         TEXT        NOT NULL,
    direction          TEXT,
    reason             TEXT,
    started_at         TIMESTAMPTZ NOT NULL,
    ended_at           TIMESTAMPTZ,                  -- NULL = still open
    last_seen_at       TIMESTAMPTZ NOT NULL,
    peak_delay_minutes INT,
    observation_count  INT         NOT NULL DEFAULT 1,
    is_anomaly         BOOLEAN     NOT NULL DEFAULT false,
    anomaly_score      REAL
);

-- At most one OPEN event per airport/type/direction at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_event
    ON delay_events (airport, delay_type, COALESCE(direction, ''))
    WHERE ended_at IS NULL;

-- Natural key for CLOSED events: refresh_events() recomputes over a rolling
-- lookback window on every ingestion run, so a closed event already stored
-- from a prior run must dedupe on replay rather than duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_closed_event
    ON delay_events (airport, delay_type, COALESCE(direction, ''), started_at)
    WHERE ended_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_airport
    ON delay_events (airport, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_anomaly
    ON delay_events (is_anomaly, started_at DESC) WHERE is_anomaly;

-- ---------------------------------------------------------------------
-- Pipeline health. Essential: when the NAS is calm, zero observations are
-- inserted, so a healthy pipeline and a dead one look identical without
-- this table.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_runs (
    id            BIGSERIAL PRIMARY KEY,
    ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    status        TEXT        NOT NULL,              -- ok|error
    records_seen  INT         NOT NULL DEFAULT 0,
    records_new   INT         NOT NULL DEFAULT 0,
    feed_update_time TIMESTAMPTZ,
    error         TEXT,
    duration_ms   INT
);

CREATE INDEX IF NOT EXISTS idx_runs_time ON ingest_runs (ran_at DESC);
