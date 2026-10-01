-- GRU now serves the public TerraBase Client HTTP API. Probe its document
-- handler directly: a request without credentials must return invalid_key.
-- The readiness routes belong to the loopback admin listener, and Atlas's
-- metadata freshness must not decide whether the public API is reachable.
UPDATE components SET lifecycle = 'active' WHERE id = 'data-api';

UPDATE endpoints SET
  url = 'https://gru.api.terrascale.tech/v1/tenants/018f0000-0000-7000-8000-000000000001/databases/018f0000-0000-7000-8000-000000000002/shards/0/collections/018f0000-0000-7000-8000-000000000003/documents/018f0000-0000-7000-8000-000000000004',
  headers = '{}',
  enabled = 1,
  expect_status = '401',
  keyword = NULL,
  assertions = '[{"path":"error.code","op":"eq","value":"invalid_key"}]',
  extract = '{}',
  indirect = 0
WHERE id = 'data-api-oci-gru';

-- The other regions have not launched.
UPDATE endpoints SET enabled = 0
WHERE component_id = 'data-api' AND region_code <> 'GRU';

UPDATE regions SET
  ping_url = 'https://gru.api.terrascale.tech/openapi.json',
  ping_label = 'TerraBase API on OCI sa-saopaulo-1'
WHERE code = 'GRU';
