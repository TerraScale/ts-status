# TerraScale status catalog: components, regions and clusters

Use this repo skill to inspect or correct status catalog metadata when the
human requests it. The [zero-configuration contract](../../docs/zero-configuration.md)
requires automatic discovery/probing of every admitted region and service.
Current lifecycle/endpoint switches and manual catalog reconciliation are
runtime gaps; do not use a launch, pause or enable step to admit a region.
Unknown or unavailable measurements must stay honest. OCI Vault must deliver
operator/probe credentials automatically; this document establishes no live
mutation authorization.

Generate new IDs with `node --input-type=module -e 'import { monotonicFactory } from "ulid"; console.log(monotonicFactory()())'`. Never use a name, UUID or prefix as an entity ID.

## Model

- `component_groups`: display groups with ULID IDs (platform, TerraBase, developer tools), ordered by `position`.
- `components`: what customers use, keyed by canonical ULIDs returned by `/api/v1/status`. `lifecycle` is `active` or `planned`; planned components are listed as "Planned" and never measured.
- `regions`: one row per region (`code` such as `GRU`, `name`, `country`, and `map_x`/`map_y`, the hub position on the 136×80 region map viewBox). Regions without enabled endpoints show as "Planned".
- `endpoints`: one health check per cluster of a component. `region_code` names the region, or is null for global services such as edge Workers; `url` answers 2xx when healthy; `headers` is a JSON object sent with every probe; `provider` is `fly`, `oci`, `cloudflare`, or `other`.

Every endpoint also carries a check:

- `expect_status`: `2xx` by default, or codes such as `200,204`.
- `keyword`: text the body must contain.
- `assertions`: a JSON array of `{"path", "op", "value"}` on the JSON body; `op` is `eq`, `ne`, `lt`, `gt`, `exists` or `contains`, and paths are dotted keys with array selectors, e.g. `status` or `regions[code=GRU].available`.
- `extract`: a JSON object of named paths recorded with every sample. A `version` that changes is recorded as a deploy in `deploys`; TerraBase cells extract `lag_ms`.
- `indirect`: `1` when the URL reports on the component instead of serving it (TerraBase cells are judged from atlas's region catalog). If it cannot be fetched, the component is unknown, not down.

A component's status is measured from four vantage points: a cluster is degraded when some vantages fail or it answers slower than 1.5 s, and down once most vantages fail two rounds in a row. A component or region is down only when all of its clusters are, and partially down when some are.

## Verify discovered services

Use Atlas-authoritative origins and actual readiness/health contracts. Every
admitted service must be probed without lifecycle or endpoint activation.
The current catalog's `active`/`planned` and endpoint booleans remain legacy
implementation inventory, not operator setup instructions.

Keep automatic incidents and their history intact. Resolve an incident before
an approved removal; a missing probe must never be presented as recovery.

## Catalog reconciliation requirements

Automatic discovery must identify the component, region, cluster and authoritative
health URL, allocate canonical IDs and retain measurement history. Verify readiness
before claiming health. A Fly anycast hostname or preferred-region hint does not
prove that a Machine serves in that region; register only observed serving origins.

Region display metadata and map positions may be corrected with authorization;
such edits must not enable/disable service or suppress health evidence. The current
manual catalog path is a pending runtime gap. No SQL mutation recipe is required
for a new region to serve or be monitored.

## Remove

Deleting an endpoint also deletes its probe history (`ON DELETE CASCADE`). Verify every change on `GET https://status.terrascale.tech/api/v1/status`.
