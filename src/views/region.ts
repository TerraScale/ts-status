/* One region: its state, where it sits, latency to its clusters from each
   vantage, and the clusters with their bars. */

import type { Details } from "../db/details";
import { RANGES } from "../domain/range";
import { STATE_LABELS } from "../domain/status";
import { html } from "../html";
import { Measurements } from "../measure";
import type { Overview, RegionOverview } from "../overview";
import { VANTAGES } from "../probe/vantages";
import { card, clusterRow, empty, incidentItem, ms, rangeSwitch, regionHref, stat, statusBadge } from "./components";
import { latencyCharts } from "./latency";
import type { Page } from "./layout";

export function regionPage(view: Overview, entry: RegionOverview, details: Details, now: number): Page {
  const planned = entry.clusters.length === 0;
  const measurements = new Measurements(details.periods);
  const charts = latencyCharts(
    measurements,
    entry.clusters.map((cluster) => cluster.id),
    details.deploys,
    view.range,
    now,
  );
  const names = new Map(view.groups.flatMap((item) => item.components).map((item) => [item.id, item.name]));
  const range = RANGES[view.range].label;

  const body = html`<main id="main" class="ts-page" data-live data-title="${entry.name} · TerraScale Status">
  <header class="st-page-head">
    <p class="ts-eyebrow"><a class="ts-link" href="/#regions">Regions</a> · ${entry.code}</p>
    <div class="ts-row">
      <h1 class="st-title">${entry.name}</h1>
      ${statusBadge(entry.status, planned ? "Planned" : STATE_LABELS[entry.status])}
    </div>
    <p class="ts-muted">${entry.country}</p>
  </header>

  ${
    planned
      ? empty(
          "No clusters yet",
          `${entry.name} is planned; its clusters will be measured here once they serve traffic.`,
        )
      : html`<dl class="ts-stats" aria-label="Latest latency from each vantage">
    ${VANTAGES.map((vantage) => stat(vantage.name, ms(entry.vantagePings[vantage.code] ?? null), "latest median"))}
  </dl>

  ${card(
    {
      id: "clusters",
      title: "Clusters",
      description: `Status over the last ${range}.`,
      actions: rangeSwitch(view.range, regionHref(entry.code)),
    },
    html`<ul class="ts-list">${entry.clusters.map((cluster) => clusterRow(cluster, view.range))}</ul>`,
  )}

  ${card({ id: "latency", title: "Response time", description: "Median and p95 of the consensus across the region's clusters." }, charts.summary)}
  ${card({ id: "vantages", title: "From each vantage point", description: "Median response seen from each vantage." }, charts.vantages)}`
  }

  ${card(
    {
      id: "incidents",
      title: "Incidents",
      description: "Incidents affecting the region's components in the last 90 days.",
    },
    details.incidents.length === 0
      ? empty("No incidents", `No incident affected ${entry.name} in the last 90 days.`)
      : html`<ul class="ts-list">${details.incidents.map((incident) => incidentItem(incident, now, names))}</ul>`,
  )}
</main>`;

  return {
    title: `${entry.name} · TerraScale Status`,
    description: `Live status and latency of the ${entry.name} region.`,
    path: null,
    body,
    live: true,
  };
}
