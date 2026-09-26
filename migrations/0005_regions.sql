-- Regions and the clusters that serve them. Each endpoint is one cluster's
-- health check URL, probed every minute by the Worker's cron trigger.
CREATE TABLE IF NOT EXISTS regions (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  -- Hub position on the 136×80 region map viewBox.
  map_x REAL NOT NULL,
  map_y REAL NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY,
  region_code TEXT NOT NULL REFERENCES regions(code),
  service_id TEXT NOT NULL REFERENCES services(id),
  cluster TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('fly', 'oci', 'cloudflare', 'other')),
  url TEXT NOT NULL,
  -- JSON object of request headers, e.g. {"fly-prefer-region": "gru"}.
  headers TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(headers)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_ok INTEGER CHECK (last_ok IN (0, 1)),
  last_latency_ms INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS endpoints_region_idx ON endpoints(region_code, position);

-- Hourly probe rollups: one row per endpoint and UTC hour, kept 30 days.
CREATE TABLE IF NOT EXISTS probe_hours (
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  hour TEXT NOT NULL,
  checks INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  -- Latency totals cover successful probes only.
  latency_sum INTEGER NOT NULL,
  latency_max INTEGER NOT NULL,
  PRIMARY KEY (endpoint_id, hour)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS probe_hours_hour_idx ON probe_hours(hour);

-- TerraBase cells from ts-infra (regions.tf), positioned like the dashboard map.
INSERT OR IGNORE INTO regions (code, name, country, map_x, map_y, position) VALUES
  ('SFO', 'San Jose', 'United States', 21, 28.58, 1),
  ('GRU', 'São Paulo', 'Brazil', 50, 59.76, 2),
  ('FRA', 'Frankfurt', 'Germany', 71.5, 20.78, 3);

INSERT OR IGNORE INTO endpoints (id, region_code, service_id, cluster, provider, url, headers, position) VALUES
  ('dashboard-fly-gru', 'GRU', 'dashboard', 'gru', 'fly', 'https://dash.terrascale.tech/health/ready', '{"fly-prefer-region":"gru"}', 1);
