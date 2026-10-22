/* Read-only Data API probe. DATA_API_CANARY maps endpoint ULIDs to a
   pre-created document and a database-scoped ts-auth client credential. */

import { isId } from "../ids";
import { logEvent } from "../log";

import { settle } from "../domain/consensus";
import { SLOW_MS, type TimelineState } from "../domain/status";
import { MAX_BODY_BYTES, USER_AGENT } from "./check";
import type { Sample } from "./round";

/** Each canary request slower than this fails. */
export const CANARY_TIMEOUT_MS = 5_000;

/** The `v` a canary result is stored under: it is not a vantage. */
export const CANARY_VANTAGE = "canary";

export interface CanaryConfig {
  /** The public API origin, e.g. https://api.terrascale.tech. */
  origin: string;
  /** The deployment region, enforced by TerraBase's region pin. */
  region: string;
  project: string;
  database: string;
  collection: string;
  document: string;
  /** Platform issuer, including /terrascale. */
  issuer: string;
  /** A ts-auth project key with only documents:read, narrowed to this database. */
  key: string;
}

export interface CanaryResult {
  ok: boolean;
  /** Token exchange plus read time; null when the canary failed. */
  latencyMs: number | null;
  error: string | null;
}

const NAME = /^[a-z][a-z0-9_-]{0,62}$/;
const VERSION = /^tbv1-[0-9a-f]{32}$/;
const REGION_CODE = /^[a-z]{3}$/;

/** A three-letter deployment region code, e.g. gru or sjc. */
export const isRegionCode = (value: unknown): value is string => typeof value === "string" && REGION_CODE.test(value);

export type DocumentProbeConfig = Omit<CanaryConfig, "document">;

export function isDocumentProbeConfig(value: unknown): value is DocumentProbeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  try {
    const url = new URL(String(entry.origin));
    const issuer = new URL(String(entry.issuer));
    return (
      url.protocol === "https:" &&
      url.origin === entry.origin &&
      issuer.protocol === "https:" &&
      `${issuer.origin}/terrascale` === entry.issuer &&
      isRegionCode(entry.region) &&
      typeof entry.project === "string" &&
      isId(entry.project) &&
      typeof entry.database === "string" &&
      NAME.test(entry.database) &&
      typeof entry.collection === "string" &&
      NAME.test(entry.collection) &&
      typeof entry.key === "string" &&
      entry.key.length === 79 &&
      isId(entry.key.slice(0, 26)) &&
      /^_[0-9a-hjkmnp-tv-z]{52}$/.test(entry.key.slice(26))
    );
  } catch {
    return false;
  }
}

export function isCanaryConfig(value: unknown): value is CanaryConfig {
  return (
    isDocumentProbeConfig(value) && "document" in value && typeof value.document === "string" && isId(value.document)
  );
}

export const collectionPath = (config: Pick<CanaryConfig, "project" | "database" | "collection">): string =>
  `/v1/projects/${config.project}/databases/${config.database}/collections/${config.collection}`;

// The v1 by-key route takes the raw document ULID in the query, not the path.
export const documentPath = (config: CanaryConfig): string =>
  `${collectionPath(config)}/documents/by-key?id=${config.document}`;

/** Validate the current document envelope; no response content reaches public errors. */
export const holdsDocument = (value: unknown, id: string): boolean => {
  const body = value as { id?: unknown; version?: unknown; state?: unknown; document?: unknown } | null;
  return (
    isId(id) &&
    body?.id === id &&
    typeof body.version === "string" &&
    VERSION.test(body.version) &&
    body.state === "value" &&
    typeof body.document === "object" &&
    body.document !== null &&
    !Array.isArray(body.document)
  );
};

/** Reads the canary secret, dropping malformed entries; empty when unset. */
export function parseCanaries(secret: string | undefined): Record<string, CanaryConfig> {
  if (!secret) return {};
  let value: unknown;
  try {
    value = JSON.parse(secret);
  } catch {
    logEvent("error", "DATA_API_CANARY is not JSON", { component: "canary" });
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, CanaryConfig] => {
      const valid = isId(entry[0]) && isCanaryConfig(entry[1]);
      if (!valid) logEvent("error", "malformed DATA_API_CANARY entry", { component: "canary" });
      return valid;
    }),
  );
}

export class CanaryError extends Error {}

/** The body as text, failing beyond MAX_BODY_BYTES: a canary response is small. */
async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new CanaryError("Response too large");
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** Only known error codes reach public samples; never echoed credentials. */
const ERROR_CODES = new Set([
  "invalid_request",
  "invalid_query",
  "invalid_cursor",
  "invalid_patch",
  "ttl_invalid",
  "sort_requires_index",
  "assert_requires_index",
  "idempotency_key_required",
  "invalid_schema",
  "invalid_key",
  "invalid_token",
  "forbidden_scope",
  "not_found",
  "unknown_database",
  "unknown_collection",
  "unknown_route",
  "method_not_allowed",
  "conflict_unresolved",
  "unique_violation",
  "patch_conflict",
  "index_limit_exceeded",
  "idempotency_conflict",
  "idempotency_expired",
  "schema_changed",
  "must_refetch",
  "name_taken",
  "index_protected",
  "codec_conversion_unsupported",
  "limit_exceeded",
  "precondition_failed",
  "payload_too_large",
  "transaction_too_large",
  "unsupported_media_type",
  "home_region_required",
  "rate_limited",
  "internal_error",
  "upstream_unavailable",
  "capacity",
  "storage_unavailable",
  "stored_corruption",
  "commit_uncertain",
  "dependencies_unavailable",
]);

/** One canary request: the body of a 2xx response (or of one of
    `statuses`) as text. Anything else throws a CanaryError naming it, with the API's
    error code when it sent one. */
export async function canaryText(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
  statuses?: readonly number[],
): Promise<string> {
  // The timer covers the body too, so a stalled response cannot hold the round.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CANARY_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetcher(url, {
        ...init,
        // A followed redirect would forward the key to its destination.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new CanaryError(controller.signal.aborted ? "Timed out" : "Unreachable");
    }
    const text = await readBounded(response).catch((error: unknown) => {
      if (error instanceof CanaryError) throw error;
      throw new CanaryError(controller.signal.aborted ? "Timed out" : "Unreachable");
    });
    if (!response.ok || (statuses !== undefined && !statuses.includes(response.status))) {
      let code = "";
      try {
        const body = JSON.parse(text) as { error?: { code?: unknown } } | null;
        // Only a documented code is kept: an echoed key must never reach a
        // public sample or incident.
        if (typeof body?.error?.code === "string" && ERROR_CODES.has(body.error.code)) code = ` ${body.error.code}`;
      } catch {
        // Not JSON: the status alone names it.
      }
      throw new CanaryError(`HTTP ${response.status}${code}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** One canary request whose 2xx response must be a JSON object. */
export async function canaryJson(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
  statuses?: readonly number[],
): Promise<unknown> {
  let body: unknown;
  try {
    body = JSON.parse(await canaryText(url, init, fetcher, statuses));
  } catch (error) {
    if (error instanceof CanaryError) throw error;
    throw new CanaryError("Invalid JSON");
  }
  if (body === null || typeof body !== "object") throw new CanaryError("Invalid JSON");
  return body;
}

/** Exchange only at ts-auth; the long-lived key is never sent to TerraBase. */
export async function readToken(
  config: Pick<CanaryConfig, "issuer" | "project" | "key">,
  fetcher: typeof fetch,
): Promise<string> {
  const body = (await canaryJson(
    `${config.issuer}/oauth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.key.slice(0, 26),
        client_secret: config.key,
        project: config.project,
        scope: "documents:read",
      }).toString(),
      cache: "no-store",
    },
    fetcher,
    [200],
  )) as { access_token?: unknown; token_type?: unknown; expires_in?: unknown };
  if (
    typeof body.access_token !== "string" ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.access_token) ||
    body.token_type !== "Bearer" ||
    typeof body.expires_in !== "number" ||
    !Number.isSafeInteger(body.expires_in) ||
    body.expires_in <= 0
  )
    throw new CanaryError("Invalid token response");
  return body.access_token;
}

/** Read a pre-created fixture; the round marker remains in the coordinator's call signature. */
export async function runCanary(
  config: CanaryConfig,
  _marker: string,
  fetcher: typeof fetch = fetch,
): Promise<CanaryResult> {
  const started = Date.now();
  try {
    if (!isCanaryConfig(config)) throw new CanaryError("Invalid probe config");
    const token = await readToken(config, fetcher);
    const read = await canaryJson(
      config.origin + documentPath(config),
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": USER_AGENT,
          "X-TerraScale-Region-Pin": config.region,
        },
        cache: "no-store",
      },
      fetcher,
      [200],
    );
    if (!holdsDocument(read, config.document)) throw new CanaryError("Invalid response");
    return { ok: true, latencyMs: Date.now() - started, error: null };
  } catch (error) {
    if (error instanceof CanaryError) return { ok: false, latencyMs: null, error: error.message };
    throw error;
  }
}

/** The round's sample of a canary endpoint, with hysteresis like any other:
    one failed round shows as degraded, two as an outage. */
export function canarySample(
  endpointId: string,
  result: CanaryResult,
  streak: number,
): { sample: Sample; streak: number } {
  let round: TimelineState;
  if (!result.ok) round = "major_outage";
  else if ((result.latencyMs ?? 0) > SLOW_MS) round = "degraded";
  else round = "operational";
  const settled = settle(round, streak);
  return {
    sample: {
      endpointId,
      state: settled.state,
      ok: result.ok ? 1 : 0,
      total: 1,
      latencyMs: result.latencyMs,
      results: [{ v: CANARY_VANTAGE, ok: result.ok ? 1 : 0, ms: result.latencyMs, e: result.error }],
      values: null,
    },
    streak: settled.streak,
  };
}
