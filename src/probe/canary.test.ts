import { describe, expect, it, vi } from "vitest";
import { holdsDocument, isCanaryConfig, parseCanaries, runCanary } from "./canary";

const canary = {
  origin: "https://api.example.test",
  issuer: "https://auth.example.test/terrascale",
  region: "gru",
  project: "01M4E7G1W82VKFPF5FJ9AVK1DT",
  database: "status_canary",
  collection: "canary",
  document: "01M4E7G1W82VKFPF5FJ9AVK1DV",
  key: `01M4E7G1W82VKFPF5FJ9AVK1CQ_${"a".repeat(52)}`,
};
const token = "header.payload.signature";
const document = { id: canary.document, version: `tbv1-${"a".repeat(32)}`, state: "value", document: { canary: true } };
const grant = { access_token: token, token_type: "Bearer", expires_in: 900 };
const fake = (body: unknown, status = 200) =>
  vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(grant))
    .mockResolvedValueOnce(Response.json(body, { status }));

describe("read-only Data API probe", () => {
  it("requires current ts-auth credentials and canonical resource identities", () => {
    expect(isCanaryConfig(canary)).toBe(true);
    for (const patch of [
      { origin: canary.origin + "/" },
      { origin: "https://user:password@api.example.test" },
      { issuer: "http://auth.example.test/terrascale" },
      { issuer: `${canary.issuer}/` },
      { issuer: "https://user:password@auth.example.test/terrascale" },
      { issuer: undefined },
      { project: "project" },
      { database: "Canary" },
      { collection: "1canary" },
      { document: "document" },
      { key: "tb_fake_key" },
      { key: canary.key + "\n" },
      { key: `tsk_${"a".repeat(20)}_${"b".repeat(52)}` },
    ])
      expect(isCanaryConfig({ ...canary, ...patch })).toBe(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseCanaries(undefined)).toEqual({});
      expect(parseCanaries("not json")).toEqual({});
      expect(parseCanaries(JSON.stringify({ [canary.document]: canary, invalid: canary }))).toEqual({
        [canary.document]: canary,
      });
    } finally {
      error.mockRestore();
    }
  });

  it("exchanges the key only at ts-auth and only GETs the fixture with its token", async () => {
    const fetcher = fake(document);
    expect(await runCanary(canary, "round", fetcher)).toMatchObject({ ok: true, error: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${canary.issuer}/oauth/token`);
    expect(init).toMatchObject({ method: "POST", redirect: "manual", cache: "no-store" });
    expect(Object.fromEntries(new URLSearchParams(init?.body as string))).toEqual({
      grant_type: "client_credentials",
      client_id: canary.key.slice(0, 26),
      client_secret: canary.key,
      project: canary.project,
      scope: "documents:read",
    });
    const [readUrl, readInit] = fetcher.mock.calls[1]!;
    expect(readUrl).toBe(
      `${canary.origin}/v1/projects/${canary.project}/databases/status_canary/collections/canary/documents/by-key?id=${canary.document}`,
    );
    expect(readInit).toMatchObject({ method: "GET", cache: "no-store", redirect: "manual" });
    expect(new Headers(readInit?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect([...new Headers(readInit?.headers).keys()].sort()).toEqual(["authorization", "user-agent"]);
    expect(JSON.stringify(fetcher.mock.calls[1])).not.toContain(canary.key);
  });

  it("fails closed on invalid documents, JSON, auth failures and redirects without leaking responses", async () => {
    for (const patch of [
      { id: "bad" },
      { id: canary.project },
      { version: "bad" },
      { state: "deleted" },
      { document: null },
      { document: [] },
    ]) {
      const result = await runCanary(canary, "round", fake({ ...document, ...patch }));
      expect(result).toMatchObject({ ok: false, error: "Invalid response" });
    }
    for (const status of [401, 403, 404, 302]) {
      const fetcher = fake({ error: { code: canary.key, message: token } }, status);
      expect(await runCanary(canary, "round", fetcher)).toMatchObject({ ok: false, error: `HTTP ${status}` });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(grant))
      .mockResolvedValueOnce(new Response("bad json"));
    expect(await runCanary(canary, "round", fetcher)).toMatchObject({ ok: false, error: "Invalid JSON" });
    expect(holdsDocument(null, canary.document)).toBe(false);
  });

  it("does not contact TerraBase when config or token exchange fails", async () => {
    const invalid = vi.fn<typeof fetch>();
    expect(await runCanary({ ...canary, key: "tb_fake" }, "round", invalid)).toMatchObject({
      ok: false,
      error: "Invalid probe config",
    });
    expect(invalid).not.toHaveBeenCalled();
    for (const response of [
      Response.json({ error: "invalid_client", error_description: canary.key }, { status: 401 }),
      ...[{ access_token: canary.key }, { token_type: "Basic" }, { expires_in: 0 }, { expires_in: 1.5 }].map((patch) =>
        Response.json({ ...grant, ...patch }),
      ),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
      expect(await runCanary(canary, "round", fetcher)).toMatchObject({ ok: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(canary.key));
    expect(await runCanary(canary, "round", fetcher)).toEqual({ ok: false, latencyMs: null, error: "Unreachable" });
  });
});
