/* D1 reads. Each page costs one batched round trip on a session that may be
   served by the nearest read replica. Timestamps are stored as SQLite
   datetime text ("YYYY-MM-DD HH:MM:SS", UTC) and returned as ISO 8601. */

import type { Env } from "../env";
import type {
  Component,
  ComponentGroup,
  Endpoint,
  Incident,
  LatestSample,
  ProbePeriod,
  Region,
} from "../domain/status";

export interface Snapshot {
  groups: ComponentGroup[];
  components: Component[];
  incidents: Incident[];
  regions: Region[];
  endpoints: Endpoint[];
  latest: LatestSample[];
  /** Consensus counts per endpoint and hour, then per endpoint and day. */
  hours: ProbePeriod[];
  days: ProbePeriod[];
}

const iso = (column: string) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${column})`;

const INCIDENT_COLUMNS = `id, kind, title, status, impact, message,
  ${iso("created_at")} AS createdAt, ${iso("updated_at")} AS updatedAt, ${iso("resolved_at")} AS resolvedAt`;

const GROUPS = `SELECT id, name FROM component_groups ORDER BY position, id`;

const COMPONENTS = `SELECT id, group_id AS groupId, name, description, lifecycle
  FROM components ORDER BY position, id`;

// Active incidents plus those resolved since the cutoff. Active ones rank
// first so the limit can only ever drop resolved history.
const CURRENT_INCIDENTS = `SELECT ${INCIDENT_COLUMNS} FROM incidents
  WHERE status != 'resolved' OR resolved_at >= ?1
  ORDER BY status != 'resolved' DESC, created_at DESC LIMIT 50`;

const REGIONS = `SELECT code, name, country, map_x AS mapX, map_y AS mapY FROM regions ORDER BY position, code`;

const ENDPOINTS = `SELECT id, component_id AS componentId, region_code AS regionCode, cluster, provider
  FROM endpoints WHERE enabled = 1 ORDER BY position, id`;

// Joined from the endpoints so every lookup is a primary key seek.
const LATEST = `SELECT s.endpoint_id AS endpointId, ${iso("s.at")} AS at, s.state, s.ok, s.total,
    s.latency_ms AS latencyMs
  FROM endpoints e JOIN probe_samples s ON s.endpoint_id = e.id
    AND s.at = (SELECT max(at) FROM probe_samples WHERE endpoint_id = e.id)
  WHERE e.enabled = 1`;

const periods = (table: "probe_hours" | "probe_days", column: "hour" | "day") =>
  `SELECT p.endpoint_id AS endpointId, ${iso(`p.${column}`)} AS start, p.checks, p.failures, p.degraded,
    p.latency_sum AS latencySum
  FROM endpoints e JOIN ${table} p ON p.endpoint_id = e.id AND p.${column} >= ?1 AND p.vantage = 'all'
  WHERE e.enabled = 1`;

const HISTORY = `SELECT ${INCIDENT_COLUMNS} FROM incidents ORDER BY created_at DESC LIMIT 100`;

/** SQLite datetime text for a moment, matching the stored format. */
export function sqlTime(at: number): string {
  return new Date(at).toISOString().slice(0, 19).replace("T", " ");
}

function session(env: Env): D1DatabaseSession {
  return env.STATUS_DB.withSession("first-unconstrained");
}

export interface SnapshotWindow {
  /** Incidents open at any time from here on. */
  incidentsFrom: number;
  /** Hourly probe rollups from here on. */
  hoursFrom: number;
  /** Daily probe rollups from here on. */
  daysFrom: number;
}

/** Everything the status page and API show, in one batched round trip. */
export async function loadSnapshot(env: Env, window: SnapshotWindow): Promise<Snapshot> {
  const db = session(env);
  const [groups, components, incidents, regions, endpoints, latest, hours, days] = await db.batch([
    db.prepare(GROUPS),
    db.prepare(COMPONENTS),
    db.prepare(CURRENT_INCIDENTS).bind(sqlTime(window.incidentsFrom)),
    db.prepare(REGIONS),
    db.prepare(ENDPOINTS),
    db.prepare(LATEST),
    db.prepare(periods("probe_hours", "hour")).bind(sqlTime(window.hoursFrom)),
    db.prepare(periods("probe_days", "day")).bind(sqlTime(window.daysFrom)),
  ]);
  return {
    groups: (groups?.results ?? []) as ComponentGroup[],
    components: (components?.results ?? []) as Component[],
    incidents: (incidents?.results ?? []) as Incident[],
    regions: (regions?.results ?? []) as Region[],
    endpoints: (endpoints?.results ?? []) as Endpoint[],
    latest: (latest?.results ?? []) as LatestSample[],
    hours: (hours?.results ?? []) as ProbePeriod[],
    days: (days?.results ?? []) as ProbePeriod[],
  };
}

/** The latest 100 incidents and warnings, newest first. */
export async function loadHistory(env: Env): Promise<Incident[]> {
  const { results } = await session(env).prepare(HISTORY).all<Incident>();
  return results ?? [];
}
