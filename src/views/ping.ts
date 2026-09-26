/* Ping: latency to every region and component, measured two ways. The
   vantage matrices show what the health checks see from Cloudflare's
   network; the browser test times requests from the visitor's own
   connection to each region. */

import type { Details } from "../db/details";
import { percentile } from "../domain/histogram";
import { HOUR } from "../format";
import { html, type Html } from "../html";
import { Measurements } from "../measure";
import type { Overview } from "../overview";
import { VANTAGES } from "../probe/vantages";
import { sparkline } from "./charts/sparkline";
import { card, empty, ms, statusBadge } from "./components";
import type { Page } from "./layout";

/** Hourly buckets behind the sparklines. */
const HOURS = 24;

function cell(
  measurements: Measurements,
  ids: readonly string[],
  vantage: string,
  latest: number | null,
  now: number,
): Html {
  const start = now - (now % HOUR) - (HOURS - 1) * HOUR;
  const starts = Array.from({ length: HOURS }, (_, index) => start + index * HOUR);
  const day = measurements.counts(ids, vantage, start, start + HOURS * HOUR, HOUR);
  const p95 = percentile(day.hist, 0.95);
  const card = JSON.stringify({
    rows: [
      ["Latest", ms(latest)],
      ["Median, 24h", ms(percentile(day.hist, 0.5))],
      ["p95, 24h", ms(p95)],
    ],
  });
  return html`<td class="st-ping-cell" data-title="${VANTAGES.find((entry) => entry.code === vantage)?.name ?? vantage}" data-card="${card}">
  <span class="st-ping-value ts-num">${ms(latest)}</span>
  <span class="ts-meta ts-num">p95 ${ms(p95)}</span>
  ${sparkline(measurements.series(ids, vantage, starts, HOUR, HOUR, 0.5))}
</td>`;
}

export function pingPage(view: Overview, details: Details, now: number): Page {
  const measurements = new Measurements(details.periods);
  const live = view.regions.filter((region) => region.clusters.length > 0);
  const components = view.groups.flatMap((group) => group.components).filter((entry) => entry.clusters.length > 0);

  const header = html`<tr><th scope="col">From</th>${VANTAGES.map((vantage) => html`<th scope="col">${vantage.name}</th>`)}</tr>`;
  const regionMatrix = html`<div class="st-table-wrap"><table class="st-ping">
  <thead>${header}</thead>
  <tbody>${view.regions.map((region) => {
    const ids = region.clusters.map((cluster) => cluster.id);
    return html`<tr><th scope="row"><a class="st-incident-link" href="/regions/${region.code}">${region.code} · ${region.name}</a> ${
      ids.length === 0 ? statusBadge("none", "Planned") : ""
    }</th>${
      ids.length === 0
        ? html`<td colspan="${VANTAGES.length}" class="ts-meta">Not yet live</td>`
        : VANTAGES.map((vantage) =>
            cell(measurements, ids, vantage.code, region.vantagePings[vantage.code] ?? null, now),
          )
    }</tr>`;
  })}</tbody>
</table></div>`;

  const componentMatrix = html`<div class="st-table-wrap"><table class="st-ping">
  <thead>${header}</thead>
  <tbody>${components.map((component) => {
    const ids = component.clusters.map((cluster) => cluster.id);
    return html`<tr><th scope="row"><a class="st-incident-link" href="/components/${component.id}">${component.name}</a></th>${VANTAGES.map(
      (vantage) => cell(measurements, ids, vantage.code, component.vantagePings[vantage.code] ?? null, now),
    )}</tr>`;
  })}</tbody>
</table></div>`;

  const targets = [
    { name: "Nearest Cloudflare data center", detail: "this page's edge", url: "/api/ping", code: "EDGE" },
    ...view.regions.map((region) => ({
      name: `${region.code} · ${region.name}`,
      detail: region.pingLabel ?? "",
      url: region.pingUrl,
      code: region.code,
    })),
  ];
  const browser = html`<div class="st-ping-test">
  <p class="ts-meta">Times five requests from your browser to each region after a warm-up, and shows the median and fastest. Nothing is sent except the requests themselves.</p>
  <button class="ts-button" type="button" data-ping-start disabled>Test from your browser</button>
  <div class="st-table-wrap"><table class="st-ping st-ping-browser">
    <thead><tr><th scope="col">To</th><th scope="col">Median</th><th scope="col">Fastest</th></tr></thead>
    <tbody>${targets.map((target) =>
      target.url
        ? html`<tr data-ping-url="${target.url}"><th scope="row">${target.name}<span class="ts-meta"> ${target.detail}</span><span class="ts-meta" data-ping-colo></span></th><td class="ts-num" data-ping-result>—</td><td class="ts-num" data-ping-min>—</td></tr>`
        : html`<tr><th scope="row">${target.name}</th><td colspan="2" class="ts-meta">Not yet live</td></tr>`,
    )}</tbody>
  </table></div>
  <noscript><p class="ts-meta">The browser test needs JavaScript.</p></noscript>
</div>`;

  const body = html`<main id="main" class="ts-page">
  <header class="st-page-head">
    <p class="ts-eyebrow">Latency</p>
    <h1 class="st-title">Ping</h1>
    <p class="ts-muted">How fast every region and component answers: from the health checks' four vantage points, and from your own browser.</p>
  </header>

  ${card({ id: "browser", title: "From your browser", description: "Your own round trip to each region." }, browser)}

  ${card(
    {
      id: "regions",
      title: "Regions from each vantage point",
      description: "The latest median response of each region's clusters, the 24-hour p95, and the last 24 hours.",
    },
    live.length === 0 && view.regions.length === 0
      ? empty("No regions", "Regions will appear once they are registered.")
      : regionMatrix,
  )}

  ${card(
    {
      id: "components",
      title: "Components from each vantage point",
      description: "The same for every measured component, regional or global.",
    },
    components.length === 0
      ? empty("Nothing measured yet", "Components appear once they are measured.")
      : componentMatrix,
  )}
</main>`;

  return {
    title: "Ping · TerraScale Status",
    description: "Latency to TerraScale regions from four vantage points and from your browser.",
    path: "/ping",
    body,
  };
}
