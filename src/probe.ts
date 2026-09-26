/* Health probes, run by the cron trigger every minute. Each run checks every
   enabled endpoint in parallel and records the results in one D1 batch. */

import type { Env } from "./data";
import { sqlTime } from "./data";
import { DAY, startOfHour } from "./format";

/** A probe slower than this fails. */
export const PROBE_TIMEOUT_MS = 5_000;

/** Hourly rollups are kept this long. */
export const PROBE_RETENTION_MS = 30 * DAY;

interface Target {
  id: string;
  url: string;
  headers: string;
}

export interface ProbeResult {
  id: string;
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

export async function probe(target: Target, fetcher: typeof fetch = fetch): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const response = await fetcher(target.url, {
      headers: { "user-agent": "TerraScale-Status/1 (+https://status.terrascale.tech)", ...JSON.parse(target.headers) },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    await response.body?.cancel();
    return response.ok
      ? { id: target.id, ok: true, latencyMs, error: null }
      : { id: target.id, ok: false, latencyMs, error: `HTTP ${response.status}` };
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return { id: target.id, ok: false, latencyMs: Date.now() - started, error: timedOut ? "Timed out" : "Unreachable" };
  }
}

const RECORD_HOUR = `INSERT INTO probe_hours (endpoint_id, hour, checks, failures, latency_sum, latency_max)
  VALUES (?1, ?2, 1, ?3, ?4, ?4)
  ON CONFLICT (endpoint_id, hour) DO UPDATE SET
    checks = checks + 1,
    failures = failures + excluded.failures,
    latency_sum = latency_sum + excluded.latency_sum,
    latency_max = max(latency_max, excluded.latency_max)`;

const RECORD_LATEST = `UPDATE endpoints SET last_checked_at = ?2, last_ok = ?3, last_latency_ms = ?4, last_error = ?5,
  consecutive_failures = CASE WHEN ?3 = 1 THEN 0 ELSE consecutive_failures + 1 END
  WHERE id = ?1`;

/** Probes every enabled endpoint and stores the results. */
export async function probeAll(env: Env, now: number, fetcher: typeof fetch = fetch): Promise<ProbeResult[]> {
  const { results: targets } = await env.STATUS_DB.prepare(
    "SELECT id, url, headers FROM endpoints WHERE enabled = 1",
  ).all<Target>();
  if (!targets?.length) return [];

  const results = await Promise.all(targets.map((target) => probe(target, fetcher)));
  const hour = sqlTime(startOfHour(now));
  const checkedAt = sqlTime(now);
  const statements = results.flatMap((result) => [
    env.STATUS_DB.prepare(RECORD_HOUR).bind(result.id, hour, result.ok ? 0 : 1, result.ok ? result.latencyMs : 0),
    env.STATUS_DB.prepare(RECORD_LATEST).bind(result.id, checkedAt, result.ok ? 1 : 0, result.latencyMs, result.error),
  ]);
  // Prune once an hour, on the first run of the hour.
  if (now - startOfHour(now) < 60_000) {
    statements.push(
      env.STATUS_DB.prepare("DELETE FROM probe_hours WHERE hour < ?1").bind(sqlTime(now - PROBE_RETENTION_MS)),
    );
  }
  await env.STATUS_DB.batch(statements);
  return results;
}
