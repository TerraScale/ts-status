/* The operator API: authenticated JSON endpoints under /api/operator for
   publishing and updating incidents, warnings and maintenance, recording
   deploys, and launching or pausing parts of the catalog. Every request
   needs the OPERATOR_TOKEN bearer token. Editing an automatic incident
   marks it operator-touched, so the probe coordinator leaves it alone. */

import { sqlTime } from "../db/reads";
import type { IncidentImpact, IncidentKind, IncidentStatus } from "../domain/status";
import type { Env } from "../env";
import { isOperator } from "../http/operator-auth";
import { createRouter } from "../router";
import { choice, ids, instant, Invalid, optionalChoice, optionalString, readBody, string, type Body } from "./validate";

const KINDS: readonly IncidentKind[] = ["incident", "warning", "maintenance"];
const IMPACTS: readonly IncidentImpact[] = ["none", "minor", "major", "critical"];
const INCIDENT_STATUSES: readonly IncidentStatus[] = ["investigating", "identified", "monitoring", "resolved"];
const MAINTENANCE_STATUSES: readonly IncidentStatus[] = ["scheduled", "in_progress", "completed"];
const FINAL: readonly IncidentStatus[] = ["resolved", "completed"];

const statusesOf = (kind: IncidentKind) => (kind === "maintenance" ? MAINTENANCE_STATUSES : INCIDENT_STATUSES);

class NotFound extends Error {}

interface Context {
  env: Env;
  params: Record<string, string>;
  body: Body;
  now: number;
}

type Handler = (context: Context) => Promise<Response>;

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function incidentKind(env: Env, id: string): Promise<IncidentKind> {
  const row = await env.STATUS_DB.prepare("SELECT kind FROM incidents WHERE id = ?1")
    .bind(id)
    .first<{ kind: IncidentKind }>();
  if (!row) throw new NotFound();
  return row.kind;
}

const componentStatements = (env: Env, id: string, components: readonly string[]) => [
  env.STATUS_DB.prepare("DELETE FROM incident_components WHERE incident_id = ?1").bind(id),
  ...components.map((component) =>
    env.STATUS_DB.prepare("INSERT INTO incident_components (incident_id, component_id) VALUES (?1, ?2)").bind(
      id,
      component,
    ),
  ),
];

const postUpdate = (env: Env, id: string, status: IncidentStatus, body: string, time: string) =>
  env.STATUS_DB.prepare(
    "INSERT INTO incident_updates (id, incident_id, status, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).bind(crypto.randomUUID(), id, status, body, time);

/** The scheduled window of maintenance, checked for order. */
function schedule(body: Body): { start: string; end: string } {
  const start = instant(body, "scheduledStart");
  const end = instant(body, "scheduledEnd");
  if (end <= start) throw new Invalid("scheduledEnd", "must be after scheduledStart");
  return { start: sqlTime(start), end: sqlTime(end) };
}

const routes: Record<string, Handler> = {
  "GET /api/operator/incidents/:id": async ({ env, params }) => {
    const [incident, updates, components] = await env.STATUS_DB.batch([
      env.STATUS_DB.prepare("SELECT * FROM incidents WHERE id = ?1").bind(params.id),
      env.STATUS_DB.prepare("SELECT * FROM incident_updates WHERE incident_id = ?1 ORDER BY created_at").bind(
        params.id,
      ),
      env.STATUS_DB.prepare("SELECT component_id FROM incident_components WHERE incident_id = ?1").bind(params.id),
    ]);
    const row = incident?.results?.[0];
    if (!row) throw new NotFound();
    return json({
      incident: row,
      updates: updates?.results ?? [],
      components: (components?.results ?? []).map((entry) => (entry as { component_id: string }).component_id),
    });
  },

  "POST /api/operator/incidents": async ({ env, body, now }) => {
    const kind = choice(body, "kind", KINDS);
    const title = string(body, "title", 200);
    const message = string(body, "message", 4_000);
    const impact = optionalChoice(body, "impact", IMPACTS) ?? (kind === "maintenance" ? "none" : "minor");
    const status =
      optionalChoice(body, "status", statusesOf(kind)) ??
      (kind === "maintenance" ? "scheduled" : kind === "warning" ? "monitoring" : "investigating");
    const components = ids(body, "components");
    const window = kind === "maintenance" ? schedule(body) : null;
    const id = crypto.randomUUID();
    const time = sqlTime(now);
    await env.STATUS_DB.batch([
      env.STATUS_DB.prepare(
        `INSERT INTO incidents (id, kind, title, status, impact, scheduled_start, scheduled_end, created_at, updated_at, resolved_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)`,
      ).bind(
        id,
        kind,
        title,
        status,
        impact,
        window?.start ?? null,
        window?.end ?? null,
        time,
        FINAL.includes(status) ? time : null,
      ),
      ...componentStatements(env, id, components),
      postUpdate(env, id, status, message, time),
    ]);
    return json({ id, url: `/incidents/${id}` }, 201);
  },

  "PATCH /api/operator/incidents/:id": async ({ env, params, body, now }) => {
    const id = params.id ?? "";
    const kind = await incidentKind(env, id);
    const title = optionalString(body, "title", 200);
    const impact = optionalChoice(body, "impact", IMPACTS);
    const window = kind === "maintenance" && body.scheduledStart !== undefined ? schedule(body) : null;
    const statements = [
      env.STATUS_DB.prepare(
        `UPDATE incidents SET title = coalesce(?2, title), impact = coalesce(?3, impact),
          scheduled_start = coalesce(?4, scheduled_start), scheduled_end = coalesce(?5, scheduled_end),
          operator_touched = 1, updated_at = ?6 WHERE id = ?1`,
      ).bind(id, title ?? null, impact ?? null, window?.start ?? null, window?.end ?? null, sqlTime(now)),
    ];
    if (body.components !== undefined) statements.push(...componentStatements(env, id, ids(body, "components")));
    await env.STATUS_DB.batch(statements);
    return json({ id });
  },

  "DELETE /api/operator/incidents/:id": async ({ env, params }) => {
    await incidentKind(env, params.id ?? "");
    await env.STATUS_DB.prepare("DELETE FROM incidents WHERE id = ?1").bind(params.id).run();
    return new Response(null, { status: 204 });
  },

  "POST /api/operator/incidents/:id/updates": async ({ env, params, body, now }) => {
    const id = params.id ?? "";
    const kind = await incidentKind(env, id);
    const status = choice(body, "status", statusesOf(kind));
    const message = string(body, "message", 4_000);
    const impact = optionalChoice(body, "impact", IMPACTS);
    const time = sqlTime(now);
    const final = FINAL.includes(status);
    await env.STATUS_DB.batch([
      env.STATUS_DB.prepare(
        `UPDATE incidents SET status = ?2, impact = coalesce(?3, impact), operator_touched = 1, updated_at = ?4,
          resolved_at = CASE WHEN ?5 THEN coalesce(resolved_at, ?4) END,
          auto_key = CASE WHEN ?5 THEN NULL ELSE auto_key END
          WHERE id = ?1`,
      ).bind(id, status, impact ?? null, time, final ? 1 : 0),
      postUpdate(env, id, status, message, time),
    ]);
    return json({ id }, 201);
  },

  "POST /api/operator/deploys": async ({ env, body, now }) => {
    const endpoint = string(body, "endpointId", 80);
    const version = string(body, "version", 100);
    await env.STATUS_DB.prepare("INSERT OR IGNORE INTO deploys (endpoint_id, version, detected_at) VALUES (?1, ?2, ?3)")
      .bind(endpoint, version, sqlTime(now))
      .run();
    return json({ endpointId: endpoint, version }, 201);
  },

  "PATCH /api/operator/components/:id": async ({ env, params, body }) => {
    const lifecycle = choice(body, "lifecycle", ["active", "planned"] as const);
    const statements = [
      env.STATUS_DB.prepare("UPDATE components SET lifecycle = ?2 WHERE id = ?1").bind(params.id, lifecycle),
    ];
    // Launching measures the component; planning it again stops probing.
    if (body.endpoints !== false) {
      statements.push(
        env.STATUS_DB.prepare("UPDATE endpoints SET enabled = ?2 WHERE component_id = ?1").bind(
          params.id,
          lifecycle === "active" ? 1 : 0,
        ),
      );
    }
    const [result] = await env.STATUS_DB.batch(statements);
    if ((result?.meta.changes ?? 0) === 0) throw new NotFound();
    return json({ id: params.id, lifecycle });
  },

  "PATCH /api/operator/endpoints/:id": async ({ env, params, body }) => {
    if (typeof body.enabled !== "boolean") throw new Invalid("enabled", "must be true or false");
    const result = await env.STATUS_DB.prepare("UPDATE endpoints SET enabled = ?2 WHERE id = ?1")
      .bind(params.id, body.enabled ? 1 : 0)
      .run();
    if ((result.meta.changes ?? 0) === 0) throw new NotFound();
    return json({ id: params.id, enabled: body.enabled });
  },
};

const route = createRouter(routes);

const failure = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });

/** Answers a request under /api/operator. */
export async function operator(request: Request, env: Env, now: number): Promise<Response> {
  if (!(await isOperator(request, env.OPERATOR_TOKEN))) {
    return failure(401, "unauthorized", "A valid operator bearer token is required.");
  }
  const url = new URL(request.url);
  const match = route(`${request.method} ${url.pathname}`);
  if (!match) return failure(404, "not_found", "No such operator endpoint.");
  try {
    const body = request.method === "POST" || request.method === "PATCH" ? await readBody(request) : {};
    const response = await match.value({ env, params: match.params, body, now });
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof Invalid) return failure(400, "invalid", error.message);
    if (error instanceof NotFound) return failure(404, "not_found", "No such record.");
    if (error instanceof Error && /FOREIGN KEY|CHECK constraint/.test(error.message)) {
      return failure(400, "invalid", "A referenced component or endpoint does not exist, or a value is out of range.");
    }
    console.error("operator request failed", error);
    return failure(500, "internal", "The request failed.");
  }
}
