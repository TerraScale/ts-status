/* D1 reads. Each page costs one batched round trip on a session that may be
   served by the nearest read replica. Timestamps are stored as SQLite
   datetime text ("YYYY-MM-DD HH:MM:SS", UTC) and returned as ISO 8601. */

import type { Endpoint, Incident, ProbeHour, Region, Service, StatusEvent } from "./status";

export interface Env {
  STATUS_DB: D1Database;
}

export interface Snapshot {
  services: Service[];
  incidents: Incident[];
  events: StatusEvent[];
  regions: Region[];
  endpoints: Endpoint[];
  probeHours: ProbeHour[];
}

const iso = (column: string) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${column})`;

const INCIDENT_COLUMNS = `id, kind, title, status, impact, message,
  ${iso("created_at")} AS createdAt, ${iso("updated_at")} AS updatedAt, ${iso("resolved_at")} AS resolvedAt`;

const SERVICES = `SELECT id, name, description, status, ${iso("updated_at")} AS updatedAt FROM services ORDER BY rowid`;

// Active incidents plus those resolved since the cutoff.
const CURRENT_INCIDENTS = `SELECT ${INCIDENT_COLUMNS} FROM incidents
  WHERE status != 'resolved' OR resolved_at >= ?1 ORDER BY created_at DESC LIMIT 20`;

// Events since the cutoff, plus the last event of every timeline before it so
// the window opens in the state that was already in effect.
const EVENTS = `SELECT serviceId, status, label, ${iso("created_at")} AS createdAt FROM (
    SELECT service_id AS serviceId, status, label, created_at FROM status_events WHERE created_at >= ?1
    UNION ALL
    SELECT serviceId, status, label, created_at FROM (
      SELECT service_id AS serviceId, status, label, created_at,
        row_number() OVER (PARTITION BY service_id ORDER BY created_at DESC) AS position
      FROM status_events WHERE created_at < ?1
    ) WHERE position = 1
  ) ORDER BY created_at`;

const REGIONS = `SELECT code, name, country, map_x AS mapX, map_y AS mapY FROM regions ORDER BY position, code`;

const ENDPOINTS = `SELECT id, region_code AS regionCode, service_id AS serviceId, cluster, provider,
  ${iso("last_checked_at")} AS lastCheckedAt, last_ok AS lastOk, last_latency_ms AS lastLatencyMs,
  consecutive_failures AS consecutiveFailures
  FROM endpoints WHERE enabled = 1 ORDER BY region_code, position, id`;

const PROBE_HOURS = `SELECT endpoint_id AS endpointId, ${iso("hour")} AS hour, checks, failures, latency_sum AS latencySum
  FROM probe_hours WHERE hour >= ?1`;

const HISTORY = `SELECT ${INCIDENT_COLUMNS} FROM incidents ORDER BY created_at DESC LIMIT 100`;

/** SQLite datetime text for a moment, matching the stored format. */
export function sqlTime(at: number): string {
  return new Date(at).toISOString().slice(0, 19).replace("T", " ");
}

function session(env: Env): D1DatabaseSession {
  return env.STATUS_DB.withSession("first-unconstrained");
}

export interface SnapshotWindow {
  /** Status events from here on, plus the state in effect at this moment. */
  eventsFrom: number;
  /** Resolved incidents from here on, alongside every active one. */
  resolvedFrom: number;
  /** Hourly probe rollups from here on. */
  probesFrom: number;
}

/** Everything the status page and API show, in one batched round trip. */
export async function loadSnapshot(env: Env, window: SnapshotWindow): Promise<Snapshot> {
  const db = session(env);
  const [services, incidents, events, regions, endpoints, probeHours] = await db.batch([
    db.prepare(SERVICES),
    db.prepare(CURRENT_INCIDENTS).bind(sqlTime(window.resolvedFrom)),
    db.prepare(EVENTS).bind(sqlTime(window.eventsFrom)),
    db.prepare(REGIONS),
    db.prepare(ENDPOINTS),
    db.prepare(PROBE_HOURS).bind(sqlTime(window.probesFrom)),
  ]);
  return {
    services: (services?.results ?? []) as Service[],
    incidents: (incidents?.results ?? []) as Incident[],
    events: (events?.results ?? []) as StatusEvent[],
    regions: (regions?.results ?? []) as Region[],
    endpoints: (endpoints?.results ?? []) as Endpoint[],
    probeHours: (probeHours?.results ?? []) as ProbeHour[],
  };
}

/** The latest 100 incidents and warnings, newest first. */
export async function loadHistory(env: Env): Promise<Incident[]> {
  const { results } = await session(env).prepare(HISTORY).all<Incident>();
  return results ?? [];
}
