import { describe, expect, it, vi } from "vitest";
import { isCanaryConfig, parseCanaries, written } from "./canary";
import { parseTerraBase } from "./terrabase";
import { isSdkProbeConfig, runSdkDocuments } from "./sdk";

const id = "01M4E7G1W82VKFPF5FJ9AVK1CV";
const canary = {
  origin: "https://gru.api.terrascale.tech",
  project: id,
  database: "status_canary",
  collection: "canary",
  document: id,
  key: "tb_test",
};
const sdk = {
  ...canary,
  issuer: "https://gru.auth.terrascale.tech/terrascale",
  key: `tsk_${"a".repeat(20)}_${"b".repeat(52)}`,
};

describe("probe entity IDs", () => {
  it("accepts canonical endpoint keys and rejects legacy secret lookup keys", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseCanaries(JSON.stringify({ [id]: canary }))).toEqual({ [id]: canary });
      expect(parseCanaries(JSON.stringify({ "data-api-canary-gru": canary }))).toEqual({});
      expect(parseTerraBase(JSON.stringify({ [id]: canary }))).toEqual({ [id]: canary });
      expect(parseTerraBase(JSON.stringify({ "documents-api-gru": canary }))).toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  it("does not write or attempt cleanup for an invalid SDK document ID", async () => {
    const collection = { put: vi.fn(), delete: vi.fn() };
    const result = await runSdkDocuments(
      collection as unknown as Parameters<typeof runSdkDocuments>[0],
      "invalid",
      "marker",
      true,
    );
    expect(result).toEqual({ ok: false, latencyMs: null, error: "Invalid probe config" });
    expect(collection.put).not.toHaveBeenCalled();
    expect(collection.delete).not.toHaveBeenCalled();
  });

  it("requires canonical ULIDs for project and document identities", () => {
    expect(isCanaryConfig(canary)).toBe(true);
    expect(isSdkProbeConfig("documents", sdk)).toBe(true);
    for (const invalid of [
      id.toLowerCase(),
      `prj_${id}`,
      "b450c3c0-4427-41e4-b620-0ba7d93dfdb8",
      "8ZZZZZZZZZZZZZZZZZZZZZZZZZ",
    ]) {
      for (const field of ["project", "document"]) {
        expect(isCanaryConfig({ ...canary, [field]: invalid })).toBe(false);
        expect(isSdkProbeConfig("documents", { ...sdk, [field]: invalid })).toBe(false);
      }
      expect(() =>
        written({ id: invalid, version: `tbv1-${"0".repeat(32)}`, offset: "1", durability: "local_durable" }),
      ).toThrow("Invalid response");
    }
  });
});
