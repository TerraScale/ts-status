import { describe, expect, it, vi } from "vitest";
import { isId } from "../ids";
import { isConfigured, isTerraBaseConfig, notConfiguredSample, parseTerraBase, runTerraBase } from "./terrabase";

const origin = "https://api.terrascale.tech";
const canary = {
  origin,
  region: "gru",
  project: "01M4E7G1W82VKFPF5FJ9AVK1CQ",
  database: "canary",
  collection: "canary",
  document: "01M4E7G1W82VKFPF5FJ9AVK1D9",
  issuer: "https://auth.example.test/terrascale",
  key: `01M4E7G1W82VKFPF5FJ9AVK1CQ_${"a".repeat(52)}`,
};

describe("TerraBase probe config", () => {
  it("validates the new config and treats absent and malformed secrets differently", () => {
    expect(isTerraBaseConfig("documents", canary)).toBe(true);
    expect(isTerraBaseConfig("health", { origin, region: "gru" })).toBe(true);
    expect(isTerraBaseConfig("documents", { ...canary, key: "tbk1_retired" })).toBe(false);
    expect(isConfigured("documents", { origin, region: "gru" })).toBe(false);
    expect(isConfigured("health", undefined)).toBe(false);
    expect(isConfigured("documents", null)).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseTerraBase(undefined)).toEqual({});
    for (const secret of ["not json", "[]", "null"]) expect(parseTerraBase(secret)).toBeNull();
    expect(parseTerraBase(JSON.stringify({ "01M4E7G1W82VKFPF5FJ9AVK1DF": canary }))).toEqual({
      "01M4E7G1W82VKFPF5FJ9AVK1DF": canary,
    });
    expect(notConfiguredSample("01M4E7G1W82VKFPF5FJ9AVK1DF")).toMatchObject({
      state: "none",
      ok: 0,
      total: 0,
      latencyMs: null,
    });
    vi.restoreAllMocks();
  });
});

describe("TerraBase probes", () => {
  const grant = { access_token: "header.payload.signature", token_type: "Bearer", expires_in: 900 };
  const collection = `${origin}/v1/projects/${canary.project}/databases/canary/collections/canary`;
  const version = `tbv1-${"a".repeat(32)}`;

  /** A TerraBase fake that stores the canary document; `fail` swaps one step's answer. */
  function fake(fail: Partial<Record<"PUT" | "GET" | "POST" | "DELETE", Response>> = {}) {
    let stored: { id: string; document: unknown } | null = null;
    return vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/oauth/token")) return Response.json(grant);
      const method = init?.method as "PUT" | "GET" | "POST" | "DELETE";
      if (fail[method]) return fail[method]!;
      const id = url.searchParams.get("id") ?? "";
      const body = () => ({ id: stored!.id, version, state: "value", document: stored!.document });
      switch (method) {
        case "PUT":
          stored = { id, document: JSON.parse(String(init?.body)) };
          return Response.json({ id, version, offset: "1", durability: "local_durable" }, { status: 201 });
        case "GET":
          return Response.json(body());
        case "POST":
          return Response.json({ items: stored ? [body()] : [], next_cursor: null });
        case "DELETE":
          stored = null;
          return Response.json({ id, version, offset: "2", durability: "local_durable" });
      }
    });
  }

  it("writes, reads, queries and deletes a fresh document with the exchanged token", async () => {
    const fetcher = fake();
    expect(await runTerraBase("documents", canary, "round", fetcher)).toMatchObject({ ok: true });
    const calls = fetcher.mock.calls.map(([url, init]) => [init?.method, String(url)]);
    const id = new URL(String(fetcher.mock.calls[1]![0])).searchParams.get("id")!;
    expect(isId(id)).toBe(true);
    expect(calls).toEqual([
      ["POST", `${canary.issuer}/oauth/token`],
      ["PUT", `${collection}/documents/by-key?id=${id}`],
      ["GET", `${collection}/documents/by-key?id=${id}`],
      ["POST", `${collection}/query`],
      ["DELETE", `${collection}/documents/by-key?id=${id}`],
    ]);
    expect(String(fetcher.mock.calls[0]![1]?.body)).toContain("scope=documents%3Aread+documents%3Awrite");
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({ canary: "round" });
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get("if-none-match")).toBe("*");
    expect(JSON.parse(String(fetcher.mock.calls[3]![1]?.body))).toEqual({ filter: { eq: ["$id", id] }, limit: 1 });
    for (const [, init] of fetcher.mock.calls.slice(1)) {
      expect(init).toMatchObject({ redirect: "manual" });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${grant.access_token}`);
      expect(new Headers(init?.headers).get("X-TerraScale-Region-Pin")).toBe("gru");
    }
    expect(JSON.stringify(fetcher.mock.calls.slice(1))).not.toContain(canary.key);
  });

  it("fails a step it cannot prove and still deletes the document", async () => {
    for (const [fail, error] of [
      [{ PUT: Response.json({ error: { code: "forbidden_scope" } }, { status: 403 }) }, "HTTP 403 forbidden_scope"],
      [{ PUT: Response.json({ id: "x", version }, { status: 201 }) }, "Invalid response"],
      [{ GET: Response.json({ error: { code: "not_found" } }, { status: 404 }) }, "HTTP 404 not_found"],
      [{ GET: Response.json({ id: "x", version, state: "value", document: {} }) }, "Write not readable"],
      [{ POST: Response.json({ items: [], next_cursor: null }) }, "Query missed the document"],
      [{ DELETE: Response.json({ error: { code: "internal_error" } }, { status: 500 }) }, "HTTP 500 internal_error"],
    ] as const) {
      const fetcher = fake(fail);
      expect(await runTerraBase("documents", canary, "round", fetcher)).toEqual({ ok: false, latencyMs: null, error });
      expect(fetcher.mock.calls.at(-1)![1]?.method).toBe("DELETE");
    }
  });

  it("leaves documents unmeasured on grant 401, but judges API and anonymous readiness 401", async () => {
    const rejected = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "invalid_client" }, { status: 401 }));
    expect(await runTerraBase("documents", canary, "round", rejected)).toEqual({
      ok: null,
      latencyMs: null,
      error: "Canary credential invalid",
    });
    expect(rejected).toHaveBeenCalledTimes(1);
    const api = fake({ PUT: Response.json({ error: { code: "invalid_token" } }, { status: 401 }) });
    expect(await runTerraBase("documents", canary, "round", api)).toMatchObject({
      ok: false,
      error: "HTTP 401 invalid_token",
    });
    const ready = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await runTerraBase("health", canary, "round", ready)).toMatchObject({ ok: false, error: "HTTP 401" });
  });

  it("reuses the token across rounds, exchanges again after a failure, and times only TerraBase", async () => {
    vi.useFakeTimers();
    try {
      const store = fake();
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        // ts-auth answers slowly; TerraBase in 100 ms per request.
        await vi.advanceTimersByTimeAsync(String(input).endsWith("/oauth/token") ? 2_000 : 100);
        return store(input, init);
      });
      const tokens = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token")).length;
      expect(await runTerraBase("documents", canary, "round", fetcher)).toEqual({
        ok: true,
        latencyMs: 100,
        error: null,
      });
      await runTerraBase("documents", canary, "round", fetcher);
      expect(tokens()).toBe(1);
      store.mockResolvedValueOnce(Response.json({ error: { code: "invalid_token" } }, { status: 401 }));
      expect(await runTerraBase("documents", canary, "round", fetcher)).toMatchObject({ ok: false });
      await runTerraBase("documents", canary, "round", fetcher);
      expect(tokens()).toBe(2);
      // Within a round's use (20 s) of the 900 s token's expiry, the next round exchanges again.
      await vi.advanceTimersByTimeAsync(880_000);
      await runTerraBase("documents", canary, "round", fetcher);
      expect(tokens()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps readiness anonymous and rejects a wrong region, unavailable or invalid response", async () => {
    for (const [body, status, ok] of [
      [{ status: "ready", version: "1.0", region: "gru" }, 200, true],
      [{ status: "ready", version: "1.0", region: "sjc" }, 200, false],
      [{ status: "unavailable", version: "1.0", region: "gru" }, 200, false],
      [{ status: "ready", version: "1.0", region: "gru" }, 503, false],
      [{ status: "ready", region: "gru" }, 200, false],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
      expect(await runTerraBase("health", canary, "round", fetcher)).toMatchObject({ ok });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe(`${origin}/readyz`);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(new Headers(init?.headers).get("X-TerraScale-Region-Pin")).toBe("gru");
      expect([...new Headers(init?.headers).keys()].sort()).toEqual(["user-agent", "x-terrascale-region-pin"]);
    }
  });
});
