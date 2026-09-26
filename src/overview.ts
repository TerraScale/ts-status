/* The status overview shared by the page and the JSON API: the headline,
   hourly bars per component and cluster, and daily platform bars with
   uptime, all measured by the health probes. */

import type { Snapshot, SnapshotWindow } from "./db/reads";
import { DAY, HOUR, startOfDay, startOfHour } from "./format";
import {
  aggregate,
  endpointStatus,
  incidentWindows,
  isActive,
  meanLatency,
  overallStatus,
  probeState,
  probeUptime,
  spans,
  sumCounts,
  worst,
  worstDuring,
  type Bucket,
  type Component,
  type ComponentGroup,
  type Endpoint,
  type Incident,
  type ProbeCounts,
  type Provider,
  type Region,
  type Status,
  type TimelineState,
} from "./domain/status";

export const SERVICE_HOURS = 24;
export const PLATFORM_DAYS = 30;
export const RESOLVED_DAYS = 7;

export interface ComponentOverview extends Component {
  status: TimelineState;
  hours: Bucket[];
  uptime24h: number | null;
  uptime30d: number | null;
}

export interface GroupOverview extends ComponentGroup {
  components: ComponentOverview[];
}

export interface ClusterOverview {
  id: string;
  componentId: string;
  componentName: string;
  cluster: string;
  provider: Provider;
  status: TimelineState;
  /** Latency of the latest successful probe. */
  pingMs: number | null;
  meanLatency24h: number | null;
  uptime24h: number | null;
  hours: Bucket[];
}

export interface RegionOverview extends Region {
  status: TimelineState;
  /** Mean latest ping of the region's reachable clusters. */
  pingMs: number | null;
  clusters: ClusterOverview[];
}

export interface Overview {
  generatedAt: number;
  status: Status;
  groups: GroupOverview[];
  regions: RegionOverview[];
  activeIncidents: Incident[];
  resolvedIncidents: Incident[];
  days: Bucket[];
  uptime30d: number | null;
}

/** Where the daily window starts: midnight UTC, 29 days before today. */
export const platformStart = (now: number): number => startOfDay(now) - (PLATFORM_DAYS - 1) * DAY;

/** Where the hourly window starts: the top of the hour, 23 hours ago. */
export const hourlyStart = (now: number): number => startOfHour(now) - (SERVICE_HOURS - 1) * HOUR;

/** The data window behind an overview at `now`. */
export function snapshotWindow(now: number): SnapshotWindow {
  const from = platformStart(now);
  return { incidentsFrom: from, probesFrom: from };
}

/** Every endpoint's hourly probe counts, keyed by the hour's start. */
type Counts = Map<string, Map<number, ProbeCounts>>;

function countsByEndpoint(snapshot: Snapshot): Counts {
  const counts: Counts = new Map();
  for (const hour of snapshot.probeHours) {
    const list = counts.get(hour.endpointId) ?? new Map<number, ProbeCounts>();
    list.set(Date.parse(hour.hour), hour);
    counts.set(hour.endpointId, list);
  }
  return counts;
}

/** An endpoint's summed probe counts over the whole hours in [from, to). */
function during(counts: Counts, endpointId: string, from: number, to: number): ProbeCounts {
  const hours = counts.get(endpointId);
  const list: ProbeCounts[] = [];
  for (let at = from; at < to; at += HOUR) {
    const hour = hours?.get(at);
    if (hour) list.push(hour);
  }
  return sumCounts(list);
}

/** Every component's enabled endpoints, in catalog order. */
function endpointsByComponent(endpoints: readonly Endpoint[]): Map<string, Endpoint[]> {
  const byComponent = new Map<string, Endpoint[]>();
  for (const endpoint of endpoints) {
    byComponent.set(endpoint.componentId, [...(byComponent.get(endpoint.componentId) ?? []), endpoint]);
  }
  return byComponent;
}

/** Bars for a set of endpoints: every bucket shows their combined state. */
function bars(counts: Counts, endpoints: readonly Endpoint[], start: number, count: number, size: number): Bucket[] {
  return spans(start, start + count * size, count).map((span) => ({
    ...span,
    state: aggregate(endpoints.map((endpoint) => probeState(during(counts, endpoint.id, span.start, span.end)))),
  }));
}

/** Summed probe counts of a set of endpoints over [from, to). */
function total(counts: Counts, endpoints: readonly Endpoint[], from: number, to: number): ProbeCounts {
  return sumCounts(endpoints.map((endpoint) => during(counts, endpoint.id, from, to)));
}

function cluster(
  endpoint: Endpoint,
  components: ReadonlyMap<string, Component>,
  counts: Counts,
  hourStart: number,
  now: number,
): ClusterOverview {
  const day = total(counts, [endpoint], hourStart, now);
  return {
    id: endpoint.id,
    componentId: endpoint.componentId,
    componentName: components.get(endpoint.componentId)?.name ?? endpoint.componentId,
    cluster: endpoint.cluster,
    provider: endpoint.provider,
    status: endpointStatus(endpoint, now),
    pingMs: endpoint.lastOk === 1 ? endpoint.lastLatencyMs : null,
    meanLatency24h: meanLatency(day),
    uptime24h: probeUptime(day),
    hours: bars(counts, [endpoint], hourStart, SERVICE_HOURS, HOUR),
  };
}

function regions(snapshot: Snapshot, counts: Counts, hourStart: number, now: number): RegionOverview[] {
  const components = new Map(snapshot.components.map((component) => [component.id, component]));
  return snapshot.regions.map((region) => {
    const clusters = snapshot.endpoints
      .filter((endpoint) => endpoint.regionCode === region.code)
      .map((endpoint) => cluster(endpoint, components, counts, hourStart, now));
    const pings = clusters.flatMap((entry) => (entry.pingMs === null ? [] : [entry.pingMs]));
    return {
      ...region,
      status: aggregate(clusters.map((entry) => entry.status)),
      pingMs: pings.length === 0 ? null : Math.round(pings.reduce((sum, ping) => sum + ping, 0) / pings.length),
      clusters,
    };
  });
}

export function overview(snapshot: Snapshot, now: number): Overview {
  const dayStart = platformStart(now);
  const hourStart = hourlyStart(now);
  const counts = countsByEndpoint(snapshot);
  const byComponent = endpointsByComponent(snapshot.endpoints);

  const components = snapshot.components.map((component): ComponentOverview => {
    const endpoints = component.lifecycle === "planned" ? [] : (byComponent.get(component.id) ?? []);
    return {
      ...component,
      status: aggregate(endpoints.map((endpoint) => endpointStatus(endpoint, now))),
      hours: bars(counts, endpoints, hourStart, SERVICE_HOURS, HOUR),
      uptime24h: probeUptime(total(counts, endpoints, hourStart, now)),
      uptime30d: probeUptime(total(counts, endpoints, dayStart, now)),
    };
  });
  const active = snapshot.components.filter((component) => component.lifecycle === "active").map((c) => c.id);
  const measured = active.flatMap((id) => byComponent.get(id) ?? []);
  const windows = incidentWindows(snapshot.incidents, now);

  const days = spans(dayStart, dayStart + PLATFORM_DAYS * DAY, PLATFORM_DAYS).map((span) => {
    const states = active.map((id) =>
      aggregate(
        (byComponent.get(id) ?? []).map((endpoint) => probeState(during(counts, endpoint.id, span.start, span.end))),
      ),
    );
    return { ...span, state: worst(aggregate(states), worstDuring(windows, span.start, span.end)) };
  });

  const resolvedFrom = now - RESOLVED_DAYS * DAY;
  return {
    generatedAt: now,
    status: overallStatus(
      components.filter((component) => component.lifecycle === "active").map((component) => component.status),
      snapshot.incidents,
    ),
    groups: snapshot.groups
      .map((group) => ({ ...group, components: components.filter((component) => component.groupId === group.id) }))
      .filter((group) => group.components.length > 0),
    regions: regions(snapshot, counts, hourStart, now),
    activeIncidents: snapshot.incidents.filter(isActive),
    resolvedIncidents: snapshot.incidents.filter(
      (incident) => !isActive(incident) && Date.parse(incident.resolvedAt ?? incident.updatedAt) >= resolvedFrom,
    ),
    days,
    uptime30d: probeUptime(total(counts, measured, dayStart, now)),
  };
}
