# ts-status

TerraScale's public status page at <https://status.terrascale.tech>: a TypeScript Cloudflare Worker that renders HTML at the edge from Cloudflare D1. It uses the ts-dashboard design system (`../ts-dashboard/DESIGN_SYSTEM.md`): the same tokens, Oxanium type, and flat hairline components.

## How it is fast

- **No framework on the client.** Pages are server-rendered strings with the stylesheet, logo, and region map inlined; one small inline script (allowed by its CSP hash) localizes times and refreshes the page. A visit is one HTML request plus one preloaded 14 KB font.
- **One D1 round trip per render.** Every query for a page runs in a single batch on a read-replica session (`withSession("first-unconstrained")`).
- **Edge cache.** Pages and the API are cached per URL for 10 seconds (`caches.default`), so load during an incident is bounded no matter how many people are watching.
- **In-place refresh.** Open status pages fetch only their `<main>` (`/?fragment=main`) every 30 seconds while the tab is visible.

## Layout

| Path              | Purpose                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `src/worker.ts`   | Routing, edge cache, security headers, cron entry point           |
| `src/data.ts`     | D1 queries                                                        |
| `src/status.ts`   | Status domain: states, timelines, uptime, probe and region states |
| `src/overview.ts` | The overview shared by the page and the JSON API                  |
| `src/probe.ts`    | Minute-by-minute health probes of every cluster                   |
| `src/views/`      | HTML views and the client script                                  |
| `src/styles/`     | Design tokens and styles, bundled and minified by Lightning CSS   |

## Local development

```sh
npm ci
npm run db:migrate:local
npm run dev
```

The dev server listens on every interface (reachable over the tailnet) and reloads on change. The local D1 database lives under `.wrangler/state`. Trigger a probe run with `curl 'http://localhost:5173/cdn-cgi/handler/scheduled'`.

## API

`GET /api/status` returns the overall status, services with 24 hourly states and uptime, regions with their clusters' ping, uptime and hourly states, and current incidents. The Worker has no write endpoint: operators change D1 directly with the repo skills — [`status-warning`](skills/status-warning/SKILL.md) for incidents and warnings, [`status-endpoint`](skills/status-endpoint/SKILL.md) for regions and clusters.

## Deploy

The production D1 database is `ts-status-db` (`8a72dd69-2136-4398-8d70-92c0c2dade5a`). Build, apply migrations, and deploy with:

```sh
npm run deploy
```

For global read latency, enable D1 read replication on `ts-status-db`; the Worker already reads through sessions.
