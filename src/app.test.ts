import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "./env";
import { testD1, type TestD1 } from "./testing/d1";

const NOW = "2026-09-26T10:15:00Z";

/** The seeded catalog plus a warning and the dashboard's recent probes. */
function seededEnv(): Env & { STATUS_DB: TestD1 } {
  const db = testD1();
  db.sqlite.exec(`
    INSERT INTO incidents (id, kind, title, status, impact, message, created_at, updated_at) VALUES
      ('i1', 'warning', 'Slow <queries>', 'monitoring', 'minor', 'We are watching it.',
       '2026-09-26 09:00:00', '2026-09-26 09:30:00');
    INSERT INTO probe_samples (endpoint_id, at, state, ok, total, latency_ms, results) VALUES
      ('dashboard-fly-gru', '2026-09-26 10:14:30', 'operational', 4, 4, 42, '[]'),
      ('website-pages', '2026-09-26 10:14:30', 'operational', 4, 4, 30, '[]'),
      ('atlas-workers', '2026-09-26 10:14:30', 'operational', 4, 4, 80, '[]'),
      ('git-forgejo', '2026-09-26 10:14:30', 'major_outage', 0, 4, NULL, '[]');
    INSERT INTO probe_hours (endpoint_id, hour, vantage, checks, failures, degraded, latency_sum, latency_max) VALUES
      ('dashboard-fly-gru', '2026-09-26 10:00:00', 'all', 30, 0, 0, 1260, 60);
    INSERT INTO probe_days (endpoint_id, day, vantage, checks, failures, degraded, latency_sum, latency_max, hist) VALUES
      ('dashboard-fly-gru', '2026-09-26 00:00:00', 'all', 1200, 0, 0, 50400, 90, '[]');
  `);
  return { STATUS_DB: db } as unknown as Env & { STATUS_DB: TestD1 };
}

const ctx = {
  waitUntil: (promise: Promise<unknown>) => void promise,
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function request(path: string, method = "GET"): Request<unknown, IncomingRequestCfProperties> {
  return new Request(`https://status.test${path}`, { method }) as Request<unknown, IncomingRequestCfProperties>;
}

describe("worker", () => {
  it("exports only its handler and Durable Objects, as workerd requires of the entry module", async () => {
    expect(Object.keys(await import("./worker")).sort()).toEqual(["Coordinator", "default"]);
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
    vi.useFakeTimers({ now: Date.parse(NOW), toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders the status page with escaped content and a strict policy", async () => {
    const response = await app.fetch(request("/"), seededEnv(), ctx);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=10");
    expect(response.headers.get("content-security-policy")).toMatch(/script-src 'sha256-[^']+'/);
    // Git is down: one component of four is a partial platform outage.
    expect(body).toContain("Partial system outage");
    expect(body).toContain("Warning: Slow &lt;queries&gt;");
    expect(body).toContain("TerraScale platform");
    expect(body).toContain("Developer tools");
    expect(body).toContain("Ping 42 ms");
    expect(body).toContain('data-lifecycle="planned"');
    expect(body).not.toContain("Monitoring delayed");
  });

  it("warns when probe rounds stop arriving", async () => {
    vi.setSystemTime(Date.parse("2026-09-26T10:30:00Z"));
    const body = await (await app.fetch(request("/"), seededEnv(), ctx)).text();
    expect(body).toContain("Monitoring delayed");
  });

  it("serves only the main element for in-place refreshes", async () => {
    const body = await (await app.fetch(request("/?fragment=main"), seededEnv(), ctx)).text();
    expect(body.startsWith("<main")).toBe(true);
    expect(body).toContain('data-title="Partial system outage · TerraScale Status"');
    expect(body).not.toContain("<style>");
  });

  it("serves repeat requests from the edge cache, ignoring query strings", async () => {
    const env = seededEnv();
    await app.fetch(request("/"), env, ctx);
    await app.fetch(request("/?bust=1"), env, ctx);
    expect(env.STATUS_DB.batches).toBe(1);
  });

  it("returns the JSON API", async () => {
    const response = await app.fetch(request("/api/status"), seededEnv(), ctx);
    const data = (await response.json()) as {
      status: string;
      groups: { id: string; components: { id: string; status: string; uptime30d: number; hours: string[] }[] }[];
      regions: { code: string; status: string; clusters: { pingMs: number; uptime24h: number }[] }[];
    };
    expect(data.status).toBe("partial_outage");
    expect(data.groups.map((group) => group.id)).toEqual(["platform", "terrabase", "developer"]);
    const dashboard = data.groups[0]?.components[0];
    expect(dashboard).toMatchObject({ id: "dashboard", status: "operational", uptime30d: 1 });
    expect(dashboard?.hours).toHaveLength(24);
    expect(dashboard?.hours.at(-1)).toBe("operational");
    expect(data.groups[2]?.components[0]).toMatchObject({ id: "git", status: "major_outage" });
    expect(data.regions.map((region) => [region.code, region.status])).toEqual([
      ["SFO", "none"],
      ["GRU", "operational"],
      ["FRA", "none"],
    ]);
    expect(data.regions[1]?.clusters[0]).toMatchObject({ pingMs: 42, uptime24h: 1 });
  });

  it("renders the history page grouped by month", async () => {
    const body = await (await app.fetch(request("/history"), seededEnv(), ctx)).text();
    expect(body).toContain("September 2026");
    expect(body).not.toMatch(/<main[^>]*data-live/);
  });

  it("rejects unknown paths and methods", async () => {
    expect((await app.fetch(request("/nope"), seededEnv(), ctx)).status).toBe(404);
    expect((await app.fetch(request("/", "POST"), seededEnv(), ctx)).status).toBe(405);
  });

  it("answers HEAD without a body", async () => {
    const response = await app.fetch(request("/", "HEAD"), seededEnv(), ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});
