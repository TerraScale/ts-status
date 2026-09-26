import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "./env";
import { testD1, type TestD1 } from "./testing/d1";

const NOW = "2026-09-26T10:15:00Z";

/** The seeded catalog plus a warning and the dashboard's recent probes. */
function seededEnv(): Env & { STATUS_DB: TestD1 } {
  const db = testD1();
  db.sqlite.exec(`
    INSERT INTO incidents (id, kind, title, status, impact, created_at, updated_at) VALUES
      ('i1', 'warning', 'Slow <queries>', 'monitoring', 'minor', '2026-09-26 09:00:00', '2026-09-26 09:30:00');
    INSERT INTO incident_updates (id, incident_id, status, body, created_at) VALUES
      ('u1', 'i1', 'investigating', 'Looking into it.', '2026-09-26 09:00:00'),
      ('u2', 'i1', 'monitoring', 'We are watching it.', '2026-09-26 09:30:00');
    INSERT INTO incidents (id, kind, title, status, impact, source, created_at, updated_at, resolved_at) VALUES
      ('i2', 'incident', 'Website is down', 'resolved', 'critical', 'auto',
       '2026-08-02 10:00:00', '2026-08-02 10:20:00', '2026-08-02 10:20:00');
    INSERT INTO incident_components (incident_id, component_id) VALUES ('i2', 'website');
    INSERT INTO incident_updates (id, incident_id, status, body, created_at) VALUES
      ('u3', 'i2', 'resolved', 'Recovered.', '2026-08-02 10:20:00');
    INSERT INTO incidents (id, kind, title, status, impact, scheduled_start, scheduled_end, created_at, updated_at) VALUES
      ('m1', 'maintenance', 'Forgejo upgrade', 'scheduled', 'none',
       '2026-09-26 10:00:00', '2026-09-26 11:00:00', '2026-09-20 10:00:00', '2026-09-20 10:00:00'),
      ('m2', 'maintenance', 'Atlas migration', 'scheduled', 'none',
       '2026-09-28 10:00:00', '2026-09-28 11:00:00', '2026-09-20 10:00:00', '2026-09-20 10:00:00');
    INSERT INTO incident_components (incident_id, component_id) VALUES ('m1', 'git'), ('m2', 'atlas');
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
    // Git is down but under maintenance, so only the warning degrades the headline.
    expect(body).toContain("Some systems are degraded");
    expect(body).toContain("Scheduled maintenance");
    expect(body).toContain("Forgejo upgrade");
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
    expect(body).toContain('data-title="Some systems are degraded · TerraScale Status"');
    expect(body).not.toContain("<style>");
  });

  it("serves repeat requests from the edge cache, ignoring query strings", async () => {
    const env = seededEnv();
    await app.fetch(request("/"), env, ctx);
    await app.fetch(request("/?bust=1"), env, ctx);
    expect(env.STATUS_DB.batches).toBe(1);
  });

  it("returns the JSON API", async () => {
    const response = await app.fetch(request("/api/v1/status"), seededEnv(), ctx);
    const data = (await response.json()) as {
      status: string;
      range: string;
      groups: { id: string; components: { id: string; status: string; uptime: number; bars: string[] }[] }[];
      regions: { code: string; status: string; clusters: { pingMs: number; uptime24h: number }[] }[];
    };
    expect(data.status).toBe("degraded");
    expect(data.groups.map((group) => group.id)).toEqual(["platform", "terrabase", "developer"]);
    const dashboard = data.groups[0]?.components[0];
    expect(data.range).toBe("90d");
    expect(dashboard).toMatchObject({ id: "dashboard", status: "operational", uptime: 1 });
    expect(dashboard?.bars).toHaveLength(90);
    expect(dashboard?.bars.at(-1)).toBe("operational");
    expect(data.groups[2]?.components[0]).toMatchObject({ id: "git", status: "maintenance" });
    expect(data.regions.map((region) => [region.code, region.status])).toEqual([
      ["SFO", "none"],
      ["GRU", "operational"],
      ["FRA", "none"],
    ]);
    expect(data.regions[1]?.clusters[0]).toMatchObject({ pingMs: 42, uptime: 1 });
  });

  it("switches the bars' range, caching each range apart", async () => {
    const env = seededEnv();
    const day = (await (await app.fetch(request("/api/v1/status?range=24h"), env, ctx)).json()) as {
      groups: { components: { bars: string[] }[] }[];
    };
    expect(day.groups[0]?.components[0]?.bars).toHaveLength(24);
    expect(day.groups[0]?.components[0]?.bars.at(-1)).toBe("operational");
    const body = await (await app.fetch(request("/?range=7d"), env, ctx)).text();
    expect(body).toContain('<a href="/?range=7d" aria-current="true">7d</a>');
    expect(body.match(/<li data-state=/g)?.length).toBeGreaterThanOrEqual(28);
    await app.fetch(request("/?range=bogus"), env, ctx);
    expect(env.STATUS_DB.batches).toBe(3);
  });

  it("gives every bar a hover card and every live region a map hub", async () => {
    const body = await (await app.fetch(request("/?range=24h"), seededEnv(), ctx)).text();
    expect(body).toContain('data-card="{&quot;rows&quot;:[[&quot;Uptime&quot;,&quot;100%&quot;]');
    expect(body).toContain('data-title="GRU · São Paulo"');
    expect(body).toContain('class="st-arc"');
    expect(body).toContain("Response time");
  });

  it("renders the history page grouped by month, with figures and filters", async () => {
    const response = await app.fetch(request("/history"), seededEnv(), ctx);
    const body = await response.text();
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(body).toContain("September 2026");
    expect(body).toContain("August 2026");
    expect(body).toContain("Auto-detected");
    expect(body).toContain("20m");
    expect(body).not.toContain("Forgejo upgrade");
    expect(body).not.toMatch(/<main[^>]*data-live/);
  });

  it("filters the history by component, kind, text and month", async () => {
    const text = async (path: string) => (await app.fetch(request(path), seededEnv(), ctx)).text();
    expect(await text("/history?component=website")).not.toContain("Slow &lt;queries&gt;");
    expect(await text("/history?kind=warning")).not.toContain("Website is down");
    expect(await text("/history?q=slow")).toContain("Slow &lt;queries&gt;");
    expect(await text("/history?q=nothing%25")).toContain("No matching incidents");
    expect(await text("/history?month=2026-08")).not.toContain("Slow &lt;queries&gt;");
  });

  it("renders an incident with its timeline", async () => {
    const body = await (await app.fetch(request("/incidents/i1"), seededEnv(), ctx)).text();
    expect(body).toContain("Slow &lt;queries&gt;");
    expect(body).toContain("Looking into it.");
    expect(body.indexOf("We are watching it.")).toBeLessThan(body.indexOf("Looking into it."));
    expect(body).toContain("All components");
    expect((await app.fetch(request("/incidents/nope"), seededEnv(), ctx)).status).toBe(404);
  });

  it("lists maintenance in progress and upcoming", async () => {
    const body = await (await app.fetch(request("/maintenance"), seededEnv(), ctx)).text();
    expect(body).toContain("In progress");
    expect(body.indexOf("Forgejo upgrade")).toBeLessThan(body.indexOf("Atlas migration"));
    expect(body).toContain('data-prefix="Starts"');
  });

  it("renders the uptime page with a year calendar and monthly table", async () => {
    const body = await (await app.fetch(request("/uptime"), seededEnv(), ctx)).text();
    expect(body.match(/<rect [^>]*data-state=/g)).toHaveLength(365);
    expect(body).toContain('class="st-sla"');
    expect(body).toContain('data-sla="met"');
  });

  it("renders component and region pages, and 404s for unknown ones", async () => {
    const env = seededEnv();
    const component = await (await app.fetch(request("/components/dashboard?range=24h"), env, ctx)).text();
    expect(component).toContain("From each vantage point");
    expect(component).toContain('<a href="/components/dashboard?range=24h" aria-current="true">24h</a>');
    expect(await (await app.fetch(request("/components/website"), env, ctx)).text()).toContain("Website is down");
    expect(await (await app.fetch(request("/components/auth"), env, ctx)).text()).toContain("Not launched yet");
    expect(await (await app.fetch(request("/regions/gru"), env, ctx)).text()).toContain("São Paulo");
    expect((await app.fetch(request("/components/nope"), env, ctx)).status).toBe(404);
    expect((await app.fetch(request("/regions/XYZ"), env, ctx)).status).toBe(404);
  });

  it("renders the ping page with vantage matrices and the browser test", async () => {
    const response = await app.fetch(request("/ping"), seededEnv(), ctx);
    const body = await response.text();
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self' https://*.terrascale.tech");
    expect(body).toContain('data-ping-url="https://dash.terrascale.tech/health/live"');
    expect(body).toContain('data-ping-url="/api/ping"');
    expect(body).toContain("Not yet live");
    expect(body.match(/class="st-ping-cell"/g)?.length).toBeGreaterThanOrEqual(4);
    const ping = await app.fetch(request("/api/ping"), seededEnv(), ctx);
    expect(ping.headers.get("cache-control")).toBe("no-store");
  });

  it("serves the Statuspage-compatible API", async () => {
    const env = seededEnv();
    const summary = (await (await app.fetch(request("/api/v2/summary.json"), env, ctx)).json()) as {
      page: { url: string };
      status: { indicator: string };
      components: { id: string; status: string; group: boolean }[];
      incidents: { name: string; incident_updates: unknown[] }[];
      scheduled_maintenances: { name: string; status: string }[];
    };
    expect(summary.page.url).toBe("https://status.test");
    expect(summary.status.indicator).toBe("minor");
    expect(summary.components.find((entry) => entry.id === "git")?.status).toBe("under_maintenance");
    expect(summary.components.some((entry) => entry.id === "auth")).toBe(false);
    expect(summary.incidents.map((entry) => entry.name)).toEqual(["Slow <queries>"]);
    expect(summary.incidents[0]?.incident_updates).toHaveLength(2);
    expect(summary.scheduled_maintenances.map((entry) => [entry.name, entry.status])).toEqual([
      ["Forgejo upgrade", "in_progress"],
      ["Atlas migration", "scheduled"],
    ]);
    const upcoming = (await (
      await app.fetch(request("/api/v2/scheduled-maintenances/upcoming.json"), env, ctx)
    ).json()) as {
      scheduled_maintenances: unknown[];
    };
    expect(upcoming.scheduled_maintenances).toHaveLength(1);
    expect((await app.fetch(request("/api/v2/incidents/unresolved.json"), env, ctx)).status).toBe(200);
    expect((await app.fetch(request("/api/v2/nope.json"), env, ctx)).status).toBe(404);
  });

  it("serves the v1 incidents, regions and latency", async () => {
    const env = seededEnv();
    const incidents = (await (await app.fetch(request("/api/v1/incidents?limit=2"), env, ctx)).json()) as {
      incidents: { updates: unknown[] }[];
    };
    expect(incidents.incidents).toHaveLength(2);
    const regions = (await (await app.fetch(request("/api/v1/regions"), env, ctx)).json()) as {
      regions: { code: string; live: boolean }[];
      vantages: unknown[];
    };
    expect(regions.regions.find((region) => region.code === "GRU")?.live).toBe(true);
    expect(regions.vantages).toHaveLength(4);
    const latency = (await (
      await app.fetch(request("/api/v1/latency?component=dashboard&range=24h"), env, ctx)
    ).json()) as {
      buckets: { vantages: Record<string, unknown> }[];
    };
    expect(latency.buckets).toHaveLength(24);
    expect(Object.keys(latency.buckets[0]?.vantages ?? {})).toEqual(["sfo", "gru", "fra", "nrt"]);
    expect((await app.fetch(request("/api/v1/latency?component=nope"), env, ctx)).status).toBe(404);
  });

  it("serves feeds, the calendar and badges with their types", async () => {
    const env = seededEnv();
    const type = async (path: string) => (await app.fetch(request(path), env, ctx)).headers.get("content-type");
    expect(await type("/feed.atom")).toBe("application/atom+xml; charset=utf-8");
    expect(await type("/feed.rss")).toBe("application/rss+xml; charset=utf-8");
    expect(await type("/maintenance.ics")).toBe("text/calendar; charset=utf-8");
    const status = await (await app.fetch(request("/badge/status.svg"), env, ctx)).text();
    expect(status).toContain("Some systems are degraded");
    expect(await (await app.fetch(request("/badge/auth.svg"), env, ctx)).text()).toContain("Planned");
    expect((await app.fetch(request("/badge/nope.svg"), env, ctx)).status).toBe(404);
  });

  it("serves an embeddable widget and the integrations page", async () => {
    const env = seededEnv();
    const embed = await app.fetch(request("/embed"), env, ctx);
    expect(embed.headers.get("content-security-policy")).toContain("frame-ancestors *");
    const body = await embed.text();
    expect(body).toContain("st-embed");
    expect(body).not.toContain("st-top");
    const integrations = await app.fetch(request("/integrations"), env, ctx);
    expect(integrations.headers.get("content-security-policy")).toContain("frame-src 'self'");
    expect(await integrations.text()).toContain("https://status.test/api/v2/summary.json");
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
