import { describe, expect, it } from "vitest";
import type { Env } from "./data";
import { probe, probeAll } from "./probe";

const target = { id: "dash-gru", url: "https://dash.test/health/ready", headers: '{"fly-prefer-region":"gru"}' };

describe("probe", () => {
  it("passes on a 2xx response and forwards the endpoint headers", async () => {
    let sent: Headers | undefined;
    const result = await probe(target, async (_url, init) => {
      sent = new Headers(init?.headers);
      return new Response("ok");
    });
    expect(result).toMatchObject({ id: "dash-gru", ok: true, error: null });
    expect(sent?.get("fly-prefer-region")).toBe("gru");
  });

  it("fails on an error status or a network error", async () => {
    expect(await probe(target, async () => new Response("down", { status: 503 }))).toMatchObject({
      ok: false,
      error: "HTTP 503",
    });
    expect(await probe(target, async () => Promise.reject(new TypeError("fetch failed")))).toMatchObject({
      ok: false,
      error: "Unreachable",
    });
  });
});

describe("probeAll", () => {
  it("records every result in one batch and prunes on the first run of the hour", async () => {
    const batches: { sql: string; values: unknown[] }[][] = [];
    const statement = (sql: string) => {
      const self = {
        sql,
        values: [] as unknown[],
        bind: (...values: unknown[]) => ({ ...self, values }),
        all: async () => ({ results: [target] }),
      };
      return self;
    };
    const env = {
      STATUS_DB: {
        prepare: statement,
        batch: async (list: { sql: string; values: unknown[] }[]) => void batches.push(list),
      },
    } as unknown as Env;

    const now = Date.parse("2026-09-26T10:00:20Z");
    const results = await probeAll(env, now, async () => new Response("ok"));

    expect(results).toHaveLength(1);
    expect(batches).toHaveLength(1);
    const [hour, latest, prune] = batches[0] ?? [];
    expect(hour?.values.slice(0, 3)).toEqual(["dash-gru", "2026-09-26 10:00:00", 0]);
    expect(latest?.values.slice(0, 3)).toEqual(["dash-gru", "2026-09-26 10:00:20", 1]);
    expect(prune?.sql).toContain("DELETE FROM probe_hours");
  });
});
