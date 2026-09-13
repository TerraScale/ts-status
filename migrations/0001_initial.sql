CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance')) DEFAULT 'operational',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  impact TEXT NOT NULL CHECK (impact IN ('minor', 'major', 'critical')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS incidents_created_at_idx ON incidents(created_at DESC);
INSERT OR IGNORE INTO services (id, name, description) VALUES
  ('api', 'API', 'Core API and data operations'),
  ('dashboard', 'Dashboard', 'TerraScale customer dashboard'),
  ('proxy', 'Proxy', 'Secure database proxy connections'),
  ('billing', 'Billing', 'Plans, usage and payments');
