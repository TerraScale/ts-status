import { createTsAuthClient } from "@terrascale/sdk/ts-auth";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTerraBase } from "../testing/terrabase";
import { documentPath } from "./canary";
import { isSdkProbeConfig, probeCollection, probeCredentials, runSdkDocuments, type SdkProbeConfig } from "./sdk";

let api: Awaited<ReturnType<typeof startTerraBase>>;
beforeAll(async () => {
  api = await startTerraBase();
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

const key = `tsk_${"a".repeat(20)}_${"b".repeat(52)}`;
const config = (): SdkProbeConfig => ({
  ...api.canary,
  issuer: "https://gru.auth.terrascale.tech/terrascale",
  key,
});

// The retained release still requires a TerraBase key. This adapter verifies
// the real SDK's document operations, not the pending JWT interoperability.
const fetchLocal = (async (input, init) => {
  const request = new Request(input, init);
  return api.fetcher(request.url, {
    method: request.method,
    headers: request.headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
    signal: request.signal,
  });
}) as typeof fetch;

describe("TS-603 SDK draft", () => {
  it("accepts platform credentials and rejects legacy identity and unsafe targets", () => {
    expect(isSdkProbeConfig("documents", config())).toBe(true);
    expect(
      isSdkProbeConfig("management", { origin: api.origin, issuer: config().issuer, project: api.canary.project, key }),
    ).toBe(true);
    for (const patch of [
      { key: api.canary.key },
      { key: "tsk_invalid" },
      { key: key.replace("a", "i") },
      { issuer: "http://auth.example/terrascale" },
      { issuer: `${config().issuer}/` },
      { issuer: `${config().issuer}?token=secret` },
      { issuer: "https://user:secret@auth.example/terrascale" },
      { issuer: "https://auth.example/customer" },
      { origin: `${api.origin}/` },
      { project: "not-a-project" },
      { database: "Customer Data" },
      { collection: "../customer" },
      { document: "not-an-id" },
      { userId: "acting-user" },
      { organization: "old-org" },
    ])
      expect(isSdkProbeConfig("documents", { ...config(), ...patch })).toBe(false);
  });

  it("prepares the published API-key grant and least scopes without impersonation", () => {
    expect(probeCredentials("documents", config())).toEqual({
      issuer: config().issuer,
      clientId: key.slice(0, 24),
      clientSecret: key,
      request: {
        grant_type: "client_credentials",
        project: api.canary.project,
        scope: "documents:read documents:write",
      },
    });
    expect(probeCredentials("management", config()).request.scope).toBe("databases:read");
    expect(() => probeCredentials("documents", { ...config(), key: api.canary.key })).toThrow("Invalid probe config");
  });

  it("records the JWT SDK blocker without dispatching or substituting a data key", () => {
    const fetcher = vi.fn();
    expect(() => probeCollection(config(), "header.payload.signature", fetcher)).toThrow("token must be a tb_ API key");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("records the platform-grant SDK blocker without using raw HTTP", () => {
    const fetcher = vi.fn();
    const client = createTsAuthClient({
      apiBaseUrl: "https://gru.auth.terrascale.tech",
      instanceSlug: "terrascale",
      fetch: fetcher,
    });
    const credentials = probeCredentials("documents", config());
    // Deliberate compile-time check: upgrade this gate when TS-592 admits
    // the published platform request (project, rather than OAuth resource).
    // @ts-expect-error SDK 0.0.2 does not implement the TS-598 platform grant.
    expect(() => client.oidc.token(credentials.clientId, credentials.clientSecret, credentials.request)).toThrow(
      TypeError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("writes and reads the retained marker through the real SDK and release", async () => {
    const collection = probeCollection(config(), api.canary.key, fetchLocal);
    for (const marker of ["sdk round one", "sdk round two"]) {
      expect(await runSdkDocuments(collection, api.canary.document, marker, false)).toMatchObject({
        ok: true,
        error: null,
      });
      expect((await collection.get(api.canary.document)).document?.canary).toBe(marker);
    }
  });

  it("queries by identity and deletes through the SDK without forwarding the ts-auth secret", async () => {
    const methods: string[] = [];
    const fetcher = (async (input, init) => {
      const request = new Request(input, init);
      methods.push(request.method);
      expect(request.headers.get("authorization")).toBe(`Bearer ${api.canary.key}`);
      expect(request.headers.get("authorization")).not.toContain(key);
      expect(request.headers.has("X-TerraBase-User-Id")).toBe(false);
      expect(request.headers.has("X-TerraBase-Organization-Id")).toBe(false);
      expect(request.redirect).toBe("manual");
      expect(request.cache).toBe("no-store");
      if (request.method === "POST")
        expect(await request.clone().json()).toEqual({ filter: { eq: ["$id", api.canary.document] }, limit: 1 });
      return fetchLocal(request);
    }) as typeof fetch;
    expect(
      await runSdkDocuments(probeCollection(config(), api.canary.key, fetcher), api.canary.document, "cleanup", true),
    ).toMatchObject({ ok: true, error: null });
    expect(methods).toEqual(["PUT", "GET", "POST", "DELETE"]);
    expect(
      (
        await api.fetcher(api.origin + documentPath(api.canary), {
          headers: { authorization: `Bearer ${api.canary.key}` },
        })
      ).status,
    ).toBe(404);
  });

  it("deletes a committed write after losing its response and keeps the first failure", async () => {
    const methods: string[] = [];
    const fetcher = (async (input, init) => {
      const request = new Request(input, init);
      methods.push(request.method);
      const response = await fetchLocal(request);
      if (request.method === "PUT") throw new TypeError(`Connection lost ${key}`);
      return response;
    }) as typeof fetch;
    const result = await runSdkDocuments(
      probeCollection(config(), api.canary.key, fetcher),
      api.canary.document,
      "lost",
      true,
    );
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(key);
    expect(methods).toEqual(["PUT", "DELETE"]);
    expect(
      (
        await api.fetcher(api.origin + documentPath(api.canary), {
          headers: { authorization: `Bearer ${api.canary.key}` },
        })
      ).status,
    ).toBe(404);
  });

  it("reports scoped rejection without echoing SDK error messages", async () => {
    const readOnly = await api.issueKey(["documents:read"]);
    expect(
      await runSdkDocuments(probeCollection(config(), readOnly, fetchLocal), api.canary.document, "denied", false),
    ).toEqual({ ok: false, latencyMs: null, error: "HTTP 403" });
  });
});
