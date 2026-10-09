# ts-status deployment pipeline

Part of [TS-768](https://ku.mariogk.com/terrascale/issue/TS-768).

CI records deployment/qualified before production changes. The orchestrator's
five-minute guard compares that marker with fresh live revisions and alerts
when the oldest pending qualified build exceeds 30 minutes. Its clock cannot
be reset by another green build. The fixed /api/v1/deployments endpoint observes
Atlas, Status and Dashboard from GRU/SFO service bindings and also reports each
vantage Worker's own deployed revision. It accepts no caller-controlled target.
Observations share the existing 10-second edge cache per colo, and concurrent
cache misses coalesce within a Worker instance. Query strings cannot bypass
that cache. Cached observations keep their original timestamps; clients receive
`no-store`, so they cannot extend proof freshness. Invalid vantage payloads
produce unknown observations for that region while preserving the other region.

Every main push runs locked dependency installation, type checking, lint,
tests, a Worker build and Wrangler dry runs. The same job deploys the verified
bundles only after all checks pass. Pull requests validate without deploying.
Main jobs queue; newer commits never cancel an active production deployment.

CI bootstraps D1 from schema.sql, deploys each GRU/SFO/FRA/NRT vantage Worker, then
deploys the status Worker. Cloudflare distributes these Workers globally;
there is no separate ts-status process on the OCI controllers. Vantages are
placed near their named regions to measure the services from those locations.

The repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are
required and checked before deployment. The status Worker's operator,
subscription, SMTP and service-probe credentials remain runtime secrets.

The source commit tags each Cloudflare deployment and supplies the status
Worker's `VERSION` binding. `GET https://status.terrascale.tech/health/version`
returns that full revision and observed Cloudflare colo without caching or
reading D1. The production smoke check requires its revision to match the
deployed source and also requires the status API to answer. A healthy older
Worker cannot pass this smoke check.

For TS-768 acceptance, merge a no-op source change and record merge time,
verification completion, deployment completion and uncached version
observations through the GRU and SFO vantages. Keep the matching Cloudflare
deployment IDs and CI run link with the measured merge-to-live/green-to-live
times. Unknown, unhealthy or stale observations cannot pass the lag guard.
