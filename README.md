# ts-status

TerraScale's public status page at <https://status.terrascale.tech>: a TypeScript Cloudflare Worker that renders HTML at the edge from Cloudflare D1. Status is the sole Ouroboros exception: its history, incidents, subscriptions and coordinator remain on D1/Durable Objects so a TerraBase outage cannot disable the status page; other TerraScale products use TerraBase. It uses the ts-dashboard design system (`../ts-dashboard/DESIGN_SYSTEM.md`): the same tokens, Oxanium type, and flat hairline components.

## How it is fast

- **No framework on the client.** Pages are server-rendered strings with the stylesheet, logo, and region map inlined; one small inline script (allowed by its CSP hash) localizes times and refreshes the page. A visit is one HTML request plus one preloaded 14 KB font.
- **One D1 round trip per render.** Every query for a page runs in a single batch on a read-replica session (`withSession("first-unconstrained")`); the uptime, component and region pages add one batch for their details.
- **Edge cache.** Pages and the API are cached per URL for 10 seconds (`caches.default`), so load during an incident is bounded no matter how many people are watching.
- **Details on demand.** Every bar, map hub, vantage and probe path carries its details (time range, state, uptime, checks, median and p95 latency, overlapping incidents) in a `data-card` attribute; the inline script shows them in one hover card on hover, keyboard focus (arrow keys move along a strip) or tap. Without scripts, bars keep a one-line tip. Charts are server-rendered SVG with their own tooltips, ported from the ts-dashboard kit.
- **Ranges without scripts.** `?range=24h|7d|30d|90d` switches the bars; the cache key keeps only valid values.
- **In-place refresh.** Open status pages fetch only their `<main>` (`/?fragment=main`) every 30 seconds while the tab is visible.

## How it measures

- **Four vantage points.** Small Workers placed near `aws:us-west-1`, `aws:sa-east-1`, `aws:eu-central-1` and `aws:ap-northeast-1` probe every endpoint; each reports the data center it ran in.
- **30-second rounds.** A single coordinator Durable Object, next to the D1 primary, runs a round on every half minute through the vantages' service bindings and stores one sample per endpoint.
- **Consensus.** A round needs two answering vantages; an endpoint is down only when most of them fail, degraded when some do or it is slower than 1.5 s, and shown down only after two down rounds in a row. A vantage that does not answer is left out, never counted as a failure.
- **Deep checks.** Besides answering, an endpoint can be required to return an expected status, contain a keyword, or satisfy JSON assertions. The global API router and GRU's public C# document handler are checked with an unauthenticated `GET /v1/projects/{project}/databases/{database}/collections/{collection}/documents/{id}`: `401 invalid_key` proves the handler is reachable, not that authenticated reads/writes work. Atlas's `GET /api/v1/regions` must report admitted `GRU-1` as `available: true` and include a corresponding `hosts.GRU-1` entry; Atlas normalizes region codes to uppercase. Region identity is separate from DNS: production TerraBase is `https://gru.api.terrascale.tech`, served by Caddy on OCI `gru-1`, and the display region is `GRU`. Dashboard readiness at `https://dash.terrascale.tech/health/ready` returns `200 {"status":"ok","version":…}`. Authentication readiness at `https://auth.terrascale.tech/readyz` returns `200 {"status":"ready","version":…}`; an unavailable storage authority returns 503. Both checks record version changes. OIDC discovery at `/.well-known/openid-configuration` is labeled **pending** in the active authentication component: its `pending_status=404` observation is unknown ("Not available yet"), so it counts as neither healthy nor an outage. A 200 must be JSON with `issuer: "https://auth.terrascale.tech"` and a present `jwks_uri`. Readiness continues to drive authentication status while discovery is pending; any non-404 discovery failure or invalid 200 payload also affects authentication and automatic incidents. SFO, FRA, docs and sync remain disabled until launch.
- **Data API canary.** With the `DATA_API_CANARY` secret set and `data-api-canary-gru` enabled, the coordinator writes each round's marker into a dedicated canary document with a scoped `tb_` key and reads it back (`src/probe/canary.ts`). A rejected key, a failed commit, an unreadable write, or an enabled canary missing its secret fails the round; two failures in a row are an outage.
- **TerraBase probes.** The coordinator uses the C# contracts in `terrabase` `origin/main` (`Features/Documents`, `Features/Management`, `Features/ApiKeys`; `src/probe/terrabase.ts`), with origins and credentials from `TERRABASE_PROBES`. An endpoint omitted from the secret shows "Not configured", with no uptime contribution. Malformed configuration, a timeout (5 seconds per request), an unexpected status or an invalid payload fails the round.

  | Component        | Requests, in order                                                                                                                                                                                                                             | Credential                                                                                            |
  | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
  | TerraBase health | `GET /readyz` must return `200` with `status: "ready"`                                                                                                                                                                                         | optional                                                                                              |
  | Document API     | `PUT /v1/projects/{project}/databases/{database}/collections/{collection}/documents/{id}` with `{canary}` → `GET` the document → `POST …/collections/{collection}/query` with `{"filter":{"eq":["$id",id]},"limit":1}` → `DELETE` the document | `tb_` key scoped to the dedicated org/project/database, with `documents:read` and `documents:write`   |
  | Management API   | `GET /v1/management/organizations/{organization}/projects?limit=1` → `GET …/projects/{project}/databases?limit=1`, each returning `{items, next}`                                                                                              | C# dashboard service credential plus `X-TerraBase-User-Id` and matching `X-TerraBase-Organization-Id` |

- **TLS expiry.** A Worker cannot see a served certificate, so once an hour the cron refreshes, from certificate transparency logs (Cert Spotter), the latest valid certificate of every monitored host not checked in a day. A latest certificate expiring within two weeks means renewal has stalled: the page warns, and cluster rows show every host's expiry.
- **Automatic incidents.** After every round the coordinator steps a state machine per component: down for a minute (or degraded for ten) opens an incident with its timeline, a worse state raises its impact, passing checks move it to monitoring, and five healthy minutes resolve it. Maintenance windows suppress it, and incidents operators take over are left alone.
- **Rollups.** The minute cron rebuilds hourly rollups (per vantage and for the consensus, with latency histograms) from the samples and daily rollups from the hours. Samples are kept 48 hours, hours 90 days and days 400 days.

## Layout

| Path              | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `src/worker.ts`   | Worker entry: re-exports the handler and the coordinator Durable Object |
| `src/app.ts`      | Routes, edge cache, cron entry point                                    |
| `src/router.ts`   | `/incidents/:id`-style path patterns                                    |
| `src/http/`       | Cache keys, content security policy, security headers, operator auth    |
| `src/db/`         | D1 queries                                                              |
| `src/domain/`     | Status domain: states, catalog, incidents, consensus, probe maths       |
| `src/overview.ts` | The overview shared by the page and the JSON API                        |
| `src/measure.ts`  | Counts, latency percentiles and series from per-vantage rollups         |
| `src/probe/`      | Coordinator, probe rounds, rollups, retention and TLS expiry            |
| `src/vantage/`    | The vantage Worker that probes targets for the coordinator              |
| `src/api/`        | The v1, Statuspage-compatible and operator JSON APIs                    |
| `src/feeds/`      | Atom, RSS and iCalendar feeds, and SVG status badges                    |
| `src/notify/`     | Subscriptions, the outbox, email over SMTP and webhooks                 |
| `src/views/`      | HTML views and the client script                                        |
| `src/styles/`     | Design tokens and styles, bundled and minified by Lightning CSS         |

## Catalog

Status is measured, never hand-edited. Components sit in display groups and are checked by regional or global endpoints. Planned components are shown without contributing to measured status. GRU's C# Data API is checked at `https://gru.api.terrascale.tech`; SFO and FRA remain disabled. The GRU browser ping uses public `/healthz`. Resolve regional origins with Atlas before pinning them in probe secrets. The [`status-endpoint`](skills/status-endpoint/SKILL.md) skill manages the catalog.

## Local development

```sh
npm ci
nice -n 19 npm run db:migrate:local
nice -n 19 npm run dev
```

The dev server listens on every interface (reachable over the tailnet) and reloads on change. The local D1 database lives under `.wrangler/state`. The four vantage Workers run alongside the status Worker. Arm the coordinator (and roll up samples) with `curl 'http://localhost:5173/cdn-cgi/handler/scheduled'`; rounds then run every 30 seconds.

## Contract tests

```sh
nice -n 19 npm run check
nice -n 19 npm run lint
nice -n 19 npm run build
nice -n 19 npm test
```

The TerraBase probe suites launch the actual `terrabase-linux-amd64` release pinned by tag and SHA256 in `src/testing/terrabase-release.json`. They verify the executable before running it, provision an isolated organization/project/database through its real APIs, and use a temporary TLS certificate and data directory. Only ts-status's own D1 storage is substituted. Linux x64 and OpenSSL are required. The harness downloads through authenticated `fj` or `FORGEJO_READ_TOKEN` and caches the verified binary; `TERRABASE_BINARY=/path/to/terrabase-linux-amd64` supplies an existing copy, which must match the same SHA256. CI reads `ORG_READ_TOKEN`, which must have access to the private release; no credential is stored in the repo.

The pinned release includes client-listener `/readyz` and region identity. The readiness integration test runs unconditionally and verifies `status: "ready"`, the configured `region`, and `X-TerraBase-Region` against the real binary.

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

Feeds and APIs, all open to any origin and listed with snippets on `/integrations`:

| Path                                         | Serves                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/feed.atom`, `/feed.rss`                    | Incidents, warnings and maintenance with their updates                                  |
| `/maintenance.ics`                           | Maintenance windows as an iCalendar subscription                                        |
| `/badge/status.svg`, `/badge/:component.svg` | Live SVG status badges                                                                  |
| `/embed`                                     | A compact live widget for iframes (the only page any site may frame)                    |
| `/api/v1/status`                             | Headline, components with bars, regions, maintenance and incidents (`?range=`)          |
| `/api/v1/incidents`                          | The latest incidents with their updates (`?limit=`)                                     |
| `/api/v1/regions`                            | Regions, clusters, and the latest latency from each vantage                             |
| `/api/v1/latency?component=`                 | Median and p95 per bucket, overall and per vantage (`?range=`)                          |
| `/api/v2/*.json`                             | The Atlassian Statuspage v2 format: status, summary, components, incidents, maintenance |

Operators publish incidents with the [`status-warning`](skills/status-warning/SKILL.md) skill.

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

## Subscriptions

Visitors subscribe on `/subscribe` by email or webhook (Discord, Slack, or any public HTTPS URL), optionally to some components only, and confirm by double opt-in. Confirm and unsubscribe links are HMAC-signed with `SUBSCRIPTION_SECRET` and act only through POST forms, so link scanners cannot trigger them; emails carry RFC 8058 one-click unsubscribe, and generic webhooks an `x-terrascale-signature: sha256=…` HMAC of the body, keyed by the `signingKey` their confirmation request carries. Requests are rate limited per IP (per /64 for IPv6), a target gets at most one confirmation an hour and three in all, and a honeypot field drops bots. Delivery runs claim their messages first, so overlapping runs never send one twice.

The minute cron enqueues every eligible update into the D1 `outbox` and delivers what is due, retrying failures with exponential backoff (8 attempts). Automatic incidents notify only once they have lasted five minutes; one resolved sooner notifies nobody. Email goes through OCI Email Delivery's SMTP relay (STARTTLS on 587, over Cloudflare TCP sockets) with the credentials ts-auth uses.

## Deploy

The production D1 database is `ts-status-db` (`8a72dd69-2136-4398-8d70-92c0c2dade5a`). Set the secrets once (the SMTP ones are ts-auth's `TS_AUTH_SMTP_*` values; without them, email subscriptions are hidden):

```sh
npx wrangler secret put OPERATOR_TOKEN
npx wrangler secret put SUBSCRIPTION_SECRET
npx wrangler secret put SMTP_HOST       # smtp.email.sa-saopaulo-1.oci.oraclecloud.com
npx wrangler secret put SMTP_USERNAME   # the OCI SMTP credential, with its @oci suffix
npx wrangler secret put SMTP_PASSWORD
npx wrangler secret put SMTP_FROM       # noreply@terrascale.tech, an approved sender
```

Provision a **dedicated status canary organization, project and database** before configuring probes. Never point a write probe at customer data. These are operator instructions; applying the catalog migration does not provision anything.

1. Resolve the admitted healthy `GRU-1` origin using `GET https://atlas.terrascale.tech/api/v1/regions` (`regions[].available` and `hosts`). If database placement is needed, use the existing `GET /api/v1/discovery?database=<name>` contract and its ranked `endpoints[].url`. The production TerraBase origin is `https://gru.api.terrascale.tech` (Caddy on OCI `gru-1`); do not turn the region identity into an invented hostname. Pin the resolved HTTPS origin in the secrets below; probes use that explicit override, rather than discovering placement on every round. Re-resolve and update the pinned origin when placement changes; do not derive it from the UI's `GRU` label.
2. Use the C# management service credential (`Authorization: Bearer <dashboard credential>`, configured by TerraBase's `dashboard-credential-file`) and a dedicated acting user's `X-TerraBase-User-Id`. Create the organization with `POST /v1/management/organizations` and `{"name":"Status canary"}`; retain its returned `id`. Create a project with `POST /v1/management/organizations/{organization}/projects` and `{"name":"Status canary"}`, then a database with `POST …/projects/{project}/databases` and `{"name":"status_canary"}`. Both organization-scoped requests require `X-TerraBase-Organization-Id` equal to the path's organization. Retain the project UUID, database UUID and database name: the data API uses the **name**, while key scoping uses the **UUID**.
3. On the TerraBase server's loopback administrative listener, issue a key with `POST /admin/api-keys` and `{"name":"status-canary","scopes":["documents:read","documents:write"],"organizationId":"<organization UUID>","projectId":"<project UUID>","databaseId":"<database UUID>"}`. Save the returned `secret` (`tb_…`) immediately; it is shown once. The management credential is distinct from this document API key. Using the `tb_` key, create separate canary collections with `POST /v1/projects/{project}/databases/status_canary/collections` and `{"name":"canary"}` (use `probe_canary` for the document probe). The key's narrowest supported scope is the database, not one collection.
4. Store the secrets below before enabling the data API canary. Give each document probe its own collection. It overwrites one fixed UUID each round and attempts deletion even after a failed write; the data API canary retains its own fixed document for read-back. Resolve any automatic incident before removing a TerraBase probe entry: a "Not configured" round does not resolve an existing incident.

```sh
npx wrangler secret put DATA_API_CANARY
# {"data-api-canary-gru": {"origin": "https://gru.api.terrascale.tech", "project": "<project UUID>",
#   "database": "status_canary", "collection": "canary", "document": "<fixed lowercase document UUID>", "key": "tb_…"}}
curl -X PATCH -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' \
  -d '{"enabled": true}' https://status.terrascale.tech/api/operator/endpoints/data-api-canary-gru

npx wrangler secret put TERRABASE_PROBES
# {"terrabase-health-gru": {"origin": "https://<reachable readiness origin>"},
#  "document-api-gru": {"origin": "https://gru.api.terrascale.tech", "key": "tb_…", "project": "<project UUID>",
#    "database": "status_canary", "collection": "probe_canary"},
#  "management-api-gru": {"origin": "https://gru.api.terrascale.tech", "key": "<dashboard service credential>",
#    "userId": "<authorized user id>", "organization": "<organization UUID>", "project": "<project UUID>"}}
```

The TerraBase health probe requires an origin exposing `/readyz`. The pinned release exposes `/readyz` on its HTTPS client listener; configure the probe only after verifying the deployed origin's readiness contract. `/healthz` is liveness and cannot replace readiness.

Every push to `main` deploys from CI once the checks and tests pass: it applies the D1 migrations, deploys the four vantage Workers, then the status Worker, with the organization's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` Forgejo secrets. To deploy by hand, build, apply migrations, deploy the four vantage Workers, then the status Worker with:

```sh
nice -n 19 npm run deploy
```

For global read latency, enable D1 read replication on `ts-status-db`; the Worker already reads through sessions.
