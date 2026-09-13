# ts-status

TerraScale's public service status page. It is a Vinext App Router application deployed to Cloudflare Workers with Cloudflare D1 as its source of truth.

## Local development

```sh
npm ci
npm run db:migrate:local
npm run dev
```

The local D1 database is stored under `.wrangler/state`. Set `STATUS_ADMIN_TOKEN` in `.dev.vars` to exercise write operations locally.

## API

`GET /api/status` returns current service statuses and the latest incidents. `POST /api/status` is an operator endpoint. Use `action: "warning"` with a title and message to publish an operator warning, or `action: "resolve"` with an incident id to resolve it. The page refreshes while visible every two minutes and includes a 24-hour event timeline. Send `Authorization: Bearer <STATUS_ADMIN_TOKEN>` and one of:

```json
{"action":"service","id":"api","status":"degraded"}
{"action":"incident","title":"API latency","message":"Requests are slower than usual.","impact":"minor","status":"investigating"}
```

Accepted service states are `operational`, `degraded`, `partial_outage`, `major_outage`, and `maintenance`. Incidents use `investigating`, `identified`, `monitoring`, or `resolved`.

## Deploy

The production D1 database is `ts-status-db` (`8a72dd69-2136-4398-8d70-92c0c2dade5a`). Apply migrations and deploy with:

```sh
npm run deploy
```

Set the operator credential with `wrangler secret put STATUS_ADMIN_TOKEN` before deploying. The current Workers URL is <https://ts-status.mariogk01-6cd.workers.dev>; `status.terrascale.tech` can be routed to this Worker when DNS is provisioned.
