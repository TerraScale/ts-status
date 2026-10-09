import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTerraBase, verifiedBinary } from "../testing/terrabase";
import { documentPath, holdsDocument, isCanaryConfig, parseCanaries, runCanary, written } from "./canary";

let api: Awaited<ReturnType<typeof startTerraBase>>;
beforeAll(async () => {
  api = await startTerraBase();
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

describe("published TerraBase canary", () => {
  it("refuses a cached or overridden binary whose SHA256 differs from the release pin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ts-status-corrupt-release-"));
    const binary = join(directory, "terrabase");
    try {
      await writeFile(binary, "corrupt release");
      vi.stubEnv("TERRABASE_BINARY", binary);
      await expect(verifiedBinary()).rejects.toThrow("SHA256 mismatch");
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("commits and reads each round's raw marker on the same document", async () => {
    for (const marker of ["round one", "round two"]) {
      expect(await runCanary(api.canary, marker, api.fetcher)).toMatchObject({ ok: true, error: null });
      const response = await api.fetcher(api.origin + documentPath(api.canary), {
        headers: { authorization: `Bearer ${api.canary.key}` },
      });
      expect(response.status).toBe(200);
      expect(holdsDocument(await response.json(), api.canary.document, marker)).toBe(true);
    }
  });

  it("fails rejected keys, read-only keys, and attempts outside the scoped database", async () => {
    const readOnly = await api.issueKey(["documents:read"]);
    await api.createDatabase("outside_scope");
    for (const [config, error] of [
      [{ ...api.canary, key: "tb_rejected" }, "HTTP 401 invalid_key"],
      [{ ...api.canary, key: readOnly }, "HTTP 403 forbidden_scope"],
      [{ ...api.canary, database: "outside_scope" }, "HTTP 404 unknown_database"],
    ] as const) {
      expect(await runCanary(config, "rejected", api.fetcher)).toEqual({ ok: false, latencyMs: null, error });
    }
  });

  it("rejects malformed config and write/read acknowledgements", () => {
    expect(isCanaryConfig(api.canary)).toBe(true);
    for (const patch of [
      { origin: api.origin + "/" },
      { origin: "http://localhost" },
      { project: "project" },
      { database: "Canary" },
      { collection: "1canary" },
      { document: "document" },
      { key: "tbk1_retired" },
    ])
      expect(isCanaryConfig({ ...api.canary, ...patch })).toBe(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseCanaries(undefined)).toEqual({});
      expect(parseCanaries("not json")).toEqual({});
      expect(
        parseCanaries(
          JSON.stringify({
            "01M4E7G1W82VKFPF5FJ9AVK1D9": api.canary,
            "01M4E7G1W82VKFPF5FJ9AVK1DF": { ...api.canary, key: "tbk1_retired" },
          }),
        ),
      ).toEqual({ "01M4E7G1W82VKFPF5FJ9AVK1D9": api.canary });
    } finally {
      error.mockRestore();
    }
    const ack = {
      id: api.canary.document,
      version: `tbv1-${"a".repeat(32)}`,
      offset: "1",
      durability: "local_durable",
    };
    expect(written(ack)).toBe(api.canary.document);
    for (const patch of [{ id: "bad" }, { version: "bad" }, { offset: "01" }, { durability: "pending" }])
      expect(() => written({ ...ack, ...patch })).toThrow("Invalid response");
    expect(holdsDocument({ ...ack, state: "value", document: { canary: "old" } }, ack.id, "new")).toBe(false);
  });

  it("reports an unreachable local origin without leaking the key", async () => {
    const result = await runCanary({ ...api.canary, origin: "https://127.0.0.1:1" }, "round");
    expect(result).toEqual({ ok: false, latencyMs: null, error: "Unreachable" });
    expect(result.error).not.toContain(api.canary.key);
  });
});
