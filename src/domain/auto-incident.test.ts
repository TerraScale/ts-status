import { describe, expect, it } from "vitest";
import { adopt, step, type Observation, type Tracker } from "./auto-incident";

const M = 60_000;
const seen = (state: Observation["state"], suppressed = false): Observation => ({
  componentId: "dashboard",
  name: "Dashboard",
  state,
  detail: "4 of 4 vantage points failing: HTTP 503",
  suppressed,
});

/** Runs observations 30 seconds apart and collects every action. */
function run(states: Observation[], options: { touched?: Set<string>; start?: Record<string, Tracker> } = {}) {
  let trackers = options.start ?? {};
  let ids = 0;
  const actions = states.flatMap((observation, index) => {
    const result = step(trackers, [observation], index * 30_000, {
      newId: () => `i${++ids}`,
      touched: options.touched ?? new Set(),
    });
    trackers = result.trackers;
    return result.actions.map((action) => ({ at: index * 30_000, ...action }));
  });
  return { actions, trackers };
}

describe("step", () => {
  it("opens after a minute down, monitors on recovery and resolves after five healthy minutes", () => {
    const { actions, trackers } = run([
      ...Array.from({ length: 3 }, () => seen("major_outage")),
      ...Array.from({ length: 12 }, () => seen("operational")),
    ]);
    expect(actions.map((action) => [action.at / 1000, action.type, "status" in action ? action.status : ""])).toEqual([
      [60, "open", ""],
      [90, "update", "monitoring"],
      [390, "resolve", ""],
    ]);
    expect(actions[0]).toMatchObject({ title: "Dashboard is down", impact: "critical" });
    expect(trackers).toEqual({});
  });

  it("ignores blips shorter than the threshold", () => {
    expect(run([seen("major_outage"), seen("operational"), seen("major_outage"), seen("operational")]).actions).toEqual(
      [],
    );
  });

  it("waits ten minutes before opening a degraded incident, then raises its impact", () => {
    const states = [...Array.from({ length: 21 }, () => seen("degraded")), seen("major_outage")];
    const { actions } = run(states);
    expect(actions.map((action) => [action.at / M, action.type])).toEqual([
      [10, "open"],
      [10.5, "update"],
    ]);
    expect(actions[0]).toMatchObject({ impact: "minor", title: "Dashboard is degraded" });
    expect(actions[1]).toMatchObject({ status: "investigating", impact: "critical" });
  });

  it("returns to investigating when checks fail again while monitoring", () => {
    const { actions } = run([
      seen("major_outage"),
      seen("major_outage"),
      seen("major_outage"),
      seen("operational"),
      seen("major_outage"),
    ]);
    expect(actions.map((action) => ("status" in action ? action.status : action.type))).toEqual([
      "open",
      "monitoring",
      "investigating",
    ]);
  });

  it("never opens during maintenance and lets go of operator-edited incidents", () => {
    expect(run(Array.from({ length: 5 }, () => seen("major_outage", true))).actions).toEqual([]);
    const start = {
      dashboard: { state: "major_outage", since: 0, incidentId: "op", impact: "critical", healthySince: null },
    } as const;
    const { actions, trackers } = run([seen("operational")], { touched: new Set(["op"]), start: { ...start } });
    expect(actions).toEqual([]);
    expect(trackers).toEqual({});
  });

  it("keeps its memory while nothing is measured", () => {
    const { trackers } = run([seen("major_outage"), seen("none")]);
    expect(trackers.dashboard?.since).toBe(0);
  });
});

describe("adopt", () => {
  it("tracks open automatic incidents it has forgotten", () => {
    expect(adopt({}, [{ id: "i9", componentId: "git", impact: "major", createdAt: 5 }])).toEqual({
      git: { state: "partial_outage", since: 5, incidentId: "i9", impact: "major", healthySince: null },
    });
  });
});
