import { describe, expect, it } from "vitest";
import { judge, parseSpec } from "../domain/assertions";
import { testD1 } from "../testing/d1";

/* The migrated probe catalog: what is probed today, and what waits for launch. */
describe("probe catalog", () => {
  const sql = testD1().sqlite;

  it("names the regions", () => {
    expect(sql.prepare("SELECT code, name FROM regions ORDER BY position").all()).toEqual([
      { code: "SFO", name: "San Jose" },
      { code: "GRU", name: "São Paulo" },
      { code: "FRA", name: "Frankfurt" },
    ]);
  });

  it("enables launched checks and observes pending OIDC discovery", () => {
    expect(sql.prepare("SELECT id FROM endpoints WHERE enabled = 1 ORDER BY id").all()).toEqual([
      { id: "api-workers" },
      { id: "atlas-workers" },
      { id: "auth-edge" },
      { id: "auth-oidc-edge" },
      { id: "dashboard-fly-gru" },
      { id: "data-api-oci-gru" },
      { id: "document-api-gru" },
      { id: "git-forgejo" },
      { id: "management-api-gru" },
      { id: "terrabase-health-gru" },
      { id: "website-pages" },
    ]);
    expect(sql.prepare("SELECT id FROM endpoints WHERE enabled = 0 ORDER BY id").all()).toEqual([
      { id: "data-api-canary-gru" },
      { id: "data-api-oci-fra" },
      { id: "data-api-oci-sfo" },
      { id: "docs-pages" },
      { id: "document-api-fra" },
      { id: "document-api-sfo" },
      { id: "management-api-fra" },
      { id: "management-api-sfo" },
      { id: "sync-edge" },
      { id: "terrabase-health-fra" },
      { id: "terrabase-health-sfo" },
    ]);
  });

  it("checks the API router and every regional data API for invalid_key on an unauthenticated read", () => {
    const rows = sql
      .prepare(
        `SELECT id, url, expect_status, assertions FROM endpoints
          WHERE id IN ('api-workers', 'data-api-oci-sfo', 'data-api-oci-gru', 'data-api-oci-fra') ORDER BY id`,
      )
      .all();
    expect(rows.map((row) => [row.id, new URL(String(row.url)).host])).toEqual([
      ["api-workers", "api.terrascale.tech"],
      ["data-api-oci-fra", "fra.api.terrascale.tech"],
      ["data-api-oci-gru", "gru.api.terrascale.tech"],
      ["data-api-oci-sfo", "sfo.api.terrascale.tech"],
    ]);
    for (const row of rows) {
      expect(new URL(String(row.url)).pathname).toBe(
        "/v1/projects/018f0000-0000-7000-8000-000000000001/databases/status_canary/collections/canary/documents/018f0000-0000-7000-8000-000000000004",
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
        component_id: "document-api",
        region_code: "GRU",
        kind: "canary",
        probe: "documents",
        url: "/v1/projects/{project}/databases/{database}/collections/{collection}",
      },
      {
        component_id: "management-api",
        region_code: "GRU",
        kind: "canary",
        probe: "management",
        url: "/v1/management/organizations/{organization}/projects",
      },
      { component_id: "terrabase-health", region_code: "GRU", kind: "canary", probe: "health", url: "/readyz" },
    ]);
    expect(sql.prepare("SELECT count(*) AS n FROM endpoints WHERE probe IS NOT NULL").get()).toEqual({ n: 9 });
  });

  it("labels OIDC pending while keeping its non-404 failures in active authentication", () => {
    expect(sql.prepare("SELECT id FROM components WHERE lifecycle = 'planned' ORDER BY id").all()).toEqual([
      { id: "docs" },
      { id: "sync" },
    ]);
    expect(sql.prepare("SELECT kind FROM endpoints WHERE id = 'data-api-canary-gru'").get()).toEqual({
      kind: "canary",
    });
    expect(sql.prepare("SELECT lifecycle FROM components WHERE id = 'auth'").get()).toEqual({ lifecycle: "active" });
    expect(sql.prepare("SELECT description FROM components WHERE id = 'auth'").get()).toEqual({
      description: "Sign-in, accounts and API keys; OIDC discovery pending (404)",
    });
    expect(sql.prepare("SELECT component_id FROM endpoints WHERE id = 'auth-oidc-edge'").get()).toEqual({
      component_id: "auth",
    });
    const oidc = endpoint("auth-oidc-edge");
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
      { id: "dashboard-fly-gru", blocked_status: 403 },
      { id: "git-forgejo", blocked_status: 403 },
    ]);
    expect(judge(parseSpec(endpoint("git-forgejo")), { status: 403, error: null })).toEqual({
      outcome: "unknown",
      error: "Probe blocked (HTTP 403)",
      values: {},
    });
    expect(judge(parseSpec(endpoint("git-forgejo")), { status: 503, error: null }).outcome).toBe("fail");
    expect(judge(parseSpec(endpoint("auth-edge")), { status: 403, error: null }).outcome).toBe("fail");
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

  it("requires Atlas to resolve the admitted gru-1 region and report it healthy", () => {
    const atlas = endpoint("atlas-workers");
    expect(atlas.url).toBe("https://atlas.terrascale.tech/api/v1/regions");
    const check = (available: boolean, host: string | null, code = "GRU-1") =>
      judge(parseSpec(atlas), {
        status: 200,
        error: null,
        body: JSON.stringify({ regions: [{ code, available }], hosts: { [code]: host } }),
      }).outcome;
    expect(check(true, "gru.api.terrascale.tech")).toBe("ok");
    expect(check(false, "gru.api.terrascale.tech")).toBe("fail");
    expect(check(true, null)).toBe("fail");
    expect(check(true, "gru.api.terrascale.tech", "GRU")).toBe("fail");
  });

  it("keeps the production GRU hostname for the canary and browser ping", () => {
    expect(sql.prepare("SELECT url FROM endpoints WHERE id = 'data-api-canary-gru'").get()).toEqual({
      url: "https://gru.api.terrascale.tech",
    });
    expect(sql.prepare("SELECT ping_url FROM regions WHERE code = 'GRU'").get()).toEqual({
      ping_url: "https://gru.api.terrascale.tech/healthz",
    });
  });

  it("checks the actual dashboard and C# auth readiness contracts", () => {
    for (const [id, url, status] of [
      ["dashboard-fly-gru", "https://dash.terrascale.tech/health/ready", "ok"],
      ["auth-edge", "https://auth.terrascale.tech/readyz", "ready"],
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
