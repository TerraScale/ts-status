import { describe, expect, it } from "vitest";
import { check } from "./check";

const target = { key: "dash", url: "https://dash.test/health/ready", headers: '{"fly-prefer-region":"gru"}' };

describe("check", () => {
  it("passes on a 2xx response and forwards the target headers", async () => {
    let sent: Headers | undefined;
    const result = await check(target, async (_url, init) => {
      sent = new Headers(init?.headers);
      return new Response("ok");
    });
    expect(result).toMatchObject({ key: "dash", ok: true, error: null });
    expect(sent?.get("fly-prefer-region")).toBe("gru");
    expect(sent?.get("user-agent")).toMatch(/^TerraScale-Status/);
  });

  it("fails on an error status or a network error", async () => {
    expect(await check(target, async () => new Response("down", { status: 503 }))).toMatchObject({
      ok: false,
      error: "HTTP 503",
    });
    expect(await check(target, async () => Promise.reject(new TypeError("fetch failed")))).toMatchObject({
      ok: false,
      error: "Unreachable",
    });
  });
});
