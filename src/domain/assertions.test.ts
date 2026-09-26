import { describe, expect, it } from "vitest";
import { judge, parsePath, parseSpec, select, statusMatches, type CheckSpec } from "./assertions";

const atlas = {
  regions: [
    { code: "GRU", available: true, lag_ms: 12 },
    { code: "SFO", available: false },
  ],
  hosts: { GRU: "gru.api.terrascale.tech" },
};

describe("paths", () => {
  it("parses keys, indexes and selectors", () => {
    expect(parsePath("regions[code=GRU].available")).toEqual([
      { key: "regions" },
      { field: "code", equals: "GRU" },
      { key: "available" },
    ]);
    expect(parsePath("items[0].name")).toEqual([{ key: "items" }, { index: 0 }, { key: "name" }]);
    expect(parsePath("a..b")).toBeNull();
    expect(parsePath("a.")).toBeNull();
    expect(parsePath("")).toBeNull();
  });

  it("selects values and misses gracefully", () => {
    expect(select(atlas, "regions[code=GRU].lag_ms")).toBe(12);
    expect(select(atlas, "regions[1].available")).toBe(false);
    expect(select(atlas, "hosts.GRU")).toBe("gru.api.terrascale.tech");
    expect(select(atlas, "regions[code=FRA].available")).toBeUndefined();
    expect(select(atlas, "hosts.GRU.deeper")).toBeUndefined();
  });
});

describe("statusMatches", () => {
  it("accepts classes, codes and lists", () => {
    expect(statusMatches("2xx", 204)).toBe(true);
    expect(statusMatches("2xx", 301)).toBe(false);
    expect(statusMatches("200, 301", 301)).toBe(true);
  });
});

describe("judge", () => {
  const spec: CheckSpec = {
    expectStatus: "2xx",
    keyword: null,
    assertions: [{ path: "regions[code=GRU].available", op: "eq", value: true }],
    extract: { lag_ms: "regions[code=GRU].lag_ms" },
    indirect: false,
  };
  const body = JSON.stringify(atlas);

  it("passes and extracts values", () => {
    expect(judge(spec, { status: 200, error: null, body })).toEqual({
      outcome: "ok",
      error: null,
      values: { lag_ms: 12 },
    });
  });

  it("fails a broken assertion with a readable reason", () => {
    const sfo = { ...spec, assertions: [{ path: "regions[code=SFO].available", op: "eq" as const, value: true }] };
    expect(judge(sfo, { status: 200, error: null, body })).toMatchObject({
      outcome: "fail",
      error: "Expected regions[code=SFO].available eq true",
    });
  });

  it("reports an unreachable indirect source as unknown, not down", () => {
    expect(judge({ ...spec, indirect: true }, { status: 503, error: null, body: "" }).outcome).toBe("unknown");
    expect(judge({ ...spec, indirect: true }, { status: null, error: "Timed out" }).outcome).toBe("unknown");
    expect(judge(spec, { status: 503, error: null, body: "" })).toMatchObject({ outcome: "fail", error: "HTTP 503" });
  });

  it("checks keywords and needs JSON only for assertions", () => {
    const keyword = { ...spec, keyword: "TerraScale", assertions: [], extract: {} };
    expect(judge(keyword, { status: 200, error: null, body: "<title>TerraScale</title>" }).outcome).toBe("ok");
    expect(judge(keyword, { status: 200, error: null, body: "<title>Oops</title>" }).error).toBe("Keyword missing");
    expect(judge(spec, { status: 200, error: null, body: "not json" }).error).toBe("Invalid JSON");
  });

  it("covers every operator", () => {
    const run = (op: CheckSpec["assertions"][number]["op"], value?: unknown, path = "regions[code=GRU].lag_ms") =>
      judge({ ...spec, extract: {}, assertions: [{ path, op, value }] }, { status: 200, error: null, body }).outcome;
    expect(run("lt", 50)).toBe("ok");
    expect(run("gt", 50)).toBe("fail");
    expect(run("ne", 13)).toBe("ok");
    expect(run("exists")).toBe("ok");
    expect(run("exists", undefined, "regions[code=SFO].lag_ms")).toBe("fail");
    expect(run("contains", "gru", "hosts.GRU")).toBe("ok");
  });
});

describe("parseSpec", () => {
  it("drops malformed assertions and extractions", () => {
    expect(
      parseSpec({
        expectStatus: "2xx",
        keyword: "",
        assertions: '[{"path":"status","op":"eq","value":"ok"},{"path":"a..b","op":"eq"},{"path":"x","op":"nope"}]',
        extract: '{"version":"version","bad":"a..","n":1}',
        indirect: 0,
      }),
    ).toEqual({
      expectStatus: "2xx",
      keyword: null,
      assertions: [{ path: "status", op: "eq", value: "ok" }],
      extract: { version: "version" },
      indirect: false,
    });
  });
});
