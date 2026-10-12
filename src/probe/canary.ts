/* The authenticated data API canary. Each round the coordinator writes the
   round's marker into a dedicated canary document with a scoped key, then
   reads it back. Unlike the vantages' unauthenticated probes, this proves
   that keys are accepted and that writes commit and become readable.

   It is configured by the DATA_API_CANARY Worker secret: a JSON object
   mapping canary endpoint ids to their document and key. A canary the
   secret does not configure shows "Not configured" and counts toward no
   uptime, like the TerraBase probes. */

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
  /** The Fly region the requests prefer, e.g. gru: one host serves every region. */
  region: string;
  project: string;
  database: string;
  collection: string;
  document: string;
  /** A tb_ API key with documents:read and documents:write. */
  key: string;
}

export interface CanaryResult {
  ok: boolean;
  /** Write plus read-back time; null when the canary failed. */
  latencyMs: number | null;
  error: string | null;
}

const NAME = /^[a-z][a-z0-9_-]{0,62}$/;
const VERSION = /^tbv1-[0-9a-f]{32}$/;
const FLY_REGION = /^[a-z]{3}$/;

/** A Fly region code, e.g. gru or sjc. */
export const isFlyRegion = (value: unknown): value is string => typeof value === "string" && FLY_REGION.test(value);

export function isCanaryConfig(value: unknown): value is CanaryConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  try {
    const url = new URL(String(entry.origin));
    return (
      url.protocol === "https:" &&
      url.origin === entry.origin &&
      isFlyRegion(entry.region) &&
      typeof entry.project === "string" &&
      isId(entry.project) &&
      typeof entry.database === "string" &&
      NAME.test(entry.database) &&
      typeof entry.collection === "string" &&
      NAME.test(entry.collection) &&
      typeof entry.document === "string" &&
      isId(entry.document) &&
      typeof entry.key === "string" &&
      entry.key.startsWith("tb_") &&
      entry.key.length > 3
    );
  } catch {
    return false;
  }
}

export const collectionPath = (config: Pick<CanaryConfig, "project" | "database" | "collection">): string =>
  `/v1/projects/${config.project}/databases/${config.database}/collections/${config.collection}`;

// The v1 by-key route takes the raw document ULID in the query, not the path.
export const documentPath = (config: CanaryConfig): string =>
  `${collectionPath(config)}/documents/by-key?id=${config.document}`;

/** Validate the C# document write acknowledgement, including durability. */
export function written(value: unknown): string {
  const body = value as { id?: unknown; version?: unknown; offset?: unknown; durability?: unknown } | null;
  if (
    !body ||
    typeof body.id !== "string" ||
    !isId(body.id) ||
    typeof body.version !== "string" ||
    !VERSION.test(body.version) ||
    typeof body.offset !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(body.offset) ||
    body.durability !== "local_durable"
  )
    throw new CanaryError("Invalid response");
  return body.id;
}

export const holdsDocument = (value: unknown, id: string, marker: string): boolean => {
  const body = value as { id?: unknown; version?: unknown; state?: unknown; document?: { canary?: unknown } } | null;
  return (
    body?.id === id &&
    typeof body.version === "string" &&
    VERSION.test(body.version) &&
    body.state === "value" &&
    body.document?.canary === marker
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

/** Writes the round marker to one dedicated document and verifies it immediately. */
export async function runCanary(
  config: CanaryConfig,
  marker: string,
  fetcher: typeof fetch = fetch,
): Promise<CanaryResult> {
  const url = config.origin + documentPath(config);
  const headers = {
    authorization: `Bearer ${config.key}`,
    "user-agent": USER_AGENT,
    "fly-prefer-region": config.region,
  };
  const started = Date.now();
  try {
    if (!isCanaryConfig(config)) throw new CanaryError("Invalid probe config");
    const write = await canaryJson(
      url,
      {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ canary: marker }),
      },
      fetcher,
      [200, 201],
    );
    if (written(write) !== config.document) throw new CanaryError("Invalid response");
    const read = await canaryJson(url, { headers, cache: "no-store" }, fetcher, [200]);
    if (!holdsDocument(read, config.document, marker)) throw new CanaryError("Write not readable");
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
