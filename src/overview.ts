/* The status overview shared by the page and the JSON API: the headline,
   hourly bars per service, and daily platform bars with uptime. */

import type { Snapshot, SnapshotWindow } from "./data";
import { DAY, HOUR, startOfDay, startOfHour } from "./format";
import {
  buckets,
  combine,
  endpointStatus,
  isActive,
  meanLatency,
  overallStatus,
  platformChanges,
  probeHourState,
  probeUptime,
  regionStatus,
  segments,
  serviceChanges,
  uptime,
  type Bucket,
  type Endpoint,
  type Incident,
  type ProbeHour,
  type Provider,
  type Region,
  type Service,
  type ServiceStatus,
  type TimelineState,
} from "./status";

export const SERVICE_HOURS = 24;
export const PLATFORM_DAYS = 30;
export const RESOLVED_DAYS = 7;

export interface ServiceOverview extends Service {
  hours: Bucket[];
  uptime24h: number | null;
  uptime30d: number | null;
}

export interface ClusterOverview {
  id: string;
  serviceId: string;
  serviceName: string;
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
  status: ServiceStatus;
  services: ServiceOverview[];
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
  return { eventsFrom: platformStart(now), resolvedFrom: now - RESOLVED_DAYS * DAY, probesFrom: hourlyStart(now) };
}

function cluster(
  endpoint: Endpoint,
  service: Service | undefined,
  hours: ProbeHour[],
  hourStart: number,
  now: number,
): ClusterOverview {
  const byHour = new Map(hours.map((hour) => [Date.parse(hour.hour), hour]));
  return {
    id: endpoint.id,
    serviceId: endpoint.serviceId,
    serviceName: service?.name ?? endpoint.serviceId,
    cluster: endpoint.cluster,
    provider: endpoint.provider,
    status: endpointStatus(endpoint, now),
    pingMs: endpoint.lastOk === 1 ? endpoint.lastLatencyMs : null,
    meanLatency24h: meanLatency(hours),
    uptime24h: probeUptime(hours),
    hours: Array.from({ length: SERVICE_HOURS }, (_, index) => {
      const start = hourStart + index * HOUR;
      return { start, end: start + HOUR, state: probeHourState(byHour.get(start)) };
    }),
  };
}

function regions(snapshot: Snapshot, hourStart: number, now: number): RegionOverview[] {
  const services = new Map(snapshot.services.map((service) => [service.id, service]));
  return snapshot.regions.map((region) => {
    const clusters = snapshot.endpoints
      .filter((endpoint) => endpoint.regionCode === region.code)
      .map((endpoint) =>
        cluster(
          endpoint,
          services.get(endpoint.serviceId),
          snapshot.probeHours.filter((hour) => hour.endpointId === endpoint.id),
          hourStart,
          now,
        ),
      );
    const pings = clusters.flatMap((entry) => (entry.pingMs === null ? [] : [entry.pingMs]));
    return {
      ...region,
      status: regionStatus(clusters.map((entry) => entry.status)),
      pingMs: pings.length === 0 ? null : Math.round(pings.reduce((sum, ping) => sum + ping, 0) / pings.length),
      clusters,
    };
  });
}

export function overview(snapshot: Snapshot, now: number): Overview {
  const dayStart = platformStart(now);
  const hourStart = hourlyStart(now);
  const regionList = regions(snapshot, hourStart, now);

  const services = snapshot.services.map((service) => {
    const changes = serviceChanges(service, snapshot.events);
    return { service, month: segments(changes, dayStart, now), day: segments(changes, hourStart, now) };
  });
  const platform = combine(
    [...services.map((entry) => entry.month), segments(platformChanges(snapshot.events), dayStart, now)],
    dayStart,
    now,
  );

  return {
    generatedAt: now,
    // One region down is a partial platform outage; only all of them is major.
    status: overallStatus(snapshot.services, snapshot.incidents, [
      regionStatus(regionList.map((region) => region.status)),
    ]),
    services: services.map(({ service, month, day }) => ({
      ...service,
      hours: buckets(day, hourStart, hourStart + SERVICE_HOURS * HOUR, SERVICE_HOURS),
      uptime24h: uptime(day),
      uptime30d: uptime(month),
    })),
    regions: regionList,
    activeIncidents: snapshot.incidents.filter(isActive),
    resolvedIncidents: snapshot.incidents.filter((incident) => !isActive(incident)),
    days: buckets(platform, dayStart, dayStart + PLATFORM_DAYS * DAY, PLATFORM_DAYS),
    uptime30d: uptime(platform),
  };
}
