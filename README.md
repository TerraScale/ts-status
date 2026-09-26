# ts-status

TerraScale's public status page at <https://status.terrascale.tech>: a TypeScript Cloudflare Worker that renders HTML at the edge from Cloudflare D1. It uses the ts-dashboard design system (`../ts-dashboard/DESIGN_SYSTEM.md`): the same tokens, Oxanium type, and flat hairline components.

## How it is fast

- **No framework on the client.** Pages are server-rendered strings with the stylesheet, logo, and region map inlined; one small inline script (allowed by its CSP hash) localizes times and refreshes the page. A visit is one HTML request plus one preloaded 14 KB font.
- **One D1 round trip per render.** Every query for a page runs in a single batch on a read-replica session (`withSession("first-unconstrained")`).
- **Edge cache.** Pages and the API are cached per URL for 10 seconds (`caches.default`), so load during an incident is bounded no matter how many people are watching.
- **In-place refresh.** Open status pages fetch only their `<main>` (`/?fragment=main`) every 30 seconds while the tab is visible.

## How it measures

- **Four vantage points.** Small Workers placed near `aws:us-west-1`, `aws:sa-east-1`, `aws:eu-central-1` and `aws:ap-northeast-1` probe every endpoint; each reports the data center it ran in.
- **30-second rounds.** A single coordinator Durable Object, next to the D1 primary, runs a round on every half minute through the vantages' service bindings and stores one sample per endpoint.
- **Consensus.** A round needs two answering vantages; an endpoint is down only when most of them fail, degraded when some do or it is slower than 1.5 s, and shown down only after two down rounds in a row. A vantage that does not answer is left out, never counted as a failure.
- **Rollups.** The minute cron rebuilds hourly rollups (per vantage and for the consensus, with latency histograms) from the samples and daily rollups from the hours. Samples are kept 48 hours, hours 90 days and days 400 days.

## Layout

| Path              | Purpose                                                         |
| ----------------- | --------------------------------------------------------------- |
| `src/worker.ts`   | Worker entry: re-exports the handler                            |
| `src/app.ts`      | Routes, edge cache, cron entry point                            |
| `src/router.ts`   | `/incidents/:id`-style path patterns                            |
| `src/http/`       | Cache keys, content security policy, security headers           |
| `src/db/`         | D1 queries                                                      |
| `src/domain/`     | Status domain: states, catalog, incidents, probe maths          |
| `src/overview.ts` | The overview shared by the page and the JSON API                |
| `src/probe.ts`    | Minute-by-minute health probes of every endpoint                |
| `src/views/`      | HTML views and the client script                                |
| `src/styles/`     | Design tokens and styles, bundled and minified by Lightning CSS |

## Catalog

Status is measured, never hand-edited. Components (the dashboard, website, region discovery, authentication, the TerraBase Data API, …) sit in display groups; each is checked by one endpoint per cluster, regional or global. Planned components are listed without being measured until they launch. The [`status-endpoint`](skills/status-endpoint/SKILL.md) skill manages the catalog.

## Local development

```sh
npm ci
npm run db:migrate:local
npm run dev
```

The dev server listens on every interface (reachable over the tailnet) and reloads on change. The local D1 database lives under `.wrangler/state`. The four vantage Workers run alongside the status Worker. Arm the coordinator (and roll up samples) with `curl 'http://localhost:5173/cdn-cgi/handler/scheduled'`; rounds then run every 30 seconds.

## API

`GET /api/status` returns the overall status, component groups with each component's 24 hourly states and uptime, regions with their clusters' ping, uptime and hourly states, and current incidents. Operators publish incidents with the [`status-warning`](skills/status-warning/SKILL.md) skill.

## Deploy

The production D1 database is `ts-status-db` (`8a72dd69-2136-4398-8d70-92c0c2dade5a`). Build, apply migrations, deploy the four vantage Workers, then the status Worker with:

```sh
npm run deploy
```

For global read latency, enable D1 read replication on `ts-status-db`; the Worker already reads through sessions.
