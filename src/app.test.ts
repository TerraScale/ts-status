import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "./env";

const rows: Record<string, unknown[]> = {
  component_groups: [
    { id: "platform", name: "TerraScale platform" },
    { id: "terrabase", name: "TerraBase" },
  ],
  components: [
    { id: "dashboard", groupId: "platform", name: "Dashboard", description: "Customer dashboard", lifecycle: "active" },
    { id: "data-api", groupId: "terrabase", name: "Data API", description: "Documents", lifecycle: "planned" },
  ],
  incidents: [
    {
      id: "i1",
      kind: "warning",
      title: "Slow <queries>",
      status: "monitoring",
      impact: "minor",
      message: "We are watching it.",
      createdAt: "2026-09-26T09:00:00Z",
      updatedAt: "2026-09-26T09:30:00Z",
      resolvedAt: null,
    },
  ],
  regions: [
    { code: "GRU", name: "São Paulo", country: "Brazil", mapX: 50, mapY: 59.76 },
    { code: "FRA", name: "Frankfurt", country: "Germany", mapX: 71.5, mapY: 20.78 },
  ],
  endpoints: [
    {
      id: "dashboard-gru",
      componentId: "dashboard",
      regionCode: "GRU",
      cluster: "gru",
      provider: "fly",
      lastCheckedAt: "2026-09-26T10:14:00Z",
      lastOk: 1,
      lastLatencyMs: 42,
      consecutiveFailures: 0,
    },
  ],
  probe_hours: [
    { endpointId: "dashboard-gru", hour: "2026-09-26T10:00:00Z", checks: 15, failures: 0, latencySum: 630 },
  ],
};

/** A D1 stand-in that answers each statement from the table it reads. */
function fakeEnv(): Env & { reads: number } {
  const env = {
    reads: 0,
    STATUS_DB: {
      withSession: () => {
        const statement = (sql: string) => {
          const table = Object.keys(rows).find((name) => sql.includes(`FROM ${name}`)) ?? "";
          const result = { results: rows[table] ?? [] };
          const self = { bind: () => self, all: async () => result, result };
          return self;
        };
        return {
          prepare: statement,
          batch: async (list: { result: unknown }[]) => {
            env.reads += 1;
            return list.map((item) => item.result);
          },
        };
      },
    },
  };
  return env as unknown as Env & { reads: number };
}

const ctx = {
  waitUntil: (promise: Promise<unknown>) => void promise,
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function request(path: string, method = "GET"): Request<unknown, IncomingRequestCfProperties> {
  return new Request(`https://status.test${path}`, { method }) as Request<unknown, IncomingRequestCfProperties>;
}

describe("worker", () => {
  it("exports only its handler, as workerd requires of the entry module", async () => {
    expect(Object.keys(await import("./worker"))).toEqual(["default"]);
  });
});

describe("app", () => {
  beforeEach(() => {
    const store = new Map<string, Response>();
    vi.stubGlobal("caches", {
      default: {
        match: async (key: Request) => store.get(key.url)?.clone(),
        put: async (key: Request, response: Response) => void store.set(key.url, response),
      },
    });
    vi.useFakeTimers({ now: Date.parse("2026-09-26T10:15:00Z"), toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders the status page with escaped content and a strict policy", async () => {
    const response = await app.fetch(request("/"), fakeEnv(), ctx);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=10");
    expect(response.headers.get("content-security-policy")).toMatch(/script-src 'sha256-[^']+'/);
    expect(body).toContain("Some systems are degraded");
    expect(body).toContain("Warning: Slow &lt;queries&gt;");
    expect(body).toContain('data-state="degraded"');
    expect(body).toContain("TerraScale platform");
    // The dashboard and its GRU cluster have hourly bars; the planned Data API has none.
    expect(body.match(/ data-tip=/g)).toHaveLength(24 + 24 + 30);
    expect(body).toContain("Ping 42 ms");
    expect(body).toContain('data-lifecycle="planned"');
  });

  it("serves only the main element for in-place refreshes", async () => {
    const body = await (await app.fetch(request("/?fragment=main"), fakeEnv(), ctx)).text();
    expect(body.startsWith("<main")).toBe(true);
    expect(body).toContain('data-title="Some systems are degraded · TerraScale Status"');
    expect(body).not.toContain("<style>");
  });

  it("serves repeat requests from the edge cache, ignoring query strings", async () => {
    const env = fakeEnv();
    await app.fetch(request("/"), env, ctx);
    await app.fetch(request("/?bust=1"), env, ctx);
    expect(env.reads).toBe(1);
  });

  it("returns the JSON API", async () => {
    const response = await app.fetch(request("/api/status"), fakeEnv(), ctx);
    const data = (await response.json()) as {
      status: string;
      groups: { id: string; components: { id: string; status: string; hours: string[] }[] }[];
      regions: { code: string; status: string; clusters: { pingMs: number; uptime24h: number }[] }[];
    };
    expect(data.status).toBe("degraded");
    expect(data.groups.map((group) => group.id)).toEqual(["platform", "terrabase"]);
    expect(data.groups[0]?.components[0]).toMatchObject({ id: "dashboard", status: "operational" });
    expect(data.groups[0]?.components[0]?.hours).toHaveLength(24);
    expect(data.regions.map((region) => [region.code, region.status])).toEqual([
      ["GRU", "operational"],
      ["FRA", "none"],
    ]);
    expect(data.regions[0]?.clusters[0]).toMatchObject({ pingMs: 42, uptime24h: 1 });
  });

  it("renders the history page grouped by month", async () => {
    const body = await (await app.fetch(request("/history"), fakeEnv(), ctx)).text();
    expect(body).toContain("September 2026");
    expect(body).not.toMatch(/<main[^>]*data-live/);
  });

  it("rejects unknown paths and methods", async () => {
    expect((await app.fetch(request("/nope"), fakeEnv(), ctx)).status).toBe(404);
    expect((await app.fetch(request("/", "POST"), fakeEnv(), ctx)).status).toBe(405);
  });

  it("answers HEAD without a body", async () => {
    const response = await app.fetch(request("/", "HEAD"), fakeEnv(), ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});
