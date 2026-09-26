/* One probe round: every vantage probes every enabled endpoint, and the
   results become one sample per endpoint. Rounds start on the half minute
   and are keyed by that moment, so a retried round never counts twice. */

import { sqlTime } from "../db/reads";
import { consensus, settle, type VantageResult } from "../domain/consensus";
import type { Env } from "../env";
import type { ProbeResponse, Target } from "./protocol";
import { VANTAGES, type Vantage } from "./vantages";

export const ROUND_MS = 30_000;

/** A vantage that has not answered by now is left out of the round. */
export const VANTAGE_TIMEOUT_MS = 8_000;

/** The round a moment belongs to. */
export const roundOf = (at: number): number => at - (at % ROUND_MS);

export interface RoundEndpoint {
  id: string;
  url: string;
  headers: string;
}

export interface Sample {
  endpointId: string;
  state: string;
  ok: number;
  total: number;
  latencyMs: number | null;
  results: { v: string; ok: 0 | 1; ms: number; e: string | null }[];
}

/** Targets to probe: endpoints sharing a URL and headers are probed once. */
export function targets(endpoints: readonly RoundEndpoint[]): Target[] {
  const unique = new Map<string, Target>();
  for (const endpoint of endpoints) {
    const key = `${endpoint.url}\n${endpoint.headers}`;
    unique.set(key, { key, url: endpoint.url, headers: endpoint.headers });
  }
  return [...unique.values()];
}

/** Turns the vantages' answers into samples, updating each endpoint's down
    streak. A missing answer leaves that vantage out, never counts as down. */
export function evaluate(
  endpoints: readonly RoundEndpoint[],
  responses: readonly (ProbeResponse | null)[],
  streaks: Readonly<Record<string, number>>,
): { samples: Sample[]; streaks: Record<string, number> } {
  const answered = responses.filter((response): response is ProbeResponse => response !== null);
  const next: Record<string, number> = {};
  const samples = endpoints.map((endpoint): Sample => {
    const key = `${endpoint.url}\n${endpoint.headers}`;
    const results: VantageResult[] = answered.flatMap((response) => {
      const result = response.results.find((entry) => entry.key === key);
      return result ? [{ vantage: response.vantage, ...result }] : [];
    });
    const round = consensus(results);
    const settled = settle(round.state, streaks[endpoint.id] ?? 0);
    if (settled.streak > 0) next[endpoint.id] = settled.streak;
    return {
      endpointId: endpoint.id,
      state: settled.state,
      ok: round.ok,
      total: round.total,
      latencyMs: round.latencyMs,
      results: results.map((result) => ({
        v: result.vantage,
        ok: result.ok ? 1 : 0,
        ms: result.latencyMs,
        e: result.error,
      })),
    };
  });
  return { samples, streaks: next };
}

/** Asks one vantage to probe the targets; null when it fails to answer. */
async function ask(vantage: Vantage, fetcher: Fetcher, list: readonly Target[]): Promise<ProbeResponse | null> {
  // A cleared timer, unlike AbortSignal.timeout, never keeps the alarm
  // running once every vantage has answered.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VANTAGE_TIMEOUT_MS);
  try {
    const response = await fetcher.fetch("https://vantage/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: list }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as ProbeResponse;
  } catch (error) {
    console.error("vantage did not answer", vantage.code, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const INSERT_SAMPLE = `INSERT OR IGNORE INTO probe_samples (endpoint_id, at, state, ok, total, latency_ms, results)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

const SEEN = `INSERT INTO vantages (code, colo, seen_at) VALUES (?1, ?2, ?3)
  ON CONFLICT (code) DO UPDATE SET colo = excluded.colo, seen_at = excluded.seen_at`;

export interface RoundResult {
  streaks: Record<string, number>;
  /** Where every answering vantage ran. */
  colos: Record<string, string | null>;
}

/** Runs the round starting at `at` and stores its samples. Vantage
    locations are written only when they change from `colos`. */
export async function runRound(
  env: Env,
  at: number,
  streaks: Readonly<Record<string, number>>,
  colos: Readonly<Record<string, string | null>>,
): Promise<RoundResult> {
  const { results: endpoints } = await env.STATUS_DB.prepare(
    "SELECT id, url, headers FROM endpoints WHERE enabled = 1",
  ).all<RoundEndpoint>();
  if (!endpoints?.length) return { streaks: {}, colos: { ...colos } };

  const list = targets(endpoints);
  const responses = await Promise.all(VANTAGES.map((vantage) => ask(vantage, env[vantage.binding], list)));
  const evaluated = evaluate(endpoints, responses, streaks);

  const time = sqlTime(at);
  const statements = evaluated.samples.map((sample) =>
    env.STATUS_DB.prepare(INSERT_SAMPLE).bind(
      sample.endpointId,
      time,
      sample.state,
      sample.ok,
      sample.total,
      sample.latencyMs,
      JSON.stringify(sample.results),
    ),
  );
  const seen = { ...colos };
  for (const response of responses) {
    if (!response || (response.vantage in seen && seen[response.vantage] === response.colo)) continue;
    seen[response.vantage] = response.colo;
    statements.push(env.STATUS_DB.prepare(SEEN).bind(response.vantage, response.colo, time));
  }
  await env.STATUS_DB.batch(statements);
  return { streaks: evaluated.streaks, colos: seen };
}
