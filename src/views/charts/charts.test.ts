import { describe, expect, it } from "vitest";
import { niceCeiling, runs, smoothPath } from "./geometry";
import { lineChart, MAX_COLUMNS } from "./line";
import { sparkline } from "./sparkline";

describe("geometry", () => {
  it("rounds scales up to 1, 2 or 5 × 10ⁿ", () => {
    expect([0, 1, 7, 12, 180, 250, 999].map(niceCeiling)).toEqual([1, 1, 10, 20, 200, 500, 1000]);
  });

  it("draws straight lines for two points and curves for more", () => {
    expect(
      smoothPath([
        [0, 0],
        [10, 10],
      ]),
    ).toBe("M 0.0,0.0 L 10.0,10.0");
    expect(
      smoothPath([
        [0, 10],
        [10, 0],
        [20, 10],
      ]),
    ).toMatch(/^M 0\.0,10\.0 C .* C .*20\.0,10\.0$/);
  });

  it("splits series at gaps", () => {
    expect(runs([1, null, 2, 3, null])).toEqual([
      [{ index: 0, value: 1 }],
      [
        { index: 2, value: 2 },
        { index: 3, value: 3 },
      ],
    ]);
  });
});

describe("lineChart", () => {
  const options = {
    label: "Latency",
    ticks: ["a", "b", "c", "d", "e"],
    points: ["p0", "p1", "p2"],
    format: (n: number) => `${n} ms`,
  };

  it("renders series, gaps and a labeled hover column per sample", () => {
    const svg = lineChart(options, [
      { name: "US West", values: [40, null, 60] },
      { name: "Europe", values: [80, 90, 100] },
    ]).value;
    expect(svg.match(/class="ts-chart-line/g)).toHaveLength(3);
    expect(svg.match(/class="ts-chart-column"/g)).toHaveLength(3);
    expect(svg).toContain('aria-label="p1: US West —, Europe 90 ms"');
    expect(svg).not.toContain("ts-chart-area");
  });

  it("fills the area of a single series and caps hover columns", () => {
    const values = Array.from({ length: 1440 }, (_, index) => index);
    const svg = lineChart({ ...options, points: [] }, [{ name: "p50", values }]).value;
    expect(svg).toContain("ts-chart-area");
    expect(svg.match(/class="ts-chart-column"/g)?.length).toBeLessThanOrEqual(MAX_COLUMNS);
  });

  it("renders nothing without values", () => {
    expect(lineChart(options, [{ name: "x", values: [null, null, null] }]).value).toBe("");
  });
});

describe("sparkline", () => {
  it("needs two values", () => {
    expect(sparkline([null, 3]).value).toBe("");
    expect(sparkline([1, 3]).value).toContain('class="st-spark"');
  });
});
