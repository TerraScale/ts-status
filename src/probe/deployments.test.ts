import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { deployments } from "./deployments";

describe("regional deployment observations", () => {
  it("checks every fixed service through both vantages and includes their own revisions", async () => {
    const version = "a".repeat(40);
    const fetched: string[] = [];
    const vantage = (colo: string) => ({
      async fetch(_url: string, init: RequestInit) {
        const { targets } = JSON.parse(init.body as string) as { targets: { key: string; url: string }[] };
        fetched.push(...targets.map((target) => target.url));
        return Response.json({
          colo,
          version,
          results: targets.map(({ key }) => ({
            key,
            status: 200,
            body: JSON.stringify({ version }),
          })),
        });
      },
    });
    const rows = await deployments({ VANTAGE_GRU: vantage("GRU"), VANTAGE_SFO: vantage("SFO") } as unknown as Env, 0);
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.version === version && row.observedAt === "1970-01-01T00:00:00.000Z")).toBe(true);
    expect(new Set(fetched)).toEqual(
      new Set([
        "https://atlas.terrascale.tech/health/version",
        "https://status.terrascale.tech/health/version",
        "https://ts-dashboard.fly.dev/health/ready",
      ]),
    );
  });

  it("keeps failed vantages, old version formats and unhealthy responses unknown", async () => {
    const rows = await deployments(
      {
        VANTAGE_GRU: {
          fetch: async () => {
            throw new Error("unreachable");
          },
        },
        VANTAGE_SFO: {
          fetch: async () =>
            Response.json({
              version: "old",
              results: [
                { key: "ts-atlas", status: 200, body: "not json" },
                { key: "ts-status", status: 503, body: JSON.stringify({ version: "a".repeat(40) }) },
                { key: "ts-dashboard", status: 200, body: JSON.stringify({ version: "short" }) },
              ],
            }),
        },
      } as unknown as Env,
      0,
    );
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.version === null)).toBe(true);
    expect(rows.filter((row) => row.region === "GRU").every((row) => row.status === null)).toBe(true);
  });

  it.each([
    null,
    [],
    {},
    { results: {} },
    { results: [null] },
    { results: [[]] },
    { results: [{ key: "ts-atlas", status: "200" }] },
    { results: [{ key: "ts-atlas", status: 200.5 }] },
    { results: [{ key: "ts-atlas", status: 600 }] },
    { results: [{ key: 1, status: 200 }] },
    { results: [{ key: "ts-atlas", status: 200, body: {} }] },
    { version: 1, results: [] },
    { colo: {}, results: [] },
  ])("keeps malformed GRU payload %j unknown without losing SFO observations", async (body) => {
    const version = "a".repeat(40);
    const rows = await deployments(
      {
        VANTAGE_GRU: { fetch: async () => Response.json(body) },
        VANTAGE_SFO: {
          fetch: async () =>
            Response.json({
              version,
              colo: "SFO",
              results: ["ts-atlas", "ts-status", "ts-dashboard"].map((key) => ({
                key,
                status: 200,
                body: JSON.stringify({ version }),
              })),
            }),
        },
      } as unknown as Env,
      0,
    );
    expect(rows).toHaveLength(8);
    const failed = rows.filter((row) => row.region === "GRU");
    expect(failed).toHaveLength(4);
    expect(failed.every((row) => row.status === null && row.version === null && row.colo === null)).toBe(true);
    const healthy = rows.filter((row) => row.region === "SFO");
    expect(healthy).toHaveLength(4);
    expect(healthy.every((row) => row.status === 200 && row.version === version && row.colo === "SFO")).toBe(true);
  });

  it("keeps non-JSON vantage responses unknown", async () => {
    const rows = await deployments(
      {
        VANTAGE_GRU: { fetch: async () => new Response("not JSON") },
        VANTAGE_SFO: { fetch: async () => Response.json({ version: "a".repeat(40), results: [] }) },
      } as unknown as Env,
      0,
    );
    expect(rows).toHaveLength(8);
    expect(rows.filter((row) => row.region === "GRU").every((row) => row.status === null)).toBe(true);
    expect(rows.find((row) => row.region === "SFO" && row.target === "vantage")?.version).toBe("a".repeat(40));
  });
});
