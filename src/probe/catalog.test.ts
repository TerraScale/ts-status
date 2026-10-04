import { describe, expect, it } from "vitest";
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

  it("probes only the endpoints that answer today", () => {
    expect(sql.prepare("SELECT id FROM endpoints WHERE enabled = 1 ORDER BY id").all()).toEqual([
      { id: "api-workers" },
      { id: "atlas-workers" },
      { id: "dashboard-fly-gru" },
      { id: "data-api-oci-gru" },
      { id: "document-api-gru" },
      { id: "git-forgejo" },
      { id: "management-api-gru" },
      { id: "terrabase-health-gru" },
      { id: "website-pages" },
    ]);
    expect(sql.prepare("SELECT id FROM endpoints WHERE enabled = 0 ORDER BY id").all()).toEqual([
      { id: "auth-edge" },
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
        url: "/v1/databases/{database}/collections/{collection}",
      },
      { component_id: "management-api", region_code: "GRU", kind: "canary", probe: "management", url: "/v1/dashboard" },
      { component_id: "terrabase-health", region_code: "GRU", kind: "canary", probe: "health", url: "/v1/readyz" },
    ]);
    expect(sql.prepare("SELECT count(*) AS n FROM endpoints WHERE probe IS NOT NULL").get()).toEqual({ n: 9 });
  });

  it("lists planned components without measuring them", () => {
    expect(sql.prepare("SELECT id FROM components WHERE lifecycle = 'planned' ORDER BY id").all()).toEqual([
      { id: "auth" },
      { id: "docs" },
      { id: "sync" },
    ]);
    expect(sql.prepare("SELECT kind FROM endpoints WHERE id = 'data-api-canary-gru'").get()).toEqual({
      kind: "canary",
    });
  });
});
