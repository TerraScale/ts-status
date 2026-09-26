import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { testD1 } from "../testing/d1";
import { checkCertificates, covers, latest } from "./tls";

describe("certificates", () => {
  it("matches hosts exactly or by a single-label wildcard", () => {
    expect(covers("dash.terrascale.tech", "dash.terrascale.tech")).toBe(true);
    expect(covers("*.terrascale.tech", "dash.terrascale.tech")).toBe(true);
    expect(covers("*.terrascale.tech", "a.b.terrascale.tech")).toBe(false);
    expect(covers("*.terrascale.tech", "terrascale.tech")).toBe(false);
  });

  it("takes the latest expiry of valid certificates covering the host", () => {
    expect(
      latest(
        [
          { dns_names: ["dash.test"], not_after: "2026-10-06T00:00:00Z", issuer: { friendly_name: "A" } },
          { dns_names: ["*.test"], not_after: "2026-12-01T00:00:00Z", issuer: { friendly_name: "B" } },
          { dns_names: ["dash.test"], not_after: "2027-01-01T00:00:00Z", revoked: true },
          { dns_names: ["other.test"], not_after: "2027-02-01T00:00:00Z" },
        ],
        "dash.test",
      ),
    ).toEqual({ notAfter: "2026-12-01T00:00:00Z", issuer: "B" });
  });

  it("looks up each monitored host once a day and keeps the last expiry on failure", async () => {
    const db = testD1();
    const env = { STATUS_DB: db } as unknown as Env;
    const asked: string[] = [];
    let fail = false;
    const fetcher = (async (url: string) => {
      const host = new URL(url).searchParams.get("domain") ?? "";
      asked.push(host);
      if (fail) return new Response("busy", { status: 429 });
      return Response.json([{ dns_names: [host], not_after: "2026-12-01T00:00:00Z", issuer: { friendly_name: "LE" } }]);
    }) as typeof fetch;

    const now = Date.parse("2026-09-26T10:17:00Z");
    expect((await checkCertificates(env, now, fetcher)).sort()).toEqual([
      "atlas.terrascale.tech",
      "dash.terrascale.tech",
      "git.terrascale.tech",
      "terrascale.tech",
    ]);
    expect(await checkCertificates(env, now + 3_600_000, fetcher)).toEqual([]);
    fail = true;
    await checkCertificates(env, now + 2 * 86_400_000, fetcher);
    expect(db.sqlite.prepare("SELECT not_after, error FROM tls_certs WHERE host = 'terrascale.tech'").get()).toEqual({
      not_after: "2026-12-01 00:00:00",
      error: "Cert Spotter HTTP 429",
    });
    expect(asked).toHaveLength(8);
  });
});
