/* Status domain: states, the catalog, incidents, and the probe maths behind
   every status bar. Everything here is pure so it is unit tested. */

/** States, least to most severe. */
export const STATES = ["operational", "maintenance", "degraded", "partial_outage", "major_outage"] as const;

export type Status = (typeof STATES)[number];

/** A timeline state: a status, or "none" where nothing was measured. */
export type TimelineState = Status | "none";

export type Lifecycle = "active" | "planned";

export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";

export type IncidentImpact = "minor" | "major" | "critical";

export type Provider = "fly" | "oci" | "cloudflare" | "other";

export interface ComponentGroup {
  id: string;
  name: string;
}

/** Something customers use, checked by the endpoints that serve it. */
export interface Component {
  id: string;
  groupId: string;
  name: string;
  description: string;
  lifecycle: Lifecycle;
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

/** A span of time in one state. */
export interface Segment {
  from: number;
  to: number;
  state: TimelineState;
}

/** A status bar: the worst state seen during [start, end). */
export interface Bucket {
  start: number;
  end: number;
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

/** The state an active incident implies. */
export const IMPACT_STATUS: Record<IncidentImpact, Status> = {
  minor: "degraded",
  major: "partial_outage",
  critical: "major_outage",
};

const severity = (state: TimelineState): number => (state === "none" ? -1 : STATES.indexOf(state));

/** The more severe of two states. */
export function worst(a: TimelineState, b: TimelineState): TimelineState {
  return severity(b) > severity(a) ? b : a;
}

/** The state of something served by several parts, such as a region's
    clusters or a component's endpoints: down when every part is down,
    partially down when some are, and otherwise the worst part. */
export function aggregate(states: readonly TimelineState[]): TimelineState {
  const known = states.filter((state) => state !== "none");
  if (known.length === 0) return "none";
  const down = known.filter((state) => state === "major_outage").length;
  if (down === known.length) return "major_outage";
  if (down > 0) return "partial_outage";
  return known.reduce<TimelineState>(worst, "none");
}

export function isActive(incident: Pick<Incident, "status">): boolean {
  return incident.status !== "resolved";
}

/** The headline: the components taken together, worsened by the impact of
    every active incident. One component down is a partial outage of the
    platform; only all of them is a major one. */
export function overallStatus(
  components: readonly TimelineState[],
  incidents: readonly Pick<Incident, "status" | "impact">[],
): Status {
  let state = aggregate(components);
  for (const incident of incidents) {
    if (isActive(incident)) state = worst(state, IMPACT_STATUS[incident.impact]);
  }
  return state === "none" ? "operational" : state;
}

/** The time every incident was open, in the state its impact implies. */
export function incidentWindows(incidents: readonly Incident[], now: number): Segment[] {
  return incidents.map((incident) => ({
    from: Date.parse(incident.createdAt),
    to: incident.resolvedAt ? Date.parse(incident.resolvedAt) : now,
    state: IMPACT_STATUS[incident.impact],
  }));
}

/** The worst state of any window overlapping [from, to). */
export function worstDuring(windows: readonly Segment[], from: number, to: number): TimelineState {
  return windows
    .filter((window) => window.from < to && window.to > from)
    .reduce<TimelineState>((acc, window) => worst(acc, window.state), "none");
}

/** Cuts [start, end) into `count` equal buckets. */
export function spans(start: number, end: number, count: number): { start: number; end: number }[] {
  const size = (end - start) / count;
  return Array.from({ length: count }, (_, index) => {
    const from = start + index * size;
    return { start: from, end: index === count - 1 ? end : from + size };
  });
}

/* Regions and health probes. Every cluster in a region is an endpoint that
   the Worker probes each minute; results roll up into hourly counts. */

export interface Region {
  code: string;
  name: string;
  country: string;
  mapX: number;
  mapY: number;
}

export interface Endpoint {
  id: string;
  componentId: string;
  regionCode: string | null;
  cluster: string;
  provider: Provider;
  lastCheckedAt: string | null;
  lastOk: number | null;
  lastLatencyMs: number | null;
  consecutiveFailures: number;
}

/** Probe counts for one UTC hour, or any sum of hours. */
export interface ProbeCounts {
  checks: number;
  failures: number;
  latencySum: number;
}

/** One endpoint's probe counts for one UTC hour. */
export interface ProbeHour extends ProbeCounts {
  endpointId: string;
  hour: string;
}

/** Probes older than this no longer describe the present. */
export const PROBE_STALE_MS = 5 * 60_000;

/** A healthy response slower than this counts as degraded. */
export const SLOW_MS = 1_500;

/** Consecutive failed probes before a cluster counts as down. */
export const DOWN_AFTER = 3;

/** The current state of one endpoint from its latest probes. */
export function endpointStatus(endpoint: Endpoint, now: number): TimelineState {
  if (!endpoint.lastCheckedAt || now - Date.parse(endpoint.lastCheckedAt) > PROBE_STALE_MS) return "none";
  if (endpoint.consecutiveFailures >= DOWN_AFTER) return "major_outage";
  if (endpoint.consecutiveFailures > 0) return "degraded";
  if ((endpoint.lastLatencyMs ?? 0) > SLOW_MS) return "degraded";
  return "operational";
}

/** The sum of several probe counts. */
export function sumCounts(list: readonly ProbeCounts[]): ProbeCounts {
  return list.reduce(
    (sum, hour) => ({
      checks: sum.checks + hour.checks,
      failures: sum.failures + hour.failures,
      latencySum: sum.latencySum + hour.latencySum,
    }),
    { checks: 0, failures: 0, latencySum: 0 },
  );
}

/** The state of a stretch of time from its failure ratio. */
export function probeState(counts: Pick<ProbeCounts, "checks" | "failures"> | undefined): TimelineState {
  if (!counts || counts.checks === 0) return "none";
  if (counts.failures === 0) return "operational";
  if (counts.failures === counts.checks) return "major_outage";
  return counts.failures / counts.checks < 0.1 ? "degraded" : "partial_outage";
}

/** Share of successful probes, or null without probes. */
export function probeUptime(counts: Pick<ProbeCounts, "checks" | "failures">): number | null {
  return counts.checks === 0 ? null : 1 - counts.failures / counts.checks;
}

/** Mean latency of successful probes, or null without any. */
export function meanLatency(counts: ProbeCounts): number | null {
  const ok = counts.checks - counts.failures;
  return ok === 0 ? null : Math.round(counts.latencySum / ok);
}
