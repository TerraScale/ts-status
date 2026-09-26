import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProbeResponse } from "../probe/protocol";
import worker from "./worker";

const env = { VANTAGE: "GRU" };
const target = { key: "dash", url: "https://dash.test/health/ready", headers: "{}" };

function probe(init: RequestInit & { cf?: { colo: string } } = {}): Promise<Response> {
  const request = new Request("https://vantage.test/", { method: "POST", ...init });
  if (init.cf) Object.defineProperty(request, "cf", { value: init.cf });
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], env);
}

describe("vantage worker", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("only accepts POST", async () => {
    expect((await probe({ method: "GET" })).status).toBe(405);
  });

  it("rejects a missing or malformed target list", async () => {
    expect((await probe({ body: "not json" })).status).toBe(400);
    expect((await probe({ body: JSON.stringify({}) })).status).toBe(400);
    expect((await probe({ body: JSON.stringify({ targets: [{ key: "dash" }] }) })).status).toBe(400);
  });

  it("probes every target and reports its vantage and placement", async () => {
    vi.stubGlobal("fetch", async () => new Response("ok"));
    const response = await probe({
      body: JSON.stringify({ targets: [target] }),
      headers: { "cf-placement": "remote-GRU" },
      cf: { colo: "EWR" },
    });
    const body = (await response.json()) as ProbeResponse;
    expect(body).toMatchObject({ vantage: "GRU", colo: "GRU", results: [{ key: "dash", ok: true, error: null }] });
  });

  it("falls back to the data center that served the request", async () => {
    vi.stubGlobal("fetch", async () => new Response("ok"));
    const response = await probe({ body: JSON.stringify({ targets: [target] }), cf: { colo: "GRU" } });
    expect(((await response.json()) as ProbeResponse).colo).toBe("GRU");
  });
});
