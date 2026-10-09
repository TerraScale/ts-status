import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "./env";
import { regionLatencyDocument } from "./api/latency";
import { testD1, type TestD1 } from "./testing/d1";

const NOW = "2026-09-26T10:15:00Z";
type RegionLatency = ReturnType<typeof regionLatencyDocument>;

/** The seeded catalog plus a warning and the dashboard's recent probes. */
function seededEnv(): Env & { STATUS_DB: TestD1 } {
  const db = testD1();
  db.sqlite.exec(`
    INSERT INTO incidents (id, kind, title, status, impact, created_at, updated_at) VALUES
      ('00000000000000000000000002', 'warning', 'Slow <queries>', 'monitoring', 'minor', '2026-09-26 09:00:00', '2026-09-26 09:30:00');
    INSERT INTO incident_updates (id, incident_id, status, body, created_at) VALUES
      ('00000000000000000000000008', '00000000000000000000000002', 'investigating', 'Looking into it.', '2026-09-26 09:00:00'),
      ('00000000000000000000000009', '00000000000000000000000002', 'monitoring', 'We are watching it.', '2026-09-26 09:30:00');
    INSERT INTO incidents (id, kind, title, status, impact, source, created_at, updated_at, resolved_at) VALUES
      ('00000000000000000000000003', 'incident', 'Website is down', 'resolved', 'critical', 'auto',
       '2026-08-02 10:00:00', '2026-08-02 10:20:00', '2026-08-02 10:20:00');
    INSERT INTO incident_components (incident_id, component_id) VALUES ('00000000000000000000000003', '01M4E7G1W82VKFPF5FJ9AVK1D3');
    INSERT INTO incident_updates (id, incident_id, status, body, created_at) VALUES
      ('00000000000000000000000010', '00000000000000000000000003', 'resolved', 'Recovered.', '2026-08-02 10:20:00');
    INSERT INTO incidents (id, kind, title, status, impact, scheduled_start, scheduled_end, created_at, updated_at) VALUES
      ('00000000000000000000000006', 'maintenance', 'Forgejo upgrade', 'scheduled', 'none',
       '2026-09-26 10:00:00', '2026-09-26 11:00:00', '2026-09-20 10:00:00', '2026-09-20 10:00:00'),
      ('00000000000000000000000007', 'maintenance', 'Atlas migration', 'scheduled', 'none',
       '2026-09-28 10:00:00', '2026-09-28 11:00:00', '2026-09-20 10:00:00', '2026-09-20 10:00:00');
    INSERT INTO incident_components (incident_id, component_id) VALUES ('00000000000000000000000006', '01M4E7G1W82VKFPF5FJ9AVK1CZ'), ('00000000000000000000000007', '01M4E7G1W82VKFPF5FJ9AVK1CS');
    INSERT INTO probe_samples (endpoint_id, at, state, ok, total, latency_ms, results) VALUES
      ('01M4E7G1W82VKFPF5FJ9AVK1D8', '2026-09-26 10:14:30', 'operational', 4, 4, 42, '[]'),
      ('01M4E7G1W82VKFPF5FJ9AVK1DS', '2026-09-26 10:14:30', 'operational', 4, 4, 30, '[]'),
      ('01M4E7G1W82VKFPF5FJ9AVK1D5', '2026-09-26 10:14:30', 'operational', 4, 4, 80, '[]'),
      ('01M4E7G1W82VKFPF5FJ9AVK1DH', '2026-09-26 10:14:30', 'major_outage', 0, 4, NULL, '[]');
    INSERT INTO probe_hours (endpoint_id, hour, vantage, checks, failures, degraded, latency_sum, latency_max) VALUES
      ('01M4E7G1W82VKFPF5FJ9AVK1D8', '2026-09-26 10:00:00', 'all', 30, 0, 0, 1260, 60);
    INSERT INTO probe_days (endpoint_id, day, vantage, checks, failures, degraded, latency_sum, latency_max, hist) VALUES
      ('01M4E7G1W82VKFPF5FJ9AVK1D8', '2026-09-26 00:00:00', 'all', 1200, 0, 0, 50400, 90, '[]');
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
  it("serves an uncached deployment revision without reading D1", async () => {
    const version = "a".repeat(40);
    const response = await app.fetch(request("/health/version"), { VERSION: version } as Env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ version });
    expect((await app.fetch(request("/health/version", "POST"), {} as Env, ctx)).status).toBe(405);
  });
  beforeEach(() => {
    const store = new Map<string, { response: Response; expires: number }>();
    vi.stubGlobal("caches", {
      default: {
        match: async (key: Request) => {
          const entry = store.get(key.url);
          return entry && entry.expires > Date.now() ? entry.response.clone() : undefined;
        },
        put: async (key: Request, response: Response) => {
          const seconds = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1] ?? 0);
          store.set(key.url, { response, expires: Date.now() + seconds * 1_000 });
        },
      },
    });
    vi.useFakeTimers({ now: Date.parse(NOW), toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("coalesces deployment cache misses and ignores caller query strings", async () => {
    const version = "a".repeat(40);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = vi.fn(async () => {
      await gate;
      return Response.json({ version, results: [] });
    });
    const env = { VANTAGE_GRU: { fetch }, VANTAGE_SFO: { fetch } } as unknown as Env;
    const responses = Promise.all([
      app.fetch(request("/api/v1/deployments?bust=1"), env, ctx),
      app.fetch(request("/api/v1/deployments?target=https://other.test"), env, ctx),
    ]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    release();
    const [first, second] = await responses;
    expect(first.headers.get("cache-control")).toBe("no-store");
    const observations = await first.json();
    expect(await second.json()).toEqual(observations);

    // The edge cache is shared even when the binding object changes.
    const cached = await app.fetch(request("/api/v1/deployments?bust=2"), { ...env }, ctx);
    expect(await cached.json()).toEqual(observations);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await app.fetch(request("/api/v1/deployments", "POST"), env, ctx)).status).toBe(405);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("expires deployment observations after ten seconds without refreshing cached timestamps or reading D1", async () => {
    const fetch = vi.fn(async () => Response.json({ version: "a".repeat(40), results: [] }));
    const env = { ...seededEnv(), VANTAGE_GRU: { fetch }, VANTAGE_SFO: { fetch } } as unknown as Env;
    const exec = vi.spyOn(env.STATUS_DB, "exec").mockRejectedValue(new Error("D1 unavailable"));
    const first = await (await app.fetch(request("/api/v1/deployments"), env, ctx)).json();
    vi.setSystemTime(Date.parse(NOW) + 9_999);
    const cached = await (await app.fetch(request("/api/v1/deployments"), env, ctx)).json();
    expect(cached).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.parse(NOW) + 10_000);
    const fresh = (await (await app.fetch(request("/api/v1/deployments"), env, ctx)).json()) as {
      observedAt: string;
    }[];
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fresh).toHaveLength(8);
    expect(fresh.every((row) => row.observedAt === "2026-09-26T10:15:10.000Z")).toBe(true);
    expect(exec).not.toHaveBeenCalled();
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

  it("warns about certificates close to expiry and shows them on clusters", async () => {
    const env = seededEnv();
    env.STATUS_DB.sqlite.exec(`INSERT INTO tls_certs (host, not_after, issuer, checked_at) VALUES
      ('dash.terrascale.tech', '2026-10-01 00:00:00', 'Let''s Encrypt', '2026-09-26 10:17:00'),
      ('terrascale.tech', '2026-12-21 00:00:00', 'Google Trust Services', '2026-09-26 10:17:00')`);
    const body = await (await app.fetch(request("/"), env, ctx)).text();
    expect(body).toContain("Certificate renewal due for dash.terrascale.tech");
    expect(body).not.toContain("Certificate renewal due for terrascale.tech");
    expect(body).toContain("TLS until Oct 1");
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

  it.each(["/", "/api/operator/incidents", "/subscribe"])(
    "returns a controlled 503 on bootstrap failure for %s and retries",
    async (path) => {
      const env = seededEnv();
      const exec = vi.spyOn(env.STATUS_DB, "exec").mockRejectedValueOnce(new Error("D1 unavailable"));
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const response = await app.fetch(request(path), env, ctx);
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("10");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).toBe("Status is temporarily unavailable.");
        expect((await app.fetch(request("/"), env, ctx)).status).toBe(200);
        expect(exec).toHaveBeenCalledTimes(2);
      } finally {
        log.mockRestore();
      }
    },
  );

  it("serves ping and cached pages without bootstrapping D1", async () => {
    await app.fetch(request("/"), seededEnv(), ctx);
    const env = seededEnv();
    const exec = vi.spyOn(env.STATUS_DB, "exec").mockRejectedValue(new Error("D1 unavailable"));
    expect((await app.fetch(request("/api/ping"), env, ctx)).status).toBe(200);
    expect((await app.fetch(request("/"), env, ctx)).status).toBe(200);
    expect(exec).not.toHaveBeenCalled();
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
    expect(data.groups.map((group) => group.id)).toEqual([
      "01M4E7G1W7XH3WHVG75QYZRE6Y",
      "01M4E7G1W82VKFPF5FJ9AVK1CQ",
      "01M4E7G1W6RJFB7Z87ARTHB8BW",
    ]);
    const dashboard = data.groups[0]?.components[0];
    expect(data.range).toBe("90d");
    expect(dashboard).toMatchObject({ id: "01M4E7G1W82VKFPF5FJ9AVK1CV", status: "operational", uptime: 1 });
    expect(dashboard?.bars).toHaveLength(90);
    expect(dashboard?.bars.at(-1)).toBe("operational");
    expect(data.groups[2]?.components[0]).toMatchObject({ id: "01M4E7G1W82VKFPF5FJ9AVK1CZ", status: "maintenance" });
    expect(data.regions.map((region) => [region.code, region.status])).toEqual([
      ["SFO", "none"],
      ["GRU", "operational"],
      ["FRA", "none"],
    ]);
    expect(data.regions[1]?.clusters[0]).toMatchObject({ pingMs: 42, uptime: 1 });
  });

  it("shows TerraBase probes the secret does not name as not configured, not down", async () => {
    const env = seededEnv();
    env.STATUS_DB.sqlite.exec(`
      INSERT INTO probe_samples (endpoint_id, at, state, ok, total, latency_ms, results) VALUES
        ('01M4E7G1W82VKFPF5FJ9AVK1DQ', '2026-09-26 10:14:30', 'none', 0, 0, NULL,
          '[{"v":"canary","ok":null,"ms":null,"e":"Not configured"}]'),
        ('01M4E7G1W82VKFPF5FJ9AVK1DK', '2026-09-26 10:14:30', 'none', 0, 0, NULL,
          '[{"v":"canary","ok":null,"ms":null,"e":"Not configured"}]'),
        ('01M4E7G1W82VKFPF5FJ9AVK1DF', '2026-09-26 10:14:30', 'operational', 1, 1, 120,
          '[{"v":"canary","ok":1,"ms":120,"e":null}]');
      -- An incident outranks the note.
      INSERT INTO incidents (id, kind, title, status, impact, created_at, updated_at) VALUES
        ('00000000000000000000000004', 'incident', 'Control plane down', 'investigating', 'critical', '2026-09-26 10:10:00', '2026-09-26 10:10:00');
      INSERT INTO incident_components (incident_id, component_id) VALUES ('00000000000000000000000004', '01M4E7G1W82VKFPF5FJ9AVK1D0');
    `);
    const data = (await (await app.fetch(request("/api/v1/status"), env, ctx)).json()) as {
      groups: { components: { id: string; status: string; note: string | null }[] }[];
    };
    const terrabase = data.groups[1]?.components.filter(
      (entry) => entry.id !== "01M4E7G1W82VKFPF5FJ9AVK1CW" && entry.id !== "01M4E7G1W82VKFPF5FJ9AVK1D1",
    );
    expect(terrabase?.map(({ id, status, note }) => ({ id, status, note }))).toEqual([
      { id: "01M4E7G1W82VKFPF5FJ9AVK1CR", status: "none", note: null },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1D2", status: "none", note: "Not configured" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1CY", status: "operational", note: null },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1D0", status: "major_outage", note: null },
    ]);
    const page = await (await app.fetch(request("/?fragment=main"), env, ctx)).text();
    expect(page).toContain("TerraBase health: No data uptime over the last 90 days, currently not configured");
    expect(page).toMatch(/data-state="none"><span class="ts-dot" aria-hidden="true"><\/span>Not configured/);
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
    expect(await text("/history?component=01M4E7G1W82VKFPF5FJ9AVK1D3")).not.toContain("Slow &lt;queries&gt;");
    expect(await text("/history?kind=warning")).not.toContain("Website is down");
    expect(await text("/history?q=slow")).toContain("Slow &lt;queries&gt;");
    expect(await text("/history?q=nothing%25")).toContain("No matching incidents");
    expect(await text("/history?month=2026-08")).not.toContain("Slow &lt;queries&gt;");
  });

  it("renders an incident with its timeline", async () => {
    const body = await (await app.fetch(request("/incidents/00000000000000000000000002"), seededEnv(), ctx)).text();
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
    const component = await (
      await app.fetch(request("/components/01M4E7G1W82VKFPF5FJ9AVK1CV?range=24h"), env, ctx)
    ).text();
    expect(component).toContain("From each vantage point");
    expect(component).toContain(
      '<a href="/components/01M4E7G1W82VKFPF5FJ9AVK1CV?range=24h" aria-current="true">24h</a>',
    );
    expect(await (await app.fetch(request("/components/01M4E7G1W82VKFPF5FJ9AVK1D3"), env, ctx)).text()).toContain(
      "Website is down",
    );
    expect(await (await app.fetch(request("/components/01M4E7G1W82VKFPF5FJ9AVK1CX"), env, ctx)).text()).toContain(
      "Not launched yet",
    );
    expect(await (await app.fetch(request("/regions/gru"), env, ctx)).text()).toContain("São Paulo");
    expect((await app.fetch(request("/components/nope"), env, ctx)).status).toBe(404);
    expect((await app.fetch(request("/regions/XYZ"), env, ctx)).status).toBe(404);
  });

  it("renders the ping page with vantage matrices and the browser test", async () => {
    const response = await app.fetch(request("/ping"), seededEnv(), ctx);
    const body = await response.text();
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self' https://*.terrascale.tech");
    expect(body).toContain('data-ping-url="https://gru.api.terrascale.tech/healthz"');
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
    expect(summary.components.find((entry) => entry.id === "01M4E7G1W82VKFPF5FJ9AVK1CZ")?.status).toBe(
      "under_maintenance",
    );
    expect(summary.components.some((entry) => entry.id === "01M4E7G1W82VKFPF5FJ9AVK1CT")).toBe(true);
    expect(summary.components.some((entry) => entry.id === "01M4E7G1W82VKFPF5FJ9AVK1CX")).toBe(false);
    expect(summary.incidents.map((entry) => entry.name)).toEqual(["Slow <queries>"]);
    expect(summary.incidents[0]?.incident_updates).toHaveLength(2);
    // Both were last updated in the same second; the id breaks the tie.
    expect(summary.scheduled_maintenances.map((entry) => [entry.name, entry.status])).toEqual([
      ["Atlas migration", "scheduled"],
      ["Forgejo upgrade", "in_progress"],
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
      await app.fetch(request("/api/v1/latency?component=01M4E7G1W82VKFPF5FJ9AVK1CV&range=24h"), env, ctx)
    ).json()) as {
      buckets: { vantages: Record<string, unknown> }[];
    };
    expect(latency.buckets).toHaveLength(24);
    expect(Object.keys(latency.buckets[0]?.vantages ?? {})).toEqual(["sfo", "gru", "fra", "nrt"]);
    expect((await app.fetch(request("/api/v1/latency?component=nope"), env, ctx)).status).toBe(404);
  });

  it("serves public region latency from the completed hour, merging cluster histograms", async () => {
    const env = seededEnv();
    env.STATUS_DB.sqlite.exec(`
      INSERT INTO probe_hours (endpoint_id, hour, vantage, checks, failures, degraded, latency_sum, latency_max, hist) VALUES
        ('01M4E7G1W82VKFPF5FJ9AVK1D8', '2026-09-26 09:00:00', 'all', 4, 2, 0, 150, 100, '[1,1,0,0,0,0,0,0,0,0,0,0,0]'),
        ('01M4E7G1W82VKFPF5FJ9AVK1DB', '2026-09-26 09:00:00', 'all', 2, 0, 0, 200, 100, '[0,2,0,0,0,0,0,0,0,0,0,0,0]'),
        ('01M4E7G1W82VKFPF5FJ9AVK1D8', '2026-09-26 09:00:00', 'sfo', 2, 0, 0, 400, 200, '[0,0,0,2,0,0,0,0,0,0,0,0,0]'),
        ('01M4E7G1W82VKFPF5FJ9AVK1D8', '2026-09-26 09:00:00', 'gru', 2, 0, 0, 80, 50, '[2,0,0,0,0,0,0,0,0,0,0,0,0]'),
        ('01M4E7G1W82VKFPF5FJ9AVK1D8', '2026-09-26 08:00:00', 'all', 100, 0, 0, 100000, 1000, '[0,0,0,0,0,0,0,0,100,0,0,0,0]'),
        ('01M4E7G1W82VKFPF5FJ9AVK1DS', '2026-09-26 09:00:00', 'all', 100, 0, 0, 100000, 1000, '[0,0,0,0,0,0,0,0,100,0,0,0,0]');
      UPDATE probe_hours SET hist = '[0,0,0,0,0,0,0,0,100,0,0,0,0]' WHERE hour = '2026-09-26 10:00:00';
    `);
    const response = await app.fetch(request("/api/latency"), env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("public, max-age=10");
    const data = (await response.json()) as RegionLatency;
    expect(data.generated_at).toBe("2026-09-26T10:15:00.000Z");
    expect(data.window).toBe("1h");
    expect(data.regions.map((region) => region.code)).toEqual(["sfo", "gru", "fra"]);
    expect(data.regions[1]).toEqual({
      code: "gru",
      name: "São Paulo",
      ping_url: "https://gru.api.terrascale.tech/healthz",
      status: "operational",
      consensus: { median_ms: 67, p95_ms: 97, samples: 4 },
      vantages: [
        { code: "sfo", name: "US West", median_ms: 175, p95_ms: 198, samples: 2 },
        { code: "gru", name: "South America", median_ms: 25, p95_ms: 48, samples: 2 },
        { code: "fra", name: "Europe", median_ms: null, p95_ms: null, samples: 0 },
        { code: "nrt", name: "Asia Pacific", median_ms: null, p95_ms: null, samples: 0 },
      ],
    });
    expect(data.regions[0]).toMatchObject({
      status: "planned",
      ping_url: null,
      consensus: { median_ms: null, p95_ms: null, samples: 0 },
    });
    await app.fetch(request("/api/latency?bust=1"), env, ctx);
    expect(env.STATUS_DB.batches).toBe(1);
  });

  it("filters region latency and caches each filter separately", async () => {
    const env = seededEnv();
    const read = async (path: string) => (await (await app.fetch(request(path), env, ctx)).json()) as RegionLatency;
    expect((await read("/api/latency?region=gru")).regions.map((region) => region.code)).toEqual(["gru"]);
    expect((await read("/api/latency?region=gru&bust=1")).regions).toHaveLength(1);
    expect(env.STATUS_DB.batches).toBe(1);
    expect((await read("/api/latency?region=GRU")).regions[0]?.code).toBe("gru");
    expect((await read("/api/latency?region=unknown")).regions).toEqual([]);
    expect((await read("/api/latency")).regions).toHaveLength(3);
    expect(env.STATUS_DB.batches).toBe(4);
  });

  it.each([
    ["degraded", "degraded"],
    ["partial_outage", "down"],
    ["major_outage", "down"],
    ["none", "planned"],
  ])("maps region state %s to %s with null stats without measured latency", async (state, status) => {
    const env = seededEnv();
    await env.STATUS_DB.prepare("UPDATE probe_samples SET state = ? WHERE endpoint_id = '01M4E7G1W82VKFPF5FJ9AVK1D8'")
      .bind(state)
      .run();
    const data = (await (await app.fetch(request("/api/latency?region=gru"), env, ctx)).json()) as RegionLatency;
    expect(data.regions[0]).toMatchObject({ status, consensus: { median_ms: null, p95_ms: null, samples: 0 } });
  });

  it("serves feeds, the calendar and badges with their types", async () => {
    const env = seededEnv();
    const type = async (path: string) => (await app.fetch(request(path), env, ctx)).headers.get("content-type");
    expect(await type("/feed.atom")).toBe("application/atom+xml; charset=utf-8");
    expect(await type("/feed.rss")).toBe("application/rss+xml; charset=utf-8");
    expect(await type("/maintenance.ics")).toBe("text/calendar; charset=utf-8");
    const status = await (await app.fetch(request("/badge/status.svg"), env, ctx)).text();
    expect(status).toContain("Some systems are degraded");
    expect(await (await app.fetch(request("/badge/01M4E7G1W82VKFPF5FJ9AVK1CX.svg"), env, ctx)).text()).toContain(
      "Planned",
    );
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
    const integrationsBody = await integrations.text();
    expect(integrationsBody).toContain("https://status.test/api/v2/summary.json");
    expect(integrationsBody).toContain("https://status.test/api/latency?region=gru");
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
