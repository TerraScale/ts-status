-- Wave 3 probe catalog. Only endpoints answering as expected on 2026-10-01
-- are enabled; the rest are seeded disabled with their final check so the
-- operator API (PATCH /api/operator/endpoints/:id) can launch them as-is.
--
-- Live: the global API router at api.terrascale.tech, probed like GRU with an
-- unauthenticated document read that must answer 401 invalid_key.
-- Pending: auth.terrascale.tech/readyz answers Cloudflare 530 (no origin);
-- sfo.api, fra.api, docs and sync.api.terrascale.tech do not resolve.

-- A canary endpoint is run by the coordinator itself with a scoped key
-- (src/probe/canary.ts), not by the vantages.
ALTER TABLE endpoints ADD COLUMN kind TEXT NOT NULL DEFAULT 'http' CHECK (kind IN ('http', 'canary'));

UPDATE regions SET name = 'São Paulo' WHERE code = 'GRU';
UPDATE regions SET name = 'San Jose' WHERE code = 'SFO';
UPDATE regions SET name = 'Frankfurt' WHERE code = 'FRA';

INSERT INTO components (id, group_id, name, description, lifecycle, position) VALUES
  ('api', 'terrabase', 'API router', 'api.terrascale.tech: routes each request to its region', 'active', 3);

-- SFO and FRA take GRU's direct check, ready for when their cells launch.
UPDATE endpoints SET
  url = 'https://' || lower(region_code) || '.api.terrascale.tech/v1/tenants/018f0000-0000-7000-8000-000000000001/databases/018f0000-0000-7000-8000-000000000002/shards/0/collections/018f0000-0000-7000-8000-000000000003/documents/018f0000-0000-7000-8000-000000000004',
  headers = '{}',
  enabled = 0,
  expect_status = '401',
  keyword = NULL,
  assertions = '[{"path":"error.code","op":"eq","value":"invalid_key"}]',
  extract = '{}',
  indirect = 0
WHERE id IN ('data-api-oci-sfo', 'data-api-oci-fra');

INSERT INTO endpoints (id, component_id, region_code, cluster, provider, url, headers, enabled, position,
    expect_status, keyword, assertions, extract, indirect, kind) VALUES
  ('api-workers', 'api', NULL, 'workers', 'cloudflare',
    'https://api.terrascale.tech/v1/tenants/018f0000-0000-7000-8000-000000000001/databases/018f0000-0000-7000-8000-000000000002/shards/0/collections/018f0000-0000-7000-8000-000000000003/documents/018f0000-0000-7000-8000-000000000004',
    '{}', 1, 1, '401', NULL, '[{"path":"error.code","op":"eq","value":"invalid_key"}]', '{}', 0, 'http'),
  ('docs-pages', 'docs', NULL, 'pages', 'cloudflare', 'https://docs.terrascale.tech/',
    '{}', 0, 1, '2xx', NULL, '[]', '{}', 0, 'http'),
  -- The sync service's health route is not published yet; confirm it before enabling.
  ('sync-edge', 'sync', NULL, 'workers', 'cloudflare', 'https://sync.api.terrascale.tech/',
    '{}', 0, 1, '2xx', NULL, '[]', '{}', 0, 'http'),
  -- Writes then reads a canary document in GRU. Runs only once enabled and
  -- the DATA_API_CANARY secret holds its scoped key and document.
  ('data-api-canary-gru', 'data-api', 'GRU', 'sa-saopaulo-1', 'oci', 'https://gru.api.terrascale.tech',
    '{}', 0, 4, '2xx', NULL, '[]', '{}', 0, 'canary');
