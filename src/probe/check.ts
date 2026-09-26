/* One HTTP health check. A check passes on a 2xx answer within the timeout;
   the body is discarded unread. */

import type { Target, TargetResult } from "./protocol";

/** A probe slower than this fails. */
export const PROBE_TIMEOUT_MS = 5_000;

export const USER_AGENT = "TerraScale-Status/2 (+https://status.terrascale.tech)";

export async function check(target: Target, fetcher: typeof fetch = fetch): Promise<TargetResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), PROBE_TIMEOUT_MS);
  try {
    const response = await fetcher(target.url, {
      headers: { "user-agent": USER_AGENT, ...(JSON.parse(target.headers) as Record<string, string>) },
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    await response.body?.cancel();
    return response.ok
      ? { key: target.key, ok: true, latencyMs, error: null }
      : { key: target.key, ok: false, latencyMs, error: `HTTP ${response.status}` };
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return {
      key: target.key,
      ok: false,
      latencyMs: Date.now() - started,
      error: timedOut ? "Timed out" : "Unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}
