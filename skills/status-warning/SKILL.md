# TerraScale status incidents and warnings

Use this repo skill when the human asks to publish, update, or resolve a TerraScale incident or status warning. Incidents are D1 records written by the human through an AI agent; component status itself is measured by the health probes and needs no manual edits.

## Publish a warning or incident

Ask the human for the title and customer-facing message if they have not supplied both. Validate that the message is factual and specific, then insert it directly into the production D1 database with Wrangler. Keep the generated id so it can be resolved later.

```sh
incident_id=$(openssl rand -hex 16)
npm exec -- wrangler d1 execute ts-status-db --remote --command \
  "INSERT INTO incidents (id, kind, title, status, impact, message) VALUES ('$incident_id', 'warning', 'TITLE', 'monitoring', 'minor', 'MESSAGE');"
```

`kind` is `incident` or `warning`; `impact` is `minor` (degraded), `major` (partial outage), or `critical` (major outage), and colors the headline and the daily platform bars while the incident is open.

Timestamps default to SQLite `datetime('now')` (`YYYY-MM-DD HH:MM:SS`, UTC). Never write ISO 8601 text such as `2026-09-26T10:00:00Z`: it sorts differently and breaks every time-window query.

Replace `TITLE` and `MESSAGE` only after shell-quoting them safely; never interpolate untrusted text into SQL. Prefer a temporary SQL file and `--file` for quotes or newlines. Never print or commit credentials. Verify with `GET https://status.terrascale.tech/api/status` after the command.

## Resolve

Only when the human asks to resolve it, update the record directly:

```sh
npm exec -- wrangler d1 execute ts-status-db --remote --command \
  "UPDATE incidents SET status = 'resolved', resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = 'INCIDENT_ID';"
```

Verify the response and the public API. Do not publish speculative incidents, and do not expose a database credential in output.
