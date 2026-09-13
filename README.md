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

`GET /api/status` returns current services, incidents, and the 30-day event timeline. The Worker intentionally has no public write endpoint. Warnings and incident changes are inserted directly into D1 by Codex using [`skills/status-warning/SKILL.md`](skills/status-warning/SKILL.md).


## Deploy

The production D1 database is `ts-status-db` (`8a72dd69-2136-4398-8d70-92c0c2dade5a`). Apply migrations and deploy with:

```sh
npm run deploy
```

Set the operator credential with `wrangler secret put STATUS_ADMIN_TOKEN` before deploying. The current Workers URL is <https://ts-status.mariogk01-6cd.workers.dev>; `status.terrascale.tech` can be routed to this Worker when DNS is provisioned.
