import { getStatusEnv } from "../../../src/env";

export const runtime = "edge";

type Service = { id: string; name: string; description: string; status: string; updated_at: string };
type Incident = { id: string; title: string; status: string; impact: string; message: string; created_at: string; updated_at: string; resolved_at: string | null };
type StatusEvent = { id: string; service_id: string | null; status: string; label: string; created_at: string };

export async function GET(): Promise<Response> {
  const env = getStatusEnv();
  const [services, incidents, events] = await Promise.all([
    env.STATUS_DB.prepare("SELECT id, name, description, status, updated_at FROM services ORDER BY rowid").all<Service>(),
    env.STATUS_DB.prepare("SELECT id, kind, title, status, impact, message, created_at, updated_at, resolved_at FROM incidents ORDER BY created_at DESC LIMIT 50").all<Incident>(),
    env.STATUS_DB.prepare("SELECT id, service_id, status, label, created_at FROM status_events WHERE created_at >= datetime('now', '-30 days') ORDER BY created_at ASC").all<StatusEvent>(),
  ]);
  return Response.json({ generatedAt: new Date().toISOString(), services: services.results ?? [], incidents: incidents.results ?? [], events: events.results ?? [] }, { headers: { "cache-control": "public, max-age=30, s-maxage=30" } });
}

export async function POST(request: Request): Promise<Response> {
  const env = getStatusEnv();
  const authorization = request.headers.get("authorization");
  if (!env.STATUS_ADMIN_TOKEN || authorization !== `Bearer ${env.STATUS_ADMIN_TOKEN}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Request body must be JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object") return Response.json({ error: "Request body must be an object" }, { status: 400 });
  const input = body as Record<string, unknown>;
  const action = input.action;
  if (action === "service") {
    const id = typeof input.id === "string" ? input.id.trim() : "";
    const status = typeof input.status === "string" ? input.status : "";
    if (!id || !["operational", "degraded", "partial_outage", "major_outage", "maintenance"].includes(status)) return Response.json({ error: "id and a valid status are required" }, { status: 400 });
    await env.STATUS_DB.batch([
      env.STATUS_DB.prepare("UPDATE services SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, id),
      env.STATUS_DB.prepare("INSERT INTO status_events (id, service_id, status, label) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), id, status, `Service ${id} changed to ${status}`),
    ]);
    return Response.json({ ok: true });
  }
  if (action === "resolve") {
    const id = typeof input.id === "string" ? input.id.trim() : "";
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });
    const result = await env.STATUS_DB.prepare("UPDATE incidents SET status = 'resolved', resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(id).run();
    if (!result.meta.changes) return Response.json({ error: "Incident not found" }, { status: 404 });
    await env.STATUS_DB.prepare("INSERT INTO status_events (id, service_id, status, label) VALUES (?, NULL, 'operational', 'Incident resolved')").bind(crypto.randomUUID()).run();
    return Response.json({ ok: true });
  }
  if (action === "incident" || action === "warning") {
    const id = crypto.randomUUID();
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const message = typeof input.message === "string" ? input.message.trim() : "";
    const impact = typeof input.impact === "string" ? input.impact : "minor";
    const incidentStatus = action === "warning" ? "monitoring" : typeof input.status === "string" ? input.status : "investigating";
    if (!title || !message || !["minor", "major", "critical"].includes(impact) || !["investigating", "identified", "monitoring", "resolved"].includes(incidentStatus)) return Response.json({ error: "title, message, impact and status are required" }, { status: 400 });
    const eventStatus = impact === "critical" ? "major_outage" : impact === "major" ? "partial_outage" : "degraded";
    await env.STATUS_DB.batch([
      env.STATUS_DB.prepare("INSERT INTO incidents (id, kind, title, status, impact, message, resolved_at) VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? = 'resolved' THEN datetime('now') ELSE NULL END)").bind(id, action === "warning" ? "warning" : "incident", title, incidentStatus, impact, message, incidentStatus),
      env.STATUS_DB.prepare("INSERT INTO status_events (id, service_id, status, label) VALUES (?, NULL, ?, ?)").bind(crypto.randomUUID(), eventStatus, title),
    ]);
    return Response.json({ id, ok: true }, { status: 201 });
  }
  return Response.json({ error: "action must be service, incident, warning or resolve" }, { status: 400 });
}
