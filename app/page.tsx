import { getStatusEnv } from "../src/env";
import { overallStatus, type ServiceStatus } from "../src/status";

type Service = { id: string; name: string; description: string; status: ServiceStatus; updated_at: string };
type Incident = { id: string; title: string; status: string; impact: string; message: string; created_at: string; updated_at: string; resolved_at: string | null };

const labels: Record<string, string> = {
  operational: "Operational",
  degraded: "Degraded performance",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  maintenance: "Maintenance",
};

export default async function StatusPage() {
  const env = getStatusEnv();
  const [serviceResult, incidentResult] = await Promise.all([
    env.STATUS_DB.prepare("SELECT id, name, description, status, updated_at FROM services ORDER BY rowid").all<Service>(),
    env.STATUS_DB.prepare("SELECT id, title, status, impact, message, created_at, updated_at, resolved_at FROM incidents ORDER BY created_at DESC LIMIT 20").all<Incident>(),
  ]);
  const services = serviceResult.results ?? [];
  const incidents = incidentResult.results ?? [];
  const status = overallStatus(services, incidents);
  const activeIncidents = incidents.filter((incident) => incident.status !== "resolved");
  return (
    <main className="shell">
      <header className="header">
        <a className="brand" href="/" aria-label="TerraScale home"><span className="brand-mark">T</span><span>TerraScale</span></a>
        <span className="updated">Updated just now</span>
      </header>
      <section className={`hero hero-${status}`}>
        <div className="status-icon" aria-hidden="true">{status === "operational" ? "✓" : "!"}</div>
        <div><p className="eyebrow">Current status</p><h1>{status === "operational" ? "All systems operational" : `Some systems are ${labels[status]?.toLowerCase() ?? "experiencing issues"}`}</h1><p className="hero-copy">We publish real-time updates for the services that power TerraScale.</p></div>
      </section>
      {activeIncidents.length > 0 && <section className="section"><h2>Active incidents</h2>{activeIncidents.map((incident) => <article className="incident" key={incident.id}><div className={`incident-dot impact-${incident.impact}`} /><div><div className="incident-heading"><h3>{incident.title}</h3><span className="pill">{incident.status}</span></div><p>{incident.message}</p><time dateTime={incident.updated_at}>Updated {new Date(incident.updated_at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}</time></div></article>)}</section>}
      <section className="section"><div className="section-heading"><h2>Services</h2><span className="availability">{services.filter((service) => service.status === "operational").length}/{services.length} operational</span></div><div className="services">{services.map((service) => <div className="service" key={service.id}><div><h3>{service.name}</h3><p>{service.description}</p></div><span className={`service-status status-${service.status}`}><i />{labels[service.status] ?? service.status}</span></div>)}</div></section>
      {incidents.length > 0 && <section className="section history"><h2>Incident history</h2>{incidents.filter((incident) => incident.status === "resolved").slice(0, 10).map((incident) => <div className="history-row" key={incident.id}><span className="resolved">✓</span><div><strong>{incident.title}</strong><p>{incident.message}</p></div><time dateTime={incident.resolved_at ?? incident.updated_at}>{new Date(incident.resolved_at ?? incident.updated_at).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })}</time></div>)}</section>}
      <footer><span>© {new Date().getFullYear()} TerraScale</span><a href="/api/status">JSON API</a></footer>
    </main>
  );
}
