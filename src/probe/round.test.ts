import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { testD1 } from "../testing/d1";
import type { ProbeRequest, ProbeResponse } from "./protocol";
import { evaluate, roundOf, runRound, targets } from "./round";

const endpoints = [
  { id: "a", url: "https://x.test/health", headers: "{}" },
  { id: "b", url: "https://x.test/health", headers: "{}" },
  { id: "c", url: "https://y.test/health", headers: "{}" },
];

const answer = (vantage: string, colo: string, ok: (url: string) => boolean) => ({
  vantage,
  colo,
  results: targets(endpoints).map((target) => ({
    key: target.key,
    ok: ok(target.url),
    latencyMs: 50,
    error: ok(target.url) ? null : "HTTP 503",
  })),
});

describe("targets", () => {
  it("probes a shared URL once", () => {
    expect(targets(endpoints).map((target) => target.url)).toEqual(["https://x.test/health", "https://y.test/health"]);
  });
});

describe("roundOf", () => {
  it("starts rounds on the half minute", () => {
    expect(roundOf(Date.parse("2026-09-26T10:00:44.123Z"))).toBe(Date.parse("2026-09-26T10:00:30Z"));
  });
});

describe("evaluate", () => {
  const down = (url: string) => !url.includes("y.test");

  it("judges each endpoint across the answering vantages", () => {
    const responses = [answer("sfo", "SJC", down), answer("fra", "FRA", down), null];
    const { samples, streaks } = evaluate(endpoints, responses, {});
    expect(samples.map((sample) => [sample.endpointId, sample.state, sample.ok, sample.total])).toEqual([
      ["a", "operational", 2, 2],
      ["b", "operational", 2, 2],
      ["c", "degraded", 0, 2],
    ]);
    expect(samples[2]?.results).toEqual([
      { v: "sfo", ok: 0, ms: 50, e: "HTTP 503" },
      { v: "fra", ok: 0, ms: 50, e: "HTTP 503" },
    ]);
    // The first down round is a streak of one; the second confirms it.
    expect(streaks).toEqual({ c: 1 });
    expect(evaluate(endpoints, responses, streaks).samples[2]?.state).toBe("major_outage");
  });

  it("cannot judge when only one vantage answered", () => {
    const { samples } = evaluate(endpoints, [answer("sfo", "SJC", () => false), null, null, null], {});
    expect(samples.every((sample) => sample.state === "none")).toBe(true);
  });
});

describe("runRound", () => {
  it("stores one sample per endpoint and each vantage's location once", async () => {
    const db = testD1();
    const asked: string[] = [];
    const vantage = (code: string, colo: string) => ({
      fetch: async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as ProbeRequest;
        asked.push(`${code}:${body.targets.length}`);
        return Response.json({
          vantage: code,
          colo,
          results: body.targets.map((target) => ({ key: target.key, ok: true, latencyMs: 40, error: null })),
        } satisfies ProbeResponse);
      },
    });
    const env = {
      STATUS_DB: db,
      VANTAGE_SFO: vantage("sfo", "SJC"),
      VANTAGE_GRU: vantage("gru", "GRU"),
      VANTAGE_FRA: vantage("fra", "FRA"),
      VANTAGE_NRT: { fetch: async () => new Response("boom", { status: 500 }) },
    } as unknown as Env;

    const at = Date.parse("2026-09-26T10:00:30Z");
    const first = await runRound(env, at, {}, {});
    // Retrying the same round stores nothing new.
    const second = await runRound(env, at, first.streaks, first.colos);

    expect(asked).toHaveLength(6);
    expect(first.colos).toEqual({ sfo: "SJC", gru: "GRU", fra: "FRA" });
    expect(second.colos).toEqual(first.colos);
    const samples = db.sqlite
      .prepare("SELECT endpoint_id, state, ok, total FROM probe_samples ORDER BY endpoint_id")
      .all();
    expect(samples).toEqual([
      { endpoint_id: "atlas-workers", state: "operational", ok: 3, total: 3 },
      { endpoint_id: "dashboard-fly-gru", state: "operational", ok: 3, total: 3 },
      { endpoint_id: "git-forgejo", state: "operational", ok: 3, total: 3 },
      { endpoint_id: "website-pages", state: "operational", ok: 3, total: 3 },
    ]);
    expect(db.sqlite.prepare("SELECT code, colo FROM vantages ORDER BY code").all()).toHaveLength(3);
  });
});
