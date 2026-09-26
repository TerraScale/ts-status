-- Incidents with a timeline of updates and the components they affect,
-- opened by operators or automatically by the probe coordinator, plus
-- scheduled maintenance windows. The first update of every existing
-- incident is its old message.
CREATE TABLE incident_messages AS SELECT id, status, message, created_at FROM incidents;

CREATE TABLE incidents_next (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'incident' CHECK (kind IN ('incident', 'warning', 'maintenance')),
  title TEXT NOT NULL,
  -- Incidents move investigating → identified → monitoring → resolved;
  -- maintenance is scheduled → in_progress → completed.
  status TEXT NOT NULL CHECK (status IN
    ('investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed')),
  impact TEXT NOT NULL CHECK (impact IN ('none', 'minor', 'major', 'critical')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  -- The component an automatic incident tracks, while it is open.
  auto_key TEXT,
  -- Set once an operator edits an automatic incident; the coordinator then
  -- leaves it alone.
  operator_touched INTEGER NOT NULL DEFAULT 0 CHECK (operator_touched IN (0, 1)),
  scheduled_start TEXT,
  scheduled_end TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  CHECK (kind != 'maintenance' OR (scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL))
);
INSERT INTO incidents_next (id, kind, title, status, impact, created_at, updated_at, resolved_at)
  SELECT id, kind, title, status, impact, created_at, updated_at, resolved_at FROM incidents;
DROP TABLE incidents;
ALTER TABLE incidents_next RENAME TO incidents;
CREATE INDEX incidents_created_at_idx ON incidents(created_at DESC);
CREATE INDEX incidents_status_idx ON incidents(status, resolved_at);
CREATE INDEX incidents_maintenance_idx ON incidents(kind, scheduled_end);
CREATE UNIQUE INDEX incidents_auto_open_idx ON incidents(auto_key)
  WHERE auto_key IS NOT NULL AND status NOT IN ('resolved', 'completed');

CREATE TABLE incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX incident_updates_incident_idx ON incident_updates(incident_id, created_at);
INSERT INTO incident_updates (id, incident_id, status, body, created_at)
  SELECT 'first-' || id, id, status, message, created_at FROM incident_messages;
DROP TABLE incident_messages;

CREATE TABLE incident_components (
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  PRIMARY KEY (incident_id, component_id)
) WITHOUT ROWID;
CREATE INDEX incident_components_component_idx ON incident_components(component_id);
