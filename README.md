# ts-status

Read the [required zero-configuration operating contract](docs/zero-configuration.md).
Current configuration paths described below are implementation limitations, not
production activation instructions.

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
- **Consensus.** A round needs two answering vantages; an endpoint is down only when most of them fail, degraded when some do or it is slower than 1.5 s, and shown down only after two down rounds in a row. A vantage that does not answer is left out, never counted as a failure. An endpoint's `blocked_status` names the status its probe is known to be refused with by something in front of the service: that result is a probe error ("Probe blocked"), also left out. Cloudflare answers the vantages' requests to dash and git, which answer everyone else, with 403, so only those two set it; any other unexpected status, 403 included, still fails.
- **Deep checks.** Besides answering, an endpoint can be required to return an expected status, contain a keyword, or satisfy JSON assertions. The global API router and GRU's public C# document handler are checked with an unauthenticated `GET /v1/projects/{project}/databases/{database}/collections/{collection}/documents/{id}`: `401 invalid_key` proves the handler is reachable, not that authenticated reads/writes work. Atlas's `GET /api/v1/regions` must list at least one region with a `code` and include a `hosts` map; the check names no region, so new regions need no catalog change. Atlas normalizes region codes to uppercase. Region identity is separate from DNS: production TerraBase is `https://gru.api.terrascale.tech`, served by Caddy on OCI `gru-1`, and the display region is `GRU`. Dashboard readiness at `https://dash.terrascale.tech/health/ready` returns `200 {"status":"ok","version":…}`. Authentication readiness at `https://auth.terrascale.tech/readyz` returns `200 {"status":"ready","version":…}`; an unavailable storage authority returns 503. Both checks record version changes. The draft TS-598 target for OIDC discovery is `https://gru.auth.terrascale.tech/terrascale/.well-known/openid-configuration`: a 200 must name the exact regional `/terrascale` issuer and its JWKS. The global auth origin is an Atlas proxy, not the issuer. The active catalog's pending discovery observation remains unknown ("Not available yet") on its configured 404; readiness continues to drive authentication status until the upstream contract ships. The current catalog still excludes some regions/components; that is an
  implementation gap. Every discovered regional service must be monitored
  automatically. Missing measurements remain unknown, never fabricated healthy.
- **Data API canary (draft target).** With `DATA_API_CANARY` configured and `data-api-canary-gru` enabled, the coordinator will write each round's marker into a dedicated canary document and read it back through the TS-592 SDK. Authentication uses a project-scoped, database-restricted ts-auth key with `documents:read documents:write`, exchanged for a short-lived bearer token; the key itself is not a bearer token. A rejected exchange, a failed commit, an unreadable write, or an enabled canary missing its secret fails the round; two failures in a row are an outage.
- **TerraBase probes (draft target).** TS-598 defines identity and token exchange; TS-589 defines TerraBase's project-scoped resource authorization, and TS-592 must expose those contracts through `@terrascale/sdk`. Origins and credentials come from `TERRABASE_PROBES`. An endpoint omitted from the secret shows "Not configured", with no uptime contribution. Malformed configuration, a timeout (5 seconds per request), an unexpected status or an invalid payload fails the round.

  | Component        | Requests, in order                                                                 | Credential                                                                       |
  | ---------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
  | TerraBase health | `GET /readyz` must return `200` with `status: "ready"`                             | None; readiness is unauthenticated                                               |
  | Document API     | Write → read → query → delete a dedicated document through the TS-592 SDK          | Project key restricted to `status_canary`, with `documents:read documents:write` |
  | Management API   | Read/list the dedicated project's databases through the TS-589/TS-592 resource API | Separate project key with only `databases:read`; no identity-management calls    |

  **Draft blocker:** `src/probe/sdk.ts` prepares credential validation, platform-grant arguments and SDK document operations against the published TS-598/TS-589 contract. It is deliberately not connected to `round.ts`: `@terrascale/sdk@0.0.2` supports only legacy `tb_` document CRUD and has no platform-grant, management or readiness SDK surface. Keep this PR draft until TS-589 and TS-592 ship. Production wiring, token exchange/cache/refresh, management/readiness SDK calls, catalog changes and a JWT-capable real fixture remain merge gates. The target configuration below is not ready to deploy; no TS-598/TS-589/TS-592 interoperability tests have been run.

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
| `src/notify/`     | Subscriptions, the outbox, email and webhooks                           |
| `src/views/`      | HTML views and the client script                                        |
| `src/styles/`     | Design tokens and styles, bundled and minified by Lightning CSS         |

## IDs and clean bootstrap

Every entity ID is a plain, canonical uppercase 26-character Crockford ULID. `src/ids.ts` uses the maintained `ulid` library's monotonic generator. Requests reject UUIDs, prefixes, lowercase aliases, invalid alphabet characters and overflow. D1 enforces the same contract for primary IDs. Region/vantage codes, hostnames, database/collection names and composite measurement keys are natural keys, not entity IDs. TerraBase document bodies contain only data; the document key is the entity ID.

`schema.sql` is the idempotent clean bootstrap (one SQL statement per line for D1 `exec`); historical data migrations are removed. Fresh stores recreate the schema and catalog before serving requests or running scheduled probes. Repeated startup preserves incidents, subscriptions and operator catalog edits. Catalog IDs are fixed ULIDs; discover component IDs through `/api/v1/status` and endpoint IDs through a D1 catalog query. Probe secrets are keyed by endpoint ULID.

Production uses the clean store `ts-status` (`c2eca5bc-6045-4983-941a-4e01e4e0c749`), created empty for TS-754; the pre-ULID `ts-status-db` (`8a72dd69-2136-4398-8d70-92c0c2dade5a`) is retained read-only until deletion is approved.

## Catalog

Status is measured, never hand-edited. Components sit in display groups and are checked by regional or global endpoints. Planned components are shown without contributing to measured status. The current catalog measures only a subset of services; automatic discovery
and probing of every region remain implementation gaps. The GRU browser ping uses public `/healthz`. Origins must follow Atlas discovery automatically; Vault delivers scoped probe
credentials without manual pinning or copying. The [`status-endpoint`](skills/status-endpoint/SKILL.md) skill manages the catalog.

## Local development

```sh
npm ci
nice -n 19 npm run db:bootstrap:local
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

The existing legacy TerraBase probe suites launch the actual `terrabase-linux-amd64` release pinned by tag and SHA256 in `src/testing/terrabase-release.json`. They verify the executable before running it, provision an isolated organization/project/database through its real APIs, and use a temporary TLS certificate and data directory. Only ts-status's own D1 storage is substituted. Linux x64 and OpenSSL are required. The harness downloads through authenticated `fj` or `FORGEJO_READ_TOKEN` and caches the verified binary; `TERRABASE_BINARY=/path/to/terrabase-linux-amd64` supplies an existing copy, which must match the same SHA256. CI reads `ORG_READ_TOKEN`, which must have access to the private release; no credential is stored in the repo.

The pinned release includes client-listener `/readyz` and region identity. The legacy readiness integration test runs unconditionally and checks `status: "ready"`, the configured `region`, and `X-TerraBase-Region` against that binary. `src/probe/sdk.test.ts` verifies the prepared SDK document operations against the same real release using its legacy fixture credential, and explicitly records the published SDK's JWT/grant restrictions. These baseline tests do not establish platform credential interoperability. That gate must wait for the upstream releases and a matching pinned TerraBase binary; it has not been run.

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
| `/api/latency`                               | Region ping over the last completed UTC hour, consensus and per vantage (`?region=gru`) |
| `/api/v1/status`                             | Headline, components with bars, regions, maintenance and incidents (`?range=`)          |
| `/api/v1/incidents`                          | The latest incidents with their updates (`?limit=`)                                     |
| `/api/v1/regions`                            | Regions, clusters, and the latest latency from each vantage                             |
| `/api/v1/latency?component=`                 | Median and p95 per bucket, overall and per vantage (`?range=`)                          |
| `/api/v1/*.json`                             | The Atlassian Statuspage format: status, summary, components, incidents, maintenance    |

Every versioned API uses v1. Statuspage-compatible documents use the `.json` suffix:
`/api/v1/summary.json`, `/api/v1/status.json`, `/api/v1/components.json`,
`/api/v1/incidents.json`, `/api/v1/incidents/unresolved.json`,
`/api/v1/scheduled-maintenances.json`, `/api/v1/scheduled-maintenances/upcoming.json`
and `/api/v1/scheduled-maintenances/active.json`. The extensionless
`/api/v1/status` and `/api/v1/incidents` retain their TerraScale payloads and query parameters.

Operators publish incidents with the [`status-warning`](skills/status-warning/SKILL.md) skill.

`GET /api/latency` is public, allows any CORS origin and is cached for 10 seconds. It returns
`generated_at` (RFC3339), `window: "1h"` and `regions`, each with a lowercase `code`, `name`,
catalog `ping_url`, `status` (`operational`, `degraded`, `down` or `planned`), `consensus` and
`vantages`. Each stats object contains integer `median_ms`, `p95_ms` and `samples`; percentiles
are estimated from the existing latency histograms. Empty stats have null percentiles and zero
samples. Regions without a configured ping URL retain `ping_url: null`. Outages map to `down`;
maintenance and unmeasured regions map to `planned`. The optional case-insensitive `?region=gru`
filters to one region; an unknown code returns an empty list.

The operator API under `/api/operator` still requires a scoped bearer token.
OCI Vault must provision/deliver it automatically. The current `OPERATOR_TOKEN`
consumer is a delivery gap; authorization remains mandatory:

| Method and path                            | Does                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `POST /api/operator/incidents`             | Publishes an incident, warning or maintenance window                               |
| `GET /api/operator/incidents/:id`          | Reads a record with its updates and components                                     |
| `PATCH /api/operator/incidents/:id`        | Edits title, impact, components or schedule                                        |
| `DELETE /api/operator/incidents/:id`       | Removes a record published by mistake                                              |
| `POST /api/operator/incidents/:id/updates` | Posts an update, changing status (and impact)                                      |
| `POST /api/operator/deploys`               | Records a deploy marker for an endpoint                                            |
| `PATCH /api/operator/components/:id`       | Legacy lifecycle control; runtime removal pending automatic catalog reconciliation |
| `PATCH /api/operator/endpoints/:id`        | Legacy endpoint switch; runtime removal pending automatic discovery                |

Editing an automatic incident takes it over from the probe coordinator. Pausing a component, or its last enabled endpoint, answers `409` while an automatic incident is open for it: resolve the incident first.

## Subscriptions

Visitors subscribe on `/subscribe` by email or webhook (Discord, Slack, or any public HTTPS URL), optionally to some components only, and confirm by double opt-in. Confirm and unsubscribe links are HMAC-signed with `SUBSCRIPTION_SECRET` and act only through POST forms, so link scanners cannot trigger them; emails carry RFC 8058 one-click unsubscribe, and generic webhooks an `x-terrascale-signature: sha256=…` HMAC of the body, keyed by the `signingKey` their confirmation request carries. Requests are rate limited per IP (per /64 for IPv6), a target gets at most one confirmation an hour and three in all, and a honeypot field drops bots. Delivery runs claim their messages first, so overlapping runs never send one twice.

The minute cron enqueues up to 1,000 eligible subscriber/update pairs into the D1 `outbox` with one insert query and delivers up to 20 due messages, retrying failures with exponential backoff (8 attempts). Later runs resume the unqueued backlog. Automatic incidents notify only once they have lasted five minutes; one resolved sooner notifies nobody. Email goes through Cloudflare Email Sending (the `EMAIL` binding in `wrangler.jsonc`), from `noreply@terrascale.tech`.

## Deploy

CI deploys qualified main revisions. OCI Vault must automatically provision and
deliver operator, subscription and probe credentials, and deliver the
vendor-issued Cloudflare deployment token stored once. There are no manual
Worker-secret commands or email/probe activation steps.

**Current gaps:** CI still consumes Forgejo deployment secrets and the Worker
expects pre-existing runtime secrets. The catalog still has lifecycle/endpoint
switches. This documentation implements neither Vault delivery nor automatic
catalog reconciliation; it must not claim all regions are already measured.

### Probe provisioning (draft; wait for TS-589/TS-592)

Provision a **dedicated status canary organization, project and database** only after the upstream contracts ship. Never point a write probe at customer data. These are target operator instructions; bootstrapping the catalog does not provision anything. Status history, incidents, subscriptions and probe coordination stay on Cloudflare D1/Durable Objects, the sole Ouroboros exception; TerraBase is only a probe target.

Automatic provisioning must resolve every admitted region through Atlas and
refresh placement changes without deriving hostnames from region IDs. It must
create a dedicated canary organization/project/database and separate collections,
never point write probes at customer data, and deliver probe credentials through
OCI Vault without copying them.

Retain these authorization and integrity requirements:

- Use separate, narrowly scoped project keys for read/write canaries and
  read-only management probes. Recurring probes must not gain database
  provisioning privileges. Token exchange uses the trusted regional issuer;
  customer-tenant and sign-in/service tokens cannot reach project routes.
- Validate signature/type, exact issuer, audience, expiry/not-before,
  `project_id`, database restriction and required scopes. Cache short-lived
  tokens and exchange again once after an authentication rejection; never log keys.
- Use separate fixed canonical document IDs. Attempt cleanup even after failed
  writes. Verify `/readyz`; `/healthz` liveness cannot replace storage readiness.
- Keep absent/unimplemented upstream contracts visibly unknown. The current
  `TERRABASE_PROBES` and `DATA_API_CANARY` consumers remain delivery gaps; no
  catalog bootstrap proves canary creation or credential interoperability.
- Resolve and retain automatic incident evidence before removing any probe;
  an unconfigured round cannot resolve an incident. Deletion of catalog data
  and history still needs explicit approval of verified targets.

The required upstream authorization/SDK contracts and real-server integration
qualification remain prerequisites for claiming safe probes. They are quality
and security boundaries, not feature activation switches.

The current main pipeline bootstraps schema/catalog and deploys vantage Workers
before the status Worker after checks pass. Vendor token scope must cover only
required Worker, route and D1 operations. Existing repo-secret consumption is
not evidence of automatic Vault delivery. Deployments retain commit identity.
