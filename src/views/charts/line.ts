/* A server-rendered line chart: gridlines, axis labels, one path per series
   (with an area under a single series), and a focusable hover column per
   sample whose tooltip is drawn in SVG, so it works without scripts. Gaps
   in a series break its line. */

import { html, type Html } from "../../html";
import { coordinate, hash, niceCeiling, runs, smoothPath } from "./geometry";

export interface Series {
  name: string;
  values: readonly (number | null)[];
}

export interface LineOptions {
  /** The chart's accessible name. */
  label: string;
  /** Five x-axis labels, from the first sample to the last. */
  ticks: readonly string[];
  /** Every sample's name, shown as its tooltip header. */
  points: readonly string[];
  /** Formats values in tooltips and on the y axis. */
  format: (value: number) => string;
  height?: number;
}

const WIDTH = 720;
const LEFT = 56;
const RIGHT = 12;
const TOP = 14;
const BOTTOM = 32;

/** Hover targets rendered per chart; dense series share columns. */
export const MAX_COLUMNS = 60;

// Tooltip metrics in viewBox units: monospaced text is its character count
// times a fixed advance.
const TIP = { char: 6.8, padX: 10, padY: 6, line: 17, swatch: 12, gap: 16, offset: 10 };

interface TipRow {
  name: string;
  value: string;
  series: number;
}

function tip(x: number, header: string, rows: readonly TipRow[]): Html {
  const names = Math.max(0, ...rows.map((row) => row.name.length));
  const values = Math.max(0, ...rows.map((row) => row.value.length));
  const content = Math.max(header.length * TIP.char, TIP.swatch + (names + values) * TIP.char + TIP.gap);
  const width = content + 2 * TIP.padX;
  const lines = rows.length + (header ? 1 : 0);
  let left = x + TIP.offset;
  if (left + width > WIDTH - RIGHT) left = Math.max(0, x - TIP.offset - width);
  const lineY = (line: number) => coordinate(TOP + TIP.padY + TIP.line * (line + 0.5));
  const first = header ? 1 : 0;
  return html`<g class="ts-chart-tip" aria-hidden="true">
  <rect class="ts-chart-tip-box" x="${coordinate(left)}" y="${coordinate(TOP)}" width="${coordinate(width)}" height="${coordinate(2 * TIP.padY + lines * TIP.line)}" rx="6"></rect>
  ${header ? html`<text class="ts-chart-tip-label" x="${coordinate(left + TIP.padX)}" y="${lineY(0)}" dy="0.35em">${header}</text>` : ""}
  ${rows.map(
    (
      row,
      index,
    ) => html`<circle class="ts-chart-tip-swatch ts-cat-${row.series}" cx="${coordinate(left + TIP.padX + 3)}" cy="${lineY(first + index)}" r="3"></circle>
  <text class="ts-chart-tip-name" x="${coordinate(left + TIP.padX + TIP.swatch)}" y="${lineY(first + index)}" dy="0.35em">${row.name}</text>
  <text class="ts-chart-tip-value" x="${coordinate(left + width - TIP.padX)}" y="${lineY(first + index)}" dy="0.35em" text-anchor="end">${row.value}</text>`,
  )}
</g>`;
}

/** Renders the chart, or nothing when there is no value to draw. */
export function lineChart(options: LineOptions, series: readonly Series[]): Html {
  const height = options.height ?? 220;
  const count = series[0]?.values.length ?? 0;
  const all = series.flatMap((entry) => entry.values.filter((value): value is number => value !== null));
  if (count === 0 || all.length === 0 || series.some((entry) => entry.values.length !== count)) return html``;

  const maximum = Math.max(...all);
  const scale = niceCeiling(maximum);
  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotHeight = height - TOP - BOTTOM;
  const bottom = TOP + plotHeight;
  const xAt = (index: number) => LEFT + (plotWidth * index) / Math.max(1, count - 1);
  const yAt = (value: number) => TOP + plotHeight * (1 - Math.max(0, value) / scale);
  const gradient = `st-fill-${hash(options.label)}`;
  const single = series.length === 1;

  const grid = Array.from({ length: 5 }, (_, step) => {
    const y = coordinate(TOP + (plotHeight * step) / 4);
    return html`<line class="ts-chart-grid${step === 4 ? " ts-chart-baseline" : ""}" x1="${LEFT}" y1="${y}" x2="${WIDTH - RIGHT}" y2="${y}"></line>
  <text class="ts-chart-axis" x="${LEFT - 10}" y="${y}" dy="0.32em" text-anchor="end">${options.format((scale * (4 - step)) / 4)}</text>`;
  });
  const ticks = Array.from({ length: 5 }, (_, step) => {
    const index = count > 1 ? Math.round((step * (count - 1)) / 4) : 0;
    const anchor = step === 0 ? "start" : step === 4 ? "end" : "middle";
    return html`<text class="ts-chart-axis" x="${coordinate(xAt(index))}" y="${height - 8}" text-anchor="${anchor}">${options.ticks[step] ?? ""}</text>`;
  });
  const paths = series.map((entry, seriesIndex) =>
    runs(entry.values).map((run) => {
      const line = smoothPath(run.map(({ index, value }) => [xAt(index), yAt(value)]));
      const first = run[0]?.index ?? 0;
      const last = run.at(-1)?.index ?? 0;
      const area = single
        ? html`<path class="ts-chart-area" d="${line} L ${coordinate(xAt(last))},${bottom} L ${coordinate(xAt(first))},${bottom} Z" fill="url(#${gradient})"></path>`
        : "";
      return html`${area}<path class="ts-chart-line ts-cat-${seriesIndex + 1}" d="${line}"></path>`;
    }),
  );

  const step = Math.max(1, Math.ceil(count / MAX_COLUMNS));
  const columnWidth = (plotWidth * step) / Math.max(1, count - 1);
  const columns: Html[] = [];
  for (let index = Math.floor(step / 2); index < count; index += step) {
    const x = xAt(index);
    const left = Math.max(LEFT, x - columnWidth / 2);
    const right = Math.min(WIDTH - RIGHT, x + columnWidth / 2);
    const rows = series.map((entry, seriesIndex): TipRow => {
      const value = entry.values[index] ?? null;
      return { name: entry.name, value: value === null ? "—" : options.format(value), series: seriesIndex + 1 };
    });
    const header = options.points[index] ?? "";
    const label = `${header ? `${header}: ` : ""}${rows.map((row) => `${row.name} ${row.value}`).join(", ")}`;
    const dots = series.flatMap((entry, seriesIndex) => {
      const value = entry.values[index] ?? null;
      return value === null
        ? []
        : [
            html`<circle class="ts-chart-dot ts-cat-${seriesIndex + 1}" cx="${coordinate(x)}" cy="${coordinate(yAt(value))}" r="4"></circle>`,
          ];
    });
    columns.push(html`<g class="ts-chart-column" tabindex="0" role="img" aria-label="${label}">
  <rect class="ts-chart-hit" x="${coordinate(left)}" y="${TOP}" width="${coordinate(right - left)}" height="${plotHeight}"></rect>
  <line class="ts-chart-guide" x1="${coordinate(x)}" y1="${TOP}" x2="${coordinate(x)}" y2="${bottom}"></line>
  ${dots}
  ${tip(x, header, rows)}
</g>`);
  }

  return html`<svg class="ts-chart" viewBox="0 0 ${WIDTH} ${height}" role="group" aria-label="${options.label}">
  <defs><linearGradient id="${gradient}" x1="0" y1="0" x2="0" y2="1"><stop class="ts-chart-fill-start" offset="0"></stop><stop class="ts-chart-fill-end" offset="1"></stop></linearGradient></defs>
  ${grid}${ticks}${paths}${columns}
</svg>`;
}

/** The legend under a multi-series chart. */
export function chartLegend(names: readonly string[]): Html {
  return html`<ul class="ts-chart-legend" aria-hidden="true">${names.map(
    (name, index) =>
      html`<li class="ts-chart-legend-item"><span class="ts-chart-swatch ts-cat-${index + 1}"></span>${name}</li>`,
  )}</ul>`;
}
