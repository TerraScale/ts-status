/* Status domain: service states, the overall headline, and the timelines
   behind the status bars. Everything here is pure so it is unit tested. */

/** Service states, least to most severe. */
export const SERVICE_STATES = ["operational", "maintenance", "degraded", "partial_outage", "major_outage"] as const;

export type ServiceStatus = (typeof SERVICE_STATES)[number];

/** A timeline state: a service status, or "none" before any data exists. */
export type TimelineState = ServiceStatus | "none";

export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";

export type IncidentImpact = "minor" | "major" | "critical";

export interface Service {
  id: string;
  name: string;
  description: string;
  status: ServiceStatus;
  updatedAt: string;
}

export interface Incident {
  id: string;
  kind: "incident" | "warning";
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  message: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

/** A status change. A null serviceId is a platform-wide event. */
export interface StatusEvent {
  serviceId: string | null;
  status: ServiceStatus;
  label: string;
  createdAt: string;
}

/** A status change on a single timeline, at epoch milliseconds. */
export interface Change {
  at: number;
  status: ServiceStatus;
}

/** A span of time in one state. */
export interface Segment {
  from: number;
  to: number;
  state: TimelineState;
}

export const STATE_LABELS: Record<TimelineState, string> = {
  operational: "Operational",
  maintenance: "Maintenance",
  degraded: "Degraded performance",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  none: "No data",
};

/** The service state an active incident implies. */
export const IMPACT_STATUS: Record<IncidentImpact, ServiceStatus> = {
  minor: "degraded",
  major: "partial_outage",
  critical: "major_outage",
};

const severity = (state: TimelineState): number => (state === "none" ? -1 : SERVICE_STATES.indexOf(state));

/** The more severe of two states. */
export function worst(a: TimelineState, b: TimelineState): TimelineState {
  return severity(b) > severity(a) ? b : a;
}

export function isActive(incident: Pick<Incident, "status">): boolean {
  return incident.status !== "resolved";
}

/** The headline state: the worst of the service statuses, active incident
    impacts, and measured region states. */
export function overallStatus(
  services: readonly Pick<Service, "status">[],
  incidents: readonly Pick<Incident, "status" | "impact">[],
  regions: readonly TimelineState[] = [],
): ServiceStatus {
  let state: TimelineState = "operational";
  for (const service of services) state = worst(state, service.status);
  for (const incident of incidents) {
    if (isActive(incident)) state = worst(state, IMPACT_STATUS[incident.impact]);
  }
  for (const region of regions) state = worst(state, region);
  return state === "none" ? "operational" : state;
}

/** Splits [start, end) into the states of one timeline. `changes` must be
    sorted by time; the latest change at or before `start` sets the opening
    state, so a window never forgets an outage that began before it. */
export function segments(changes: readonly Change[], start: number, end: number): Segment[] {
  const result: Segment[] = [];
  let state: TimelineState = "none";
  let from = start;
  for (const change of changes) {
    if (change.at >= end) break;
    if (change.at <= start) {
      state = change.status;
      continue;
    }
    if (change.status === state) continue;
    result.push({ from, to: change.at, state });
    from = change.at;
    state = change.status;
  }
  result.push({ from, to: end, state });
  return result;
}

/** The state of a segment list at time `at`. */
function stateAt(list: readonly Segment[], at: number): TimelineState {
  for (const segment of list) if (at >= segment.from && at < segment.to) return segment.state;
  return "none";
}

/** Combines timelines over the same window into their worst state at every
    moment, e.g. the platform timeline from every service. */
export function combine(lists: readonly (readonly Segment[])[], start: number, end: number): Segment[] {
  const points = [...new Set(lists.flatMap((list) => list.map((segment) => segment.from)).concat(start))]
    .filter((point) => point >= start && point < end)
    .sort((a, b) => a - b);
  const result: Segment[] = [];
  points.forEach((from, index) => {
    const state = lists.reduce<TimelineState>((acc, list) => worst(acc, stateAt(list, from)), "none");
    const previous = result.at(-1);
    if (previous && previous.state === state) previous.to = points[index + 1] ?? end;
    else result.push({ from, to: points[index + 1] ?? end, state });
  });
  return result;
}

/** A status bar: the worst state seen during [start, end). */
export interface Bucket {
  start: number;
  end: number;
  state: TimelineState;
}

/** Cuts [start, end) into `count` equal buckets showing their worst state. */
export function buckets(list: readonly Segment[], start: number, end: number, count: number): Bucket[] {
  const size = (end - start) / count;
  return Array.from({ length: count }, (_, index) => {
    const from = start + index * size;
    const to = index === count - 1 ? end : from + size;
    const state = list
      .filter((segment) => segment.from < to && segment.to > from)
      .reduce<TimelineState>((acc, segment) => worst(acc, segment.state), "none");
    return { start: from, end: to, state };
  });
}

/** The share of recorded time without an outage, or null with no data.
    Degraded performance and maintenance count as available. */
export function uptime(list: readonly Segment[]): number | null {
  let known = 0;
  let down = 0;
  for (const segment of list) {
    if (segment.state === "none") continue;
    const length = segment.to - segment.from;
    known += length;
    if (segment.state === "partial_outage" || segment.state === "major_outage") down += length;
  }
  return known === 0 ? null : 1 - down / known;
}

/** The changes of one service: its events, closed by its current status when
    the table was updated without a matching event. */
export function serviceChanges(service: Service, events: readonly StatusEvent[]): Change[] {
  const changes = events
    .filter((event) => event.serviceId === service.id)
    .map((event) => ({ at: Date.parse(event.createdAt), status: event.status }));
  const last = changes.at(-1);
  if (last?.status !== service.status) {
    changes.push({ at: Math.max(Date.parse(service.updatedAt), last?.at ?? 0), status: service.status });
  }
  return changes;
}

/** Changes of platform-wide events, such as published warnings. */
export function platformChanges(events: readonly StatusEvent[]): Change[] {
  return events
    .filter((event) => event.serviceId === null)
    .map((event) => ({ at: Date.parse(event.createdAt), status: event.status }));
}

/* Regions and health probes. Every cluster in a region is an endpoint that
   the Worker probes each minute; results roll up into hourly counts. */

export type Provider = "fly" | "oci" | "cloudflare" | "other";

export interface Region {
  code: string;
  name: string;
  country: string;
  mapX: number;
  mapY: number;
}

export interface Endpoint {
  id: string;
  regionCode: string;
  serviceId: string;
  cluster: string;
  provider: Provider;
  lastCheckedAt: string | null;
  lastOk: number | null;
  lastLatencyMs: number | null;
  consecutiveFailures: number;
}

/** One endpoint's probe counts for one UTC hour. */
export interface ProbeHour {
  endpointId: string;
  hour: string;
  checks: number;
  failures: number;
  latencySum: number;
}

/** Probes older than this no longer describe the present. */
export const PROBE_STALE_MS = 5 * 60_000;

/** A healthy response slower than this counts as degraded. */
export const SLOW_MS = 1_500;

/** Consecutive failed probes before a cluster counts as down. */
export const DOWN_AFTER = 3;

/** The current state of one cluster from its latest probes. */
export function endpointStatus(endpoint: Endpoint, now: number): TimelineState {
  if (!endpoint.lastCheckedAt || now - Date.parse(endpoint.lastCheckedAt) > PROBE_STALE_MS) return "none";
  if (endpoint.consecutiveFailures >= DOWN_AFTER) return "major_outage";
  if (endpoint.consecutiveFailures > 0) return "degraded";
  if ((endpoint.lastLatencyMs ?? 0) > SLOW_MS) return "degraded";
  return "operational";
}

/** A region's state: down when every cluster is down, partially down when
    some are, and otherwise the worst cluster state. */
export function regionStatus(states: readonly TimelineState[]): TimelineState {
  const known = states.filter((state) => state !== "none");
  if (known.length === 0) return "none";
  const down = known.filter((state) => state === "major_outage").length;
  if (down === known.length) return "major_outage";
  if (down > 0) return "partial_outage";
  return known.reduce<TimelineState>(worst, "none");
}

/** The state of an hour from its failure ratio. */
export function probeHourState(hour: Pick<ProbeHour, "checks" | "failures"> | undefined): TimelineState {
  if (!hour || hour.checks === 0) return "none";
  if (hour.failures === 0) return "operational";
  if (hour.failures === hour.checks) return "major_outage";
  return hour.failures / hour.checks < 0.1 ? "degraded" : "partial_outage";
}

/** Share of successful probes, or null without probes. */
export function probeUptime(hours: readonly Pick<ProbeHour, "checks" | "failures">[]): number | null {
  const checks = hours.reduce((sum, hour) => sum + hour.checks, 0);
  const failures = hours.reduce((sum, hour) => sum + hour.failures, 0);
  return checks === 0 ? null : 1 - failures / checks;
}

/** Mean latency of successful probes, or null without any. */
export function meanLatency(hours: readonly Pick<ProbeHour, "checks" | "failures" | "latencySum">[]): number | null {
  const ok = hours.reduce((sum, hour) => sum + hour.checks - hour.failures, 0);
  return ok === 0 ? null : Math.round(hours.reduce((sum, hour) => sum + hour.latencySum, 0) / ok);
}
