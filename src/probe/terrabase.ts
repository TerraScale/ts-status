/* Coordinator probes of the C# TerraBase contract. Unconfigured secrets
   remain unjudged; malformed configuration and contract failures fail closed. */

import { isId } from "../ids";
import { logEvent } from "../log";

import { NOT_CONFIGURED } from "../domain/status";
import {
  CANARY_VANTAGE,
  CanaryError,
  canaryJson,
  collectionPath,
  documentPath,
  holdsDocument,
  isCanaryConfig,
  isRegionCode,
  written,
  type CanaryConfig,
  type CanaryResult,
} from "./canary";
import { USER_AGENT } from "./check";
import type { Sample } from "./round";

export type TerraBaseProbe = "health" | "documents";

export interface TerraBaseConfig {
  /** The public API origin, e.g. https://api.terrascale.tech. */
  origin: string;
  /** The deployment region, e.g. gru; the origin selects the service. */
  region: string;
  /** Document API key. */
  key?: string;
  project?: string;
  database?: string;
  collection?: string;
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

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** One item is enough to prove a list or query route answers. */
const PAGE_SIZE = 1;

/** The one document the canary writes, each round over the last: a create
    whose answer is lost, or a failed delete, leaves at most this document
    behind, and the next round overwrites and deletes it. */
const CANARY_DOCUMENT = "01M4E7G1W82VKFPF5FJ9AVK1DW";

const documentConfig = (config: TerraBaseConfig): CanaryConfig =>
  ({
    ...config,
    document: CANARY_DOCUMENT,
  }) as CanaryConfig;

const ROUTES = {
  readyz: "/readyz",
  document: (config: TerraBaseConfig) => documentPath(documentConfig(config)),
  query: (config: TerraBaseConfig) => `${collectionPath(documentConfig(config))}/query`,
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
  if (!isOrigin(entry.origin) || !isRegionCode(entry.region)) return false;
  switch (probe) {
    case "health":
      return entry.key === undefined || isString(entry.key);
    case "documents":
      return isCanaryConfig(documentConfig(entry as unknown as TerraBaseConfig));
  }
}

/** Reads the secret's entries, unchecked: empty when unset, null when it
    is not a JSON object, so a broken secret fails every probe instead of
    passing for an absent one. */
export function parseTerraBase(secret: string | undefined): Record<string, unknown> | null {
  if (!secret) return {};
  try {
    const value: unknown = JSON.parse(secret);
    if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).every(isId))
      return value as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  logEvent("error", "TERRABASE_PROBES must be a JSON object keyed by canonical endpoint ULIDs", {
    component: "terrabase",
  });
  return null;
}

const invalid = (): never => {
  throw new CanaryError("Invalid response");
};

const isCursor = (value: unknown): boolean => value === null || typeof value === "string";

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
    if (!holdsDocument(await call(ROUTES.document(config), { cache: "no-store" }), id, marker)) invalid();
    const found = (await call(
      ROUTES.query(config),
      json("POST", { filter: { eq: ["$id", id] }, limit: PAGE_SIZE }),
    )) as {
      items?: unknown;
      next_cursor?: unknown;
    };
    if (!Array.isArray(found.items) || !isCursor(found.next_cursor)) invalid();
    if (!(found.items as unknown[]).some((item) => holdsDocument(item, id, marker)))
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
    if (!isTerraBaseConfig(probe, config)) throw new CanaryError("Invalid probe config");
    switch (probe) {
      case "health": {
        const ready = (await call(ROUTES.readyz, { cache: "no-store" })) as { status?: unknown; version?: unknown };
        if (ready.status !== "ready" || !isString(ready.version)) invalid();
        break;
      }
      case "documents":
        await documents(config, marker, call);
        break;
    }
    return { ok: true, latencyMs: Date.now() - started, error: null };
  } catch (error) {
    if (error instanceof CanaryError) return { ok: false, latencyMs: null, error: error.message };
    throw error;
  }
}
