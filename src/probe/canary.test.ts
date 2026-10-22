import { describe, expect, it, vi } from "vitest";
import { holdsDocument, isCanaryConfig, parseCanaries, runCanary, written } from "./canary";

const canary = {
  origin: "https://api.terrascale.tech",
  region: "gru",
  project: "01M4E7G1W82VKFPF5FJ9AVK1CQ",
  database: "canary",
  collection: "canary",
  document: "01M4E7G1W82VKFPF5FJ9AVK1D9",
  key: "tb_fake_key",
};

describe("TerraBase canary", () => {
  it("uses the configured public origin without regional routing headers", async () => {
    const ack = {
      id: canary.document,
      version: `tbv1-${"a".repeat(32)}`,
      offset: "1",
      durability: "local_durable",
    };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toMatch(/^https:\/\/api\.terrascale\.tech\/v1\//);
      expect([...new Headers(init?.headers).keys()].sort()).toEqual(
        init?.method === "PUT" ? ["authorization", "content-type", "user-agent"] : ["authorization", "user-agent"],
      );
      return Response.json(init?.method === "PUT" ? ack : { ...ack, state: "value", document: { canary: "round" } });
    });
    expect(await runCanary(canary, "round", fetcher)).toMatchObject({ ok: true, error: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed config and write/read acknowledgements", () => {
    expect(isCanaryConfig(canary)).toBe(true);
    for (const patch of [
      { origin: canary.origin + "/" },
      { origin: "http://localhost" },
      { project: "project" },
      { database: "Canary" },
      { collection: "1canary" },
      { document: "document" },
      { key: "tbk1_retired" },
    ])
      expect(isCanaryConfig({ ...canary, ...patch })).toBe(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseCanaries(undefined)).toEqual({});
      expect(parseCanaries("not json")).toEqual({});
      expect(
        parseCanaries(
          JSON.stringify({
            "01M4E7G1W82VKFPF5FJ9AVK1D9": canary,
            "01M4E7G1W82VKFPF5FJ9AVK1DF": { ...canary, key: "tbk1_retired" },
          }),
        ),
      ).toEqual({ "01M4E7G1W82VKFPF5FJ9AVK1D9": canary });
    } finally {
      error.mockRestore();
    }
    const ack = {
      id: canary.document,
      version: `tbv1-${"a".repeat(32)}`,
      offset: "1",
      durability: "local_durable",
    };
    expect(written(ack)).toBe(canary.document);
    for (const patch of [{ id: "bad" }, { version: "bad" }, { offset: "01" }, { durability: "pending" }])
      expect(() => written({ ...ack, ...patch })).toThrow("Invalid response");
    expect(holdsDocument({ ...ack, state: "value", document: { canary: "old" } }, ack.id, "new")).toBe(false);
  });

  it("reports an unreachable local origin without leaking the key", async () => {
    const result = await runCanary({ ...canary, origin: "https://127.0.0.1:1" }, "round");
    expect(result).toEqual({ ok: false, latencyMs: null, error: "Unreachable" });
    expect(result.error).not.toContain(canary.key);
  });
});
