# Recover regional canaries after an FR1 wipe

Run from the ts-status checkout on mariogk-dev, with the existing logged-in `cf`
CLI and mailbox password file. This command provisions customer resources and
updates only the two ts-status Worker secrets; it does not deploy or restart a
service, change orchestration, or touch status history in D1.

```sh
nice -n 19 python3 scripts/recover-canaries.py < /home/mariogk/.config/terrascale/mailbox-password
```

DECISION: use the dedicated `mariogk+status-canary@terrascale.tech` customer
identity and the dashboard's hosted sign-in/session routes. The dashboard owns
its current OIDC client registration. A public ts-cli device grant, approved by
the same dedicated hosted session, supplies customer management authority;
no confidential client secret is read. No owner application login, QA credentials,
OCI access, or copied dashboard client secret is needed. IMAP uses the mailbox
owner solely to retrieve the dedicated alias's single verification message.

The command discovers serving regions from the public TerraBase `/v1/regions`
contract and uses the advertised global API with the supported regional pin.
Every region must name itself in `/readyz` and `X-TerraBase-Region`, including on
all document requests. One logical `status-canary` database uses the producer's
all-regions placement. DECISION: each pin proves that region's local data path
against its replicated copy; separate logical databases add no regional proof
and would consume the Free plan's database quota. Normal quota enforcement is
retained; no paid capacity is purchased. Its key is
restricted to that database and `documents:read documents:write`. Fresh documents prove
write/read/query/delete/read-after-delete; the retained fixture supports Data
API reads. Live status `/api/v1/regions` supplies Document API endpoint IDs and
the Data API's `canary` cluster ID. Negative HTTP checks are excluded. Missing
regional Document API catalog entries stop installation and require the status
catalog owner; this command does not mutate D1 or invent endpoint IDs or origins.

Private state is kept at `~/.local/state/ts-status/canaries.json` (0600), outside
Git, under an exclusive lock. Retain it: valid sessions/passwords and scoped keys
are reused, including after interrupted installation. A pending signup answer is
saved before polling mail. After session/password rejection, a wiped identity
can be registered once per previous user identity; an ambiguous signup or code
submission stops for coordination instead of requesting or replaying codes.
A wipe during provisioning fails closed. Rerun after the reset completes; the
script rediscovers databases and key metadata before installing replacement
credentials. Never delete the persistent canary account at the end.

Secrets enter `cf workers secrets bulk --worker ts-status --file /dev/stdin`
through stdin. Subprocess responses, HTTP bodies, cookies, passwords and keys
are never logged. Output contains only stages, object IDs and regional CRUD
proof. If authorization fails, fix the intended CLI identity/scope; D1 7403 does
not justify widening the CI token or adding a TerraBase status-storage path.

FR1 integration handoff: invoke the command after customer auth and regional
readiness recover. Parent owns rollout and the final public monitoring proof.
Focused offline tests: `nice -n 19 python3 -m unittest discover -s scripts -p 'test_*.py'`.

Live recovery and idempotent rerun both passed on 2026-10-26: FRA, GRU and SJC
returned matching readiness/body and serving-region headers; all five CRUD
checks passed in each region using the same database and key on both runs.
Both Worker secrets were installed through protected stdin. One signup total;
the dedicated account remains intact. Sanitized objects:

- User: `01M5V31RD7CCPHY5ZG4W4GEB40`
- Organization: `01M5V32M72EFA5YHG17D0EK8P3`
- Project: `01M5V32MP79F09Q7X5RBSR1Q4H`
- Database: `01M5V3HJG49JAGHYY8X7PQAT3V` (`status-canary`, all regions)
- Key ID: `01M5V3HQXJAKKPA965D77Y79BX` (database-scoped read/write)
- Worker: `ts-status`; secret bindings: `DATA_API_CANARY`, `TERRABASE_PROBES`.

The dashboard database form returned 503 before any database existed. The final
recovery uses supported public customer management APIs with the public CLI
grant, without dashboard database forms or an application deployment.
