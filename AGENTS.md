# ts-status

Follow the workspace [Shipping code](../AGENTS.md#shipping-code-user-2026-10-29-go-fast-break-things-fast-q-trunk-q-local-check) rules in `/home/mariogk/Projects/TerraScale/AGENTS.md`.

- TypeScript Cloudflare Worker with server-rendered HTML, Vite Plus and the Cloudflare Vite plugin; no frontend framework. Plain CSS uses dashboard design tokens and Lightning CSS.
- `src/` contains the application, probes, API, admin and database code; `schema.sql` defines D1 storage; `public/` holds static assets; `scripts/` holds canary recovery tools.
- Install: `npm ci`. Build: `npm run build`. Fast: `npm run check && npm test`; recovery tests: `python3 -m unittest discover -s scripts -p 'test_*.py'`. Lint: `npm run lint`.
- Status history, incidents, subscriptions and probe coordination stay on D1 (`STATUS_DB`) and Durable Objects. This deliberate Ouroboros exception must keep working during a TerraBase outage. Never move its data path to TerraBase.
- ts-orch is authoritative for regional origins. Discover all public regions and placement changes automatically; do not keep a static list, copy probe credentials or infer DNS names from region identities. The public `api.terrascale.tech` host supports regional readiness assertions.
- Every feature is always on. Do not add feature flags, activation settings, deploy toggles, kill switches or tuning knobs. Keep one correct value in code. CI allowances for unavoidable third-party switch names need a one-line reason. Fakes, demo stores and skip-auth belong only in tests and test binaries.
- Every region serves when ts-orch reports it ready, with no enable step. Discover public regional services automatically.
