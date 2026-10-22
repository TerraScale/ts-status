import { describe, expect, it, vi } from "vitest";
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

describe("read-only TerraBase probes", () => {
  const grant = { access_token: "header.payload.signature", token_type: "Bearer", expires_in: 900 };
  const document = { id: canary.document, version: `tbv1-${"a".repeat(32)}`, state: "value", document: {} };

  it("GETs one bounded page using only the exchanged read token, including empty collections", async () => {
    for (const items of [[], [document]]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(grant))
        .mockResolvedValueOnce(Response.json({ items, next_cursor: null }));
      expect(await runTerraBase("documents", canary, "round", fetcher)).toMatchObject({ ok: true });
      expect(fetcher).toHaveBeenCalledTimes(2);
      const [url, init] = fetcher.mock.calls[1]!;
      expect(url).toBe(`${origin}/v1/projects/${canary.project}/databases/canary/collections/canary/documents?limit=1`);
      expect(init).toMatchObject({ method: "GET", redirect: "manual", cache: "no-store" });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${grant.access_token}`);
      expect(new Headers(init?.headers).get("X-TerraScale-Region-Pin")).toBe("gru");
      expect(JSON.stringify(fetcher.mock.calls[1])).not.toContain(canary.key);
    }
  });

  it("rejects malformed pages and authorization failures without cleanup mutations", async () => {
    for (const body of [
      null,
      [],
      { items: [], next_cursor: 1 },
      { items: [] },
      { items: [null], next_cursor: null },
      { items: [{ ...document, version: "bad" }], next_cursor: null },
      { items: [document, document], next_cursor: null },
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(grant))
        .mockResolvedValueOnce(Response.json(body));
      expect(await runTerraBase("documents", canary, "round", fetcher)).toMatchObject({ ok: false });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    for (const status of [401, 403]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(grant))
        .mockResolvedValueOnce(Response.json({ error: { code: "forbidden_scope" } }, { status }));
      expect(await runTerraBase("documents", canary, "round", fetcher)).toMatchObject({
        ok: false,
        error: `HTTP ${status} forbidden_scope`,
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
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
    }
  });
});
