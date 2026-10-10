import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { testD1 } from "../testing/d1";
import { startTerraBase, testRegion } from "../testing/terrabase";
import { documentPath, runCanary } from "./canary";
import { runRound, type RoundState } from "./round";
import { isConfigured, isTerraBaseConfig, notConfiguredSample, parseTerraBase, runTerraBase } from "./terrabase";

let api: Awaited<ReturnType<typeof startTerraBase>>;
beforeAll(async () => {
  api = await startTerraBase();
}, 180_000);
afterAll(async () => {
  await api?.stop();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const empty = (): RoundState => ({ streaks: {}, colos: {}, versions: {}, trackers: {} });
const start = Date.parse("2026-10-04T10:00:00Z");

describe("published TerraBase probes", () => {
  it("preserves a real conditional document read's bodyless 304 response", async () => {
    expect(await runCanary(api.canary, "conditional read", api.fetcher)).toMatchObject({ ok: true });
    const response = await api.fetcher(api.origin + documentPath(api.canary), {
      headers: { authorization: `Bearer ${api.canary.key}`, "if-none-match": "*" },
    });
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("rejects response-construction errors from the real server", async () => {
    const error = new TypeError("Response conversion failed");
    vi.stubGlobal(
      "Response",
      class extends Response {
        constructor(body?: BodyInit | null, init?: ResponseInit) {
          super(body, init);
          throw error;
        }
      },
    );
    await expect(api.fetcher(`${api.origin}/healthz`)).rejects.toBe(error);
  });

  it("serves /readyz with JSON status ready and region on the HTTPS client listener", async () => {
    const response = await api.fetcher(`${api.origin}/readyz`);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-TerraBase-Region")).toBe(testRegion);
    expect(await response.json()).toMatchObject({ status: "ready", region: testRegion });
    const result = await runTerraBase("health", { origin: api.origin }, "round", api.fetcher);
    expect(result).toMatchObject({ ok: true, error: null });
  });

  it("writes, reads, queries by $id, and deletes the fixed document each round", async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const fetcher = (async (input, init) => {
      calls.push({
        path: new URL(String(input)).pathname + new URL(String(input)).search,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return api.fetcher(input, init);
    }) as typeof fetch;
    for (const marker of ["first", "second"]) {
      expect(await runTerraBase("documents", api.canary, marker, fetcher)).toMatchObject({ ok: true, error: null });
    }
    expect(calls.map((call) => call.method)).toEqual(["PUT", "GET", "POST", "DELETE", "PUT", "GET", "POST", "DELETE"]);
    const document = calls[0]!.path;
    const id = new URL(document, api.origin).searchParams.get("id")!;
    expect(calls[2]!.body).toEqual({ filter: { eq: ["$id", id] }, limit: 1 });
    expect(calls[0]!.body).toEqual({ canary: "first" });
    expect(calls[4]!.path).toBe(document);
    const response = await api.fetcher(api.origin + document, {
      headers: { authorization: `Bearer ${api.canary.key}` },
    });
    expect(response.status).toBe(404);
  });

  it("cleans up a real committed write when its response is lost", async () => {
    let document = "";
    const fetcher = (async (input, init) => {
      const response = await api.fetcher(input, init);
      if (init?.method === "PUT") {
        expect(response.status).toBe(201);
        document = String(input);
        throw new TypeError("Connection lost after commit");
      }
      return response;
    }) as typeof fetch;
    expect(await runTerraBase("documents", api.canary, "lost answer", fetcher)).toEqual({
      ok: false,
      latencyMs: null,
      error: "Unreachable",
    });
    expect((await api.fetcher(document, { headers: { authorization: `Bearer ${api.canary.key}` } })).status).toBe(404);
  });

  it("validates the new config and treats absent and malformed secrets differently", () => {
    expect(isTerraBaseConfig("documents", api.canary)).toBe(true);
    expect(isTerraBaseConfig("health", { origin: api.origin })).toBe(true);
    expect(isTerraBaseConfig("documents", { ...api.canary, key: "tbk1_retired" })).toBe(false);
    expect(isConfigured("documents", { origin: api.origin })).toBe(false);
    expect(isConfigured("health", undefined)).toBe(false);
    expect(isConfigured("documents", null)).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseTerraBase(undefined)).toEqual({});
    for (const secret of ["not json", "[]", "null"]) expect(parseTerraBase(secret)).toBeNull();
    expect(parseTerraBase(JSON.stringify({ "01M4E7G1W82VKFPF5FJ9AVK1DF": api.canary }))).toEqual({
      "01M4E7G1W82VKFPF5FJ9AVK1DF": api.canary,
    });
    expect(notConfiguredSample("01M4E7G1W82VKFPF5FJ9AVK1DF")).toMatchObject({
      state: "none",
      ok: 0,
      total: 0,
      latencyMs: null,
    });
  });

  it("persists real successes, two rejected-key rounds, and unjudged rounds in D1", async () => {
    const db = testD1();
    try {
      db.sqlite.exec(
        "UPDATE endpoints SET enabled = 0; UPDATE endpoints SET enabled = 1 WHERE id IN ('01M4E7G1W82VKFPF5FJ9AVK1DF', '01M4E7G1W82VKFPF5FJ9AVK1D9')",
      );
      const env = {
        STATUS_DB: db,
        DATA_API_CANARY: JSON.stringify({ "01M4E7G1W82VKFPF5FJ9AVK1D9": api.canary }),
        TERRABASE_PROBES: JSON.stringify({
          "01M4E7G1W82VKFPF5FJ9AVK1DF": api.canary,
        }),
      } as unknown as Env;
      vi.stubGlobal("fetch", api.fetcher);
      let state = await runRound(env, start, empty());
      const sampleStates = () =>
        db.sqlite
          .prepare("SELECT endpoint_id AS id, state, ok, total FROM probe_samples ORDER BY at, endpoint_id")
          .all();
      expect(sampleStates()).toEqual(
        ["01M4E7G1W82VKFPF5FJ9AVK1D9", "01M4E7G1W82VKFPF5FJ9AVK1DF"].map((id) => ({
          id,
          state: "operational",
          ok: 1,
          total: 1,
        })),
      );
      env.DATA_API_CANARY = JSON.stringify({ "01M4E7G1W82VKFPF5FJ9AVK1D9": { ...api.canary, key: "tb_rejected" } });
      env.TERRABASE_PROBES = JSON.stringify({
        "01M4E7G1W82VKFPF5FJ9AVK1DF": { ...api.canary, key: "tb_rejected" },
      });
      state = await runRound(env, start + 30_000, state);
      state = await runRound(env, start + 60_000, state);
      expect(
        sampleStates()
          .slice(2, 4)
          .map((row) => row.state),
      ).toEqual(["degraded", "degraded"]);
      expect(
        sampleStates()
          .slice(4, 6)
          .map((row) => row.state),
      ).toEqual(["major_outage", "major_outage"]);
      expect(state.streaks).toEqual({
        "01M4E7G1W82VKFPF5FJ9AVK1D9": 2,
        "01M4E7G1W82VKFPF5FJ9AVK1DF": 2,
      });
      env.TERRABASE_PROBES = undefined;
      await runRound(env, start + 90_000, state);
      expect(sampleStates().slice(-1)).toEqual([{ id: "01M4E7G1W82VKFPF5FJ9AVK1DF", state: "none", ok: 0, total: 0 }]);
      env.TERRABASE_PROBES = "not json";
      vi.spyOn(console, "error").mockImplementation(() => {});
      await runRound(env, start + 120_000, empty());
      expect(
        sampleStates()
          .slice(-1)
          .map((row) => row.state),
      ).toEqual(["degraded"]);
    } finally {
      db.sqlite.close();
    }
  });
});
