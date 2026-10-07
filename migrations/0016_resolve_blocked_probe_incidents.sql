-- TS-580: the vantage Workers' requests to dash and git.terrascale.tech are
-- refused with HTTP 403 by Cloudflare before they reach Fly or Forgejo,
-- while both services answer 200 to everyone else. The two automatic
-- incidents opened from those refusals since 2026-10-01 were never outages.
--
-- blocked_status names the status an endpoint's probe is known to be
-- refused with: it is a probe error ("Probe blocked"), neither healthy nor
-- an outage. Only these two endpoints get it; any other unexpected 403 still
-- fails. Remove it once the vantages are let through.
ALTER TABLE endpoints ADD COLUMN blocked_status INTEGER CHECK (blocked_status BETWEEN 100 AND 599);
UPDATE endpoints SET blocked_status = 403 WHERE id IN ('dashboard-fly-gru', 'git-forgejo');

-- A blocked probe can neither open nor close an incident, so resolve the two
-- false incidents here, with no impact. Marking them operator-touched keeps
-- the coordinator from updating them again. Being operator-touched, the
-- resolving update is delivered at once by the outbox: subscribers who were
-- told of these outages are told they were not real, as intended.
INSERT INTO incident_updates (id, incident_id, status, body, created_at)
  SELECT 'ts-580-' || id, id, 'resolved',
    'This was not an outage: our health checks were refused (HTTP 403) before reaching the service, which stayed available throughout. We have fixed how such checks are counted.',
    datetime('now')
  FROM incidents
  WHERE id IN ('b450c3c0-4427-41e4-b620-0ba7d93dfdb8', '16c62d53-3f6c-48b3-8bec-a6671c61a3d8')
    AND status NOT IN ('resolved', 'completed');

UPDATE incidents SET status = 'resolved', impact = 'none', resolved_at = datetime('now'), updated_at = datetime('now'),
    auto_key = NULL, operator_touched = 1
  WHERE id IN ('b450c3c0-4427-41e4-b620-0ba7d93dfdb8', '16c62d53-3f6c-48b3-8bec-a6671c61a3d8')
    AND status NOT IN ('resolved', 'completed');
