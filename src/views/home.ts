/* The status page: headline, stats, active incidents, components by group
   and regions with hourly bars, the 30-day platform history, and recently
   resolved incidents. */

import regionMap from "../assets/region-map.svg?raw";
import { formatDay, formatUptime } from "../format";
import { html, raw } from "../html";
import {
  PLATFORM_DAYS,
  RESOLVED_DAYS,
  SERVICE_HOURS,
  type ClusterOverview,
  type ComponentOverview,
  type GroupOverview,
  type Overview,
  type RegionOverview,
} from "../overview";
import { STATES, STATE_LABELS, type Status, type TimelineState } from "../domain/status";
import {
  card,
  dayBars,
  empty,
  hourBars,
  incidentAlert,
  incidentItem,
  legend,
  stat,
  statusBadge,
  time,
  zone,
} from "./components";
import type { Page } from "./layout";

const HEADLINES: Record<Status, string> = {
  operational: "All systems operational",
  maintenance: "Scheduled maintenance in progress",
  degraded: "Some systems are degraded",
  partial_outage: "Partial system outage",
  major_outage: "Major system outage",
};

const PROVIDERS: Record<ClusterOverview["provider"], string> = {
  fly: "Fly.io",
  oci: "Oracle Cloud",
  cloudflare: "Cloudflare",
  other: "Self-hosted",
};

const LEGEND: TimelineState[] = [...STATES, "none"];

const ms = (value: number | null): string => (value === null ? "—" : `${value} ms`);

const lower = (state: TimelineState): string => STATE_LABELS[state].toLowerCase();

function component(entry: ComponentOverview) {
  if (entry.lifecycle === "planned") {
    return html`<li class="ts-list-item st-service" data-lifecycle="planned">
  <div class="ts-list-main">
    <h4 class="ts-strong">${entry.name}</h4>
    <p class="ts-meta">${entry.description}</p>
  </div>
  <div class="st-service-state">${statusBadge("none", "Planned")}</div>
</li>`;
  }
  const summary = `${entry.name}: ${formatUptime(entry.uptime24h)} uptime over the last ${SERVICE_HOURS} hours, currently ${lower(entry.status)}`;
  return html`<li class="ts-list-item st-service">
  <div class="ts-list-main">
    <h4 class="ts-strong">${entry.name}</h4>
    <p class="ts-meta">${entry.description}</p>
  </div>
  <div class="st-service-state">
    <span class="ts-meta ts-num">${formatUptime(entry.uptime24h)}</span>
    ${statusBadge(entry.status)}
  </div>
  ${hourBars(entry.hours, summary)}
</li>`;
}

function group(entry: GroupOverview) {
  return html`<section class="st-group" aria-labelledby="group-${entry.id}">
  <h3 id="group-${entry.id}" class="st-group-title">${entry.name}</h3>
  <ul class="ts-list">${entry.components.map(component)}</ul>
</section>`;
}

function cluster(entry: ClusterOverview) {
  const summary = `${entry.componentName} on ${entry.cluster}: ${formatUptime(entry.uptime24h)} of health checks passed over the last ${SERVICE_HOURS} hours, currently ${lower(entry.status)}`;
  return html`<li class="ts-list-item st-service">
  <div class="ts-list-main">
    <h4 class="ts-strong">${entry.componentName}</h4>
    <p class="ts-meta">${PROVIDERS[entry.provider]} · ${entry.cluster}</p>
  </div>
  <div class="st-service-state">
    <span class="ts-meta ts-num" title="Latest ping · 24h mean">${ms(entry.pingMs)} · ${ms(entry.meanLatency24h)}</span>
    ${statusBadge(entry.status)}
  </div>
  ${hourBars(entry.hours, summary)}
</li>`;
}

function region(entry: RegionOverview) {
  const planned = entry.clusters.length === 0;
  return html`<section class="st-region" aria-labelledby="region-${entry.code}">
  <header class="ts-row-between">
    <div class="ts-row">
      <span class="st-region-code">${entry.code}</span>
      <h3 id="region-${entry.code}" class="ts-strong">${entry.name}</h3>
      <span class="ts-meta">${entry.country}</span>
    </div>
    <div class="ts-row">
      ${planned ? "" : html`<span class="ts-meta ts-num">Ping ${ms(entry.pingMs)}</span>`}
      ${statusBadge(entry.status, planned ? "Planned" : STATE_LABELS[entry.status])}
    </div>
  </header>
  ${planned ? html`<p class="ts-meta">No clusters serve this region yet.</p>` : html`<ul class="ts-list">${entry.clusters.map(cluster)}</ul>`}
</section>`;
}

/** The dotted world map with one hub per region, colored by its state. */
function map(list: readonly RegionOverview[]) {
  const label = `Region map: ${list.map((entry) => `${entry.name} ${entry.clusters.length === 0 ? "planned" : lower(entry.status)}`).join(", ")}`;
  const hubs = list.map(
    (entry) => html`<g class="st-hub" data-state="${entry.status}" transform="translate(${entry.mapX} ${entry.mapY})">
    <circle class="st-hub-ring" r="2.4"></circle><circle r="1.1"></circle>
    <text x="3" y="1.1">${entry.code}</text>
  </g>`,
  );
  const dots = regionMap.replace(/^<svg[^>]*>|<\/svg>\s*$/g, "");
  return html`<svg class="st-map" viewBox="0 0 136 80" role="img" aria-label="${label}">${raw(dots)}${hubs}</svg>`;
}

export function homePage(view: Overview): Page {
  const active = view.groups.flatMap((entry) => entry.components).filter((entry) => entry.lifecycle === "active");
  // Components without fresh data are neither up nor down, so they count on
  // neither side of the stat.
  const measured = active.filter((entry) => entry.status !== "none");
  const operational = measured.filter((entry) => entry.status === "operational").length;
  const live = view.regions.filter((entry) => entry.clusters.length > 0).length;
  const headline = HEADLINES[view.status];
  const title = view.status === "operational" ? "TerraScale Status" : `${headline} · TerraScale Status`;

  const delayMessage =
    view.monitoring.lastRoundAt === null
      ? "Health checks have not reported yet, so component states are unknown."
      : html`Health checks last reported ${time(view.monitoring.lastRoundAt, "seconds")}; states below may be out of date.`;

  const body = html`<main id="main" class="ts-page" data-live data-title="${title}">
  <section class="st-hero" data-state="${view.status}" aria-labelledby="st-headline">
    <span class="st-hero-mark" aria-hidden="true"><span class="ts-dot"></span></span>
    <div class="st-hero-copy">
      <p class="ts-eyebrow">Current status</p>
      <h1 class="st-title" id="st-headline">${headline}</h1>
      <p class="ts-meta">Updated ${time(view.generatedAt, "seconds")} · refreshes every 30 seconds</p>
    </div>
  </section>

  ${
    view.monitoring.delayed
      ? html`<article class="ts-alert" data-state="degraded" role="status">
    <h2 class="ts-alert-title">Monitoring delayed</h2>
    <p class="ts-alert-body">${delayMessage}</p>
  </article>`
      : ""
  }

  <dl class="ts-stats" aria-label="Platform summary">
    ${stat("Components", `${operational}/${measured.length}`, "operational now")}
    ${stat("Regions", `${live}/${view.regions.length}`, live === view.regions.length ? "all live" : `${view.regions.length - live} planned`)}
    ${stat("Uptime", formatUptime(view.uptime30d), `last ${PLATFORM_DAYS} days`)}
    ${stat("Active incidents", String(view.activeIncidents.length), view.activeIncidents.length === 0 ? "nothing to report" : "see below")}
  </dl>

  ${
    view.activeIncidents.length > 0
      ? card(
          {
            id: "incidents",
            title: "Active incidents",
            description: "Updates are posted here as soon as we have them.",
          },
          html`<div class="ts-card-body">${view.activeIncidents.map(incidentAlert)}</div>`,
        )
      : ""
  }

  ${card(
    {
      id: "components",
      title: "Components",
      description: html`Hourly status over the last ${SERVICE_HOURS} hours, in ${zone}, measured by health checks.`,
    },
    view.groups.length === 0
      ? empty("No components published", "Component status will appear here once components are registered.")
      : html`${view.groups.map(group)}
  ${active.length > 0 ? html`<div class="st-axis" aria-hidden="true"><span>${SERVICE_HOURS}h ago</span><span>Now</span></div>` : ""}`,
  )}

  ${card(
    {
      id: "regions",
      title: "Regions",
      description:
        "Every cluster is health checked every 30 seconds from four vantage points on Cloudflare's network. Ping is the median of the latest round, then the 24-hour mean.",
    },
    view.regions.length === 0
      ? empty("No regions published", "Regions will appear here once they are registered.")
      : html`${map(view.regions)}
  <div class="st-regions">${view.regions.map(region)}</div>`,
  )}

  ${card(
    {
      id: "history",
      title: `Last ${PLATFORM_DAYS} days`,
      description: "Daily platform status in UTC days, from health checks and incidents.",
    },
    html`${dayBars(view.days, `Platform: ${formatUptime(view.uptime30d)} uptime over the last ${PLATFORM_DAYS} days`)}
  <div class="st-axis" aria-hidden="true"><span>${formatDay(view.days[0]?.start ?? view.generatedAt)}</span><span>Today</span></div>
  ${legend(LEGEND)}`,
  )}

  ${
    view.resolvedIncidents.length > 0
      ? card(
          {
            id: "resolved",
            title: "Recently resolved",
            description: `Incidents and warnings resolved in the last ${RESOLVED_DAYS} days.`,
            actions: html`<a class="ts-link" href="/history">Full history</a>`,
          },
          html`<ul class="ts-list">${view.resolvedIncidents.map(incidentItem)}</ul>`,
        )
      : ""
  }
</main>`;

  return {
    title,
    description: "Live operational status for TerraScale services and regions.",
    path: "/",
    body,
    live: true,
  };
}
