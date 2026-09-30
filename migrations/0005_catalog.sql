-- The real catalog: regions, component groups, the components customers use,
-- and the endpoints whose health checks measure them. Status is measured
-- now, so the hand-edited services and their status events are gone.
DROP TABLE IF EXISTS status_events;
DROP TABLE IF EXISTS services;

CREATE TABLE regions (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  -- Hub position on the 136×80 region map viewBox.
  map_x REAL NOT NULL,
  map_y REAL NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE component_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

-- Planned components are listed without being measured.
CREATE TABLE components (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES component_groups(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'planned')),
  position INTEGER NOT NULL DEFAULT 0
);

-- One health check per cluster serving a component. Regional clusters name
-- their region; global ones (edge Workers, Pages) leave it null.
CREATE TABLE endpoints (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES components(id),
  region_code TEXT REFERENCES regions(code),
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
CREATE INDEX endpoints_component_idx ON endpoints(component_id, position);
CREATE INDEX endpoints_region_idx ON endpoints(region_code, position);

-- Hourly probe rollups: one row per endpoint and UTC hour.
CREATE TABLE probe_hours (
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  hour TEXT NOT NULL,
  checks INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  -- Latency totals cover successful probes only.
  latency_sum INTEGER NOT NULL,
  latency_max INTEGER NOT NULL,
  PRIMARY KEY (endpoint_id, hour)
) WITHOUT ROWID;
CREATE INDEX probe_hours_hour_idx ON probe_hours(hour);

-- TerraBase cells from ts-infra (regions.tf), positioned like the dashboard map.
INSERT INTO regions (code, name, country, map_x, map_y, position) VALUES
  ('SFO', 'San Jose', 'United States', 21, 28.58, 1),
  ('GRU', 'São Paulo', 'Brazil', 50, 59.76, 2),
  ('FRA', 'Frankfurt', 'Germany', 71.5, 20.78, 3);

INSERT INTO component_groups (id, name, position) VALUES
  ('platform', 'TerraScale platform', 1),
  ('terrabase', 'TerraBase', 2),
  ('developer', 'Developer tools', 3);

INSERT INTO components (id, group_id, name, description, lifecycle, position) VALUES
  ('dashboard', 'platform', 'Dashboard', 'Customer dashboard at dash.terrascale.tech', 'active', 1),
  ('website', 'platform', 'Website', 'terrascale.tech', 'active', 2),
  ('atlas', 'platform', 'Region discovery', 'Atlas: the region catalog SDKs route with', 'active', 3),
  ('auth', 'platform', 'Authentication', 'Sign-in, accounts and API keys', 'planned', 4),
  ('docs', 'platform', 'Documentation', 'docs.terrascale.tech', 'planned', 5),
  ('data-api', 'terrabase', 'Data API', 'Document reads, writes and transactions', 'planned', 1),
  ('sync', 'terrabase', 'Sync', 'Reactive sync for live queries', 'planned', 2),
  ('git', 'developer', 'Git and CI', 'Forgejo at git.terrascale.tech', 'active', 1);

-- Endpoints of planned components stay disabled until they launch.
-- The data-api seeds match their final Atlas health URL. Migration 0007 adds
-- indirect checks and per-region assertions; it already gives deployed databases
-- this same URL, so normalizing this seed requires no forward migration.
INSERT INTO endpoints (id, component_id, region_code, cluster, provider, url, headers, enabled, position) VALUES
  ('dashboard-fly-gru', 'dashboard', 'GRU', 'gru', 'fly', 'https://dash.terrascale.tech/health/ready', '{"fly-prefer-region":"gru"}', 1, 1),
  ('website-pages', 'website', NULL, 'pages', 'cloudflare', 'https://terrascale.tech/', '{}', 1, 1),
  ('atlas-workers', 'atlas', NULL, 'workers', 'cloudflare', 'https://atlas.terrascale.tech/api/v1/regions', '{}', 1, 1),
  ('auth-edge', 'auth', NULL, 'workers', 'cloudflare', 'https://auth.terrascale.tech/readyz', '{}', 0, 1),
  ('data-api-oci-sfo', 'data-api', 'SFO', 'us-sanjose-1', 'oci', 'https://atlas.terrascale.tech/api/v1/regions', '{}', 0, 1),
  ('data-api-oci-gru', 'data-api', 'GRU', 'sa-saopaulo-1', 'oci', 'https://atlas.terrascale.tech/api/v1/regions', '{}', 0, 2),
  ('data-api-oci-fra', 'data-api', 'FRA', 'eu-frankfurt-1', 'oci', 'https://atlas.terrascale.tech/api/v1/regions', '{}', 0, 3),
  ('git-forgejo', 'git', NULL, 'forgejo', 'other', 'https://git.terrascale.tech/api/healthz', '{}', 1, 1);
