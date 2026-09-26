# TerraScale status catalog: components, regions and clusters

Use this repo skill when the human asks to add, launch, move, pause, or remove a component, region, or cluster on the status page. The catalog lives in D1; the Worker's cron trigger probes every enabled endpoint each minute, so changes apply within a minute without a deploy.

## Model

- `component_groups`: display groups (`platform`, `terrabase`, `developer`), ordered by `position`.
- `components`: what customers use (`dashboard`, `website`, `atlas`, `auth`, `docs`, `data-api`, `sync`, `git`). `lifecycle` is `active` or `planned`; planned components are listed as "Planned" and never measured.
- `regions`: one row per region (`code` such as `GRU`, `name`, `country`, and `map_x`/`map_y`, the hub position on the 136×80 region map viewBox). Regions without enabled endpoints show as "Planned".
- `endpoints`: one health check per cluster of a component. `region_code` names the region, or is null for global services such as edge Workers; `url` answers 2xx when healthy; `headers` is a JSON object sent with every probe; `provider` is `fly`, `oci`, `cloudflare`, or `other`.

A component's status is measured: a cluster is degraded after one failed probe or a healthy response slower than 1.5 s, and down after three consecutive failures. A component or region is down only when all of its clusters are, and partially down when some are.

## Launch a planned component

When a planned component goes live, confirm its health check answers, then enable it:

```sh
curl -fsS -o /dev/null -w '%{http_code} %{time_total}s\n' https://auth.terrascale.tech/readyz
npm exec -- wrangler d1 execute ts-status-db --remote --command \
  "UPDATE components SET lifecycle = 'active' WHERE id = 'auth'; UPDATE endpoints SET enabled = 1 WHERE component_id = 'auth';"
```

## Add a cluster

Ask the human for the component, region, cluster name, and health check URL if they have not supplied them. Confirm the URL answers before inserting it:

```sh
curl -fsS -o /dev/null -w '%{http_code} %{time_total}s\n' https://HOST/health/ready
npm exec -- wrangler d1 execute ts-status-db --remote --command \
  "INSERT INTO endpoints (id, component_id, region_code, cluster, provider, url, headers, position) VALUES ('dashboard-fly-fra', 'dashboard', 'FRA', 'fra', 'fly', 'https://dash.terrascale.tech/health/ready', '{\"fly-prefer-region\":\"fra\"}', 2);"
```

Fly.io apps share one anycast hostname. Send `{"fly-prefer-region": "gru"}` in `headers` to prefer a region's Machines; Fly falls back to the nearest region when that one has none running, so only register Fly regions that have Machines.

## Add a component or region

```sh
npm exec -- wrangler d1 execute ts-status-db --remote --command \
  "INSERT INTO components (id, group_id, name, description, lifecycle, position) VALUES ('console', 'platform', 'Console', 'Operator console', 'planned', 6);"
npm exec -- wrangler d1 execute ts-status-db --remote --command \
  "INSERT INTO regions (code, name, country, map_x, map_y, position) VALUES ('NRT', 'Tokyo', 'Japan', 118.5, 30.2, 4);"
```

Place the hub by eye on `src/assets/region-map.svg` (x grows east, y grows south).

## Pause or remove

Pause probing with `UPDATE endpoints SET enabled = 0 WHERE id = '…'`. Deleting an endpoint also deletes its probe history (`ON DELETE CASCADE`). Verify every change on `GET https://status.terrascale.tech/api/status`.
