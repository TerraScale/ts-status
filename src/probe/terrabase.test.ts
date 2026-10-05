import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { testD1 } from "../testing/d1";
import { release, startTerraBase } from "../testing/terrabase";
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
  it("preserves the real management DELETE's bodyless 204 response", async () => {
    const database = await api.createDatabase("bodyless_response");
    const { organization, project } = api.management;
    const response = await api.fetcher(
      `${api.origin}/v1/management/organizations/${organization}/projects/${project}/databases/${database}`,
      { method: "DELETE", headers: api.managementHeaders(organization) },
    );
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
  });

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

  // TODO(TS-483): bump the published release pin and remove this gate after terrabase#16 ships.
  it.skipIf(release.tag === "ci-ff256067015433c8c40b59879f1282d2a40480ce-run-13258")(
    "serves /readyz with JSON status ready on the HTTPS client listener",
    async () => {
      const result = await runTerraBase("health", { origin: api.origin }, "round", api.fetcher);
      expect(result).toMatchObject({ ok: true, error: null });
    },
  );

  it("writes, reads, queries by $id, and deletes the fixed document each round", async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const fetcher = (async (input, init) => {
      calls.push({
        path: new URL(String(input)).pathname,
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
    const id = document.split("/").at(-1)!;
    expect(calls[2]!.body).toEqual({ filter: { eq: ["$id", id] }, limit: 1 });
    expect(calls[0]!.body).toEqual({ canary: "first" });
    expect(calls[4]!.path).toBe(document);
    const response = await api.fetcher(api.origin + document, {
      headers: { authorization: `Bearer ${api.canary.key}` },
    });
    expect(response.status).toBe(404);
  });

  it("requires both management identities and the service credential", async () => {
    expect(await runTerraBase("management", api.management, "round", api.fetcher)).toMatchObject({
      ok: true,
      error: null,
    });
    for (const [patch, error] of [
      [{ key: api.canary.key }, "HTTP 401 invalid_key"],
      [{ userId: "not-a-member" }, "HTTP 404 unknown_route"],
    ] as const) {
      expect(await runTerraBase("management", { ...api.management, ...patch }, "round", api.fetcher)).toEqual({
        ok: false,
        latencyMs: null,
        error,
      });
    }
    const path = `${api.origin}/v1/management/organizations/${api.management.organization}/projects?limit=1`;
    for (const header of ["X-TerraBase-User-Id", "X-TerraBase-Organization-Id"]) {
      const headers = new Headers(api.managementHeaders(api.management.organization));
      headers.delete(header);
      expect((await api.fetcher(path, { headers })).status).toBe(400);
    }
    const headers = new Headers(api.managementHeaders(api.management.organization));
    headers.set("X-TerraBase-Organization-Id", "another-organization");
    expect((await api.fetcher(path, { headers })).status).toBe(400);
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
    expect(isTerraBaseConfig("management", api.management)).toBe(true);
    expect(isTerraBaseConfig("health", { origin: api.origin })).toBe(true);
    expect(isTerraBaseConfig("management", { ...api.management, userId: "status-\u00ff" })).toBe(true);
    for (const patch of [{ project: "bad" }, { organization: "bad" }, { userId: "" }, { userId: "x\n" }, { key: "" }])
      expect(isTerraBaseConfig("management", { ...api.management, ...patch })).toBe(false);
    expect(isTerraBaseConfig("documents", { ...api.canary, key: "tbk1_retired" })).toBe(false);
    expect(isConfigured("documents", { origin: api.origin })).toBe(false);
    expect(isConfigured("health", undefined)).toBe(false);
    expect(isConfigured("documents", null)).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseTerraBase(undefined)).toEqual({});
    for (const secret of ["not json", "[]", "null"]) expect(parseTerraBase(secret)).toBeNull();
    expect(parseTerraBase(JSON.stringify({ documents: api.canary }))).toEqual({ documents: api.canary });
    expect(notConfiguredSample("document-api-gru")).toMatchObject({ state: "none", ok: 0, total: 0, latencyMs: null });
  });

  it.each(["用户", "\u0100", "\ud800", "\udfff", "😀"])(
    "rejects header-unsafe management identity %j before making a request",
    async (userId) => {
      const management = { ...api.management, userId };
      expect(isTerraBaseConfig("management", management)).toBe(false);
      const db = testD1();
      try {
        db.sqlite.exec(
          "UPDATE endpoints SET enabled = 0; UPDATE endpoints SET enabled = 1 WHERE id = 'management-api-gru'",
        );
        const fetcher = vi.fn(api.fetcher);
        vi.stubGlobal("fetch", fetcher);
        await runRound(
          {
            STATUS_DB: db,
            TERRABASE_PROBES: JSON.stringify({ "management-api-gru": management }),
          } as unknown as Env,
          start,
          empty(),
        );
        expect(fetcher).not.toHaveBeenCalled();
        const sample = db.sqlite.prepare("SELECT state, results FROM probe_samples").get()!;
        expect(sample.state).toBe("degraded");
        expect(JSON.parse(sample.results as string)).toEqual([
          { v: "canary", ok: 0, ms: null, e: "Invalid probe config" },
        ]);
      } finally {
        db.sqlite.close();
      }
    },
  );

  it("persists real successes, two rejected-key rounds, and unjudged rounds in D1", async () => {
    const db = testD1();
    try {
      db.sqlite.exec(
        "UPDATE endpoints SET enabled = 0; UPDATE endpoints SET enabled = 1 WHERE id IN ('document-api-gru', 'management-api-gru', 'data-api-canary-gru')",
      );
      const env = {
        STATUS_DB: db,
        DATA_API_CANARY: JSON.stringify({ "data-api-canary-gru": api.canary }),
        TERRABASE_PROBES: JSON.stringify({ "document-api-gru": api.canary, "management-api-gru": api.management }),
      } as unknown as Env;
      vi.stubGlobal("fetch", api.fetcher);
      let state = await runRound(env, start, empty());
      const sampleStates = () =>
        db.sqlite
          .prepare("SELECT endpoint_id AS id, state, ok, total FROM probe_samples ORDER BY at, endpoint_id")
          .all();
      expect(sampleStates()).toEqual(
        ["data-api-canary-gru", "document-api-gru", "management-api-gru"].map((id) => ({
          id,
          state: "operational",
          ok: 1,
          total: 1,
        })),
      );
      env.DATA_API_CANARY = JSON.stringify({ "data-api-canary-gru": { ...api.canary, key: "tb_rejected" } });
      env.TERRABASE_PROBES = JSON.stringify({
        "document-api-gru": { ...api.canary, key: "tb_rejected" },
        "management-api-gru": { ...api.management, key: "rejected-service-credential" },
      });
      state = await runRound(env, start + 30_000, state);
      state = await runRound(env, start + 60_000, state);
      expect(
        sampleStates()
          .slice(3, 6)
          .map((row) => row.state),
      ).toEqual(["degraded", "degraded", "degraded"]);
      expect(
        sampleStates()
          .slice(6)
          .map((row) => row.state),
      ).toEqual(["major_outage", "major_outage", "major_outage"]);
      expect(state.streaks).toEqual({ "data-api-canary-gru": 2, "document-api-gru": 2, "management-api-gru": 2 });
      env.TERRABASE_PROBES = undefined;
      await runRound(env, start + 90_000, state);
      expect(sampleStates().slice(-2)).toEqual(
        ["document-api-gru", "management-api-gru"].map((id) => ({ id, state: "none", ok: 0, total: 0 })),
      );
      env.TERRABASE_PROBES = "not json";
      vi.spyOn(console, "error").mockImplementation(() => {});
      await runRound(env, start + 120_000, empty());
      expect(
        sampleStates()
          .slice(-2)
          .map((row) => row.state),
      ).toEqual(["degraded", "degraded"]);
    } finally {
      db.sqlite.close();
    }
  });
});
