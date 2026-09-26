# TerraScale status regions and clusters

Use this repo skill when the human asks to add, move, pause, or remove a region or cluster on the status page. Regions and clusters are D1 records; the Worker's cron trigger probes every enabled endpoint each minute, so changes apply within a minute without a deploy.

## Model

- `regions`: one row per region (`code` such as `GRU`, `name`, `country`, and `map_x`/`map_y`, the hub position on the 136×80 region map viewBox). Regions without endpoints show as "Planned".
- `endpoints`: one row per cluster. `url` is a public health check that answers 2xx when healthy; `headers` is a JSON object sent with every probe; `provider` is `fly`, `oci`, `cloudflare`, or `other`; `service_id` names the service the cluster runs.

A cluster is degraded after one failed probe or a healthy response slower than 1.5 s, and down after three consecutive failures. A region is down only when all of its clusters are.

## Add a cluster

Ask the human for the region, service, cluster name, and health check URL if they have not supplied them. Confirm the URL answers before inserting it:

```sh
curl -fsS -o /dev/null -w '%{http_code} %{time_total}s\n' https://HOST/health/ready
npm exec -- wrangler d1 execute ts-status-db --remote --command \
  "INSERT INTO endpoints (id, region_code, service_id, cluster, provider, url, headers, position) VALUES ('terrabase-oci-gru-a', 'GRU', 'api', 'sa-saopaulo-1 · cell a', 'oci', 'https://HOST/health/ready', '{}', 2);"
```

Fly.io apps share one anycast hostname. Send `{"fly-prefer-region": "gru"}` in `headers` to prefer a region's Machines; Fly falls back to the nearest region when that one has none running, so only register Fly regions that have Machines.

## Add a region

```sh
npm exec -- wrangler d1 execute ts-status-db --remote --command \
  "INSERT INTO regions (code, name, country, map_x, map_y, position) VALUES ('NRT', 'Tokyo', 'Japan', 118.5, 30.2, 4);"
```

Place the hub by eye on `src/assets/region-map.svg` (x grows east, y grows south).

## Pause or remove

Pause probing with `UPDATE endpoints SET enabled = 0 WHERE id = '…'`. Deleting an endpoint also deletes its probe history (`ON DELETE CASCADE`). Verify every change on `GET https://status.terrascale.tech/api/status`. Never add a public write endpoint to the Worker.
