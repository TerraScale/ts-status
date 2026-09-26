/* Markup helpers mirroring the ts-dashboard component kit (ui.Card, ui.Stat,
   ui.StatusBadge, ui.Empty) plus the status bars. */

import { html, type Html } from "../html";
import { percentile } from "../domain/histogram";
import {
  IMPACT_STATUS,
  probeUptime,
  STATE_LABELS,
  type Bucket,
  type Incident,
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

export interface BarsOptions {
  /** Summarizes the strip for assistive tech. */
  label: string;
  large?: boolean;
  card?: (bucket: Bucket) => CardContent;
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
export function bars(list: readonly Bucket[], options: BarsOptions): Html {
  const cells = list.map((bucket) => {
    const state = STATE_LABELS[bucket.state];
    const span = bucket.end - bucket.start >= DAY ? "day" : "hour";
    const card = JSON.stringify(options.card?.(bucket) ?? { rows: probeRows(bucket.counts) });
    return html`<li data-state="${bucket.state}" data-from="${bucket.start}" data-to="${bucket.end}" data-span="${span}" data-label="${state}" data-when="${when(bucket)}" data-tip="${when(bucket)} · ${state}" data-card="${card}"></li>`;
  });
  return html`<ol class="st-bars${options.large ? " st-bars-lg" : ""}" role="img" tabindex="0" aria-label="${options.label}">${cells}</ol>`;
}

export function legend(states: readonly TimelineState[]): Html {
  return html`<ul class="st-legend" aria-label="Legend">${states.map(
    (state) =>
      html`<li data-state="${state}"><span class="ts-dot" aria-hidden="true"></span>${STATE_LABELS[state]}</li>`,
  )}</ul>`;
}

const STATUS_TEXT: Record<Incident["status"], string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

/** When an incident started and, once resolved, how long it lasted. */
function timing(incident: Incident): Html {
  const started = html`Started ${time(incident.createdAt, "datetime")}`;
  if (!incident.resolvedAt) return html`${started} · updated ${time(incident.updatedAt, "datetime")}`;
  const lasted = formatDuration(Date.parse(incident.resolvedAt) - Date.parse(incident.createdAt));
  return html`${started} · resolved after ${lasted}`;
}

/** An active incident as an alert, colored by its impact. */
export function incidentAlert(incident: Incident): Html {
  return html`<article class="ts-alert" data-state="${IMPACT_STATUS[incident.impact]}">
  <div class="ts-row-between">
    <h3 class="ts-alert-title">${incident.kind === "warning" ? "Warning: " : ""}${incident.title}</h3>
    ${badge(STATUS_TEXT[incident.status], IMPACT_STATUS[incident.impact])}
  </div>
  <p class="ts-alert-body">${incident.message}</p>
  <p class="ts-meta">${timing(incident)}</p>
</article>`;
}

/** An incident as a divided list row. */
export function incidentItem(incident: Incident): Html {
  const resolved = incident.status === "resolved";
  return html`<li class="ts-list-item">
  <article class="ts-list-main">
    <div class="ts-row">
      <h3 class="st-incident-title">${incident.title}</h3>
      ${incident.kind === "warning" ? badge("Warning") : ""}
      ${badge(STATUS_TEXT[incident.status], resolved ? "operational" : IMPACT_STATUS[incident.impact])}
    </div>
    <p class="st-incident-body">${incident.message}</p>
    <p class="ts-meta">${timing(incident)}</p>
  </article>
</li>`;
}
