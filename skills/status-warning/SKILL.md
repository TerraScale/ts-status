# TerraScale status warnings

Use this repo skill when the human asks Codex to publish or resolve a TerraScale status warning. Warnings are database records managed only by the human through Codex or an explicitly delegated AI agent. The Worker has no warning write endpoint: never add one, call `POST /api/status`, or put a token in a client.

## Publish a warning

Ask the human for the warning title and customer-facing message if they have not supplied both. Validate that the message is factual and specific, then insert it directly into the production D1 database with Wrangler. Keep the generated id so it can be resolved later.

```sh
warning_id=$(openssl rand -hex 16)
npm exec -- wrangler d1 execute ts-status-db --remote --command \
  "INSERT INTO incidents (id, kind, title, status, impact, message) VALUES ('$warning_id', 'warning', 'TITLE', 'monitoring', 'minor', 'MESSAGE'); INSERT INTO status_events (id, service_id, status, label) VALUES ('$(openssl rand -hex 16)', NULL, 'degraded', 'TITLE');"
```

Timestamps default to SQLite `datetime('now')` (`YYYY-MM-DD HH:MM:SS`, UTC). Never write ISO 8601 text such as `2026-09-26T10:00:00Z`: it sorts differently and breaks every time-window query. Set `service_id` to a service id (`api`, `dashboard`, `proxy`, `billing`) instead of `NULL` when the warning affects one service, so its bars show it.

Replace `TITLE` and `MESSAGE` only after shell-quoting them safely; never interpolate untrusted text into SQL. Prefer a temporary SQL file and `--file` for quotes or newlines. Never print or commit credentials. Verify with `GET https://status.terrascale.tech/api/status` after the command.

## Resolve a warning

Only when the human asks to resolve it, update the record directly:

```sh
npm exec -- wrangler d1 execute ts-status-db --remote --command \
  "UPDATE incidents SET status = 'resolved', resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = 'INCIDENT_ID'; INSERT INTO status_events (id, service_id, status, label) VALUES ('EVENT_ID', NULL, 'operational', 'Incident resolved');"
```

Verify the response and the public API. Do not publish speculative warnings, and do not expose a database credential in output.
