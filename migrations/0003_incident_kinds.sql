ALTER TABLE incidents ADD COLUMN kind TEXT NOT NULL DEFAULT 'incident' CHECK (kind IN ('incident', 'warning'));
