/* The status page: headline, stats, active incidents, components by group
   with bars over the chosen range, response times, the live region map,
   the 90-day platform history, and recently resolved incidents. */

import regionMap from "../assets/region-map.svg?raw";
import { RANGE_KEYS, RANGES, DEFAULT_RANGE, type RangeKey } from "../domain/range";
import { STATES, STATE_LABELS, type Status, type TimelineState } from "../domain/status";
import { formatClock, formatDay, formatUptime } from "../format";
import { html, raw, type Html } from "../html";
import {
  PLATFORM_DAYS,
  RESOLVED_DAYS,
  type ClusterOverview,
  type ComponentOverview,
  type GroupOverview,
  type Overview,
  type RegionOverview,
} from "../overview";
import { VANTAGES } from "../probe/vantages";
import { chartLegend, lineChart } from "./charts/line";
import { sparkline } from "./charts/sparkline";
import {
  bars,
  card,
  empty,
  incidentAlert,
  incidentItem,
  legend,
  ms,
  probeRows,
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

const lower = (state: TimelineState): string => STATE_LABELS[state].toLowerCase();

const rangeHref = (range: RangeKey): string => (range === DEFAULT_RANGE ? "/" : `/?range=${range}`);

/** Links switching the bars' time range; the page renders without scripts. */
function rangeSwitch(current: RangeKey): Html {
  return html`<nav class="st-range" aria-label="Time range">${RANGE_KEYS.map(
    (range) =>
      html`<a href="${rangeHref(range)}"${range === current ? raw(' aria-current="true"') : ""}>${RANGES[range].short}</a>`,
  )}</nav>`;
}

function axis(view: Overview): Html {
  return html`<div class="st-axis" aria-hidden="true"><span>${RANGES[view.range].label} ago</span><span>Now</span></div>`;
}

function component(entry: ComponentOverview, view: Overview) {
  if (entry.lifecycle === "planned") {
    return html`<li class="ts-list-item st-service" data-lifecycle="planned">
  <div class="ts-list-main">
    <h4 class="ts-strong">${entry.name}</h4>
    <p class="ts-meta">${entry.description}</p>
  </div>
  <div class="st-service-state">${statusBadge("none", "Planned")}</div>
</li>`;
  }
  const range = RANGES[view.range].label;
  const summary = `${entry.name}: ${formatUptime(entry.uptime)} uptime over the last ${range}, currently ${lower(entry.status)}`;
  return html`<li class="ts-list-item st-service">
  <div class="ts-list-main">
    <h4 class="ts-strong">${entry.name}</h4>
    <p class="ts-meta">${entry.description}</p>
  </div>
  <div class="st-service-state">
    ${sparkline(entry.latency)}
    <span class="ts-meta ts-num" title="Uptime over the last ${range}">${formatUptime(entry.uptime)}</span>
    ${statusBadge(entry.status)}
  </div>
  ${bars(entry.bars, { label: summary })}
</li>`;
}

function group(entry: GroupOverview, view: Overview) {
  return html`<section class="st-group" aria-labelledby="group-${entry.id}">
  <h3 id="group-${entry.id}" class="st-group-title">${entry.name}</h3>
  <ul class="ts-list">${entry.components.map((item) => component(item, view))}</ul>
</section>`;
}

function cluster(entry: ClusterOverview, view: Overview) {
  const summary = `${entry.componentName} on ${entry.cluster}: ${formatUptime(entry.uptime)} of checks up over the last ${RANGES[view.range].label}, currently ${lower(entry.status)}`;
  return html`<li class="ts-list-item st-service">
  <div class="ts-list-main">
    <h4 class="ts-strong">${entry.componentName}</h4>
    <p class="ts-meta">${PROVIDERS[entry.provider]} · ${entry.cluster}</p>
  </div>
  <div class="st-service-state">
    ${sparkline(entry.latency)}
    <span class="ts-meta ts-num" title="Latest ping · mean over the range">${ms(entry.pingMs)} · ${ms(entry.meanLatency)}</span>
    ${statusBadge(entry.status)}
  </div>
  ${bars(entry.bars, { label: summary })}
</li>`;
}

function region(entry: RegionOverview, view: Overview) {
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
  ${
    planned
      ? html`<p class="ts-meta">No clusters serve this region yet.</p>`
      : html`<ul class="ts-list">${entry.clusters.map((item) => cluster(item, view))}</ul>`
  }
</section>`;
}

/** The dotted world map: one hub per region colored by its state, the
    vantage points probing them, and an arc from each vantage to every live
    region carrying its latest latency. */
function map(view: Overview) {
  const regions = view.regions;
  const live = regions.filter((entry) => entry.clusters.length > 0);
  const colos = new Map(view.monitoring.vantages.map((vantage) => [vantage.code, vantage.colo]));
  const label = `Region map: ${regions.map((entry) => `${entry.name} ${entry.clusters.length === 0 ? "planned" : lower(entry.status)}`).join(", ")}`;

  const arcs = live.flatMap((entry) =>
    VANTAGES.flatMap((vantage) => {
      const dx = entry.mapX - vantage.mapX;
      const dy = entry.mapY - vantage.mapY;
      const distance = Math.hypot(dx, dy);
      if (distance < 6) return [];
      const cx = (vantage.mapX + entry.mapX) / 2;
      const cy = Math.min(vantage.mapY, entry.mapY) - distance * 0.22;
      const d = `M ${vantage.mapX} ${vantage.mapY} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${entry.mapX} ${entry.mapY}`;
      const ping = entry.vantagePings[vantage.code] ?? null;
      const cardData = JSON.stringify({ rows: [["Latest", ms(ping)]] });
      return [
        html`<g class="st-arc" data-state="${ping === null ? "none" : entry.status}" data-title="${vantage.name} → ${entry.name}" data-card="${cardData}">
    <path class="st-arc-line" d="${d}"></path><path class="st-arc-hit" d="${d}"></path>
  </g>`,
      ];
    }),
  );
  const vantages = VANTAGES.map((vantage) => {
    const colo = colos.get(vantage.code);
    const cardData = JSON.stringify({
      rows: [
        ["Placement", vantage.placement],
        ["Runs in", colo ?? "Not seen yet"],
      ],
    });
    return html`<g class="st-vantage" transform="translate(${vantage.mapX} ${vantage.mapY})" tabindex="0" role="img" aria-label="Vantage point ${vantage.name}" data-title="Vantage · ${vantage.name}" data-card="${cardData}">
    <rect x="-1.3" y="-1.3" width="2.6" height="2.6" transform="rotate(45)"></rect>
  </g>`;
  });
  const hubs = regions.map((entry) => {
    const planned = entry.clusters.length === 0;
    const cardData = JSON.stringify({
      rows: planned
        ? [["Status", "Planned"]]
        : [
            ["Status", STATE_LABELS[entry.status]],
            ["Ping", ms(entry.pingMs)],
            ["Clusters", String(entry.clusters.length)],
            ...VANTAGES.map((vantage): [string, string] => [
              `From ${vantage.name}`,
              ms(entry.vantagePings[vantage.code] ?? null),
            ]),
          ],
    });
    return html`<g class="st-hub" data-state="${entry.status}"${planned ? raw(' data-lifecycle="planned"') : ""} transform="translate(${entry.mapX} ${entry.mapY})" tabindex="0" role="img" aria-label="${entry.name}: ${planned ? "planned" : lower(entry.status)}" data-title="${entry.code} · ${entry.name}" data-card="${cardData}">
    <circle class="st-hub-pulse" r="2.4"></circle><circle class="st-hub-ring" r="2.4"></circle><circle r="1.1"></circle>
    <text x="3" y="1.1">${entry.code}</text>
  </g>`;
  });
  const dots = regionMap.replace(/^<svg[^>]*>|<\/svg>\s*$/g, "");
  return html`<figure class="st-map-figure">
  <svg class="st-map" viewBox="0 0 136 80" role="group" aria-label="${label}">${raw(dots)}${arcs}${vantages}${hubs}</svg>
  <figcaption class="st-map-legend" aria-hidden="true">
    <span><span class="st-key st-key-hub"></span>Region</span>
    <span><span class="st-key st-key-vantage"></span>Vantage point</span>
    <span><span class="st-key st-key-arc"></span>Probe path</span>
  </figcaption>
</figure>`;
}

/** Median response time per component over the range. */
function responseTimes(view: Overview): Html {
  const components = view.groups
    .flatMap((entry) => entry.components)
    .filter((entry) => entry.lifecycle === "active" && entry.latency.some((value) => value !== null));
  const first = components[0];
  if (!first) return html``;
  const hourly = RANGES[view.range].size < 86_400_000;
  const name = (start: number) => (hourly ? `${formatDay(start)} ${formatClock(start)} UTC` : formatDay(start));
  const points = first.bars.map((bucket) => name(bucket.start));
  const tickAt = (step: number) => first.bars[Math.round((step * (first.bars.length - 1)) / 4)];
  const ticks = [0, 1, 2, 3, 4].map((step) => {
    const bucket = tickAt(step);
    return bucket ? (hourly ? `${formatDay(bucket.start)} ${formatClock(bucket.start)}` : formatDay(bucket.start)) : "";
  });
  return card(
    {
      id: "latency",
      title: "Response time",
      description: `Median response of every component across the vantage points, over the last ${RANGES[view.range].label}.`,
    },
    html`${lineChart(
      {
        label: `Median response time over the last ${RANGES[view.range].label}`,
        ticks,
        points,
        format: (value) => `${Math.round(value)} ms`,
      },
      components.map((entry) => ({ name: entry.name, values: entry.latency })),
    )}
  ${chartLegend(components.map((entry) => entry.name))}`,
  );
}

function historyCard(view: Overview): Html {
  const summary = `Platform: ${formatUptime(view.uptimeHistory)} uptime over the last ${PLATFORM_DAYS} days`;
  return card(
    {
      id: "history",
      title: `Last ${PLATFORM_DAYS} days`,
      description: html`Daily platform status in UTC days, from health checks and incidents · ${formatUptime(view.uptimeHistory)} uptime.`,
      actions: html`<a class="ts-link" href="/history">Incident history</a>`,
    },
    html`${bars(view.days, {
      label: summary,
      large: true,
      card: (bucket) => {
        const day = view.days.find((entry) => entry.start === bucket.start);
        return { rows: probeRows(bucket.counts), notes: day?.incidents.map((incident) => incident.title) ?? [] };
      },
    })}
  <div class="st-axis" aria-hidden="true"><span>${formatDay(view.days[0]?.start ?? view.generatedAt)}</span><span>Today</span></div>
  ${legend(LEGEND)}`,
  );
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
  const range = RANGES[view.range].label;
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
      <p class="ts-meta">${
        view.monitoring.lastRoundAt === null
          ? html`Updated ${time(view.generatedAt, "seconds")}`
          : html`Checked every 30 seconds from ${VANTAGES.length} vantage points · last round <span data-ago="${view.monitoring.lastRoundAt}">${time(view.monitoring.lastRoundAt, "seconds")}</span>`
      }</p>
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
    ${stat("Uptime", formatUptime(view.uptime), `last ${range}`)}
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
      description: html`Status over the last ${range}, in ${zone}. Hover or focus a bar for details.`,
      actions: rangeSwitch(view.range),
    },
    view.groups.length === 0
      ? empty("No components published", "Component status will appear here once components are registered.")
      : html`${view.groups.map((entry) => group(entry, view))}
  ${active.length > 0 ? axis(view) : ""}`,
  )}

  ${responseTimes(view)}

  ${card(
    {
      id: "regions",
      title: "Regions",
      description:
        "Every cluster is checked every 30 seconds from four vantage points on Cloudflare's network. Ping is the median of the latest round, then the mean over the range.",
    },
    view.regions.length === 0
      ? empty("No regions published", "Regions will appear here once they are registered.")
      : html`${map(view)}
  <div class="st-regions">${view.regions.map((entry) => region(entry, view))}</div>`,
  )}

  ${historyCard(view)}

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
