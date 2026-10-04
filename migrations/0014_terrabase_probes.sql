-- TerraBase health, document API and management API, each probed by the
-- coordinator (src/probe/terrabase.ts) against the v1 contract. Origins and
-- keys come from the TERRABASE_PROBES secret, keyed by endpoint id; `url`
-- holds only the route probed. Until the secret names an endpoint it shows
-- as not configured, never down, so GRU's are enabled now. SFO and FRA have
-- not launched.
ALTER TABLE endpoints ADD COLUMN probe TEXT CHECK (probe IN ('health', 'documents', 'management'));

INSERT INTO components (id, group_id, name, description, lifecycle, position) VALUES
  ('terrabase-health', 'terrabase', 'TerraBase health', 'Readiness of the TerraBase servers', 'active', 4),
  ('document-api', 'terrabase', 'Document API', 'A canary document created, read, queried and deleted', 'active', 5),
  ('management-api', 'terrabase', 'Management API', 'Tenants and databases listed through the control plane', 'active', 6);

INSERT INTO endpoints (id, component_id, region_code, cluster, provider, url, headers, enabled, position,
    expect_status, keyword, assertions, extract, indirect, kind, probe) VALUES
  ('terrabase-health-gru', 'terrabase-health', 'GRU', 'sa-saopaulo-1', 'oci', '/v1/readyz',
    '{}', 1, 1, '2xx', NULL, '[]', '{}', 0, 'canary', 'health'),
  ('terrabase-health-sfo', 'terrabase-health', 'SFO', 'us-sanjose-1', 'oci', '/v1/readyz',
    '{}', 0, 2, '2xx', NULL, '[]', '{}', 0, 'canary', 'health'),
  ('terrabase-health-fra', 'terrabase-health', 'FRA', 'eu-frankfurt-1', 'oci', '/v1/readyz',
    '{}', 0, 3, '2xx', NULL, '[]', '{}', 0, 'canary', 'health'),
  ('document-api-gru', 'document-api', 'GRU', 'sa-saopaulo-1', 'oci', '/v1/databases/{database}/collections/{collection}',
    '{}', 1, 1, '2xx', NULL, '[]', '{}', 0, 'canary', 'documents'),
  ('document-api-sfo', 'document-api', 'SFO', 'us-sanjose-1', 'oci', '/v1/databases/{database}/collections/{collection}',
    '{}', 0, 2, '2xx', NULL, '[]', '{}', 0, 'canary', 'documents'),
  ('document-api-fra', 'document-api', 'FRA', 'eu-frankfurt-1', 'oci', '/v1/databases/{database}/collections/{collection}',
    '{}', 0, 3, '2xx', NULL, '[]', '{}', 0, 'canary', 'documents'),
  ('management-api-gru', 'management-api', 'GRU', 'sa-saopaulo-1', 'oci', '/v1/dashboard',
    '{}', 1, 1, '2xx', NULL, '[]', '{}', 0, 'canary', 'management'),
  ('management-api-sfo', 'management-api', 'SFO', 'us-sanjose-1', 'oci', '/v1/dashboard',
    '{}', 0, 2, '2xx', NULL, '[]', '{}', 0, 'canary', 'management'),
  ('management-api-fra', 'management-api', 'FRA', 'eu-frankfurt-1', 'oci', '/v1/dashboard',
    '{}', 0, 3, '2xx', NULL, '[]', '{}', 0, 'canary', 'management');
