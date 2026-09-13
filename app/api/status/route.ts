import { getStatusEnv } from "../../../src/env";

export const runtime = "edge";

type Service = { id: string; name: string; description: string; status: string; updated_at: string };
type Incident = { id: string; kind: string; title: string; status: string; impact: string; message: string; created_at: string; updated_at: string; resolved_at: string | null };
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
