# TerraScale status incidents, warnings and maintenance

Use this repo skill when the human asks to publish, update, or resolve a TerraScale incident or status warning, or to schedule maintenance. Records live in D1; component status itself is measured by the health probes and needs no manual edits.

## Model

- `incidents`: `kind` is `incident`, `warning`, or `maintenance`. `impact` is `none`, `minor` (degraded), `major` (partial outage), or `critical` (major outage). Incidents move `investigating` → `identified` → `monitoring` → `resolved`; maintenance is `scheduled` → `in_progress` → `completed`, and follows its `scheduled_start`/`scheduled_end` unless completed early.
- `incident_updates`: the timeline. Every change of status gets an update with a customer-facing `body`; the latest body is what the page shows.
- `incident_components`: the components an incident affects (`dashboard`, `website`, `atlas`, `auth`, `docs`, `data-api`, `sync`, `git`). With none, it concerns the whole platform and colors the headline directly.

The probe coordinator opens incidents on its own (`source = 'auto'`) when a component stays down for a minute or degraded for ten, and resolves them after five healthy minutes. To take one over, set `operator_touched = 1`; the coordinator then leaves it alone. During a maintenance window covering a component, the component shows as under maintenance and no automatic incident opens for it.

## Publish an incident or warning

Ask the human for the title, the customer-facing message, the impact, and the affected components if they have not supplied them. Validate that the message is factual and specific. Write a temporary SQL file (it handles quotes and newlines) and apply it:

```sql
-- incident.sql; replace ID, UPDATE_ID, TITLE, MESSAGE.
INSERT INTO incidents (id, kind, title, status, impact) VALUES ('ID', 'incident', 'TITLE', 'investigating', 'major');
INSERT INTO incident_components (incident_id, component_id) VALUES ('ID', 'dashboard');
INSERT INTO incident_updates (id, incident_id, status, body) VALUES ('UPDATE_ID', 'ID', 'investigating', 'MESSAGE');
```

```sh
npm exec -- wrangler d1 execute ts-status-db --remote --file incident.sql
```

Generate ids with `openssl rand -hex 16`. Use `kind = 'warning'` and `status = 'monitoring'` for an operational warning.

## Post an update or resolve

```sql
UPDATE incidents SET status = 'resolved', resolved_at = datetime('now'), updated_at = datetime('now'),
  operator_touched = 1 WHERE id = 'ID';
INSERT INTO incident_updates (id, incident_id, status, body) VALUES ('UPDATE_ID', 'ID', 'resolved', 'MESSAGE');
```

For an update without resolving, set `status` to `identified` or `monitoring` and leave `resolved_at` null.

## Schedule maintenance

```sql
INSERT INTO incidents (id, kind, title, status, impact, scheduled_start, scheduled_end)
  VALUES ('ID', 'maintenance', 'TITLE', 'scheduled', 'none', '2026-10-01 02:00:00', '2026-10-01 03:00:00');
INSERT INTO incident_components (incident_id, component_id) VALUES ('ID', 'git');
INSERT INTO incident_updates (id, incident_id, status, body) VALUES ('UPDATE_ID', 'ID', 'scheduled', 'MESSAGE');
```

To end it early, set `status = 'completed'` and `resolved_at = datetime('now')`.

## Rules

Timestamps are SQLite datetime text in UTC (`YYYY-MM-DD HH:MM:SS`, as `datetime('now')` writes). Never write ISO 8601 text such as `2026-09-26T10:00:00Z`: it sorts differently and breaks every time-window query.

Never interpolate untrusted text into SQL without quoting it safely; never print or commit credentials. Only resolve an incident when the human asks. Verify every change on `https://status.terrascale.tech/incidents/ID` and `GET /api/status`.
