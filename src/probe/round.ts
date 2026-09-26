/* One probe round: every vantage probes every enabled endpoint, and the
   results become one sample per endpoint. Rounds start on the half minute
   and are keyed by that moment, so a retried round never counts twice. */

import { sqlTime } from "../db/reads";
import { judge, needsBody, parseSpec, type CheckSpec } from "../domain/assertions";
import { consensus, settle, type VantageResult } from "../domain/consensus";
import type { Env } from "../env";
import type { ProbeResponse, Target } from "./protocol";
import { VANTAGES, type Vantage } from "./vantages";

export const ROUND_MS = 30_000;

/** A vantage that has not answered by now is left out of the round. */
export const VANTAGE_TIMEOUT_MS = 8_000;

/** The round a moment belongs to. */
export const roundOf = (at: number): number => at - (at % ROUND_MS);

/** An endpoint as a round reads it. */
export interface RoundEndpoint {
  id: string;
  url: string;
  headers: string;
  spec: CheckSpec;
}

export interface Sample {
  endpointId: string;
  state: string;
  ok: number;
  total: number;
  latencyMs: number | null;
  /** Each vantage's result; `ok` is null where the result was unknown, and
      `ms` is null where the time measured is not the endpoint's own. */
  results: { v: string; ok: 0 | 1 | null; ms: number | null; e: string | null }[];
  /** Values extracted by the first passing vantage. */
  values: Record<string, unknown> | null;
}

const keyOf = (endpoint: Pick<RoundEndpoint, "url" | "headers">): string => `${endpoint.url}\n${endpoint.headers}`;

/** Targets to probe: endpoints sharing a URL and headers are probed once,
    with the body when any of them needs it. */
export function targets(endpoints: readonly RoundEndpoint[]): Target[] {
  const unique = new Map<string, Target>();
  for (const endpoint of endpoints) {
    const key = keyOf(endpoint);
    const body = (unique.get(key)?.body ?? false) || needsBody(endpoint.spec);
    unique.set(key, { key, url: endpoint.url, headers: endpoint.headers, body });
  }
  return [...unique.values()];
}

/** Judges every vantage's observation of every endpoint and turns them into
    samples, updating each endpoint's down streak. A vantage that did not
    answer, or whose result is unknown, is left out, never counts as down. */
export function evaluate(
  endpoints: readonly RoundEndpoint[],
  responses: readonly (ProbeResponse | null)[],
  streaks: Readonly<Record<string, number>>,
): { samples: Sample[]; streaks: Record<string, number> } {
  const answered = responses.filter((response): response is ProbeResponse => response !== null);
  const next: Record<string, number> = {};
  const samples = endpoints.map((endpoint): Sample => {
    const key = keyOf(endpoint);
    // An indirect source's response time is the source's, not the endpoint's.
    const latencyOf = (observation: { latencyMs: number }) => (endpoint.spec.indirect ? null : observation.latencyMs);
    const judged = answered.flatMap((response) => {
      const observation = response.results.find((entry) => entry.key === key);
      return observation
        ? [{ vantage: response.vantage, observation, judgement: judge(endpoint.spec, observation) }]
        : [];
    });
    const known: VantageResult[] = judged
      .filter((entry) => entry.judgement.outcome !== "unknown")
      .map((entry) => ({
        vantage: entry.vantage,
        ok: entry.judgement.outcome === "ok",
        latencyMs: latencyOf(entry.observation),
        error: entry.judgement.error,
      }));
    const round = consensus(known);
    const settled = settle(round.state, streaks[endpoint.id] ?? 0);
    if (settled.streak > 0) next[endpoint.id] = settled.streak;
    const values = judged.find((entry) => entry.judgement.outcome === "ok")?.judgement.values;
    return {
      endpointId: endpoint.id,
      state: settled.state,
      ok: round.ok,
      total: round.total,
      latencyMs: round.latencyMs,
      results: judged.map((entry) => ({
        v: entry.vantage,
        ok: entry.judgement.outcome === "unknown" ? null : entry.judgement.outcome === "ok" ? 1 : 0,
        ms: latencyOf(entry.observation),
        e: entry.judgement.error,
      })),
      values: values && Object.keys(values).length > 0 ? values : null,
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

const ENDPOINTS = `SELECT id, url, headers, expect_status AS expectStatus, keyword, assertions, extract, indirect
  FROM endpoints WHERE enabled = 1`;

const INSERT_SAMPLE = `INSERT OR IGNORE INTO probe_samples (endpoint_id, at, state, ok, total, latency_ms, results, "values")
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`;

const DEPLOYED = "INSERT OR IGNORE INTO deploys (endpoint_id, version, detected_at) VALUES (?1, ?2, ?3)";

const SEEN = `INSERT INTO vantages (code, colo, seen_at) VALUES (?1, ?2, ?3)
  ON CONFLICT (code) DO UPDATE SET colo = excluded.colo, seen_at = excluded.seen_at`;

/** What a round remembers for the next one. */
export interface RoundState {
  /** Consecutive down rounds per endpoint. */
  streaks: Record<string, number>;
  /** Where every answering vantage last ran. */
  colos: Record<string, string | null>;
  /** The last version seen per endpoint. */
  versions: Record<string, string>;
}

type EndpointRow = Omit<RoundEndpoint, "spec"> & Parameters<typeof parseSpec>[0];

/** Runs the round starting at `at` and stores its samples. Vantage
    locations are written when they change, and a version that differs
    from the last one seen is recorded as a deploy. */
export async function runRound(env: Env, at: number, previous: RoundState): Promise<RoundState> {
  const { results: rows } = await env.STATUS_DB.prepare(ENDPOINTS).all<EndpointRow>();
  if (!rows?.length) return { ...previous, streaks: {} };
  const endpoints = rows.map((row): RoundEndpoint => ({
    id: row.id,
    url: row.url,
    headers: row.headers,
    spec: parseSpec(row),
  }));

  const list = targets(endpoints);
  const responses = await Promise.all(VANTAGES.map((vantage) => ask(vantage, env[vantage.binding], list)));
  const evaluated = evaluate(endpoints, responses, previous.streaks);

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
      sample.values && JSON.stringify(sample.values),
    ),
  );
  const versions = { ...previous.versions };
  for (const sample of evaluated.samples) {
    const version = sample.values?.version;
    if (typeof version !== "string" && typeof version !== "number") continue;
    const text = String(version).slice(0, 100);
    if (sample.endpointId in versions && versions[sample.endpointId] !== text) {
      statements.push(env.STATUS_DB.prepare(DEPLOYED).bind(sample.endpointId, text, time));
    }
    versions[sample.endpointId] = text;
  }
  const seen = { ...previous.colos };
  for (const response of responses) {
    if (!response || (response.vantage in seen && seen[response.vantage] === response.colo)) continue;
    seen[response.vantage] = response.colo;
    statements.push(env.STATUS_DB.prepare(SEEN).bind(response.vantage, response.colo, time));
  }
  await env.STATUS_DB.batch(statements);
  return { streaks: evaluated.streaks, colos: seen, versions };
}
