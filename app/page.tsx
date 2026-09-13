import { getStatusEnv } from "../src/env";
import { overallStatus, type ServiceStatus } from "../src/status";

type Service = { id: string; name: string; description: string; status: ServiceStatus; updated_at: string };
type Incident = { id: string; kind: string; title: string; status: string; impact: string; message: string; created_at: string; updated_at: string; resolved_at: string | null };
type StatusEvent = { id: string; service_id: string | null; status: ServiceStatus; label: string; created_at: string };

const labels: Record<string, string> = {
  operational: "Operational",
  degraded: "Degraded performance",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  maintenance: "Maintenance",
};

export default async function StatusPage() {
  const env = getStatusEnv();
  const [serviceResult, incidentResult, eventResult] = await Promise.all([
    env.STATUS_DB.prepare("SELECT id, name, description, status, updated_at FROM services ORDER BY rowid").all<Service>(),
    env.STATUS_DB.prepare("SELECT id, kind, title, status, impact, message, created_at, updated_at, resolved_at FROM incidents ORDER BY created_at DESC LIMIT 20").all<Incident>(),
    env.STATUS_DB.prepare("SELECT id, service_id, status, label, created_at FROM status_events WHERE created_at >= datetime('now', '-24 hours') ORDER BY created_at ASC").all<StatusEvent>(),
  ]);
  const services = serviceResult.results ?? [];
  const incidents = incidentResult.results ?? [];
  const events = eventResult.results ?? [];
  const status = overallStatus(services, incidents);
  const activeIncidents = incidents.filter((incident) => incident.status !== "resolved");
  return (
    <main className="shell">
      <header className="header">
        <a className="brand" href="/" aria-label="TerraScale home"><img src="/logo-principal.svg" alt="TerraScale" width="178" height="43" /></a>
        <span className="updated">Updated just now</span>
      </header>
      <section className={`hero hero-${status}`}>
        <div className="status-icon" aria-hidden="true">{status === "operational" ? "✓" : "!"}</div>
        <div><p className="eyebrow">Current status</p><h1>{status === "operational" ? "All systems operational" : `Some systems are ${labels[status]?.toLowerCase() ?? "experiencing issues"}`}</h1><p className="hero-copy">We publish real-time updates for the services that power TerraScale.</p></div>
      </section>
      {activeIncidents.length > 0 && <section className="section"><h2>Active incidents</h2>{activeIncidents.map((incident) => <article className="incident" key={incident.id}><div className={`incident-dot impact-${incident.impact}`} /><div><div className="incident-heading"><h3>{incident.kind === "warning" ? "Warning: " : ""}{incident.title}</h3><span className="pill">{incident.kind === "warning" ? "warning" : incident.status}</span></div><p>{incident.message}</p><time dateTime={incident.updated_at}>Updated {new Date(incident.updated_at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}</time></div></article>)}</section>}
      <section className="section"><div className="section-heading"><h2>Services</h2><span className="availability">{services.filter((service) => service.status === "operational").length}/{services.length} operational</span></div><div className="services">{services.map((service) => { const serviceEvents = events.filter((event) => event.service_id === service.id); return <div className="service" key={service.id}><div className="service-copy"><div><h3>{service.name}</h3><p>{service.description}</p></div><span className={`service-status status-${service.status}`}><i />{labels[service.status] ?? service.status}</span></div><div className="service-graph" role="img" aria-label={`${service.name} status over the last 12 hours`}>{Array.from({ length: 12 }, (_, index) => { const event = [...serviceEvents].reverse()[index]; const state = event?.status ?? service.status; return <span key={index} className={`timeline-bar timeline-${state}`} title={labels[state] ?? state} />; })}</div></div>; })}</div></section>
      <section className="section timeline"><div className="section-heading"><h2>Last 24 hours</h2><span className="availability">live · refreshes every 2 min</span></div><div className="timeline-card"><div className="timeline-bars" role="img" aria-label="Service status timeline for the last 24 hours">{Array.from({ length: 24 }, (_, index) => { const cutoff = Date.now() - (23 - index) * 60 * 60 * 1000; const event = [...events].reverse().find((candidate) => Date.parse(candidate.created_at.replace(" ", "T") + "Z") <= cutoff); const state = event?.status ?? "operational"; return <span key={index} className={`timeline-bar timeline-${state}`} title={`${index + 1} hours ago: ${labels[state] ?? state}`} />; })}</div><div className="timeline-axis"><span>24h ago</span><span>Now</span></div></div></section>

      <footer><span>© {new Date().getFullYear()} TerraScale</span><nav className="footer-links"><a href="/history">Incident history</a><a href="/api/status">JSON API</a></nav></footer>
    </main>
  );
}
