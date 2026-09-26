-- Deep checks: an expected status, a keyword, JSON assertions and extracted
-- values per endpoint (src/domain/assertions.ts). An indirect endpoint's URL
-- reports on the component instead of serving it, so failing to fetch it
-- leaves the component unknown rather than down.
ALTER TABLE endpoints ADD COLUMN expect_status TEXT NOT NULL DEFAULT '2xx';
ALTER TABLE endpoints ADD COLUMN keyword TEXT;
ALTER TABLE endpoints ADD COLUMN assertions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(assertions));
ALTER TABLE endpoints ADD COLUMN extract TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extract));
ALTER TABLE endpoints ADD COLUMN indirect INTEGER NOT NULL DEFAULT 0 CHECK (indirect IN (0, 1));

-- Values extracted in the round, from the first passing vantage.
ALTER TABLE probe_samples ADD COLUMN "values" TEXT;

-- A new version seen on an endpoint's health check: a deploy marker.
CREATE TABLE deploys (
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  PRIMARY KEY (endpoint_id, detected_at)
) WITHOUT ROWID;

UPDATE endpoints SET keyword = 'TerraScale' WHERE id = 'website-pages';
UPDATE endpoints SET assertions = '[{"path":"regions","op":"exists"}]' WHERE id = 'atlas-workers';
UPDATE endpoints SET assertions = '[{"path":"status","op":"eq","value":"ready"}]',
  extract = '{"version":"version"}' WHERE id = 'auth-edge';
UPDATE endpoints SET assertions = '[{"path":"status","op":"eq","value":"ok"}]',
  extract = '{"version":"version"}' WHERE id = 'dashboard-fly-gru';
UPDATE endpoints SET assertions = '[{"path":"status","op":"eq","value":"pass"}]' WHERE id = 'git-forgejo';

-- TerraBase cells are judged by atlas, whose health document the
-- orchestrator publishes: available, and replication lag once atlas reports it.
UPDATE endpoints SET url = 'https://atlas.terrascale.tech/api/v1/regions', indirect = 1,
  assertions = '[{"path":"regions[code=' || region_code || '].available","op":"eq","value":true}]',
  extract = '{"lag_ms":"regions[code=' || region_code || '].lag_ms"}'
  WHERE component_id = 'data-api';
