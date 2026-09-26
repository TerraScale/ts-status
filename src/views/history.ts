/* Incident history: every incident and warning, grouped by month. */

import { formatMonth } from "../format";
import { html } from "../html";
import type { Incident } from "../status";
import { card, empty, incidentItem } from "./components";
import type { Page } from "./layout";

function byMonth(incidents: readonly Incident[]): Map<string, Incident[]> {
  const groups = new Map<string, Incident[]>();
  for (const incident of incidents) {
    const month = incident.createdAt.slice(0, 7);
    groups.set(month, [...(groups.get(month) ?? []), incident]);
  }
  return groups;
}

export function historyPage(incidents: readonly Incident[]): Page {
  const months = [...byMonth(incidents)];
  const body = html`<main id="main" class="ts-page">
  <header class="st-page-head">
    <p class="ts-eyebrow">Transparency</p>
    <h1 class="st-title">Incident history</h1>
    <p class="ts-muted">Incidents and operational warnings from the TerraScale platform, newest first.</p>
  </header>
  ${
    months.length === 0
      ? empty("No incidents recorded", "TerraScale has not reported any incidents or warnings.")
      : months.map(([month, list]) =>
          card(
            {
              id: `month-${month}`,
              title: formatMonth(`${month}-01T00:00:00Z`),
              description: `${list.length} ${list.length === 1 ? "entry" : "entries"}`,
            },
            html`<ul class="ts-list">${list.map(incidentItem)}</ul>`,
          ),
        )
  }
</main>`;

  return {
    title: "Incident history · TerraScale Status",
    description: "Past incidents and operational warnings for TerraScale services.",
    path: "/history",
    body,
  };
}
