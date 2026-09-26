/* Markup helpers mirroring the ts-dashboard component kit (ui.Card, ui.Stat,
   ui.StatusBadge, ui.Empty) plus the status bars. */

import { html, type Html } from "../html";
import { formatClock, formatClockSeconds, formatDateTime, formatDay, formatDuration } from "../format";
import { IMPACT_STATUS, STATE_LABELS, type Bucket, type Incident, type TimelineState } from "../status";

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

function strip(label: string, large: boolean, cells: Html[]): Html {
  return html`<ol class="st-bars${large ? " st-bars-lg" : ""}" role="img" aria-label="${label}">${cells}</ol>`;
}

/** Hourly status bars; each carries its hour so the tooltip can follow the
    visitor's time zone. `label` summarizes the strip for assistive tech. */
export function hourBars(list: readonly Bucket[], label: string): Html {
  return strip(
    label,
    false,
    list.map((bucket) => {
      const state = STATE_LABELS[bucket.state];
      const tip = `${formatClock(bucket.start)}–${formatClock(bucket.end)} UTC · ${state}`;
      return html`<li data-state="${bucket.state}" data-from="${bucket.start}" data-to="${bucket.end}" data-label="${state}" data-tip="${tip}"></li>`;
    }),
  );
}

/** Daily status bars over UTC days. */
export function dayBars(list: readonly Bucket[], label: string): Html {
  return strip(
    label,
    true,
    list.map(
      (bucket) =>
        html`<li data-state="${bucket.state}" data-tip="${formatDay(bucket.start)} · ${STATE_LABELS[bucket.state]}"></li>`,
    ),
  );
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
