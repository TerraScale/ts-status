/* A sparkline: a small trend line without axes, stretched to its box.
   It is decorative; the row it sits in states the numbers. */

import { html, type Html } from "../../html";
import { coordinate, niceCeiling, runs, smoothPath } from "./geometry";

const WIDTH = 120;
const HEIGHT = 28;
const PAD = 3;

export function sparkline(values: readonly (number | null)[]): Html {
  const known = values.filter((value): value is number => value !== null);
  if (known.length < 2) return html``;
  const scale = niceCeiling(Math.max(...known));
  const xAt = (index: number) => (WIDTH * index) / Math.max(1, values.length - 1);
  const yAt = (value: number) => PAD + (HEIGHT - 2 * PAD) * (1 - value / scale);
  const paths = runs(values).map(
    (run) => html`<path d="${smoothPath(run.map(({ index, value }) => [xAt(index), yAt(value)]))}"></path>`,
  );
  const last = runs(values).at(-1)?.at(-1);
  return html`<svg class="st-spark" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="none" aria-hidden="true">${paths}${
    last ? html`<circle cx="${coordinate(xAt(last.index))}" cy="${coordinate(yAt(last.value))}" r="2"></circle>` : ""
  }</svg>`;
}
