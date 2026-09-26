-- A URL per region that visitors' browsers can time requests to from the
-- ping page. Until a region's TerraBase cell serves its own, GRU is timed
-- through the dashboard's Fly.io Machines there.
ALTER TABLE regions ADD COLUMN ping_url TEXT;
ALTER TABLE regions ADD COLUMN ping_label TEXT;
UPDATE regions SET ping_url = 'https://dash.terrascale.tech/health/live', ping_label = 'dashboard on Fly.io gru'
  WHERE code = 'GRU';
