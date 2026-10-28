# Provision the regional canaries

Run from a ts-status checkout with the logged-in `cf` CLI. This command
provisions the canary database and key and updates only the two ts-status
Worker secrets. It does not deploy or restart a service, change orchestration,
or touch status history in D1.

```sh
nice -n 19 python3 scripts/recover-canaries.py
```

It prints one line, `{"approve": <url>, "user_code": <code>, "expires_in": <s>}`,
and waits. An owner or admin of the internal `terrascale` organization opens
the URL on `https://auth.terrascale.tech` and approves the code. The grant is a
public ts-cli device grant (no confidential client secret). It is kept only in
the private state file. While it waits, a `503 temporarily_unavailable` from
ts-auth backs off and keeps polling until the code expires; any other
unexpected token reply stops the run.

DECISION (2026-10-27, Q-CANARYPLAN): the canaries live in the internal
`terrascale` organization's `ts-status` project. The Free plan's 50,000 monthly
operation units cover less than a day of probing: the Data API read canary
alone takes about 2,900 units a day and the document probe about 35,000. Once
the allowance was spent, TerraBase refused every canary write with
`429 operation_allowance`, and the status page showed the Document API down in
every region. The internal organization's internal billing plan publishes a
paid tier to TerraBase, so no paid capacity is bought. A spent allowance now
shows as "Canary quota exhausted" (unmeasured), never as an outage
(`src/probe/canary.ts`). An automatic incident whose component the monitor
cannot measure for five minutes closes as unconfirmed
(`src/domain/auto-incident.ts`).

The command discovers serving regions from the public TerraBase `/v1/regions`
contract and uses the advertised global API with the supported regional pin.
Every region must name itself in `/readyz` and `X-TerraBase-Region`, including on
all document requests. One logical `status-canary` database uses the producer's
all-regions placement: each pin proves that region's local data path against its
replicated copy. Its key is narrowed to that database by its ULID (ts-auth
refuses a key narrowed by name, since a rename can move a name) and to
`documents:read documents:write`; probe requests still address the database by
name, which TerraBase resolves to the same ULID. Fresh documents prove
write/read/query/delete/read-after-delete; the retained fixture supports Data
API reads. Live status `/api/v1/regions` supplies Document API endpoint IDs and
the Data API's `canary` cluster ID. Negative HTTP checks are excluded. Missing
regional Document API catalog entries stop installation and require the status
catalog owner; this command does not mutate D1 or invent endpoint IDs or origins.

Private state is kept at `~/.local/state/ts-status/canaries.json` (0600), outside
Git, under an exclusive lock. A valid grant and a key narrowed by the database's ULID
are reused on a rerun, so a rerun needs no approval while the grant lasts; a
key narrowed by name is replaced. After a wipe, rerun
once customer auth and regional readiness recover; the script rediscovers the
organization, project, database and key metadata before installing replacement
credentials.

Secrets enter `cf workers secrets bulk --worker ts-status --file /dev/stdin`
through stdin. Subprocess responses, HTTP bodies, device codes and keys are
never logged. Output contains only stages, object IDs, the approval line and
regional CRUD proof. If authorization fails, fix the intended CLI identity or
scope. D1 7403 does not justify widening the CI token or adding a TerraBase
status-storage path.

Focused offline tests: `nice -n 19 python3 -m unittest discover -s scripts -p 'test_*.py'`.
