AI IS NOT ALLOWED TO EDIT THIS FILE ONLY HUMANS CAN!

# Rules
- Never add AI attribution to commits, PR titles, or PR descriptions: no `Co-Authored-By:` trailers, no `🤖 Generated with [Claude Code]` or similar generated-by notices.

## Stack
- Vite (vite-plus) with the Cloudflare Vite plugin
- TypeScript Cloudflare Worker rendering HTML on the server, no frontend framework
- Cloudflare D1
- Plain CSS with the ts-dashboard design system tokens, bundled by Lightning CSS

## Status storage and discovery

- ts-status is the sole Ouroboros exception: keep status history, incidents,
  subscriptions and probe coordination on Cloudflare D1/Durable Objects so a
  TerraBase outage cannot take down its status page. Other TerraScale products
  use TerraBase under the Ouroboros rule.
- Atlas is authoritative for regional origins. Monitoring must discover every
  admitted region and follow placement changes automatically; do not maintain
  a static region list or copy probe credentials. Region identity does not
  imply a DNS hostname. Never invent a route or hostname from it.

## D1 data and the CI deploy token

- ts-status MUST keep its data in Cloudflare D1 (`STATUS_DB`), a deliberate
  exception to the TerraScale rule that all service data lives in TerraBase.
  User decision 2026-10-07: the status page must keep working while TerraBase
  is down. Never move ts-status data to TerraBase or add a TerraBase dependency
  to the data path.
- The vendor-issued Cloudflare deployment token is stored once in OCI Vault
  and must be delivered automatically to CI, scoped only to ts-status
  (Workers scripts and routes, D1 Edit). The current repo-secret consumer is
  an implementation gap. Never print or copy it; check scope on D1 error 7403.

## Cloudflare: use the `cf` CLI
The Cloudflare CLI `cf` (npm package `cf`, v1.0.0-beta.10, installed through the mise Node toolchain) is installed and logged in on all 3 T3 hosts (delta, beta, mariogk-dev) as `mariogk01@gmail.com`, whose account owns the `terrascale.tech` zone.
- Use `cf` for Cloudflare work: DNS records, zones, origin CA / client certificates, SSL/TLS and cache settings, rules, analytics, API tokens. Workers deploys keep using `wrangler`.
- Before you start, run `cf auth whoami`. It must show `"authenticated": true`.
- Never print tokens or the config file. Print the plan before you change anything. Deleting zones, production DNS records or Workers needs the user's confirmation. Record changed Cloudflare object IDs (not secrets) in the PR or runbook.

## Local CPU Priority

- When building or testing locally, run every build, test, lint, and benchmark
  command at low CPU priority by prefixing it with `nice -n 19` (for example
  `nice -n 19 make test-fast`). Local dev servers and watchers count too.
- In CI (`CI=true`) use full CPU priority: do nothing. Never add `nice` or
  `renice` to CI workflows, Makefiles, scripts, or Containerfiles; the low
  priority is applied by whoever runs the command locally.

## Develop
- Always create a feature called feat/{feature_name} fix/{fix_name} and then we create a PR into main when the work is ready to be merged when pushing and creating the pull request make sure that the linter has no errors and that all tests passes, when creating pull request send the link of that PR to the user.
- If the user requests a preview url to check the work that is current made you need to start the dev env and send the user a tailscale dns to access it and test if it works before sending to the user if it doesnt work fix it
- Do not use worktrees
- When running a dev server it must always be accesible via the tailscale net and it must have hmr turned for really fast development

## Zero configuration (user decision 2026-10-09, do not revert)

- Every feature is always on. No feature flags, on/off variables, opt-in settings, boolean enabled configuration keys, deploy toggles or kill switches in code, config or CI. Delete switches and their guarded paths.
- Every region always serves. NetBird network membership admits a node automatically; it discovers every region, infers its own region from where it runs and starts serving without a per-region enable step.
- OCI Vault automatically creates, delivers and configures every first-party production secret. Vendor-issued keys (such as Stripe and Cloudflare) are stored once in Vault and picked up automatically; nobody copies secrets by hand.
- Values have one correct setting in code. Expose no tuning knobs. Fakes, demo stores and skip-auth belong only in test code and test binaries.
- CI rejects new switch-style configuration; ts-reviewer requests changes. Only unavoidable third-party names may have a narrow allowance with a one-line reason.

Discover every public regional service automatically; OCI Vault supplies monitoring and Cloudflare credentials.
