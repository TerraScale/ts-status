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
      components: ["dashboard"],
    });
    expect(created.status).toBe(201);
    expect(created.response.headers.get("cache-control")).toBe("no-store");
    const id = String(created.data?.id);

    expect((await call("POST", `/incidents/${id}/updates`, { status: "resolved", message: "Fixed." })).status).toBe(
      201,
    );
    const row = sql.prepare("SELECT status, impact, operator_touched, resolved_at FROM incidents WHERE id = ?").get(id);
    expect(row).toMatchObject({ status: "resolved", impact: "major", operator_touched: 1 });
    expect(row?.resolved_at).not.toBeNull();

    const read = await call("GET", `/incidents/${id}`);
    expect(read.data?.components).toEqual(["dashboard"]);
    expect((read.data?.updates as unknown[]).length).toBe(2);
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
      components: ["git"],
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
      `INSERT INTO incidents (id, kind, title, status, impact, source, auto_key) VALUES ('a1', 'incident', 'Git is down', 'investigating', 'critical', 'auto', 'git')`,
    );
    expect((await call("PATCH", "/incidents/a1", { title: "Forgejo is down", components: ["git"] })).status).toBe(200);
    expect(sql.prepare("SELECT title, operator_touched FROM incidents WHERE id = 'a1'").get()).toEqual({
      title: "Forgejo is down",
      operator_touched: 1,
    });
    expect((await call("PATCH", "/incidents/a1", { components: ["nope"] })).status).toBe(400);
    expect((await call("DELETE", "/incidents/a1")).status).toBe(204);
    expect((await call("DELETE", "/incidents/a1")).status).toBe(404);
  });

  it("launches components, pauses endpoints and records deploys", async () => {
    const { call, sql } = setup();
    expect((await call("PATCH", "/components/auth", { lifecycle: "active" })).status).toBe(200);
    expect(sql.prepare("SELECT lifecycle FROM components WHERE id = 'auth'").get()).toEqual({ lifecycle: "active" });
    expect(sql.prepare("SELECT enabled FROM endpoints WHERE id = 'auth-edge'").get()).toEqual({ enabled: 1 });
    expect((await call("PATCH", "/endpoints/git-forgejo", { enabled: false })).status).toBe(200);
    expect((await call("PATCH", "/endpoints/missing", { enabled: false })).status).toBe(404);
    expect((await call("POST", "/deploys", { endpointId: "dashboard-fly-gru", version: "1.2.3" })).status).toBe(201);
    expect(sql.prepare("SELECT version FROM deploys").all()).toEqual([{ version: "1.2.3" }]);
    expect((await call("POST", "/deploys", { endpointId: "dashboard-fly-gru", version: "1.2.4" })).status).toBe(409);
  });

  it("refuses to pause what an open automatic incident still needs measured", async () => {
    const { call, sql } = setup();
    sql.exec(
      `INSERT INTO incidents (id, kind, title, status, impact, source, auto_key) VALUES ('a1', 'incident', 'Git is down', 'investigating', 'critical', 'auto', 'git')`,
    );
    expect((await call("PATCH", "/endpoints/git-forgejo", { enabled: false })).status).toBe(409);
    expect((await call("PATCH", "/components/git", { lifecycle: "planned" })).status).toBe(409);
    expect((await call("POST", "/incidents/a1/updates", { status: "resolved", message: "Fixed." })).status).toBe(201);
    expect((await call("PATCH", "/components/git", { lifecycle: "planned" })).status).toBe(200);
  });

  it("answers unknown routes and bad bodies clearly", async () => {
    const { call } = setup();
    expect((await call("PUT", "/incidents")).status).toBe(404);
    expect((await call("POST", "/incidents", { kind: "nope" })).data).toEqual({
      error: { code: "invalid", message: "kind: must be one of incident, warning, maintenance" },
    });
  });
});
