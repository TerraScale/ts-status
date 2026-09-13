export type ServiceStatus = "operational" | "degraded" | "partial_outage" | "major_outage" | "maintenance";
export interface StatusService { status: ServiceStatus }
export interface StatusIncident { status: string; impact: string }
export function overallStatus(services: readonly StatusService[], incidents: readonly StatusIncident[]): ServiceStatus {
  if (services.some((service) => service.status === "major_outage") || incidents.some((incident) => incident.impact === "critical" && incident.status !== "resolved")) return "major_outage";
  if (services.some((service) => ["partial_outage", "degraded"].includes(service.status)) || incidents.some((incident) => incident.status !== "resolved")) return "degraded";
  if (services.some((service) => service.status === "maintenance")) return "maintenance";
  return "operational";
}
