# TerraScale status catalog: components, regions and clusters

Use this repo skill when the human asks to add, launch, move, pause, or remove a component, region, or cluster on the status page. The catalog lives in D1; the Worker's cron trigger probes every enabled endpoint every 30 seconds, so changes apply within a minute without a deploy.

## Model

- `component_groups`: display groups (`platform`, `terrabase`, `developer`), ordered by `position`.
- `components`: what customers use (`dashboard`, `website`, `atlas`, `auth`, `docs`, `data-api`, `sync`, `git`). `lifecycle` is `active` or `planned`; planned components are listed as "Planned" and never measured.
- `regions`: one row per region (`code` such as `GRU`, `name`, `country`, and `map_x`/`map_y`, the hub position on the 136×80 region map viewBox). Regions without enabled endpoints show as "Planned".
- `endpoints`: one health check per cluster of a component. `region_code` names the region, or is null for global services such as edge Workers; `url` answers 2xx when healthy; `headers` is a JSON object sent with every probe; `provider` is `fly`, `oci`, `cloudflare`, or `other`.

Every endpoint also carries a check:

- `expect_status`: `2xx` by default, or codes such as `200,204`.
- `keyword`: text the body must contain.
- `assertions`: a JSON array of `{"path", "op", "value"}` on the JSON body; `op` is `eq`, `ne`, `lt`, `gt`, `exists` or `contains`, and paths are dotted keys with array selectors, e.g. `status` or `regions[code=GRU].available`.
- `extract`: a JSON object of named paths recorded with every sample. A `version` that changes is recorded as a deploy in `deploys`; TerraBase cells extract `lag_ms`.
- `indirect`: `1` when the URL reports on the component instead of serving it (TerraBase cells are judged from atlas's region catalog). If it cannot be fetched, the component is unknown, not down.

A component's status is measured from four vantage points: a cluster is degraded when some vantages fail or it answers slower than 1.5 s, and down once most vantages fail two rounds in a row. A component or region is down only when all of its clusters are, and partially down when some are.

## Launch a planned component

When a planned component goes live, confirm its health check answers, then launch it through the operator API (see the `status-warning` skill for the `api` helper and token). Launching enables its endpoints; setting it back to `planned` pauses them.

```sh
curl -fsS -o /dev/null -w '%{http_code} %{time_total}s\n' https://auth.terrascale.tech/readyz
echo '{ "lifecycle": "active" }' > launch.json
api PATCH /components/auth launch.json
```

Pause or resume one endpoint with `PATCH /endpoints/ID` and `{ "enabled": false }`. Pausing a component, or its last enabled endpoint, answers `409` while an automatic incident is open for it; resolve that incident first.

## Add a cluster

Ask the human for the component, region, cluster name, and health check URL if they have not supplied them. Confirm the URL answers before inserting it:

```sh
curl -fsS -o /dev/null -w '%{http_code} %{time_total}s\n' https://HOST/health/ready
npm exec -- wrangler d1 execute ts-status-db --remote --command \
  "INSERT INTO endpoints (id, component_id, region_code, cluster, provider, url, headers, position) VALUES ('dashboard-fly-fra', 'dashboard', 'FRA', 'fra', 'fly', 'https://dash.terrascale.tech/health/ready', '{\"fly-prefer-region\":\"fra\"}', 2);"
```

Fly.io apps share one anycast hostname. Send `{"fly-prefer-region": "gru"}` in `headers` to prefer a region's Machines; Fly falls back to the nearest region when that one has none running, so only register Fly regions that have Machines.

Check a TerraBase cell through atlas:

```sh
npm exec -- wrangler d1 execute ts-status-db --remote --command \
  "UPDATE endpoints SET assertions = '[{\"path\":\"regions[code=NRT].available\",\"op\":\"eq\",\"value\":true}]', extract = '{\"lag_ms\":\"regions[code=NRT].lag_ms\"}', indirect = 1 WHERE id = 'data-api-oci-nrt';"
```

## Add a component or region

```sh
npm exec -- wrangler d1 execute ts-status-db --remote --command \
  "INSERT INTO components (id, group_id, name, description, lifecycle, position) VALUES ('console', 'platform', 'Console', 'Operator console', 'planned', 6);"
npm exec -- wrangler d1 execute ts-status-db --remote --command \
  "INSERT INTO regions (code, name, country, map_x, map_y, position) VALUES ('NRT', 'Tokyo', 'Japan', 118.5, 30.2, 4);"
```

Place the hub by eye on `src/assets/region-map.svg` (x grows east, y grows south).

## Remove

Deleting an endpoint also deletes its probe history (`ON DELETE CASCADE`). Verify every change on `GET https://status.terrascale.tech/api/status`.
