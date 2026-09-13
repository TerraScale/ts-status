CREATE TABLE IF NOT EXISTS status_events (
  id TEXT PRIMARY KEY,
  service_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance')),
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS status_events_created_at_idx ON status_events(created_at DESC);
INSERT INTO status_events (id, service_id, status, label)
SELECT 'seed-' || id, id, status, name || ' initialized'
FROM services
WHERE NOT EXISTS (SELECT 1 FROM status_events);
