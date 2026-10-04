/* TerraBase probes, run by the coordinator like the data API canary, each
   against the v1 contract (terrabase-rust docs/api-v1.md and
   control-plane-v1.md):

   - health: `GET /v1/readyz` must answer `200 ready`.
   - documents: with a data key holding read and write on one canary
     collection, create (PUT) the canary document, read it back, find it by
     query, then delete it.
   - management: with a control key, list tenants (one per dashboard
     project) and the databases of one tenant. Reads only.

   Origins and keys come from the TERRABASE_PROBES Worker secret, a JSON
   object keyed by endpoint id. An endpoint the secret does not name is not
   configured, and so is a documents or management entry without its key:
   its samples carry no state, so it shows as such and never counts as
   down. Any other malformed entry fails, so a typo is never silent. */

import { NOT_CONFIGURED } from "../domain/status";
import { CANARY_VANTAGE, CanaryError, canaryJson, canaryText, type CanaryResult } from "./canary";
import { USER_AGENT } from "./check";
import type { Sample } from "./round";

export type TerraBaseProbe = "health" | "documents" | "management";

export interface TerraBaseConfig {
  /** The probed origin, e.g. https://gru.api.terrascale.tech. */
  origin: string;
  /** A tbk1 key: optional for health, a data key for documents and a
      control key for management. */
  key?: string;
  /** documents: the canary database and collection names. */
  database?: string;
  collection?: string;
  /** management: the tenant whose databases are listed. */
  tenant?: string;
}

/** A not configured endpoint's sample: unjudged, so it is neither up nor
    down, counts toward no uptime and leaves any down streak behind. */
export const notConfiguredSample = (endpointId: string): Sample => ({
  endpointId,
  state: "none",
  ok: 0,
  total: 0,
  latencyMs: null,
  results: [{ v: CANARY_VANTAGE, ok: null, ms: null, e: NOT_CONFIGURED }],
  values: null,
});

const NAME = /^[a-z][a-z0-9_-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^tbv1-[0-9a-f]{32}$/;

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** One item is enough to prove a list or query route answers. */
const PAGE_SIZE = 1;

/** The one document the canary writes, each round over the last: a create
    whose answer is lost, or a failed delete, leaves at most this document
    behind, and the next round overwrites and deletes it. */
const CANARY_DOCUMENT = "7d8f6b0e-4c1a-4f2e-9a63-746572726173";

/** The v1 routes probed: api-v1.md, query-v1.md and control-plane-v1.md. */
const ROUTES = {
  readyz: "/v1/readyz",
  document: (config: TerraBaseConfig) =>
    `/v1/databases/${config.database}/collections/${config.collection}/documents/${CANARY_DOCUMENT}`,
  query: (config: TerraBaseConfig) => `/v1/databases/${config.database}/collections/${config.collection}/query`,
  tenants: `/v1/dashboard/tenants?limit=${PAGE_SIZE}`,
  databases: (config: TerraBaseConfig) => `/v1/dashboard/tenants/${config.tenant}/databases?limit=${PAGE_SIZE}`,
};

/** Whether the secret configures an endpoint: it names it, with the key
    the probe needs. Whatever else it holds is checked by isTerraBaseConfig. */
export function isConfigured(probe: TerraBaseProbe, value: unknown): boolean {
  if (value === undefined) return false;
  const keyless =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { key?: unknown }).key === undefined;
  return probe === "health" || !keyless;
}

/** A bare https origin: no credentials, path, query or fragment, which the
    appended API path would otherwise land behind. */
function isOrigin(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

/** Whether `value` holds everything `probe` needs. */
export function isTerraBaseConfig(probe: TerraBaseProbe, value: unknown): value is TerraBaseConfig {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (!isOrigin(entry.origin)) return false;
  switch (probe) {
    case "health":
      return entry.key === undefined || isString(entry.key);
    case "documents":
      return (
        isString(entry.key) &&
        typeof entry.database === "string" &&
        NAME.test(entry.database) &&
        typeof entry.collection === "string" &&
        NAME.test(entry.collection)
      );
    case "management":
      return isString(entry.key) && typeof entry.tenant === "string" && UUID.test(entry.tenant);
  }
}

/** Reads the secret's entries, unchecked: empty when unset, null when it
    is not a JSON object, so a broken secret fails every probe instead of
    passing for an absent one. */
export function parseTerraBase(secret: string | undefined): Record<string, unknown> | null {
  if (!secret) return {};
  try {
    const value: unknown = JSON.parse(secret);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  console.error("TERRABASE_PROBES is not a JSON object");
  return null;
}

const invalid = (): never => {
  throw new CanaryError("Invalid response");
};

/** A document write's answer: `{id, version, offset, durability}`. */
function written(value: unknown): string {
  const body = value as { id?: unknown; version?: unknown; offset?: unknown; durability?: unknown };
  if (typeof body.id !== "string" || !UUID.test(body.id)) invalid();
  if (typeof body.version !== "string" || !VERSION.test(body.version)) invalid();
  if (typeof body.offset !== "string" || !/^(0|[1-9][0-9]*)$/.test(body.offset)) invalid();
  if (body.durability !== "local_durable" && body.durability !== "object_durable") invalid();
  return body.id as string;
}

const isCursor = (value: unknown): boolean => value === null || typeof value === "string";

/** A list route's answer: `{items: [{id}, …], next_cursor}`. */
function listed(value: unknown): void {
  const body = value as { items?: unknown; next_cursor?: unknown };
  if (!Array.isArray(body.items)) invalid();
  if (!isCursor(body.next_cursor)) invalid();
  for (const item of body.items as unknown[]) {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !UUID.test(id)) invalid();
  }
}

/** Holds the marker the canary wrote. */
const holds = (item: unknown, id: string, marker: string): boolean => {
  const entry = item as { id?: unknown; version?: unknown; state?: unknown; document?: { canary?: unknown } } | null;
  return (
    entry?.id === id &&
    typeof entry.version === "string" &&
    VERSION.test(entry.version) &&
    entry.state === "value" &&
    entry.document?.canary === marker
  );
};

async function documents(
  config: TerraBaseConfig,
  marker: string,
  call: (path: string, init?: RequestInit, statuses?: readonly number[]) => Promise<unknown>,
): Promise<void> {
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const id = CANARY_DOCUMENT;
  let failure: unknown;
  try {
    // 201 creates it; 200 replaces one a failed round left behind.
    const created = await call(ROUTES.document(config), json("PUT", { canary: marker }), [200, 201]);
    if (written(created) !== id) invalid();
    if (!holds(await call(ROUTES.document(config), { cache: "no-store" }), id, marker)) invalid();
    const found = (await call(
      ROUTES.query(config),
      json("POST", { filter: { eq: ["$id", id] }, limit: PAGE_SIZE }),
    )) as {
      items?: unknown;
      next_cursor?: unknown;
    };
    if (!Array.isArray(found.items) || !isCursor(found.next_cursor)) invalid();
    if (!(found.items as unknown[]).some((item) => holds(item, id, marker)))
      throw new CanaryError("Query missed the document");
  } catch (error) {
    failure = error;
  } finally {
    // Deleted every round, even after a failed or unanswered write, which
    // may still have committed; the first failure is reported.
    try {
      if (written(await call(ROUTES.document(config), { method: "DELETE" })) !== id) invalid();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

/** Runs one TerraBase probe; `marker` makes the documents canary's write unique. */
export async function runTerraBase(
  probe: TerraBaseProbe,
  config: TerraBaseConfig,
  marker: string,
  fetcher: typeof fetch = fetch,
): Promise<CanaryResult> {
  const headers: Record<string, string> = { "user-agent": USER_AGENT };
  if (config.key) headers.authorization = `Bearer ${config.key}`;
  const init = (extra: RequestInit = {}): RequestInit => ({ ...extra, headers: { ...headers, ...extra.headers } });
  // Every request answers 200 unless it says otherwise.
  const call = (path: string, extra?: RequestInit, statuses: readonly number[] = [200]) =>
    canaryJson(config.origin + path, init(extra), fetcher, statuses);
  const started = Date.now();
  try {
    switch (probe) {
      case "health":
        if (
          (await canaryText(config.origin + ROUTES.readyz, init({ cache: "no-store" }), fetcher, [200])).trim() !==
          "ready"
        ) {
          invalid();
        }
        break;
      case "documents":
        await documents(config, marker, call);
        break;
      case "management":
        listed(await call(ROUTES.tenants, { cache: "no-store" }));
        listed(await call(ROUTES.databases(config), { cache: "no-store" }));
        break;
    }
    return { ok: true, latencyMs: Date.now() - started, error: null };
  } catch (error) {
    if (error instanceof CanaryError) return { ok: false, latencyMs: null, error: error.message };
    throw error;
  }
}
