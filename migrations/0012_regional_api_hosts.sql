-- Update existing catalog entries as well as the fresh-install seed.
UPDATE endpoints
SET url = 'https://' || lower(region_code) || '.terrascale.tech/api/v1/health'
WHERE component_id = 'data-api'
  AND id IN ('data-api-oci-gru', 'data-api-oci-sfo', 'data-api-oci-fra');
