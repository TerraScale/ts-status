-- Forward-only catalog correction for the C# contracts. Keep endpoint ids
-- and history; retired tenant/shard and dashboard routes are never probed.
ALTER TABLE endpoints ADD COLUMN pending_status INTEGER CHECK (pending_status BETWEEN 100 AND 599);

UPDATE endpoints SET
  url = 'https://' || CASE WHEN id = 'api-workers' THEN 'api' ELSE lower(region_code) || '.api' END || '.terrascale.tech/v1/projects/018f0000-0000-7000-8000-000000000001/databases/status_canary/collections/canary/documents/018f0000-0000-7000-8000-000000000004',
  headers = '{}', expect_status = '401', keyword = NULL,
  assertions = '[{"path":"error.code","op":"eq","value":"invalid_key"}]',
  extract = '{}', indirect = 0
WHERE id IN ('api-workers', 'data-api-oci-gru', 'data-api-oci-sfo', 'data-api-oci-fra');

UPDATE endpoints SET url = '/readyz' WHERE probe = 'health';
UPDATE endpoints SET url = '/v1/projects/{project}/databases/{database}/collections/{collection}'
WHERE probe = 'documents';
UPDATE endpoints SET url = '/v1/management/organizations/{organization}/projects'
WHERE probe = 'management';
UPDATE components SET description = 'Projects and databases listed through the C# management API'
WHERE id = 'management-api';

-- Atlas normalizes admitted region codes to uppercase, including gru-1.
UPDATE endpoints SET expect_status = '200',
  assertions = '[{"path":"regions[code=GRU-1].available","op":"eq","value":true},{"path":"hosts.GRU-1","op":"exists"}]',
  extract = '{"lag_ms":"regions[code=GRU-1].lag_ms"}'
WHERE id = 'atlas-workers';
UPDATE regions SET ping_url = 'https://gru.api.terrascale.tech/healthz'
WHERE code = 'GRU';

-- The deployed dashboard still serves dash, with status=ok and version.
UPDATE endpoints SET url = 'https://dash.terrascale.tech/health/ready', expect_status = '200',
  assertions = '[{"path":"status","op":"eq","value":"ok"}]', extract = '{"version":"version"}'
WHERE id = 'dashboard-fly-gru';

UPDATE components SET lifecycle = 'active',
  description = 'Sign-in, accounts and API keys; OIDC discovery pending (404)'
WHERE id = 'auth';
UPDATE endpoints SET url = 'https://auth.terrascale.tech/readyz', enabled = 1, expect_status = '200',
  assertions = '[{"path":"status","op":"eq","value":"ready"}]', extract = '{"version":"version"}'
WHERE id = 'auth-edge';

-- OIDC is not implemented in ts-auth yet. A 404 is unknown, not healthy or
-- an outage; a 200 must satisfy the OIDC contract. Other failures affect auth.
INSERT INTO endpoints (id, component_id, cluster, provider, url, enabled, position, expect_status, pending_status, assertions) VALUES
  ('auth-oidc-edge', 'auth', 'workers', 'cloudflare',
    'https://auth.terrascale.tech/.well-known/openid-configuration', 1, 2, '200', 404,
    '[{"path":"issuer","op":"eq","value":"https://auth.terrascale.tech"},{"path":"jwks_uri","op":"exists"}]');
