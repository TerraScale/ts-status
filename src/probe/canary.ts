/* The authenticated data API canary. Each round the coordinator writes the
   round's marker into a dedicated canary document with a scoped key, then
   reads it back. Unlike the vantages' unauthenticated probes, this proves
   that keys are accepted and that writes commit and become readable.

   It is configured by the DATA_API_CANARY Worker secret: a JSON object
   mapping canary endpoint ids to their document and key. Canary endpoints
   are seeded disabled; once enabled, one the secret does not configure
   fails every round, so losing the secret is never silent. */

import { settle } from "../domain/consensus";
import { SLOW_MS, type TimelineState } from "../domain/status";
import { MAX_BODY_BYTES, USER_AGENT } from "./check";
import type { Sample } from "./round";

/** Each canary request slower than this fails. */
export const CANARY_TIMEOUT_MS = 5_000;

/** How long a canary commit's transaction id stays valid. */
const TRANSACTION_TTL_MS = 60_000;

/** The `v` a canary result is stored under: it is not a vantage. */
export const CANARY_VANTAGE = "canary";

export interface CanaryConfig {
  /** The regional API origin, e.g. https://gru.api.terrascale.tech. */
  origin: string;
  tenant: string;
  database: string;
  shard: string;
  collection: string;
  document: string;
  schemaGeneration: string;
  schemaDigest: string;
  /** The utf8 field the marker is written to. */
  fieldId: number;
  /** A tbk1 key scoped to read and write the canary collection only. */
  key: string;
}

export interface CanaryResult {
  ok: boolean;
  /** Write plus read-back time; null when the canary failed. */
  latencyMs: number | null;
  error: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isConfig(value: unknown): value is CanaryConfig {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.origin === "string" &&
    /^https:\/\/[^/]+$/.test(entry.origin) &&
    [entry.tenant, entry.database, entry.collection, entry.document].every(
      (id) => typeof id === "string" && UUID.test(id),
    ) &&
    typeof entry.shard === "string" &&
    /^(0|[1-9][0-9]*)$/.test(entry.shard) &&
    typeof entry.schemaGeneration === "string" &&
    /^[1-9][0-9]*$/.test(entry.schemaGeneration) &&
    typeof entry.schemaDigest === "string" &&
    /^[0-9a-f]{64}$/.test(entry.schemaDigest) &&
    typeof entry.fieldId === "number" &&
    Number.isInteger(entry.fieldId) &&
    entry.fieldId >= 1 &&
    typeof entry.key === "string" &&
    entry.key.length > 0
  );
}

/** Reads the canary secret, dropping malformed entries; empty when unset. */
export function parseCanaries(secret: string | undefined): Record<string, CanaryConfig> {
  if (!secret) return {};
  let value: unknown;
  try {
    value = JSON.parse(secret);
  } catch {
    console.error("DATA_API_CANARY is not JSON");
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, CanaryConfig] => {
      const valid = isConfig(entry[1]);
      if (!valid) console.error("malformed DATA_API_CANARY entry", entry[0]);
      return valid;
    }),
  );
}

class CanaryError extends Error {}

interface Point {
  state: "absent" | "deleted" | "value" | "conflict";
  context: unknown[];
  siblings: { kind: string; fields?: { id: number; value: { type: string; value?: unknown } }[] }[];
}

const isObserved = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.replica === "string" && typeof entry.incarnation === "string" && typeof entry.sequence === "string"
  );
};

const isSibling = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const sibling = value as Record<string, unknown>;
  if (typeof sibling.kind !== "string") return false;
  if (sibling.fields === undefined) return sibling.kind !== "live";
  return (
    Array.isArray(sibling.fields) &&
    sibling.fields.every((field: unknown) => {
      if (typeof field !== "object" || field === null) return false;
      const entry = field as Record<string, unknown>;
      return (
        typeof entry.id === "number" &&
        typeof entry.value === "object" &&
        entry.value !== null &&
        typeof (entry.value as Record<string, unknown>).type === "string"
      );
    })
  );
};

/** A point read as the API documents it; anything else fails the canary
    before it writes, so a malformed context never makes a blind write. */
function asPoint(value: unknown): Point {
  const point = value as Partial<Point> | null;
  if (
    typeof point !== "object" ||
    point === null ||
    !["absent", "deleted", "value", "conflict"].includes(String(point.state)) ||
    !Array.isArray(point.context) ||
    !point.context.every(isObserved) ||
    !Array.isArray(point.siblings) ||
    !point.siblings.every(isSibling)
  ) {
    throw new CanaryError("Invalid point");
  }
  return point as Point;
}

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

const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Writes `marker` into the canary document and reads it back. */
export async function runCanary(
  config: CanaryConfig,
  marker: string,
  fetcher: typeof fetch = fetch,
): Promise<CanaryResult> {
  const shard = `${config.origin}/v1/tenants/${config.tenant}/databases/${config.database}/shards/${config.shard}`;
  const point = `${shard}/collections/${config.collection}/documents/${config.document}`;
  const headers = { authorization: `Bearer ${config.key}`, "user-agent": USER_AGENT };

  const call = async (url: string, init: RequestInit = {}): Promise<unknown> => {
    // The timer covers the body too, so a stalled response cannot hold the round.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CANARY_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await fetcher(url, {
          ...init,
          headers: { ...headers, ...init.headers },
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
      let body: { error?: { code?: unknown } } | null = null;
      try {
        body = JSON.parse(text) as { error?: { code?: unknown } } | null;
      } catch {
        // Judged below by status first.
      }
      if (!response.ok) {
        const code = typeof body?.error?.code === "string" ? ` ${body.error.code}` : "";
        throw new CanaryError(`HTTP ${response.status}${code}`);
      }
      if (body === null || typeof body !== "object") throw new CanaryError("Invalid JSON");
      return body;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    // Updating needs the current context as observed.
    const before = asPoint(await call(point, { cache: "no-store" }));
    const started = Date.now();
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    await call(`${shard}/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        transaction_id: { expires_at_unix_ms: String(Date.now() + TRANSACTION_TTL_MS), nonce },
        writes: [
          {
            collection: config.collection,
            document: config.document,
            schema_generation: config.schemaGeneration,
            schema_digest: config.schemaDigest,
            observed: before.context,
            value: { kind: "live", fields: [{ id: config.fieldId, value: { type: "utf8", value: marker } }] },
          },
        ],
      }),
    });
    const after = asPoint(await call(point, { cache: "no-store" }));
    const latencyMs = Date.now() - started;
    // Only a settled value holding the utf8 marker proves the write; a
    // conflict means another writer raced it.
    const read =
      after.state === "value" &&
      after.siblings.some(
        (sibling) =>
          sibling.kind === "live" &&
          sibling.fields?.some(
            (field) => field.id === config.fieldId && field.value.type === "utf8" && field.value.value === marker,
          ),
      );
    return read ? { ok: true, latencyMs, error: null } : { ok: false, latencyMs: null, error: "Write not readable" };
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
