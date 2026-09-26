-- Rows written with ISO 8601 text ("…T…Z") sort after SQLite datetime text on
-- the same day, which broke every time-window query. Store one format only.
UPDATE services SET updated_at = datetime(updated_at)
  WHERE updated_at IS NOT datetime(updated_at) AND datetime(updated_at) IS NOT NULL;
UPDATE incidents SET created_at = datetime(created_at)
  WHERE created_at IS NOT datetime(created_at) AND datetime(created_at) IS NOT NULL;
UPDATE incidents SET updated_at = datetime(updated_at)
  WHERE updated_at IS NOT datetime(updated_at) AND datetime(updated_at) IS NOT NULL;
UPDATE incidents SET resolved_at = datetime(resolved_at)
  WHERE resolved_at IS NOT datetime(resolved_at) AND datetime(resolved_at) IS NOT NULL;
UPDATE status_events SET created_at = datetime(created_at)
  WHERE created_at IS NOT datetime(created_at) AND datetime(created_at) IS NOT NULL;

-- Serves the per-timeline "last event before the window" lookup.
CREATE INDEX IF NOT EXISTS status_events_timeline_idx ON status_events(service_id, created_at);
CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents(status, resolved_at);
