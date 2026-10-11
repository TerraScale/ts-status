import { describe, expect, it } from "vitest";
import { judge, parseSpec } from "../domain/assertions";
import { testD1 } from "../testing/d1";

/* The migrated probe catalog: what is probed today, and what waits for launch. */
describe("probe catalog", () => {
  const sql = testD1().sqlite;

  it("names the regions", () => {
    expect(sql.prepare("SELECT code, name FROM regions ORDER BY position").all()).toEqual([
      { code: "SJC", name: "San Jose" },
      { code: "GRU", name: "São Paulo" },
    ]);
  });

  it("enables launched checks and observes pending OIDC discovery", () => {
    expect(sql.prepare("SELECT id FROM endpoints WHERE enabled = 1 ORDER BY id").all()).toEqual([
      { id: "01M4E7G1W82VKFPF5FJ9AVK1D4" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1D6" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1D7" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1D8" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1DB" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1DF" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1DH" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1DQ" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1DS" },
    ]);
    expect(sql.prepare("SELECT id FROM endpoints WHERE enabled = 0 ORDER BY id").all()).toEqual([
      { id: "01M4E7G1W82VKFPF5FJ9AVK1D9" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1DC" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1DD" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1DG" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1DN" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1DR" },
    ]);
  });

  it("checks the API router and every regional data API for invalid_key on an unauthenticated read", () => {
    const rows = sql
      .prepare(
        `SELECT id, url, expect_status, assertions FROM endpoints
          WHERE id IN ('01M4E7G1W82VKFPF5FJ9AVK1D4', '01M4E7G1W82VKFPF5FJ9AVK1DC', '01M4E7G1W82VKFPF5FJ9AVK1DB') ORDER BY id`,
      )
      .all();
    expect(rows.map((row) => [row.id, new URL(String(row.url)).host])).toEqual([
      ["01M4E7G1W82VKFPF5FJ9AVK1D4", "api.terrascale.tech"],
      ["01M4E7G1W82VKFPF5FJ9AVK1DB", "api.terrascale.tech"],
      ["01M4E7G1W82VKFPF5FJ9AVK1DC", "api.terrascale.tech"],
    ]);
    for (const row of rows) {
      expect(new URL(String(row.url)).pathname).toBe(
        "/v1/projects/01M4E7G1W82VKFPF5FJ9AVK1DT/databases/status_canary/collections/canary/documents/01M4E7G1W82VKFPF5FJ9AVK1DV",
      );
      expect(row.expect_status).toBe("401");
      expect(JSON.parse(String(row.assertions))).toEqual([{ path: "error.code", op: "eq", value: "invalid_key" }]);
    }
  });

  it("runs the TerraBase probes in the coordinator, one per region, with no origin or key in the catalog", () => {
    expect(
      sql
        .prepare(
          "SELECT component_id, region_code, kind, probe, url FROM endpoints WHERE probe IS NOT NULL ORDER BY id",
        )
        .all()
        .filter((row) => row.region_code === "GRU"),
    ).toEqual([
      {
        component_id: "01M4E7G1W82VKFPF5FJ9AVK1CY",
        region_code: "GRU",
        kind: "canary",
        probe: "documents",
        url: "/v1/projects/{project}/databases/{database}/collections/{collection}",
      },
      {
        component_id: "01M4E7G1W82VKFPF5FJ9AVK1D2",
        region_code: "GRU",
        kind: "canary",
        probe: "health",
        url: "/readyz",
      },
    ]);
    expect(sql.prepare("SELECT count(*) AS n FROM endpoints WHERE probe IS NOT NULL").get()).toEqual({ n: 4 });
  });

  it("labels OIDC pending while keeping its non-404 failures in active authentication", () => {
    expect(sql.prepare("SELECT id FROM components WHERE lifecycle = 'planned' ORDER BY id").all()).toEqual([
      { id: "01M4E7G1W82VKFPF5FJ9AVK1CX" },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1D1" },
    ]);
    expect(sql.prepare("SELECT kind FROM endpoints WHERE id = '01M4E7G1W82VKFPF5FJ9AVK1D9'").get()).toEqual({
      kind: "canary",
    });
    expect(sql.prepare("SELECT lifecycle FROM components WHERE id = '01M4E7G1W82VKFPF5FJ9AVK1CT'").get()).toEqual({
      lifecycle: "active",
    });
    expect(sql.prepare("SELECT description FROM components WHERE id = '01M4E7G1W82VKFPF5FJ9AVK1CT'").get()).toEqual({
      description: "Sign-in, accounts and API keys; OIDC discovery pending (404)",
    });
    expect(sql.prepare("SELECT component_id FROM endpoints WHERE id = '01M4E7G1W82VKFPF5FJ9AVK1D7'").get()).toEqual({
      component_id: "01M4E7G1W82VKFPF5FJ9AVK1CT",
    });
    const oidc = endpoint("01M4E7G1W82VKFPF5FJ9AVK1D7");
    expect(oidc.url).toBe("https://auth.terrascale.tech/.well-known/openid-configuration");
    expect(oidc.pendingStatus).toBe(404);
    expect(oidc.expectStatus).toBe("200");
    const spec = parseSpec(oidc);
    expect(judge(spec, { status: 404, error: null })).toEqual({
      outcome: "unknown",
      error: "Not available yet (HTTP 404)",
      values: {},
    });
    expect(
      judge(spec, {
        status: 200,
        error: null,
        body: '{"issuer":"https://auth.terrascale.tech","jwks_uri":"https://auth.terrascale.tech/.well-known/jwks.json"}',
      }).outcome,
    ).toBe("ok");
    expect(judge(spec, { status: 200, error: null, body: "{}" }).outcome).toBe("fail");
    expect(
      judge(spec, {
        status: 200,
        error: null,
        body: '{"issuer":"https://other.example","jwks_uri":"https://other.example/jwks"}',
      }).outcome,
    ).toBe("fail");
    expect(judge(spec, { status: 503, error: null }).outcome).toBe("fail");
  });

  it("treats Cloudflare's 403 as a blocked probe only on dash and git", () => {
    expect(
      sql.prepare("SELECT id, blocked_status FROM endpoints WHERE blocked_status IS NOT NULL ORDER BY id").all(),
    ).toEqual([
      { id: "01M4E7G1W82VKFPF5FJ9AVK1D8", blocked_status: 403 },
      { id: "01M4E7G1W82VKFPF5FJ9AVK1DH", blocked_status: 403 },
    ]);
    expect(judge(parseSpec(endpoint("01M4E7G1W82VKFPF5FJ9AVK1DH")), { status: 403, error: null })).toEqual({
      outcome: "unknown",
      error: "Probe blocked (HTTP 403)",
      values: {},
    });
    expect(judge(parseSpec(endpoint("01M4E7G1W82VKFPF5FJ9AVK1DH")), { status: 503, error: null }).outcome).toBe("fail");
    expect(judge(parseSpec(endpoint("01M4E7G1W82VKFPF5FJ9AVK1D6")), { status: 403, error: null }).outcome).toBe("fail");
  });

  const endpoint = (id: string) =>
    sql
      .prepare(
        "SELECT url, expect_status AS expectStatus, pending_status AS pendingStatus, blocked_status AS blockedStatus, keyword, assertions, extract, indirect FROM endpoints WHERE id = ?",
      )
      .get(id) as {
      url: string;
      expectStatus: string;
      pendingStatus: number | null;
      blockedStatus: number | null;
      keyword: string | null;
      assertions: string;
      extract: string;
      indirect: number;
    };

  it("serves every region from the public API host, preferring each region through Fly", () => {
    expect(sql.prepare("SELECT url FROM endpoints WHERE id = '01M4E7G1W82VKFPF5FJ9AVK1D9'").get()).toEqual({
      url: "https://api.terrascale.tech",
    });
    expect(sql.prepare("SELECT ping_url FROM regions WHERE code = 'GRU'").get()).toEqual({
      ping_url: "https://api.terrascale.tech/healthz",
    });
    expect(
      sql
        .prepare(
          "SELECT region_code, headers FROM endpoints WHERE id IN ('01M4E7G1W82VKFPF5FJ9AVK1DB', '01M4E7G1W82VKFPF5FJ9AVK1DC') ORDER BY region_code",
        )
        .all(),
    ).toEqual([
      { region_code: "GRU", headers: '{"fly-prefer-region":"gru"}' },
      { region_code: "SJC", headers: '{"fly-prefer-region":"sjc"}' },
    ]);
  });

  it("checks the actual dashboard and C# auth readiness contracts", () => {
    for (const [id, url, status] of [
      ["01M4E7G1W82VKFPF5FJ9AVK1D8", "https://dash.terrascale.tech/health/ready", "ok"],
      ["01M4E7G1W82VKFPF5FJ9AVK1D6", "https://auth.terrascale.tech/readyz", "ready"],
    ]) {
      const row = endpoint(id!);
      expect(row.url).toBe(url);
      const spec = parseSpec(row);
      expect(
        judge(spec, { status: 200, error: null, body: JSON.stringify({ status, version: "csharp-build" }) }),
      ).toEqual({
        outcome: "ok",
        error: null,
        values: { version: "csharp-build" },
      });
      expect(judge(spec, { status: 200, error: null, body: '{"status":"not_ready"}' }).outcome).toBe("fail");
      expect(judge(spec, { status: 503, error: null }).outcome).toBe("fail");
    }
  });

  it("leaves no retired route active", () => {
    expect(
      sql
        .prepare(
          "SELECT id FROM endpoints WHERE enabled = 1 AND (url LIKE '%/tenants/%' OR url LIKE '%/shards/%' OR url LIKE '%/v1/dashboard%' OR url LIKE '%/v1/readyz%')",
        )
        .all(),
    ).toEqual([]);
  });
});
