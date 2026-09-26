# ts-status

TerraScale's public status page at <https://status.terrascale.tech>: a TypeScript Cloudflare Worker that renders HTML at the edge from Cloudflare D1. It uses the ts-dashboard design system (`../ts-dashboard/DESIGN_SYSTEM.md`): the same tokens, Oxanium type, and flat hairline components.

## How it is fast

- **No framework on the client.** Pages are server-rendered strings with the stylesheet, logo, and region map inlined; one small inline script (allowed by its CSP hash) localizes times and refreshes the page. A visit is one HTML request plus one preloaded 14 KB font.
- **One D1 round trip per render.** Every query for a page runs in a single batch on a read-replica session (`withSession("first-unconstrained")`).
- **Edge cache.** Pages and the API are cached per URL for 10 seconds (`caches.default`), so load during an incident is bounded no matter how many people are watching.
- **Details on demand.** Every bar, map hub, vantage and probe path carries its details (time range, state, uptime, checks, median and p95 latency, overlapping incidents) in a `data-card` attribute; the inline script shows them in one hover card on hover, keyboard focus (arrow keys move along a strip) or tap. Without scripts, bars keep a one-line tip. Charts are server-rendered SVG with their own tooltips, ported from the ts-dashboard kit.
- **Ranges without scripts.** `?range=24h|7d|30d|90d` switches the bars; the cache key keeps only valid values.
- **In-place refresh.** Open status pages fetch only their `<main>` (`/?fragment=main`) every 30 seconds while the tab is visible.

## How it measures

- **Four vantage points.** Small Workers placed near `aws:us-west-1`, `aws:sa-east-1`, `aws:eu-central-1` and `aws:ap-northeast-1` probe every endpoint; each reports the data center it ran in.
- **30-second rounds.** A single coordinator Durable Object, next to the D1 primary, runs a round on every half minute through the vantages' service bindings and stores one sample per endpoint.
- **Consensus.** A round needs two answering vantages; an endpoint is down only when most of them fail, degraded when some do or it is slower than 1.5 s, and shown down only after two down rounds in a row. A vantage that does not answer is left out, never counted as a failure.
- **Deep checks.** Besides answering, an endpoint can be required to return an expected status, contain a keyword, or satisfy JSON assertions such as `regions[code=GRU].available eq true`; extracted values (a version, replication lag) are stored with each sample, and a new version becomes a deploy marker. TerraBase cells are judged from atlas's region catalog; when atlas itself cannot be reached, they are unknown rather than down.
- **Automatic incidents.** After every round the coordinator steps a state machine per component: down for a minute (or degraded for ten) opens an incident with its timeline, a worse state raises its impact, passing checks move it to monitoring, and five healthy minutes resolve it. Maintenance windows suppress it, and incidents operators take over are left alone.
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

Pages:

| Path              | Shows                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `/`               | Status, components, response times, regions and the 90-day history (`?range=24h\|7d\|30d\|90d`) |
| `/uptime`         | A year of daily status as a calendar, monthly uptime per component against 99.9%                |
| `/ping`           | Latency from each vantage to every region and component, and a test from your browser           |
| `/components/:id` | A component's bars, median and p95 latency with deploys, latency per vantage, clusters          |
| `/regions/:code`  | A region's clusters, latency from each vantage, and incidents                                   |
| `/history`        | Incidents filtered by component, kind, impact, text and month, with MTTR                        |
| `/incidents/:id`  | An incident's timeline and what the health checks saw around it                                 |
| `/maintenance`    | Maintenance windows in progress, upcoming and completed                                         |

`GET /api/ping` answers with the visitor's Cloudflare data center; the ping page times it as a baseline. Regions carry a `ping_url` the browser test times (`no-cors`, so any HTTPS URL on `*.terrascale.tech` works).

`GET /api/status` returns the overall status, component groups with each component's 24 hourly states and uptime, regions with their clusters' ping, uptime and hourly states, and current incidents. Operators publish incidents with the [`status-warning`](skills/status-warning/SKILL.md) skill.

The operator API under `/api/operator` needs the `OPERATOR_TOKEN` bearer token (`wrangler secret put OPERATOR_TOKEN`; locally in `.dev.vars`):

| Method and path                            | Does                                                             |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `POST /api/operator/incidents`             | Publishes an incident, warning or maintenance window             |
| `GET /api/operator/incidents/:id`          | Reads a record with its updates and components                   |
| `PATCH /api/operator/incidents/:id`        | Edits title, impact, components or schedule                      |
| `DELETE /api/operator/incidents/:id`       | Removes a record published by mistake                            |
| `POST /api/operator/incidents/:id/updates` | Posts an update, changing status (and impact)                    |
| `POST /api/operator/deploys`               | Records a deploy marker for an endpoint                          |
| `PATCH /api/operator/components/:id`       | Launches (`active`) or plans a component, enabling its endpoints |
| `PATCH /api/operator/endpoints/:id`        | Enables or pauses one endpoint                                   |

Editing an automatic incident takes it over from the probe coordinator. Pausing a component, or its last enabled endpoint, answers `409` while an automatic incident is open for it: resolve the incident first.

## Deploy

The production D1 database is `ts-status-db` (`8a72dd69-2136-4398-8d70-92c0c2dade5a`). Build, apply migrations, deploy the four vantage Workers, then the status Worker with:

```sh
npm run deploy
```

For global read latency, enable D1 read replication on `ts-status-db`; the Worker already reads through sessions.
