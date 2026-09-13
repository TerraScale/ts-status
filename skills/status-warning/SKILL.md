# TerraScale status warnings

Use this repo skill when the human asks to publish, update, or resolve a TerraScale status warning. Warnings are operator changes and must be made only by the human or an explicitly delegated AI agent through the authenticated status API. Do not add a warning form, public write route, client-side token, or scheduled automatic warning source.

## Publish a warning

Set `STATUS_ADMIN_TOKEN` in the invoking environment and run:

```sh
curl --fail-with-body -X POST https://ts-status.mariogk01-6cd.workers.dev/api/status \
  -H "Authorization: Bearer $STATUS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"warning","title":"Short title","message":"What customers should know."}'
```

The warning is stored in D1 as a minor-impact monitoring event and is visible in Active incidents. Never print or commit the token.

## Resolve a warning

Use the returned incident id:

```sh
curl --fail-with-body -X POST https://ts-status.mariogk01-6cd.workers.dev/api/status \
  -H "Authorization: Bearer $STATUS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"resolve","id":"INCIDENT_ID"}'
```

Always verify the response and fetch `GET /api/status` after a change. Do not publish speculative warnings; the human must provide the message and authorize the action.
