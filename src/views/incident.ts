/* One incident: what happened, what it affected and for how long, the
   state and latency of the affected endpoints around it, and its timeline
   of updates, newest first. */

import type { IncidentDetail } from "../db/reads";
import {
  aggregate,
  IMPACT_STATUS,
  spans,
  STATE_LABELS,
  stateAttr,
  worst,
  type Bucket,
  type TimelineState,
} from "../domain/status";
import { formatClock, formatDay, formatDuration } from "../format";
import { html, type Html } from "../html";
import { chartLegend, lineChart } from "./charts/line";
import {
  affected,
  bars,
  badge,
  card,
  empty,
  incidentBadge,
  STATUS_TEXT,
  statusState,
  time,
  timing,
  zone,
} from "./components";
import type { Page } from "./layout";

const KINDS = { incident: "Incident", warning: "Warning", maintenance: "Maintenance" } as const;

/** Buckets across the window for the state strip. */
const STRIP_BUCKETS = 48;

/** Chart points: every round, or every hour, across the window. */
function grid(detail: IncidentDetail): number[] {
  const step = detail.resolution === "round" ? 30_000 : 3_600_000;
  const first = detail.window.from - (detail.window.from % step);
  return Array.from(
    { length: Math.max(1, Math.ceil((detail.window.to - first) / step)) },
    (_, index) => first + index * step,
  );
}

function latency(detail: IncidentDetail, names: ReadonlyMap<string, string>): Html {
  const points = grid(detail);
  const series = detail.endpoints
    .map((endpoint) => {
      const values = new Map(
        detail.series
          .filter((point) => point.endpointId === endpoint.id)
          .map((point) => [Date.parse(point.start), point.latencyMs] as const),
      );
      return {
        name: `${names.get(endpoint.componentId) ?? endpoint.componentId} · ${endpoint.cluster}`,
        values: points.map((at) => values.get(at) ?? null),
      };
    })
    .filter((entry) => entry.values.some((value) => value !== null))
    .slice(0, 5);
  if (series.length === 0) return empty("No measurements", "No health check results cover this incident's window.");
  const name = (at: number) => `${formatDay(at)} ${formatClock(at)} UTC`;
  const ticks = [0, 1, 2, 3, 4].map((step) => formatClock(points[Math.round((step * (points.length - 1)) / 4)] ?? 0));
  return html`${lineChart(
    {
      label: "Latency of the affected endpoints",
      ticks,
      points: points.map(name),
      format: (value) => `${Math.round(value)} ms`,
    },
    series,
  )}${series.length > 1 ? chartLegend(series.map((entry) => entry.name)) : ""}`;
}

/** The affected endpoints' combined state across the window. */
function strip(detail: IncidentDetail): Html {
  const list: Bucket[] = spans(detail.window.from, detail.window.to, STRIP_BUCKETS).map((span) => {
    const inside = detail.series.filter((point) => {
      const at = Date.parse(point.start);
      return at >= span.start && at < span.end;
    });
    const byEndpoint = detail.endpoints.map((endpoint) =>
      inside
        .filter((point) => point.endpointId === endpoint.id)
        .reduce<TimelineState>((acc, point) => worst(acc, point.state), "none"),
    );
    return { ...span, state: aggregate(byEndpoint) };
  });
  return html`${bars(list, {
    label: "State of the affected endpoints during the incident",
    card: (bucket) => ({ rows: [["State", STATE_LABELS[bucket.state]]] }),
  })}
  <div class="st-axis" aria-hidden="true"><span>30 minutes before</span><span>${detail.incident.resolvedAt ? "30 minutes after" : "Now"}</span></div>`;
}

export function incidentPage(detail: IncidentDetail, now: number): Page {
  const { incident } = detail;
  const names = new Map(detail.components.map((component) => [component.id, component.name]));
  const start = Date.parse(incident.scheduledStart ?? incident.createdAt);
  const end = incident.resolvedAt ? Date.parse(incident.resolvedAt) : now;

  const body = html`<main id="main" class="ts-page"${incident.resolvedAt ? "" : html` data-live data-title="${incident.title} · TerraScale Status"`}>
  <header class="st-page-head">
    <p class="ts-eyebrow"><a class="ts-link" href="/history">Incident history</a> · ${KINDS[incident.kind]}${incident.source === "auto" ? " · Auto-detected" : ""}</p>
    <div class="ts-row">
      <h1 class="st-title">${incident.title}</h1>
      ${incidentBadge(incident, now)}
    </div>
    <p class="ts-meta">${affected(incident, names)} · ${timing(incident)}</p>
  </header>

  <dl class="ts-stats" aria-label="Incident summary">
    <div class="ts-stat"><dt class="ts-stat-label" data-state="${stateAttr(IMPACT_STATUS[incident.impact])}"><span class="ts-dot" aria-hidden="true"></span>Impact</dt><dd class="ts-stat-value st-stat-text">${incident.impact === "none" ? "None" : incident.impact[0]?.toUpperCase() + incident.impact.slice(1)}</dd></div>
    <div class="ts-stat"><dt class="ts-stat-label">${incident.resolvedAt ? "Lasted" : "Ongoing for"}</dt><dd class="ts-stat-value">${formatDuration(Math.max(0, end - start))}</dd></div>
    <div class="ts-stat"><dt class="ts-stat-label">Updates</dt><dd class="ts-stat-value">${detail.updates.length}</dd></div>
  </dl>

  ${card(
    {
      id: "measured",
      title: "What the health checks saw",
      description: html`State and ${detail.resolution === "round" ? "per-round" : "hourly median"} latency of the affected endpoints, in ${zone}.`,
    },
    html`${strip(detail)}${latency(detail, names)}`,
  )}

  ${card(
    { id: "updates", title: "Updates", description: "Newest first." },
    detail.updates.length === 0
      ? empty("No updates", "This incident has no updates yet.")
      : html`<ol class="st-timeline">${detail.updates.map(
          (update) => html`<li class="st-timeline-item" data-state="${stateAttr(statusState(incident, update.status))}">
    <div class="ts-row">${badge(STATUS_TEXT[update.status] ?? update.status, statusState(incident, update.status))}${time(update.createdAt, "datetime")}</div>
    <p class="st-incident-body">${update.body}</p>
  </li>`,
        )}</ol>`,
  )}
</main>`;

  return {
    title: `${incident.title} · TerraScale Status`,
    description: `${KINDS[incident.kind]}: ${incident.title}`,
    path: null,
    body,
    live: !incident.resolvedAt,
  };
}
