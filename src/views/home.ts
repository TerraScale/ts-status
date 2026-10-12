/* The status page: headline, stats, active incidents, components by group
   with bars over the chosen range, response times, the live region map,
   the 90-day platform history, and recently resolved incidents. */

import regionMap from "../assets/region-map.svg?raw";
import { byHour, RANGES } from "../domain/range";
import { vantageLabel, type Coverage, type VantageCoverage, type VantageState } from "../domain/coverage";
import { COMING_SOON, HEADLINES, STATES, STATE_LABELS, type TimelineState } from "../domain/status";
import { formatClock, formatDay, formatUptime } from "../format";
import { html, raw, type Html } from "../html";
import {
  PLATFORM_DAYS,
  RESOLVED_DAYS,
  type ComponentOverview,
  type GroupOverview,
  type Overview,
  type RegionOverview,
} from "../overview";
import { VANTAGES, type Vantage } from "../probe/vantages";
import { MAP_HEIGHT, MAP_WIDTH } from "./charts/geometry";
import { chartLegend, lineChart } from "./charts/line";
import { sparkline } from "./charts/sparkline";
import {
  bars,
  card,
  clusterRow,
  componentHref,
  empty,
  incidentAlert,
  incidentItem,
  legend,
  ms,
  probeRows,
  PROVIDERS,
  rangeSwitch,
  regionHref,
  stat,
  statusBadge,
  time,
  zone,
} from "./components";
import { icon } from "./icons";
import type { Page } from "./layout";
import { maintenanceItems } from "./maintenance";

const LEGEND: TimelineState[] = [...STATES, "none"];

const lower = (state: TimelineState): string => STATE_LABELS[state].toLowerCase();

/** Who serves a region, such as "Fly.io". */
export const providersOf = (entry: RegionOverview): string =>
  [...new Set(entry.clusters.map((cluster) => PROVIDERS[cluster.provider]))].join(", ") || "No clusters yet";

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
  <div class="st-service-state">${statusBadge("none", COMING_SOON)}</div>
</li>`;
  }
  const range = RANGES[view.range].label;
  const summary = `${entry.name}: ${formatUptime(entry.uptime)} uptime over the last ${range}, currently ${entry.note?.toLowerCase() ?? lower(entry.status)}`;
  return html`<li class="ts-list-item st-service">
  <div class="ts-list-main">
    <h4 class="ts-strong"><a class="st-incident-link" href="${componentHref(entry.id)}">${entry.name}</a></h4>
    <p class="ts-meta">${entry.description}</p>
  </div>
  <div class="st-service-state">
    ${sparkline(entry.latency)}
    <span class="ts-meta ts-num" title="Uptime over the last ${range}">${formatUptime(entry.uptime)}</span>
    ${statusBadge(entry.status, entry.note ?? undefined)}
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

/** A region's state label: coming soon without clusters, else its note or state. */
export const regionLabel = (entry: RegionOverview): string =>
  entry.clusters.length === 0 ? COMING_SOON : (entry.note ?? STATE_LABELS[entry.status]);

/** A region as one collapsed row (code, name, provider, ping and state)
    that opens to its clusters, so the page lists every region without
    repeating every component's bars for each. */
function region(entry: RegionOverview, view: Overview) {
  const planned = entry.clusters.length === 0;
  const clusters = entry.clusters.length === 1 ? "1 cluster" : `${entry.clusters.length} clusters`;
  return html`<details class="st-region" id="region-${entry.code}">
  <summary class="ts-row-between">
    <div class="ts-row">
      ${icon("chevron-right", "st-region-chevron")}
      <span class="st-region-code">${entry.code}</span>
      <h3 class="ts-strong"><a class="st-incident-link" href="${regionHref(entry.code)}">${entry.name}</a></h3>
      <span class="ts-meta">${entry.country} · ${providersOf(entry)}${planned ? "" : ` · ${clusters}`}</span>
    </div>
    <div class="ts-row">
      ${planned || entry.note ? "" : html`<span class="ts-meta ts-num">Ping ${ms(entry.pingMs)}</span>`}
      ${statusBadge(entry.status, regionLabel(entry))}
    </div>
  </summary>
  ${
    planned
      ? html`<p class="ts-meta">No clusters serve this region yet.</p>`
      : html`<ul class="ts-list">${entry.clusters.map((item) => clusterRow(item, view.range))}</ul>`
  }
</details>`;
}

/** The dotted world map: one hub per region colored by its state, the
    vantage points probing them, and an arc from each vantage to every live
    region carrying its latest latency. */
function map(view: Overview) {
  const regions = view.regions;
  const live = regions.filter((entry) => entry.clusters.length > 0);
  const coverage = new Map(view.monitoring.coverage.vantages.map((entry) => [entry.code, entry]));
  const named = (vantage: Vantage) => vantageLabel(view.monitoring.coverage, vantage);
  const label = `Region map: ${regions.map((entry) => `${entry.name} ${regionLabel(entry).toLowerCase()}`).join(", ")}`;

  const arcs = live.flatMap((entry) =>
    VANTAGES.flatMap((vantage) => {
      const dx = entry.mapX - vantage.mapX;
      const dy = entry.mapY - vantage.mapY;
      const distance = Math.hypot(dx, dy);
      if (vantage.region === entry.code) return [];
      const cx = (vantage.mapX + entry.mapX) / 2;
      const cy = Math.min(vantage.mapY, entry.mapY) - distance * 0.22;
      const d = `M ${vantage.mapX} ${vantage.mapY} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${entry.mapX} ${entry.mapY}`;
      const ping = entry.vantagePings[vantage.code] ?? null;
      const cardData = JSON.stringify({ rows: [["Latest", ms(ping)]] });
      return [
        html`<g class="st-arc" data-state="${ping === null ? "none" : entry.status}" tabindex="0" role="img" aria-label="${named(vantage)} to ${entry.name}: latest ${ms(ping)}" data-title="${named(vantage)} → ${entry.name}" data-card="${cardData}">
    <path class="st-arc-line" d="${d}"></path><path class="st-arc-hit" d="${d}"></path>
  </g>`,
      ];
    }),
  );
  const vantages = VANTAGES.map((vantage) => {
    const entry = coverage.get(vantage.code);
    const cardData = JSON.stringify({
      rows: [
        ["Requested", vantage.placement],
        ["Proven to run in", entry?.observed ?? "Not proven"],
        ["Last answer", entry?.lastAnswerAt ? formatClock(entry.lastAnswerAt) : "Never"],
        ["Coverage", VANTAGE_STATES[entry?.state ?? "missing"]],
      ],
    });
    return html`<g class="st-vantage" transform="translate(${vantage.mapX} ${vantage.mapY})" tabindex="0" role="img" aria-label="Vantage point ${named(vantage)}" data-title="Vantage · ${named(vantage)}" data-card="${cardData}">
    <rect x="-1.3" y="-1.3" width="2.6" height="2.6" transform="rotate(45)"></rect>
  </g>`;
  });
  const hubs = regions.map((entry) => {
    const planned = entry.clusters.length === 0;
    const cardData = JSON.stringify({
      rows: planned
        ? [["Status", COMING_SOON]]
        : [
            ["Status", regionLabel(entry)],
            ["Ping", ms(entry.pingMs)],
            ["Clusters", String(entry.clusters.length)],
            ...VANTAGES.map((vantage): [string, string] => [
              `From ${named(vantage)}`,
              ms(entry.vantagePings[vantage.code] ?? null),
            ]),
          ],
    });
    return html`<g class="st-hub" data-state="${entry.status}"${planned ? raw(' data-lifecycle="planned"') : ""} transform="translate(${entry.mapX} ${entry.mapY})" tabindex="0" role="img" aria-label="${entry.name}: ${regionLabel(entry).toLowerCase()}" data-title="${entry.code} · ${entry.name}" data-card="${cardData}">
    <circle class="st-hub-pulse" r="2.4"></circle><circle class="st-hub-ring" r="2.4"></circle><circle r="1.1"></circle>
    <text x="3" y="1.1">${entry.code}</text>
  </g>`;
  });
  const dots = regionMap.replace(/^<svg[^>]*>|<\/svg>\s*$/g, "");
  return html`<figure class="st-map-figure">
  <svg class="st-map" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}" role="group" aria-label="${label}">${raw(dots)}${arcs}${vantages}${hubs}</svg>
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
  const hourly = byHour(view.range);
  const name = (start: number) => (hourly ? `${formatDay(start)} ${formatClock(start)} UTC` : formatDay(start));
  const points = first.bars.map((bucket) => name(bucket.start));
  const tickAt = (step: number) => first.bars[Math.round((step * (first.bars.length - 1)) / 4)];
  const ticks = [0, 1, 2, 3, 4].map((step) => {
    const bucket = tickAt(step);
    return bucket ? name(bucket.start) : "";
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
      card: (day) => ({ rows: probeRows(day.counts), notes: day.incidents.map((incident) => incident.title) }),
    })}
  <div class="st-axis" aria-hidden="true"><span>${formatDay(view.days[0]?.start ?? view.generatedAt)}</span><span>Today</span></div>
  ${legend(LEGEND)}`,
  );
}

const VANTAGE_STATES: Record<VantageState, string> = {
  verified: "Answering, location proven",
  unverified: "Answering, location not proven",
  mismatched: "Answering from another data center",
  missing: "Not answering",
};

function vantageDetail(entry: VantageCoverage): string {
  const last = entry.lastAnswerAt === null ? "never answered" : `last answered ${formatClock(entry.lastAnswerAt)}`;
  if (entry.state === "missing") return `did not answer the latest round, ${last}`;
  if (entry.state === "mismatched") return `ran in ${entry.observed}, not where it was placed`;
  return "answered without proof of where it ran";
}

function coverageMessage(coverage: Coverage): string {
  if (coverage.level === "insufficient") {
    return `Only ${coverage.answered} of ${coverage.total} vantage points answered the latest round. Website and API checks need answers from at least ${coverage.minimum} to decide, so their states are unknown.`;
  }
  return `${coverage.answered} of ${coverage.total} vantage points answered the latest round and ${coverage.verified} proved they ran where they were placed. Health states still rest on at least ${coverage.minimum} answers, but not on every vantage point.`;
}

/** Live only means a region has launched; whether it is up now needs
    enough fresh answers. */
function regionDetail(live: number, view: Overview): string {
  const launched = live === view.regions.length ? "all launched" : `${view.regions.length - live} pending launch`;
  return view.monitoring.delayed || view.monitoring.coverage.level === "insufficient"
    ? `${launched} · state unknown`
    : launched;
}

export function homePage(view: Overview): Page {
  const active = view.groups.flatMap((entry) => entry.components).filter((entry) => entry.lifecycle === "active");
  // Components without fresh data are neither up nor down, so they count on
  // neither side of the stat.
  const measured = active.filter((entry) => entry.status !== "none");
  const operational = measured.filter((entry) => entry.status === "operational").length;
  // A region is live once any of its clusters has passed a check.
  const live = view.regions.filter((entry) => entry.clusters.length > 0 && entry.note === null).length;
  const headline = HEADLINES[view.status];
  const title = view.status === "operational" ? "TerraScale Status" : `${headline} · TerraScale Status`;
  const range = RANGES[view.range].label;
  const delayMessage =
    view.monitoring.lastRoundAt === null
      ? "Health checks have not reported yet, so component states are unknown."
      : html`Health checks last reported ${time(view.monitoring.lastRoundAt, "seconds")}; states below may be out of date.`;
  const names = new Map(view.groups.flatMap((entry) => entry.components).map((entry) => [entry.id, entry.name]));
  const coverage = view.monitoring.coverage;

  const body = html`<main id="main" class="ts-page" data-live data-title="${title}">
  <section class="st-hero" data-state="${view.status}" aria-labelledby="st-headline">
    <span class="st-hero-mark" aria-hidden="true"><span class="ts-dot"></span></span>
    <div class="st-hero-copy">
      <p class="ts-eyebrow">Current status</p>
      <h1 class="st-title" id="st-headline">${headline}</h1>
      <p class="ts-meta">${
        view.monitoring.lastRoundAt === null
          ? html`Updated ${time(view.generatedAt, "seconds")}`
          : html`Checked every 30 seconds · ${coverage.answered} of ${coverage.total} vantage points answered the last round · last round <span data-ago="${view.monitoring.lastRoundAt}">${time(view.monitoring.lastRoundAt, "seconds")}</span>`
      }</p>
    </div>
  </section>

  ${
    view.monitoring.delayed
      ? html`<article class="ts-alert" data-state="degraded" role="status">
    <h2 class="ts-alert-title">Monitoring delayed</h2>
    <p class="ts-alert-body">${delayMessage}</p>
  </article>`
      : coverage.level === "full"
        ? ""
        : html`<article class="ts-alert" data-state="degraded" role="status" id="coverage">
    <h2 class="ts-alert-title">${coverage.level === "insufficient" ? "Monitoring coverage insufficient" : "Monitoring coverage degraded"}</h2>
    <p class="ts-alert-body">${coverageMessage(coverage)} This is a problem with monitoring, not a reported service outage.</p>
    <ul class="ts-alert-body">${coverage.vantages
      .filter((entry) => entry.state !== "verified")
      .map((entry) => html`<li>${entry.name} (requested ${entry.requested}): ${vantageDetail(entry)}</li>`)}</ul>
  </article>`
  }

  ${view.expiring.map(
    (certificate) => html`<article class="ts-alert" data-state="degraded" role="status">
    <h2 class="ts-alert-title">Certificate renewal due for ${certificate.host}</h2>
    <p class="ts-alert-body">The latest TLS certificate logged for ${certificate.host}${certificate.issuer ? ` (${certificate.issuer})` : ""} ${
      Date.parse(certificate.notAfter ?? "") <= view.generatedAt
        ? "has expired"
        : html`expires ${time(certificate.notAfter ?? "", "datetime")}`
    }. It is normally renewed well before then.</p>
  </article>`,
  )}

  <dl class="ts-stats" aria-label="Platform summary">
    ${stat("Components", `${operational}/${measured.length}`, "operational now")}
    ${stat("Regions", `${live}/${view.regions.length}`, regionDetail(live, view))}
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
          html`<div class="ts-card-body">${view.activeIncidents.map((incident) => incidentAlert(incident, view.generatedAt, names))}</div>`,
        )
      : ""
  }

  ${
    view.maintenance.length > 0
      ? card(
          {
            id: "maintenance",
            title: "Scheduled maintenance",
            description:
              "Components under maintenance show in blue; health checks open no incidents for them meanwhile.",
            actions: html`<a class="ts-link" href="/maintenance">All maintenance</a>`,
          },
          maintenanceItems(view.maintenance, view.generatedAt, names),
        )
      : ""
  }

  ${card(
    {
      id: "components",
      title: "Components",
      description: html`Status over the last ${range}, in ${zone}. Hover or focus a bar for details.`,
      actions: rangeSwitch(view.range, "/"),
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
      description: `Every cluster is checked every 30 seconds from ${coverage.total} vantage points on Cloudflare's network; ${coverage.answered} answered the latest round. Ping is the median of the latest round, then the mean over the range. Open a region for its clusters.`,
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
          html`<ul class="ts-list">${view.resolvedIncidents.map((incident) => incidentItem(incident, view.generatedAt, names))}</ul>`,
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
