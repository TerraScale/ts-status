import { isId } from "../ids";
import { describe, expect, it } from "vitest";
import app from "../app";
import type { Env } from "../env";
import { testD1, type TestD1 } from "../testing/d1";

const TOKEN = "s3cret-operator-token";
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function setup() {
  const env = { STATUS_DB: testD1(), OPERATOR_TOKEN: TOKEN } as unknown as Env & { STATUS_DB: TestD1 };
  const call = async (method: string, path: string, body?: unknown, token = TOKEN) => {
    const response = await app.fetch(
      new Request(`https://status.test/api/operator${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx,
    );
    const text = await response.text();
    return { status: response.status, data: text ? (JSON.parse(text) as Record<string, unknown>) : null, response };
  };
  return { env, call, sql: env.STATUS_DB.sqlite };
}

describe("operator API", () => {
  it("rejects malformed IDs before reading or writing entities", async () => {
    const { call, sql } = setup();
    const body = { kind: "incident", title: "Outage", message: "Investigating." };
    for (const id of [
      "dashboard",
      "acct_01M4E7G1W82VKFPF5FJ9AVK1CV",
      "01m4e7g1w82vkfpf5fj9avk1cv",
      "8ZZZZZZZZZZZZZZZZZZZZZZZZZ",
      "b450c3c0-4427-41e4-b620-0ba7d93dfdb8",
    ]) {
      expect((await call("GET", `/incidents/${id}`)).status).toBe(400);
      expect((await call("POST", "/incidents", { ...body, components: [id] })).status).toBe(400);
      expect((await call("POST", "/deploys", { endpointId: id, version: "1" })).status).toBe(400);
    }
    expect((await call("GET", "/incidents/000000000000000000000000ZZ")).status).toBe(404);
    expect(sql.prepare("SELECT count(*) AS n FROM incidents").get()?.n).toBe(0);
  });

  it("rejects requests without the token", async () => {
    const { call } = setup();
    expect((await call("POST", "/incidents", {}, "wrong")).status).toBe(401);
    expect((await call("POST", "/incidents", {}, "")).status).toBe(401);
    const bare = setup();
    delete (bare.env as { OPERATOR_TOKEN?: string }).OPERATOR_TOKEN;
    expect((await bare.call("GET", "/incidents/x")).status).toBe(401);
  });

  it("publishes an incident with its components and first update, then resolves it", async () => {
    const { call, sql } = setup();
    const created = await call("POST", "/incidents", {
      kind: "incident",
      title: "Dashboard sign-in errors",
      message: "Some sign-ins fail.",
      impact: "major",
      components: ["01M4E7G1W82VKFPF5FJ9AVK1CV"],
    });
    expect(created.status).toBe(201);
    expect(created.response.headers.get("cache-control")).toBe("no-store");
    const id = String(created.data?.id);
    expect(isId(id)).toBe(true);
    expect(
      sql
        .prepare("SELECT id FROM incident_updates")
        .all()
        .every((row) => isId(row.id)),
    ).toBe(true);

    expect((await call("POST", `/incidents/${id}/updates`, { status: "resolved", message: "Fixed." })).status).toBe(
      201,
    );
    const row = sql.prepare("SELECT status, impact, operator_touched, resolved_at FROM incidents WHERE id = ?").get(id);
    expect(row).toMatchObject({ status: "resolved", impact: "major", operator_touched: 1 });
    expect(row?.resolved_at).not.toBeNull();

    const read = await call("GET", `/incidents/${id}`);
    expect(read.data?.components).toEqual(["01M4E7G1W82VKFPF5FJ9AVK1CV"]);
    expect(read.data?.updates).toHaveLength(2);
  });

  it("schedules maintenance and validates its window", async () => {
    const { call, sql } = setup();
    const bad = await call("POST", "/incidents", {
      kind: "maintenance",
      title: "Upgrade",
      message: "Planned.",
      scheduledStart: "2026-10-01T03:00:00Z",
      scheduledEnd: "2026-10-01T02:00:00Z",
    });
    expect(bad).toMatchObject({ status: 400, data: { error: { code: "invalid" } } });
    const good = await call("POST", "/incidents", {
      kind: "maintenance",
      title: "Upgrade",
      message: "Planned.",
      components: ["01M4E7G1W82VKFPF5FJ9AVK1CZ"],
      scheduledStart: "2026-10-01T02:00:00Z",
      scheduledEnd: "2026-10-01T03:00:00Z",
    });
    expect(good.status).toBe(201);
    const id = String(good.data?.id);
    expect((await call("PATCH", `/incidents/${id}`, { scheduledEnd: "2026-10-01T05:00:00Z" })).status).toBe(200);
    expect(sql.prepare("SELECT scheduled_start, scheduled_end FROM incidents WHERE id = ?").get(id)).toEqual({
      scheduled_start: "2026-10-01 02:00:00",
      scheduled_end: "2026-10-01 05:00:00",
    });
    expect((await call("PATCH", `/incidents/${id}`, { scheduledEnd: "2026-10-01T01:00:00Z" })).status).toBe(400);
    expect((await call("PATCH", `/incidents/${id}`, { scheduledStart: "1" })).status).toBe(400);
    const incident = await call("POST", "/incidents", {
      kind: "incident",
      title: "Errors",
      message: "Some fail.",
      scheduledStart: "2026-10-01T02:00:00Z",
    });
    expect(incident.status).toBe(400);
    expect(
      (await call("POST", `/incidents/${String(good.data?.id)}/updates`, { status: "resolved", message: "x" })).status,
    ).toBe(400);
  });

  it("takes over automatic incidents, edits and deletes", async () => {
    const { call, sql } = setup();
    sql.exec(
      `INSERT INTO incidents (id, kind, title, status, impact, source, auto_key) VALUES ('00000000000000000000000011', 'incident', 'Git is down', 'investigating', 'critical', 'auto', '01M4E7G1W82VKFPF5FJ9AVK1CZ')`,
    );
    expect(
      (
        await call("PATCH", "/incidents/00000000000000000000000011", {
          title: "Forgejo is down",
          components: ["01M4E7G1W82VKFPF5FJ9AVK1CZ"],
        })
      ).status,
    ).toBe(200);
    expect(
      sql.prepare("SELECT title, operator_touched FROM incidents WHERE id = '00000000000000000000000011'").get(),
    ).toEqual({
      title: "Forgejo is down",
      operator_touched: 1,
    });
    expect((await call("PATCH", "/incidents/00000000000000000000000011", { components: ["nope"] })).status).toBe(400);
    expect((await call("DELETE", "/incidents/00000000000000000000000011")).status).toBe(204);
    expect((await call("DELETE", "/incidents/00000000000000000000000011")).status).toBe(404);
  });

  it("launches components, pauses endpoints and records deploys", async () => {
    const { call, sql } = setup();
    expect((await call("PATCH", "/components/01M4E7G1W82VKFPF5FJ9AVK1CT", { lifecycle: "active" })).status).toBe(200);
    expect(sql.prepare("SELECT lifecycle FROM components WHERE id = '01M4E7G1W82VKFPF5FJ9AVK1CT'").get()).toEqual({
      lifecycle: "active",
    });
    expect(sql.prepare("SELECT enabled FROM endpoints WHERE id = '01M4E7G1W82VKFPF5FJ9AVK1D6'").get()).toEqual({
      enabled: 1,
    });
    expect((await call("PATCH", "/endpoints/01M4E7G1W82VKFPF5FJ9AVK1DH", { enabled: false })).status).toBe(200);
    expect((await call("PATCH", "/endpoints/000000000000000000000000ZZ", { enabled: false })).status).toBe(404);
    expect(
      (await call("POST", "/deploys", { endpointId: "01M4E7G1W82VKFPF5FJ9AVK1D8", version: "1.2.3" })).status,
    ).toBe(201);
    expect(sql.prepare("SELECT version FROM deploys").all()).toEqual([{ version: "1.2.3" }]);
    expect(
      (await call("POST", "/deploys", { endpointId: "01M4E7G1W82VKFPF5FJ9AVK1D8", version: "1.2.4" })).status,
    ).toBe(409);
  });

  it("refuses to pause what an open automatic incident still needs measured", async () => {
    const { call, sql } = setup();
    sql.exec(
      `INSERT INTO incidents (id, kind, title, status, impact, source, auto_key) VALUES ('00000000000000000000000011', 'incident', 'Git is down', 'investigating', 'critical', 'auto', '01M4E7G1W82VKFPF5FJ9AVK1CZ')`,
    );
    expect((await call("PATCH", "/endpoints/01M4E7G1W82VKFPF5FJ9AVK1DH", { enabled: false })).status).toBe(409);
    expect((await call("PATCH", "/components/01M4E7G1W82VKFPF5FJ9AVK1CZ", { lifecycle: "planned" })).status).toBe(409);
    expect(
      (await call("POST", "/incidents/00000000000000000000000011/updates", { status: "resolved", message: "Fixed." }))
        .status,
    ).toBe(201);
    expect((await call("PATCH", "/components/01M4E7G1W82VKFPF5FJ9AVK1CZ", { lifecycle: "planned" })).status).toBe(200);
  });

  it("answers unknown routes and bad bodies clearly", async () => {
    const { call } = setup();
    expect((await call("PUT", "/incidents")).status).toBe(404);
    expect((await call("POST", "/incidents", { kind: "nope" })).data).toEqual({
      error: { code: "invalid", message: "kind: must be one of incident, warning, maintenance" },
    });
  });
});
