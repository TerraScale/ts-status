/* The status overview shared by the page and the JSON API: the headline,
   hourly bars per component and cluster, and daily platform bars with
   uptime, all measured by the probe rounds. */

import type { Snapshot, SnapshotWindow } from "./db/reads";
import { DAY, HOUR, startOfDay, startOfHour } from "./format";
import {
  aggregate,
  endpointStatus,
  incidentWindows,
  isActive,
  meanLatency,
  overallStatus,
  PROBE_STALE_MS,
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
  type LatestSample,
  type ProbeCounts,
  type ProbePeriod,
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
  /** Median latency of the latest round. */
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

export interface Monitoring {
  /** When the latest probe round ran, or null before the first. */
  lastRoundAt: number | null;
  /** True when rounds have stopped arriving and states may be out of date. */
  delayed: boolean;
}

export interface Overview {
  generatedAt: number;
  status: Status;
  monitoring: Monitoring;
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
  return { incidentsFrom: platformStart(now), hoursFrom: hourlyStart(now), daysFrom: platformStart(now) };
}

/** Consensus counts per endpoint, keyed by the period's start. */
type Periods = Map<string, Map<number, ProbeCounts>>;

function byEndpoint(list: readonly ProbePeriod[]): Periods {
  const periods: Periods = new Map();
  for (const period of list) {
    const entries = periods.get(period.endpointId) ?? new Map<number, ProbeCounts>();
    entries.set(Date.parse(period.start), period);
    periods.set(period.endpointId, entries);
  }
  return periods;
}

/** The summed counts of a set of endpoints over every period in `starts`. */
function total(periods: Periods, endpoints: readonly Endpoint[], starts: readonly number[]): ProbeCounts {
  return sumCounts(
    endpoints.flatMap((endpoint) => starts.flatMap((start) => periods.get(endpoint.id)?.get(start) ?? [])),
  );
}

/** Bars for a set of endpoints: every bucket shows their combined state. */
function bars(periods: Periods, endpoints: readonly Endpoint[], start: number, count: number, size: number): Bucket[] {
  return spans(start, start + count * size, count).map((span) => ({
    ...span,
    state: aggregate(endpoints.map((endpoint) => probeState(periods.get(endpoint.id)?.get(span.start)))),
  }));
}

/** Every component's enabled endpoints, in catalog order. */
function endpointsByComponent(endpoints: readonly Endpoint[]): Map<string, Endpoint[]> {
  const byComponent = new Map<string, Endpoint[]>();
  for (const endpoint of endpoints) {
    byComponent.set(endpoint.componentId, [...(byComponent.get(endpoint.componentId) ?? []), endpoint]);
  }
  return byComponent;
}

const startsOf = (start: number, count: number, size: number): number[] =>
  Array.from({ length: count }, (_, index) => start + index * size);

export function overview(snapshot: Snapshot, now: number): Overview {
  const dayStart = platformStart(now);
  const hourStart = hourlyStart(now);
  const hourStarts = startsOf(hourStart, SERVICE_HOURS, HOUR);
  const dayStarts = startsOf(dayStart, PLATFORM_DAYS, DAY);
  const hours = byEndpoint(snapshot.hours);
  const days = byEndpoint(snapshot.days);
  const latest = new Map(snapshot.latest.map((sample): [string, LatestSample] => [sample.endpointId, sample]));
  const components = new Map(snapshot.components.map((component) => [component.id, component]));
  const status = (endpoint: Endpoint) => endpointStatus(latest.get(endpoint.id), now);
  const endpointsOf = endpointsByComponent(snapshot.endpoints);

  const componentList = snapshot.components.map((component): ComponentOverview => {
    const endpoints = component.lifecycle === "planned" ? [] : (endpointsOf.get(component.id) ?? []);
    return {
      ...component,
      status: aggregate(endpoints.map(status)),
      hours: bars(hours, endpoints, hourStart, SERVICE_HOURS, HOUR),
      uptime24h: probeUptime(total(hours, endpoints, hourStarts)),
      uptime30d: probeUptime(total(days, endpoints, dayStarts)),
    };
  });
  const active = componentList.filter((component) => component.lifecycle === "active");
  const measured = active.flatMap((component) => endpointsOf.get(component.id) ?? []);
  const windows = incidentWindows(snapshot.incidents, now);

  const regions = snapshot.regions.map((region): RegionOverview => {
    const clusters = measured
      .filter((endpoint) => endpoint.regionCode === region.code)
      .map((endpoint): ClusterOverview => {
        const day = total(hours, [endpoint], hourStarts);
        const sample = latest.get(endpoint.id);
        return {
          id: endpoint.id,
          componentId: endpoint.componentId,
          componentName: components.get(endpoint.componentId)?.name ?? endpoint.componentId,
          cluster: endpoint.cluster,
          provider: endpoint.provider,
          status: status(endpoint),
          pingMs: status(endpoint) === "none" ? null : (sample?.latencyMs ?? null),
          meanLatency24h: meanLatency(day),
          uptime24h: probeUptime(day),
          hours: bars(hours, [endpoint], hourStart, SERVICE_HOURS, HOUR),
        };
      });
    const pings = clusters.flatMap((entry) => (entry.pingMs === null ? [] : [entry.pingMs]));
    return {
      ...region,
      status: aggregate(clusters.map((entry) => entry.status)),
      pingMs: pings.length === 0 ? null : Math.round(pings.reduce((sum, ping) => sum + ping, 0) / pings.length),
      clusters,
    };
  });

  const platformDays = dayStarts.map((start) => {
    const end = start + DAY;
    const states = active.map((component) =>
      aggregate((endpointsOf.get(component.id) ?? []).map((endpoint) => probeState(days.get(endpoint.id)?.get(start)))),
    );
    return { start, end, state: worst(aggregate(states), worstDuring(windows, start, end)) };
  });

  const rounds = snapshot.latest.map((sample) => Date.parse(sample.at));
  const lastRoundAt = rounds.length === 0 ? null : Math.max(...rounds);
  const resolvedFrom = now - RESOLVED_DAYS * DAY;
  return {
    generatedAt: now,
    status: overallStatus(
      active.map((component) => component.status),
      snapshot.incidents,
    ),
    monitoring: {
      lastRoundAt,
      delayed: measured.length > 0 && (lastRoundAt === null || now - lastRoundAt > PROBE_STALE_MS),
    },
    groups: snapshot.groups
      .map((group) => ({ ...group, components: componentList.filter((component) => component.groupId === group.id) }))
      .filter((group) => group.components.length > 0),
    regions,
    activeIncidents: snapshot.incidents.filter(isActive),
    resolvedIncidents: snapshot.incidents.filter(
      (incident) => !isActive(incident) && Date.parse(incident.resolvedAt ?? incident.updatedAt) >= resolvedFrom,
    ),
    days: platformDays,
    uptime30d: probeUptime(total(days, measured, dayStarts)),
  };
}
