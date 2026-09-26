import { describe, expect, it } from "vitest";
import { incidentStats } from "./history";
import type { Incident } from "./status";

const incident = (id: string, impact: Incident["impact"], minutes: number | null): Incident => ({
  id,
  kind: "incident",
  title: id,
  status: minutes === null ? "investigating" : "resolved",
  impact,
  source: "auto",
  message: "",
  components: [],
  scheduledStart: null,
  scheduledEnd: null,
  createdAt: "2026-09-26T10:00:00Z",
  updatedAt: "2026-09-26T10:00:00Z",
  resolvedAt: minutes === null ? null : new Date(Date.parse("2026-09-26T10:00:00Z") + minutes * 60_000).toISOString(),
});

describe("incidentStats", () => {
  it("counts incidents, their mean time to recovery and the longest", () => {
    expect(
      incidentStats([incident("a", "critical", 10), incident("b", "minor", 30), incident("c", "major", null)]),
    ).toEqual({
      count: 3,
      resolved: 2,
      mttrMs: 20 * 60_000,
      longest: { id: "b", title: "b", durationMs: 30 * 60_000 },
      byImpact: { minor: 1, major: 1, critical: 1 },
    });
  });

  it("has no recovery figures without resolved incidents", () => {
    expect(incidentStats([])).toMatchObject({ count: 0, mttrMs: null, longest: null });
  });
});
