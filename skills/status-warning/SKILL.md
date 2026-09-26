# TerraScale status incidents, warnings and maintenance

Use this repo skill when the human asks to publish, update, or resolve a TerraScale incident or status warning, or to schedule maintenance. Use the operator API; component status itself is measured by the health probes and needs no manual edits.

## Model

- `kind` is `incident`, `warning`, or `maintenance`. `impact` is `none`, `minor` (degraded), `major` (partial outage), or `critical` (major outage).
- Incidents move `investigating` → `identified` → `monitoring` → `resolved`; maintenance is `scheduled` → `in_progress` → `completed` and follows its schedule unless completed early.
- Every change of status is an update with a customer-facing `message`; the page shows the latest.
- `components` lists the affected component ids (`dashboard`, `website`, `atlas`, `auth`, `docs`, `data-api`, `sync`, `git`). With none, the incident concerns the whole platform and colors the headline directly.

The probe coordinator opens incidents on its own when a component stays down for a minute or degraded for ten, and resolves them after five healthy minutes. Any operator edit through the API takes an automatic incident over, and the coordinator then leaves it alone. During maintenance covering a component, no automatic incident opens for it.

## Calling the API

The token is the Worker secret `OPERATOR_TOKEN`; the human keeps it in `TS_STATUS_OPERATOR_TOKEN`. Never print it, pass it on a command line that gets logged, or commit it. Send JSON from a file so quotes and newlines survive:

```sh
api() { curl -fsS -X "$1" "https://status.terrascale.tech/api/operator$2" \
  -H "authorization: Bearer $TS_STATUS_OPERATOR_TOKEN" -H 'content-type: application/json' ${3:+--data @"$3"}; }
```

## Publish

Ask the human for the title, the customer-facing message, the impact, and the affected components if they have not supplied them. Validate that the message is factual and specific.

```sh
cat > incident.json <<'JSON'
{ "kind": "incident", "title": "Dashboard sign-in errors", "impact": "major",
  "components": ["dashboard"], "message": "Some sign-ins fail with an error. We are investigating." }
JSON
api POST /incidents incident.json   # → {"id": "…", "url": "/incidents/…"}
```

Use `"kind": "warning"` for an operational warning (it starts in `monitoring`).

## Update or resolve

Only resolve when the human asks.

```sh
echo '{ "status": "resolved", "message": "Sign-ins work again." }' > update.json
api POST /incidents/ID/updates update.json
```

An update may also change `impact`. `PATCH /incidents/ID` edits `title`, `impact`, `components`, or a maintenance window's `scheduledStart` and `scheduledEnd`; `DELETE /incidents/ID` removes a record published by mistake.

## Schedule maintenance

```sh
cat > maintenance.json <<'JSON'
{ "kind": "maintenance", "title": "Forgejo upgrade", "components": ["git"],
  "scheduledStart": "2026-10-01T02:00:00Z", "scheduledEnd": "2026-10-01T03:00:00Z",
  "message": "Git and CI will be unavailable for up to an hour." }
JSON
api POST /incidents maintenance.json
```

End it early with an update of status `completed`.

Verify every change on `https://status.terrascale.tech/incidents/ID`. Do not publish speculative incidents.
