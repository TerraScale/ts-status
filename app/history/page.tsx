import { getStatusEnv } from "../../src/env";
import "../styles.css";

type Incident = { id: string; kind: string; title: string; status: string; impact: string; message: string; created_at: string; updated_at: string; resolved_at: string | null };

export default async function IncidentHistoryPage() {
  const env = getStatusEnv();
  const result = await env.STATUS_DB.prepare("SELECT id, kind, title, status, impact, message, created_at, updated_at, resolved_at FROM incidents ORDER BY created_at DESC LIMIT 100").all<Incident>();
  const incidents = result.results ?? [];
  return <main className="shell history-page"><header className="header"><a className="brand" href="/" aria-label="TerraScale home"><img src="/logo-principal.svg" alt="TerraScale" width="178" height="43" /></a><a className="back-link" href="/">← Current status</a></header><section className="history-heading"><p className="eyebrow">Transparency</p><h1>Incident history</h1><p>Resolved incidents and operational warnings from the TerraScale platform.</p></section><section className="history-list">{incidents.length === 0 ? <p className="empty-history">No incidents recorded.</p> : incidents.map((incident) => <article className="history-card" key={incident.id}><div className={`incident-dot impact-${incident.impact}`} /><div className="history-content"><div className="incident-heading"><h2>{incident.kind === "warning" ? "Warning: " : ""}{incident.title}</h2><span className={`pill ${incident.status === "resolved" ? "pill-resolved" : ""}`}>{incident.status}</span></div><p>{incident.message}</p><time dateTime={incident.resolved_at ?? incident.updated_at}>{new Date(incident.resolved_at ?? incident.updated_at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}</time></div></article>)}</section><footer><span>© {new Date().getFullYear()} TerraScale</span><a href="/">Current status</a></footer></main>;
}
