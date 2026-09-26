-- 30-second probe rounds from four vantage points. Every round stores one
-- sample per endpoint with each vantage's result; hourly and daily rollups
-- are rebuilt from the samples, per vantage and for the consensus ('all').
-- The latest sample replaces the endpoints' last-probe columns.
ALTER TABLE endpoints DROP COLUMN last_checked_at;
ALTER TABLE endpoints DROP COLUMN last_ok;
ALTER TABLE endpoints DROP COLUMN last_latency_ms;
ALTER TABLE endpoints DROP COLUMN last_error;
ALTER TABLE endpoints DROP COLUMN consecutive_failures;

-- Kept 48 hours. `results` is a JSON array of {v, ok, ms, e}: the vantage,
-- whether it passed, its latency, and its error.
CREATE TABLE probe_samples (
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  -- The endpoint's state after consensus and hysteresis.
  state TEXT NOT NULL CHECK (state IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'none')),
  -- Vantages that passed, out of those that answered.
  ok INTEGER NOT NULL,
  total INTEGER NOT NULL,
  -- Median latency of the passing vantages.
  latency_ms INTEGER,
  results TEXT NOT NULL CHECK (json_valid(results)),
  PRIMARY KEY (endpoint_id, at)
) WITHOUT ROWID;

-- Kept 90 days. `checks` counts judged rounds (or one vantage's probes),
-- `failures` the down ones and `degraded` the degraded ones. Latency totals
-- and the histogram (see src/domain/histogram.ts) cover passing probes only.
CREATE TABLE probe_hours_next (
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  hour TEXT NOT NULL,
  vantage TEXT NOT NULL,
  checks INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  degraded INTEGER NOT NULL DEFAULT 0,
  latency_sum INTEGER NOT NULL,
  latency_max INTEGER NOT NULL,
  hist TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (endpoint_id, hour, vantage)
) WITHOUT ROWID;
INSERT INTO probe_hours_next (endpoint_id, hour, vantage, checks, failures, latency_sum, latency_max)
  SELECT endpoint_id, hour, 'all', checks, failures, latency_sum, latency_max FROM probe_hours;
DROP TABLE probe_hours;
ALTER TABLE probe_hours_next RENAME TO probe_hours;

-- Kept 400 days, rolled up from the hours.
CREATE TABLE probe_days (
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  vantage TEXT NOT NULL,
  checks INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  degraded INTEGER NOT NULL,
  latency_sum INTEGER NOT NULL,
  latency_max INTEGER NOT NULL,
  hist TEXT NOT NULL,
  PRIMARY KEY (endpoint_id, day, vantage)
) WITHOUT ROWID;

-- Where each vantage last ran, to spot placement drift.
CREATE TABLE vantages (
  code TEXT PRIMARY KEY,
  colo TEXT,
  seen_at TEXT NOT NULL
);
