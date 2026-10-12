# ts-status deployment pipeline

The fixed /api/v1/deployments endpoint observes TerraBase, ts-auth, ts-status
and the dashboard from the gru and sfo vantage Durable Objects and also reports
the revision each vantage runs. It accepts no caller-controlled target.
Observations share the existing 10-second edge cache per colo, and concurrent
cache misses coalesce within a Worker instance. Query strings cannot bypass
that cache. Cached observations keep their original timestamps; clients receive
`no-store`, so they cannot extend proof freshness. Invalid vantage payloads
produce unknown observations for that region while preserving the other region.

CI runs on GitHub Actions with Blacksmith runners. Every pull request and main
push runs locked dependency installation, lint, type checking, tests and a
Worker build. On main, the deploy job runs only after those checks pass. Main
jobs queue; newer commits never cancel an active production deployment.

CI bootstraps D1 from schema.sql, then deploys the one status Worker,
`ts-status`. Its four vantages (sfo, gru, fra, nrt) are Durable Objects inside
it, created with the location hints wnam, sam, weur and apac, so there is no
other Worker to deploy. Pull requests get no preview deploy and the Worker has
no preview URLs. Cloudflare runs it all;
ts-status has no process on Fly, so it keeps working while the platform is down.

Deploys read the repo secret `CLOUDFLARE_API_TOKEN` and the repo variable
`CLOUDFLARE_ACCOUNT_ID`. The status Worker's admin, subscription and probe
credentials are Worker secrets.

The source commit tags each Cloudflare deployment and supplies the status
Worker's `VERSION` binding. `GET https://status.terrascale.tech/health/version`
returns that full revision and observed Cloudflare colo without caching or
reading D1. The production smoke check requires its revision to match the
deployed source and also requires the status API to answer. A healthy older
Worker cannot pass this smoke check.
