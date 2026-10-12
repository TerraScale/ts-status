import { describe, expect, it, vi } from "vitest";
import { isConfigured, isTerraBaseConfig, notConfiguredSample, parseTerraBase } from "./terrabase";

const origin = "https://api.terrascale.tech";
const canary = {
  origin,
  region: "gru",
  project: "01M4E7G1W82VKFPF5FJ9AVK1CQ",
  database: "canary",
  collection: "canary",
  document: "01M4E7G1W82VKFPF5FJ9AVK1D9",
  key: "tb_fake_key",
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
