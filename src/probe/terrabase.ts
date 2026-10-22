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
  holdsDocument,
  isDocumentProbeConfig,
  isRegionCode,
  readToken,
  type DocumentProbeConfig,
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
  /** Platform issuer, including /terrascale; required for document reads. */
  issuer?: string;
  /** Database-scoped ts-auth project key with documents:read. */
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

const ROUTES = {
  readyz: "/readyz",
  documents: (config: TerraBaseConfig) =>
    `${collectionPath(config as DocumentProbeConfig)}/documents?limit=${PAGE_SIZE}`,
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
      return isDocumentProbeConfig(entry);
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

/** Readiness or a bounded document list; neither probe mutates application data. */
export async function runTerraBase(
  probe: TerraBaseProbe,
  config: TerraBaseConfig,
  _marker: string,
  fetcher: typeof fetch = fetch,
): Promise<CanaryResult> {
  const headers: Record<string, string> = { "user-agent": USER_AGENT };
  const init = (extra: RequestInit = {}): RequestInit => ({ ...extra, headers: { ...headers, ...extra.headers } });
  // Every request answers 200 unless it says otherwise.
  const call = (path: string, extra?: RequestInit, statuses: readonly number[] = [200]) =>
    canaryJson(config.origin + path, init(extra), fetcher, statuses);
  const started = Date.now();
  try {
    if (!isTerraBaseConfig(probe, config)) throw new CanaryError("Invalid probe config");
    switch (probe) {
      case "health": {
        const ready = (await call(ROUTES.readyz, { cache: "no-store" })) as {
          status?: unknown;
          version?: unknown;
          region?: unknown;
        };
        if (ready.status !== "ready" || !isString(ready.version) || ready.region !== config.region) invalid();
        break;
      }
      case "documents": {
        headers.authorization = `Bearer ${await readToken(config as DocumentProbeConfig, fetcher)}`;
        const page = (await call(ROUTES.documents(config), { method: "GET", cache: "no-store" })) as {
          items?: unknown;
          next_cursor?: unknown;
        };
        if (!Array.isArray(page.items) || page.items.length > PAGE_SIZE || !isCursor(page.next_cursor)) invalid();
        for (const item of page.items as { id?: unknown }[]) {
          if (typeof item?.id !== "string" || !holdsDocument(item, item.id)) invalid();
        }
        break;
      }
    }
    return { ok: true, latencyMs: Date.now() - started, error: null };
  } catch (error) {
    if (error instanceof CanaryError) return { ok: false, latencyMs: null, error: error.message };
    throw error;
  }
}
