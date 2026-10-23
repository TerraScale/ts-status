import { describe, expect, it } from "vitest";
import { judge, parseSpec } from "../domain/assertions";
import { testD1 } from "../testing/d1";

/* The seeded catalog: the deployment regions, and what is probed in each. */
describe("probe catalog", () => {
  const sql = testD1().sqlite;

  const endpoint = (id: string) =>
    sql
      .prepare(
        "SELECT url, headers, expect_status AS expectStatus, blocked_status AS blockedStatus, keyword, assertions, extract, indirect FROM endpoints WHERE id = ?",
      )
      .get(id) as {
      url: string;
      headers: string;
      expectStatus: string;
      blockedStatus: number | null;
      keyword: string | null;
      assertions: string;
      extract: string;
      indirect: number;
    };

  it("names the deployment regions", () => {
    expect(sql.prepare("SELECT code, name FROM regions ORDER BY position").all()).toEqual([
      { code: "GRU", name: "São Paulo" },
      { code: "SJC", name: "San Francisco Bay Area" },
      { code: "FRA", name: "Frankfurt" },
    ]);
  });

  it("starts every endpoint pending launch and probes every component", () => {
    expect(sql.prepare("SELECT count(*) AS n FROM endpoints WHERE live_since IS NOT NULL").get()).toEqual({ n: 0 });
    expect(sql.prepare("SELECT name FROM components WHERE lifecycle = 'planned'").all()).toEqual([]);
    expect(
      sql
        .prepare(
          "SELECT name FROM components WHERE NOT EXISTS (SELECT 1 FROM endpoints WHERE component_id = components.id)",
        )
        .all(),
    ).toEqual([]);
  });

  it("requires the dashboard's readiness", () => {
    const row = endpoint("01M5K15M315JB1H3FYW3VS1S55");
    expect(row.url).toBe("https://dash.terrascale.tech/health/ready");
    const spec = parseSpec(row);
    const ready = (status: string) =>
      judge(spec, { status: 200, error: null, body: JSON.stringify({ status, version: "v1" }) });
    expect(ready("ok")).toEqual({ outcome: "ok", error: null, values: { version: "v1" } });
    expect(ready("starting").outcome).toBe("fail");
    expect(judge(spec, { status: 503, error: null }).outcome).toBe("fail");
  });

  it("requires ts-auth readiness once: its host serves every region and names none", () => {
    expect(sql.prepare("SELECT id FROM endpoints WHERE url = 'https://auth.terrascale.tech/readyz'").all()).toEqual([
      { id: "01M4E7G1W82VKFPF5FJ9AVK1D6" },
    ]);
    const spec = parseSpec(endpoint("01M4E7G1W82VKFPF5FJ9AVK1D6"));
    const ready = (status: string) =>
      judge(spec, { status: 200, error: null, body: JSON.stringify({ status, version: "v1" }) });
    expect(ready("ready")).toEqual({ outcome: "ok", error: null, values: { version: "v1" } });
    expect(ready("not_ready").outcome).toBe("fail");
    expect(judge(spec, { status: 503, error: null }).outcome).toBe("fail");
  });

  it("requires TerraBase readiness from each catalog region and fails a check another region answered", () => {
    for (const [id, host, region] of [
      ["01M4E7G1W82VKFPF5FJ9AVK1DQ", "api", "gru"],
      ["01M4E7G1W82VKFPF5FJ9AVK1DR", "api", "sjc"],
      ["01M4E7G1W82VKFPF5FJ9AVK1DY", "api", "fra"],
    ] as const) {
      const row = endpoint(id);
      expect(row.url).toBe(`https://${host}.terrascale.tech/readyz`);
      expect(JSON.parse(row.headers)).toEqual({ "X-TerraScale-Region-Pin": region });
      const spec = parseSpec(row);
      const ready = (status: string, served: string) =>
        judge(spec, { status: 200, error: null, body: JSON.stringify({ status, version: "v1", region: served }) });
      expect(ready("ready", region)).toEqual({ outcome: "ok", error: null, values: { version: "v1" } });
      // A response from a different deployment must not count as this region.
      expect(ready("ready", region === "gru" ? "fra" : "gru").outcome).toBe("fail");
      expect(ready("not_ready", region).outcome).toBe("fail");
      expect(judge(spec, { status: 503, error: null }).outcome).toBe("fail");
    }
  });

  it("requires TerraBase replication health from each catalog region and passes only when it is ok from that region", () => {
    for (const [id, region] of [
      ["01M4PVGGBHD58R8HYNDBTGFRGJ", "gru"],
      ["01M4PVGGBJ24A140MWGJV7MVKV", "sjc"],
      ["01M4PVGGBJA6S4F64HDQVD2MXM", "fra"],
    ] as const) {
      const row = endpoint(id);
      expect(row.url).toBe("https://api.terrascale.tech/health/replication");
      expect(JSON.parse(row.headers)).toEqual({ "X-TerraScale-Region-Pin": region });
      const spec = parseSpec(row);
      const health = (status: string, served: string) =>
        judge(spec, {
          status: 200,
          error: null,
          body: JSON.stringify({ region: served, status, maxLagSeconds: 4, peers: [] }),
        });
      expect(health("ok", region)).toEqual({ outcome: "ok", error: null, values: { lag: 4 } });
      expect(health("degraded", region).outcome).toBe("fail");
      expect(health("ok", region === "gru" ? "fra" : "gru").outcome).toBe("fail");
    }
  });

  it("checks every regional data API for invalid_key on an unauthenticated read", () => {
    for (const [id, region] of [
      ["01M4E7G1W82VKFPF5FJ9AVK1DB", "gru"],
      ["01M4E7G1W82VKFPF5FJ9AVK1DC", "sjc"],
      ["01M4E7G1W82VKFPF5FJ9AVK1E0", "fra"],
    ] as const) {
      const row = endpoint(id);
      expect(row.url).toBe(
        "https://api.terrascale.tech/v1/projects/01M4E7G1W82VKFPF5FJ9AVK1DT/databases/status_canary/collections/canary/documents/by-key?id=01M4E7G1W82VKFPF5FJ9AVK1DV",
      );
      expect(JSON.parse(row.headers)).toEqual({ "X-TerraScale-Region-Pin": region });
      expect(row.expectStatus).toBe("401");
      expect(JSON.parse(row.assertions)).toEqual([{ path: "error.code", op: "eq", value: "invalid_key" }]);
    }
  });

  it("runs the TerraBase document probes in the coordinator, one per region, with no origin or key in the catalog", () => {
    expect(
      sql
        .prepare("SELECT region_code, kind, probe, url FROM endpoints WHERE probe IS NOT NULL ORDER BY region_code")
        .all(),
    ).toEqual(
      ["FRA", "GRU", "SJC"].map((region_code) => ({
        region_code,
        kind: "canary",
        probe: "documents",
        url: "/v1/projects/{project}/databases/{database}/collections/{collection}",
      })),
    );
  });

  it("validates the platform tenant's OIDC discovery", () => {
    const spec = parseSpec(endpoint("01M4E7G1W82VKFPF5FJ9AVK1D7"));
    expect(endpoint("01M4E7G1W82VKFPF5FJ9AVK1D7").url).toBe(
      "https://auth.terrascale.tech/terrascale/.well-known/openid-configuration",
    );
    const discovery = (issuer: string) =>
      judge(spec, { status: 200, error: null, body: JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }) }).outcome;
    expect(discovery("https://auth.terrascale.tech/terrascale")).toBe("ok");
    expect(discovery("https://auth.terrascale.tech")).toBe("fail");
    expect(judge(spec, { status: 404, error: null }).outcome).toBe("fail");
  });

  it("reads email health from Cloudflare's status page, where an unreachable page is unknown", () => {
    const spec = parseSpec(endpoint("01M4E7G1W82VKFPF5FJ9AVK1DH"));
    expect(spec.indirect).toBe(true);
    const component = (status: string) =>
      judge(spec, { status: 200, error: null, body: JSON.stringify({ component: { name: "Email Sending", status } }) })
        .outcome;
    expect(component("operational")).toBe("ok");
    expect(component("major_outage")).toBe("fail");
    expect(judge(spec, { status: null, error: "Unreachable" }).outcome).toBe("unknown");
  });

  it("probes the public sites and nothing retired", () => {
    expect(endpoint("01M4E7G1W82VKFPF5FJ9AVK1DD").url).toBe("https://docs.terrascale.tech/");
    expect(endpoint("01M4E7G1W82VKFPF5FJ9AVK1DS")).toMatchObject({
      url: "https://terrascale.tech/",
      keyword: "TerraScale",
    });
    expect(
      sql
        .prepare(
          "SELECT url FROM endpoints WHERE url LIKE '%git.%' OR url LIKE '%sync.%' OR url LIKE '%gru.api%' OR url LIKE '%/tenants/%'",
        )
        .all(),
    ).toEqual([]);
  });
});
