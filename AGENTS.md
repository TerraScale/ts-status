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
- Atlas is authoritative for regional origins. Resolve an admitted healthy
  region (currently `gru-1`) through Atlas before pinning a static probe origin
  in a secret; re-resolve when placement changes. Display region `GRU` is not
  the Atlas region identifier. Production TerraBase is served by Caddy on
  OCI `gru-1` at `https://gru.api.terrascale.tech`; region identity does not
  imply a DNS hostname. Never invent a route or hostname from it.

## D1 data and the CI deploy token

- ts-status MUST keep its data in Cloudflare D1 (`STATUS_DB`), a deliberate
  exception to the TerraScale rule that all service data lives in TerraBase.
  User decision 2026-10-07: the status page must keep working while TerraBase
  is down. Never move ts-status data to TerraBase or add a TerraBase dependency
  to the data path.
- CI deploys with the repo secret `CLOUDFLARE_API_TOKEN`, a user-supplied token
  used only for ts-status (Workers scripts and routes, D1 Edit). Never print it,
  never copy it to other repos, and if a deploy gets D1 error 7403, check this
  token's scope first.

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
