import { describe, expect, it } from "vitest";
import type { CheckSpec } from "../domain/assertions";
import type { Env } from "../env";
import { testD1 } from "../testing/d1";
import type { ProbeRequest, ProbeResponse } from "./protocol";
import { evaluate, roundOf, runRound, targets, type RoundEndpoint } from "./round";

const plain: CheckSpec = { expectStatus: "2xx", keyword: null, assertions: [], extract: {}, indirect: false };
const atlas = (code: string): CheckSpec => ({
  ...plain,
  assertions: [{ path: `regions[code=${code}].available`, op: "eq", value: true }],
  extract: { lag_ms: `regions[code=${code}].lag_ms` },
  indirect: true,
});

const endpoints: RoundEndpoint[] = [
  { id: "gru", url: "https://atlas.test/regions", headers: "{}", spec: atlas("GRU") },
  { id: "sfo", url: "https://atlas.test/regions", headers: "{}", spec: atlas("SFO") },
  { id: "web", url: "https://web.test/", headers: "{}", spec: plain },
];

const catalog = JSON.stringify({
  regions: [
    { code: "GRU", available: true, lag_ms: 9 },
    { code: "SFO", available: false },
  ],
});

/** A vantage's answer: atlas answering with `atlasStatus`, the website with `webStatus`. */
const answer = (vantage: string, atlasStatus: number, webStatus = 200): ProbeResponse => ({
  vantage,
  colo: vantage.toUpperCase(),
  results: targets(endpoints).map((target) =>
    target.url.includes("atlas")
      ? { key: target.key, status: atlasStatus, latencyMs: 50, error: null, body: catalog }
      : { key: target.key, status: webStatus, latencyMs: 30, error: null },
  ),
});

describe("targets", () => {
  it("probes a shared URL once, with its body when any endpoint needs it", () => {
    expect(targets(endpoints).map((target) => [target.url, target.body])).toEqual([
      ["https://atlas.test/regions", true],
      ["https://web.test/", false],
    ]);
  });
});

describe("roundOf", () => {
  it("starts rounds on the half minute", () => {
    expect(roundOf(Date.parse("2026-09-26T10:00:44.123Z"))).toBe(Date.parse("2026-09-26T10:00:30Z"));
  });
});

describe("evaluate", () => {
  it("judges each endpoint on the shared observation", () => {
    const { samples, streaks } = evaluate(endpoints, [answer("sfo", 200), answer("fra", 200), null], {});
    expect(samples.map((sample) => [sample.endpointId, sample.state, sample.ok, sample.total])).toEqual([
      ["gru", "operational", 2, 2],
      ["sfo", "degraded", 0, 2],
      ["web", "operational", 2, 2],
    ]);
    expect(samples[0]?.values).toEqual({ lag_ms: 9 });
    expect(samples[1]?.results[0]).toEqual({
      v: "sfo",
      ok: 0,
      ms: null,
      e: "Expected regions[code=SFO].available eq true",
    });
    // The first down round is a streak of one; the second confirms it.
    expect(streaks).toEqual({ sfo: 1 });
    expect(evaluate(endpoints, [answer("sfo", 200), answer("fra", 200)], streaks).samples[1]?.state).toBe(
      "major_outage",
    );
  });

  it("leaves unknown results out: a failing indirect source never marks its cells down", () => {
    const { samples } = evaluate(endpoints, [answer("sfo", 503, 503), answer("fra", 503, 503)], {});
    expect(samples.map((sample) => sample.state)).toEqual(["none", "none", "degraded"]);
    expect(samples[0]?.results).toEqual([
      { v: "sfo", ok: null, ms: null, e: "HTTP 503" },
      { v: "fra", ok: null, ms: null, e: "HTTP 503" },
    ]);
  });

  it("never counts a known blocked probe as down, and keeps the streak", () => {
    const blocked = ["sfo", "gru", "fra", "nrt"].map((code) => answer(code, 200, 403));
    const known = endpoints.map((endpoint) =>
      endpoint.id === "web" ? { ...endpoint, spec: { ...plain, blockedStatus: 403 } } : endpoint,
    );
    const { samples, streaks } = evaluate(known, blocked, { web: 1 });
    expect(samples[2]?.state).toBe("none");
    expect(samples[2]?.results[0]).toEqual({ v: "sfo", ok: null, ms: 30, e: "Probe blocked (HTTP 403)" });
    expect(streaks.web).toBe(1);
  });

  it("cannot judge when only one vantage answered", () => {
    const { samples } = evaluate(endpoints, [answer("sfo", 200, 503), null, null, null], {});
    expect(samples.every((sample) => sample.state === "none")).toBe(true);
  });
});

describe("runRound", () => {
  it("stores one sample per endpoint, each vantage's location once, and new versions as deploys", async () => {
    const db = testD1();
    let version = "1.0.0";
    const asked: string[] = [];
    const vantage = (code: string) => ({
      fetch: async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as ProbeRequest;
        asked.push(code);
        return Response.json({
          vantage: code,
          colo: code.toUpperCase(),
          results: body.targets.map((target) => ({
            key: target.key,
            status: target.url.includes("openid-configuration")
              ? 404
              : target.url.includes("api.terrascale.tech/v1/")
                ? 401
                : 200,
            latencyMs: 40,
            error: null,
            body: target.body
              ? JSON.stringify({
                  status: target.url.includes("git") ? "pass" : target.url.includes("auth") ? "ready" : "ok",
                  version,
                  regions: [{ code: "GRU-1", available: true }],
                  hosts: { "GRU-1": "gru.api.terrascale.tech" },
                  error: { code: "invalid_key" },
                })
              : undefined,
          })),
        } satisfies ProbeResponse);
      },
    });
    const env = {
      STATUS_DB: db,
      VANTAGE_SFO: vantage("sfo"),
      VANTAGE_GRU: vantage("gru"),
      VANTAGE_FRA: vantage("fra"),
      VANTAGE_NRT: { fetch: async () => new Response("boom", { status: 500 }) },
    } as unknown as Env;
    // The website must mention TerraScale; this stand-in answers JSON, so it fails.
    const at = Date.parse("2026-09-26T10:00:30Z");
    const first = await runRound(env, at, { streaks: {}, colos: {}, versions: {}, trackers: {} });
    // Retrying the same round stores nothing new.
    const again = await runRound(env, at, first);
    version = "1.1.0";
    await runRound(env, at + 30_000, again);

    expect(asked).toHaveLength(9);
    expect(first.colos).toEqual({ sfo: "SFO", gru: "GRU", fra: "FRA" });
    expect(first.versions).toEqual({ "auth-edge": "1.0.0", "dashboard-fly-gru": "1.0.0" });
    const samples = db.sqlite
      .prepare(
        `SELECT endpoint_id, state, ok, total, "values" FROM probe_samples WHERE at = '2026-09-26 10:00:30' ORDER BY endpoint_id`,
      )
      .all();
    expect(samples).toEqual([
      { endpoint_id: "api-workers", state: "operational", ok: 3, total: 3, values: null },
      { endpoint_id: "atlas-workers", state: "operational", ok: 3, total: 3, values: null },
      { endpoint_id: "auth-edge", state: "operational", ok: 3, total: 3, values: '{"version":"1.0.0"}' },
      { endpoint_id: "auth-oidc-edge", state: "none", ok: 0, total: 0, values: null },
      { endpoint_id: "dashboard-fly-gru", state: "operational", ok: 3, total: 3, values: '{"version":"1.0.0"}' },
      { endpoint_id: "data-api-oci-gru", state: "operational", ok: 3, total: 3, values: null },
      // Without TERRABASE_PROBES the TerraBase probes are not configured, never down.
      { endpoint_id: "document-api-gru", state: "none", ok: 0, total: 0, values: null },
      { endpoint_id: "git-forgejo", state: "operational", ok: 3, total: 3, values: null },
      { endpoint_id: "management-api-gru", state: "none", ok: 0, total: 0, values: null },
      { endpoint_id: "terrabase-health-gru", state: "none", ok: 0, total: 0, values: null },
      { endpoint_id: "website-pages", state: "degraded", ok: 0, total: 3, values: null },
    ]);
    expect(db.sqlite.prepare("SELECT endpoint_id, version FROM deploys").all()).toEqual([
      { endpoint_id: "auth-edge", version: "1.1.0" },
      { endpoint_id: "dashboard-fly-gru", version: "1.1.0" },
    ]);
    expect(db.sqlite.prepare("SELECT code FROM vantages").all()).toHaveLength(3);
  });
});

describe("automatic incidents", () => {
  it("opens an incident for a component down for a minute and resolves it after five healthy minutes", async () => {
    const db = testD1();
    let up = false;
    const vantage = (code: string) => ({
      fetch: async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as ProbeRequest;
        return Response.json({
          vantage: code,
          colo: null,
          results: body.targets.map((target) => {
            const failing = !up && target.url.includes("git.terrascale.tech");
            const json = {
              status: target.url.includes("git") ? "pass" : target.url.includes("auth") ? "ready" : "ok",
              regions: [{ code: "GRU-1", available: true }],
              hosts: { "GRU-1": "gru.api.terrascale.tech" },
              error: { code: "invalid_key" },
            };
            return {
              key: target.key,
              status: failing
                ? 503
                : target.url.includes("openid-configuration")
                  ? 404
                  : target.url.includes("api.terrascale.tech/v1/")
                    ? 401
                    : 200,
              latencyMs: 40,
              error: null,
              body: target.url === "https://terrascale.tech/" ? "TerraScale" : JSON.stringify(json),
            };
          }),
        } satisfies ProbeResponse);
      },
    });
    const env = {
      STATUS_DB: db,
      VANTAGE_SFO: vantage("sfo"),
      VANTAGE_GRU: vantage("gru"),
      VANTAGE_FRA: vantage("fra"),
      VANTAGE_NRT: vantage("nrt"),
    } as unknown as Env;

    let state = { streaks: {}, colos: {}, versions: {}, trackers: {} };
    const start = Date.parse("2026-09-26T10:00:00Z");
    for (let round = 0; round < 20; round++) {
      if (round === 6) up = true;
      state = await runRound(env, start + round * 30_000, state);
    }

    const incidents = db.sqlite
      .prepare("SELECT title, status, impact, source, auto_key, created_at, resolved_at FROM incidents")
      .all();
    expect(incidents).toEqual([
      {
        title: "Git and CI is down",
        status: "resolved",
        impact: "critical",
        source: "auto",
        auto_key: null,
        // Opened a minute after the first failing round.
        created_at: "2026-09-26 10:01:00",
        resolved_at: "2026-09-26 10:08:00",
      },
    ]);
    const updates = db.sqlite.prepare("SELECT status FROM incident_updates ORDER BY created_at").all();
    expect(updates.map((row) => row.status)).toEqual(["investigating", "monitoring", "resolved"]);
    expect(db.sqlite.prepare("SELECT component_id FROM incident_components").all()).toEqual([{ component_id: "git" }]);
  });
});
