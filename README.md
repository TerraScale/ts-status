# ts-status

Read the [zero-configuration operating contract](docs/zero-configuration.md).

TerraScale's public status page at <https://status.terrascale.tech>: a TypeScript Cloudflare Worker that renders HTML at the edge from Cloudflare D1. Status is the sole Ouroboros exception: its history, incidents, subscriptions and coordinator remain on D1/Durable Objects so a TerraBase outage cannot disable the status page; other TerraScale products use TerraBase. It uses the ts-dashboard design system (`../ts-dashboard/DESIGN_SYSTEM.md`): the same tokens, Oxanium type, and flat hairline components.

## How it is fast

- **No framework on the client.** Pages are server-rendered strings with the stylesheet, logo, and region map inlined; one small inline script (allowed by its CSP hash) localizes times and refreshes the page. A visit is one HTML request plus one preloaded 14 KB font.
- **One D1 round trip per render.** Every query for a page runs in a single batch on a read-replica session (`withSession("first-unconstrained")`); the uptime, component and region pages add one batch for their details.
- **Edge cache.** Pages and the API are cached per URL for 10 seconds (`caches.default`), so load during an incident is bounded no matter how many people are watching.
- **Details on demand.** Every bar, map hub, vantage and probe path carries its details (time range, state, uptime, checks, median and p95 latency, overlapping incidents) in a `data-card` attribute; the inline script shows them in one hover card on hover, keyboard focus (arrow keys move along a strip) or tap. Without scripts, bars keep a one-line tip. Charts are server-rendered SVG with their own tooltips, ported from the ts-dashboard kit.
- **Ranges without scripts.** `?range=24h|7d|30d|90d` switches the bars; the cache key keeps only valid values.
- **In-place refresh.** Open status pages fetch only their `<main>` (`/?fragment=main`) every 30 seconds while the tab is visible.

## How it measures

- **Four vantage points.** `VantagePoint` Durable Objects in the status Worker, created with the location hints `wnam`, `sam`, `weur` and `apac`, probe every endpoint; each reports the data center it ran in. A hint is a preference: Cloudflare may create an object elsewhere (South America most often), and the page shows where it really runs.
- **30-second rounds.** A single coordinator Durable Object, next to the D1 primary, runs a round on every half minute through the vantage Durable Objects and stores one sample per endpoint.
- **Consensus.** A round needs two answering vantages; an endpoint is down only when most of them fail, degraded when some do or it is slower than 1.5 s, and shown down only after two down rounds in a row. A vantage that does not answer is left out, never counted as a failure. An endpoint's `blocked_status` names a status something in front of the service is known to refuse the probe with: that result is a probe error ("Probe blocked"), also left out.
- **Coverage.** Separately from service health, the page and API report which vantages answered the latest round and where they ran. Fewer than two answers means HTTP checks cannot decide (insufficient coverage); a missing, unproven or out-of-area vantage means degraded coverage. Neither is shown as a service outage.
- **Fly regions.** TerraBase (`https://api.terrascale.tech`, Fly app `ts-terrabase`) and ts-auth (`https://auth.terrascale.tech`) run one machine in every Fly region: gru (São Paulo), sjc (San Francisco Bay Area) and fra (Frankfurt) today. Each regional endpoint pins its region with the `fly-prefer-region` header, and the readiness checks require the answer's `region` to match, so a region whose machine is gone fails instead of being answered by another region.
- **Deep checks.** Besides answering, an endpoint can be required to return an expected status, contain a keyword, or satisfy JSON assertions:
  - TerraBase and ts-auth readiness: `GET /readyz` must return `200 {"status":"ready","version":…,"region":"gru"}`; the version is recorded, so deploys show on the latency charts.
  - Data API: an unauthenticated `GET /v1/projects/{project}/databases/{database}/collections/{collection}/documents/{id}` must answer `401 invalid_key`, which proves the request reached the document handler in that region.
  - Authentication: the platform tenant's OIDC discovery at `https://auth.terrascale.tech/terrascale/.well-known/openid-configuration` must name the issuer `https://auth.terrascale.tech/terrascale` and a JWKS. Every tenant has its own issuer at `/<tenant>`.
  - Documentation (`https://docs.terrascale.tech`) and the website (`https://terrascale.tech`) must answer 2xx; the website must mention TerraScale.
  - Email: Cloudflare Email Sending has no health endpoint, so its component on Cloudflare's status page is read instead. That check is `indirect`: when the status page cannot be reached the result is unknown, not down.
- **Pending launch.** An endpoint counts only from its first passing round (`live_since`). Until then it shows "Pending launch" in grey, opens no incident and adds nothing to uptime, so a service that is not live yet never looks like an outage. Rounds before the launch are left out of the rollups.
- **Canaries.** The Data API canary (`DATA_API_CANARY`) writes each round's marker into a dedicated canary document and reads it back; the Document API probes (`TERRABASE_PROBES`) write, read, query and delete a canary document in each region. Both secrets are JSON keyed by endpoint ULID with the origin (`https://api.terrascale.tech`), the Fly `region`, and a project-scoped key restricted to the canary database. An endpoint the secret does not name shows "Not configured" and counts toward nothing; a malformed entry, a timeout (5 seconds per request) or a failed write fails the round.
- **TLS expiry.** A Worker cannot see a served certificate, so once an hour the cron refreshes, from certificate transparency logs (Cert Spotter), the latest valid certificate of every monitored host not checked in a day (indirect sources such as Cloudflare's status page are skipped). A latest certificate expiring within two weeks means renewal has stalled: the page warns, and cluster rows show every host's expiry.
- **Automatic incidents.** After every round the coordinator steps a state machine per component: down for a minute (or degraded for ten) opens an incident with its timeline, a worse state raises its impact, passing checks move it to monitoring, and five healthy minutes resolve it. Maintenance windows suppress it, and incidents operators take over in the admin page are left alone.
- **Rollups.** The minute cron rebuilds hourly rollups (per vantage and for the consensus, with latency histograms) from the samples and daily rollups from the hours. Samples are kept 48 hours, hours 90 days and days 400 days.

## Layout

| Path              | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `src/worker.ts`   | Worker entry: re-exports the handler and the coordinator Durable Object |
| `src/app.ts`      | Routes, edge cache, cron entry point                                    |
| `src/router.ts`   | `/incidents/:id`-style path patterns                                    |
| `src/http/`       | Cache keys, content security policy, security headers                   |
| `src/admin/`      | The admin page: sign-in, sessions, CSRF and every operator action       |
| `src/db/`         | D1 queries                                                              |
| `src/domain/`     | Status domain: states, catalog, incidents, consensus, probe maths       |
| `src/overview.ts` | The overview shared by the page and the JSON API                        |
| `src/measure.ts`  | Counts, latency percentiles and series from per-vantage rollups         |
| `src/probe/`      | Coordinator, probe rounds, rollups, retention and TLS expiry            |
| `src/vantage/`    | The vantage Durable Object that probes targets for the coordinator      |
| `src/api/`        | The v1 and Statuspage-compatible JSON APIs                              |
| `src/feeds/`      | Atom, RSS and iCalendar feeds, and SVG status badges                    |
| `src/notify/`     | Subscriptions, the outbox, email and webhooks                           |
| `src/views/`      | HTML views and the client script                                        |
| `src/styles/`     | Design tokens and styles, bundled and minified by Lightning CSS         |

## IDs and clean bootstrap

Every entity ID is a plain, canonical uppercase 26-character Crockford ULID. `src/ids.ts` uses the maintained `ulid` library's monotonic generator. Requests reject UUIDs, prefixes, lowercase aliases, invalid alphabet characters and overflow. D1 enforces the same contract for primary IDs. Region/vantage codes, hostnames, database/collection names and composite measurement keys are natural keys, not entity IDs. TerraBase document bodies contain only data; the document key is the entity ID.

`schema.sql` is the idempotent clean bootstrap (one SQL statement per line for D1 `exec`); historical data migrations are removed. Fresh stores recreate the schema and catalog before serving requests or running scheduled probes. Repeated startup preserves incidents, subscriptions and catalog edits made in the admin page. Seeded catalog IDs are fixed ULIDs; the admin page shows every component and endpoint ID. Probe secrets are keyed by endpoint ULID.

Production uses the D1 store `ts-status` (`c2eca5bc-6045-4983-941a-4e01e4e0c749`).

## Catalog

Status is measured, never hand-edited. Components sit in display groups and are checked by regional or global endpoints:

| Group     | Component      | Endpoints                                                                             |
| --------- | -------------- | ------------------------------------------------------------------------------------- |
| TerraBase | TerraBase API  | `api.terrascale.tech/readyz` in gru, sjc and fra                                      |
| TerraBase | Data API       | Unauthenticated document read in gru, sjc and fra; the gru canary                     |
| TerraBase | Document API   | The document canary probe in gru, sjc and fra                                         |
| TerraBase | Replication    | `ts-terrabase.fly.dev/health/replication` in gru, sjc and fra, ok from its own region |
| Platform  | Authentication | `auth.terrascale.tech/readyz` in gru, sjc and fra; the tenant OIDC issuer             |
| Platform  | Documentation  | `docs.terrascale.tech`                                                                |
| Platform  | Website        | `terrascale.tech`                                                                     |
| Platform  | Email          | Cloudflare Email Sending, from Cloudflare's status page                               |
| Platform  | Dashboard      | None yet: "Coming soon"                                                               |

A component is either active (measured) or "Coming soon" (shown, never probed). Replication is probed per region and passes only when TerraBase reports `status: ok` from the pinned region. Until a region's first passing round it shows "Pending launch", so an unhealthy report opens no incident before then. Edit the catalog, regions and groups in the admin page; see the [`status-endpoint`](skills/status-endpoint/SKILL.md) skill.

## Local development

```sh
npm ci
nice -n 19 npm run db:bootstrap:local
nice -n 19 npm run dev
```

For the admin page locally, put an `ADMIN_PASSWORD_HASH` (see [Admin](#admin)) and an `ADMIN_SESSION_SECRET` in `.dev.vars` (git-ignored).

The dev server listens on every interface (reachable over the tailnet) and reloads on change. The local D1 database lives under `.wrangler/state`. Arm the coordinator (and roll up samples) with `curl 'http://localhost:5173/cdn-cgi/handler/scheduled'`; rounds then run every 30 seconds.

## Contract tests

```sh
nice -n 19 npm run check
nice -n 19 npm run lint
nice -n 19 npm run build
nice -n 19 npm test
```

Tests never download or run a TerraBase binary. The TerraBase probes are tested with fake configs and fetchers only; production probes call the live public API.

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

Operators publish incidents in the [admin page](#admin) ([`status-warning`](skills/status-warning/SKILL.md) skill).

`GET /api/latency` is public, allows any CORS origin and is cached for 10 seconds. It returns
`generated_at` (RFC3339), `window: "1h"` and `regions`, each with a lowercase `code`, `name`,
catalog `ping_url`, `status` (`operational`, `degraded`, `down` or `planned`), `consensus` and
`vantages`. Each stats object contains integer `median_ms`, `p95_ms` and `samples`; percentiles
are estimated from the existing latency histograms. Empty stats have null percentiles and zero
samples. Regions without a configured ping URL retain `ping_url: null`. Outages map to `down`;
maintenance and unmeasured regions map to `planned`. The optional case-insensitive `?region=gru`
filters to one region; an unknown code returns an empty list.

## Admin

<https://status.terrascale.tech/admin> is the only way to change anything: publish, edit, update, resolve or delete incidents, warnings and maintenance windows; record deploy markers; add, edit and delete groups, components, endpoints and regions; remove subscribers; and check endpoints from every vantage on demand ("Check now", nothing stored). Editing an automatic incident takes it over from the probe coordinator. Planning or deleting a component, or deleting its last endpoint, is refused while an automatic incident is open for it: resolve the incident first.

- **One password.** Its PBKDF2-SHA256 hash (100,000 iterations, the Workers maximum) is the Worker secret `ADMIN_PASSWORD_HASH`, as `pbkdf2-sha256$100000$<salt>$<hash>` (base64url). The plaintext lives only in `~/.config/terrascale/ts-status-admin.txt` (mode 600) on the dev servers.
- **Sessions.** Signing in sets `__Host-ts_status_admin`, an HttpOnly, Secure, SameSite=Strict cookie holding an expiry one hour out and a nonce, signed with HMAC-SHA256 under the Worker secret `ADMIN_SESSION_SECRET`. Nothing is stored server-side; rotating the secret signs everyone out.
- **CSRF.** Every form carries a token derived from the session nonce, and every POST must come from this origin.
- **Rate limit.** Sign-in attempts are limited to five a minute per client (`ADMIN_LOGIN_LIMITER`). Password and signature checks are constant time. Admin responses are never cached and carry `noindex`.

To change the password, hash a new one and set both secrets:

```sh
node --input-type=module -e '
import { webcrypto as c } from "node:crypto";
const pw = process.argv[1], salt = c.getRandomValues(new Uint8Array(16)), b64 = (x) => Buffer.from(x).toString("base64url");
const key = await c.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
const bits = await c.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
console.log(`pbkdf2-sha256$100000$${b64(salt)}$${b64(new Uint8Array(bits))}`);' "$(cat ~/.config/terrascale/ts-status-admin.txt)"
```

## Subscriptions

Visitors subscribe on `/subscribe` by email or webhook (Discord, Slack, or any public HTTPS URL), optionally to some components only, and confirm by double opt-in. Confirm and unsubscribe links are HMAC-signed with `SUBSCRIPTION_SECRET` and act only through POST forms, so link scanners cannot trigger them; emails carry RFC 8058 one-click unsubscribe, and generic webhooks an `x-terrascale-signature: sha256=…` HMAC of the body, keyed by the `signingKey` their confirmation request carries. Requests are rate limited per IP (per /64 for IPv6), a target gets at most one confirmation an hour and three in all, and a honeypot field drops bots. Delivery runs claim their messages first, so overlapping runs never send one twice.

The minute cron enqueues up to 1,000 eligible subscriber/update pairs into the D1 `outbox` with one insert query and delivers up to 20 due messages, retrying failures with exponential backoff (8 attempts). Later runs resume the unqueued backlog. Automatic incidents notify only once they have lasted five minutes; one resolved sooner notifies nobody. Email goes through Cloudflare Email Sending (the `EMAIL` binding in `wrangler.jsonc`), from `noreply@terrascale.tech`.

## Deploy

Cloudflare Workers Builds deploys every push to main with `npm run deploy`: it builds, bootstraps D1 from `schema.sql`, then deploys the one status Worker. There is no GitHub Actions workflow, so run `npm run lint`, `npm run check` and `npm test` before merging. Pull requests get no preview build and the Worker has no preview URLs.

Worker secrets: `SUBSCRIPTION_SECRET`, `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`, and the probe secrets `TERRABASE_PROBES` and `DATA_API_CANARY`. Set them with `wrangler secret put` or `cf workers secrets update`; never print them.

Canary keys must be project-scoped to a dedicated status canary organization, project and database, never customer data, with only `documents:read documents:write`.
