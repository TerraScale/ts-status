/* Markup helpers mirroring the ts-dashboard component kit (ui.Card, ui.Stat,
   ui.StatusBadge, ui.Empty) plus the status bars. */

import { DEFAULT_RANGE, RANGE_KEYS, RANGES, type RangeKey } from "../domain/range";
import { html, raw, type Html } from "../html";
import type { ClusterOverview } from "../overview";
import { sparkline } from "./charts/sparkline";
import { percentile } from "../domain/histogram";
import {
  IMPACT_STATUS,
  maintenancePhase,
  probeUptime,
  STATE_LABELS,
  type Bucket,
  type Incident,
  type MaintenancePhase,
  type ProbeCounts,
  type TimelineState,
} from "../domain/status";
import {
  DAY,
  formatClock,
  formatClockSeconds,
  formatDateTime,
  formatDay,
  formatDuration,
  formatUptime,
} from "../format";

export interface CardProps {
  id: string;
  title: string;
  description?: string | Html;
  actions?: Html;
}

export function card(props: CardProps, body: Html): Html {
  return html`<section class="ts-card" id="${props.id}" aria-labelledby="${props.id}-title">
  <header class="ts-card-head">
    <div class="ts-card-heading">
      <h2 class="ts-card-title" id="${props.id}-title">${props.title}</h2>
      ${props.description ? html`<p class="ts-card-description">${props.description}</p>` : ""}
    </div>
    ${props.actions ?? ""}
  </header>
  ${body}
</section>`;
}

export function stat(label: string, value: string, detail?: string): Html {
  return html`<div class="ts-stat">
  <dt class="ts-stat-label">${label}</dt>
  <dd class="ts-stat-value">${value}</dd>
  ${detail ? html`<dd class="ts-stat-detail">${detail}</dd>` : ""}
</div>`;
}

export function statusBadge(state: TimelineState, text: string = STATE_LABELS[state]): Html {
  return html`<span class="ts-badge" data-state="${state}"><span class="ts-dot" aria-hidden="true"></span>${text}</span>`;
}

export function badge(text: string, state?: TimelineState): Html {
  return state
    ? html`<span class="ts-badge" data-state="${state}">${text}</span>`
    : html`<span class="ts-badge">${text}</span>`;
}

export function empty(title: string, detail: string): Html {
  return html`<div class="ts-empty" role="status">
  <p class="ts-empty-title">${title}</p>
  <p class="ts-empty-detail">${detail}</p>
</div>`;
}

/** A time rendered in UTC; the client script re-renders it in the visitor's
    time zone. */
export function time(at: string | number, format: "datetime" | "seconds"): Html {
  const iso = new Date(at).toISOString().replace(".000Z", "Z");
  const text = format === "datetime" ? formatDateTime(at) : formatClockSeconds(Number(new Date(at)));
  return html`<time datetime="${iso}" data-format="${format}">${text}</time>`;
}

/** The time zone times are shown in; the client script names the visitor's. */
export const zone = html`<span data-zone>UTC</span>`;

/** A latency in milliseconds, or a dash. */
export const ms = (value: number | null): string => (value === null ? "—" : `${value} ms`);

/** What a hover card shows below its time and state. */
export interface CardContent {
  rows?: [string, string][];
  notes?: string[];
}

/** The rows describing a stretch of probes. */
export function probeRows(counts: ProbeCounts | undefined): [string, string][] {
  if (!counts || counts.checks === 0) return [["Checks", "None in this period"]];
  return [
    ["Uptime", formatUptime(probeUptime(counts))],
    ["Checks", `${(counts.checks - counts.failures).toLocaleString("en")} of ${counts.checks.toLocaleString("en")} up`],
    ["Median", ms(percentile(counts.hist, 0.5))],
    ["p95", ms(percentile(counts.hist, 0.95))],
  ];
}

export interface BarsOptions<T extends Bucket> {
  /** Summarizes the strip for assistive tech. */
  label: string;
  large?: boolean;
  card?: (bucket: T) => CardContent;
}

/** When a bar's time span was, in UTC; the client script re-renders spans
    shorter than a day in the visitor's time zone. */
function when(bucket: Bucket): string {
  if (bucket.end - bucket.start >= DAY) return formatDay(bucket.start);
  return `${formatDay(bucket.start)}, ${formatClock(bucket.start)}–${formatClock(bucket.end)} UTC`;
}

/** Status bars: one cell per bucket, colored by its worst state. The strip
    is one focusable image; arrow keys move between cells, and every cell
    opens a hover card with its details. */
export function bars<T extends Bucket>(list: readonly T[], options: BarsOptions<T>): Html {
  const cells = list.map((bucket) => {
    const state = STATE_LABELS[bucket.state];
    const span = bucket.end - bucket.start >= DAY ? "day" : "hour";
    const card = JSON.stringify(options.card?.(bucket) ?? { rows: probeRows(bucket.counts) });
    return html`<li data-state="${bucket.state}" data-from="${bucket.start}" data-to="${bucket.end}" data-span="${span}" data-label="${state}" data-when="${when(bucket)}" data-tip="${when(bucket)} · ${state}" data-card="${card}"></li>`;
  });
  return html`<ol class="st-bars${options.large ? " st-bars-lg" : ""}" role="img" tabindex="0" data-strip aria-label="${options.label}">${cells}</ol>`;
}

export function legend(states: readonly TimelineState[]): Html {
  return html`<ul class="st-legend" aria-label="Legend">${states.map(
    (state) =>
      html`<li data-state="${state}"><span class="ts-dot" aria-hidden="true"></span>${STATE_LABELS[state]}</li>`,
  )}</ul>`;
}

export const STATUS_TEXT: Record<Incident["status"], string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
};

const PHASE_STATE: Record<MaintenancePhase, TimelineState> = {
  scheduled: "maintenance",
  in_progress: "maintenance",
  completed: "operational",
};

/** An incident's status text and the state coloring its badge. */
export function incidentBadge(incident: Incident, now: number): Html {
  if (incident.kind === "maintenance") {
    const phase = maintenancePhase(incident, now);
    return badge(STATUS_TEXT[phase], PHASE_STATE[phase]);
  }
  return badge(
    STATUS_TEXT[incident.status],
    incident.status === "resolved" ? "operational" : IMPACT_STATUS[incident.impact],
  );
}

/** The labels beside an incident's title. */
function labels(incident: Incident, now: number): Html {
  return html`${incident.kind === "warning" ? badge("Warning") : ""}${incident.kind === "maintenance" ? badge("Maintenance") : ""}${
    incident.source === "auto"
      ? html`<span class="ts-badge" title="Opened by automated health checks">Auto-detected</span>`
      : ""
  }${incidentBadge(incident, now)}`;
}

/** When an incident started and, once resolved, how long it lasted; for
    maintenance, its window. */
export function timing(incident: Incident): Html {
  if (incident.kind === "maintenance" && incident.scheduledStart && incident.scheduledEnd) {
    return html`Scheduled ${time(incident.scheduledStart, "datetime")} to ${time(incident.scheduledEnd, "datetime")}`;
  }
  const started = html`Started ${time(incident.createdAt, "datetime")}`;
  if (!incident.resolvedAt) return html`${started} · updated ${time(incident.updatedAt, "datetime")}`;
  const lasted = formatDuration(Date.parse(incident.resolvedAt) - Date.parse(incident.createdAt));
  return html`${started} · resolved after ${lasted}`;
}

/** An incident's page. */
export const incidentHref = (id: string): string => `/incidents/${encodeURIComponent(id)}`;

/** The names of the components an incident affects, or the platform. */
export function affected(incident: Incident, names: ReadonlyMap<string, string>): string {
  if (incident.components.length === 0) return "All components";
  return incident.components.map((id) => names.get(id) ?? id).join(", ");
}

/** An active incident as an alert, colored by its impact. */
export function incidentAlert(incident: Incident, now: number, names: ReadonlyMap<string, string>): Html {
  const state = incident.kind === "maintenance" ? "maintenance" : IMPACT_STATUS[incident.impact];
  return html`<article class="ts-alert" data-state="${state}">
  <div class="ts-row-between">
    <h3 class="ts-alert-title"><a class="st-incident-link" href="${incidentHref(incident.id)}">${incident.kind === "warning" ? "Warning: " : ""}${incident.title}</a></h3>
    <div class="ts-row">${labels(incident, now)}</div>
  </div>
  <p class="ts-alert-body">${incident.message}</p>
  <p class="ts-meta">${affected(incident, names)} · ${timing(incident)}</p>
</article>`;
}

/** An incident as a divided list row; `extra` follows its timing. */
export function incidentItem(incident: Incident, now: number, names: ReadonlyMap<string, string>, extra?: Html): Html {
  return html`<li class="ts-list-item">
  <article class="ts-list-main">
    <div class="ts-row">
      <h3 class="st-incident-title"><a class="st-incident-link" href="${incidentHref(incident.id)}">${incident.title}</a></h3>
      ${labels(incident, now)}
    </div>
    <p class="st-incident-body">${incident.message}</p>
    <p class="ts-meta">${affected(incident, names)} · ${timing(incident)}${extra ? html` · ${extra}` : ""}</p>
  </article>
</li>`;
}

const rangeHref = (base: string, range: RangeKey): string =>
  range === DEFAULT_RANGE ? base : `${base}?range=${range}`;

/** Links switching a page's time range; pages render without scripts. */
export function rangeSwitch(current: RangeKey, base: string): Html {
  return html`<nav class="st-range" aria-label="Time range">${RANGE_KEYS.map(
    (range) =>
      html`<a href="${rangeHref(base, range)}"${range === current ? raw(' aria-current="true"') : ""}>${RANGES[range].short}</a>`,
  )}</nav>`;
}

export const PROVIDERS: Record<ClusterOverview["provider"], string> = {
  fly: "Fly.io",
  oci: "Oracle Cloud",
  cloudflare: "Cloudflare",
  other: "Self-hosted",
};

/** One cluster: its component, where it runs, pings, state and bars. */
export function clusterRow(
  entry: ClusterOverview,
  range: RangeKey,
  title: "component" | "cluster" = "component",
): Html {
  const summary = `${entry.componentName} on ${entry.cluster}: ${formatUptime(entry.uptime)} of checks up over the last ${RANGES[range].label}, currently ${STATE_LABELS[entry.status].toLowerCase()}`;
  const where = `${PROVIDERS[entry.provider]} · ${entry.cluster}${entry.regionCode ? ` · ${entry.regionCode}` : " · global"}`;
  return html`<li class="ts-list-item st-service">
  <div class="ts-list-main">
    <h4 class="ts-strong">${title === "component" ? html`<a class="st-incident-link" href="/components/${entry.componentId}">${entry.componentName}</a>` : entry.cluster}</h4>
    <p class="ts-meta">${where}</p>
  </div>
  <div class="st-service-state">
    ${sparkline(entry.latency)}
    <span class="ts-meta ts-num" title="Latest ping · mean over the range">${ms(entry.pingMs)} · ${ms(entry.meanLatency)}</span>
    ${statusBadge(entry.status)}
  </div>
  ${bars(entry.bars, { label: summary })}
</li>`;
}
