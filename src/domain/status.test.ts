import { describe, expect, it } from "vitest";
import {
  aggregate,
  endpointStatus,
  incidentWindows,
  meanLatency,
  overallStatus,
  probeState,
  probeUptime,
  spans,
  sumCounts,
  worstDuring,
  type Incident,
} from "./status";

const H = 3_600_000;

describe("aggregate", () => {
  it("reports down only when every part is down", () => {
    expect(aggregate(["major_outage", "major_outage"])).toBe("major_outage");
    expect(aggregate(["major_outage", "operational"])).toBe("partial_outage");
    expect(aggregate(["degraded", "operational", "none"])).toBe("degraded");
    expect(aggregate([])).toBe("none");
  });
});

describe("overallStatus", () => {
  it("reports operational when components and incidents are clear", () => {
    expect(overallStatus(["operational", "none"], [])).toBe("operational");
    expect(overallStatus([], [])).toBe("operational");
  });

  it("treats one component down as a partial platform outage", () => {
    expect(overallStatus(["major_outage", "operational"], [])).toBe("partial_outage");
    expect(overallStatus(["major_outage"], [])).toBe("major_outage");
  });

  it("maps active incident impact onto the headline", () => {
    expect(overallStatus(["operational"], [{ status: "investigating", impact: "minor" }])).toBe("degraded");
    expect(overallStatus(["operational"], [{ status: "monitoring", impact: "critical" }])).toBe("major_outage");
    expect(overallStatus(["operational"], [{ status: "resolved", impact: "critical" }])).toBe("operational");
  });
});

describe("incident windows", () => {
  const incident: Incident = {
    id: "i",
    kind: "incident",
    title: "",
    status: "resolved",
    impact: "major",
    message: "",
    createdAt: "1970-01-01T02:00:00Z",
    updatedAt: "1970-01-01T03:00:00Z",
    resolvedAt: "1970-01-01T03:00:00Z",
  };

  it("spans an incident from its start to its resolution, or now", () => {
    expect(incidentWindows([incident], 10 * H)).toEqual([{ from: 2 * H, to: 3 * H, state: "partial_outage" }]);
    expect(incidentWindows([{ ...incident, resolvedAt: null }], 10 * H)[0]?.to).toBe(10 * H);
  });

  it("takes the worst overlapping window", () => {
    const windows = incidentWindows([incident], 10 * H);
    expect(worstDuring(windows, 0, 2 * H)).toBe("none");
    expect(worstDuring(windows, 2.5 * H, 4 * H)).toBe("partial_outage");
  });
});

describe("spans", () => {
  it("cuts a window into equal parts, closing on its end", () => {
    expect(spans(0, 3 * H, 3)).toEqual([
      { start: 0, end: H },
      { start: H, end: 2 * H },
      { start: 2 * H, end: 3 * H },
    ]);
  });
});

describe("probes", () => {
  const now = Date.parse("2026-09-26T10:15:00Z");
  const endpoint = {
    id: "e",
    componentId: "dashboard",
    regionCode: "GRU",
    cluster: "c",
    provider: "fly" as const,
    lastCheckedAt: "2026-09-26T10:14:00Z",
    lastOk: 1,
    lastLatencyMs: 40,
    consecutiveFailures: 0,
  };

  it("derives an endpoint state from its latest probes", () => {
    expect(endpointStatus(endpoint, now)).toBe("operational");
    expect(endpointStatus({ ...endpoint, lastLatencyMs: 4_000 }, now)).toBe("degraded");
    expect(endpointStatus({ ...endpoint, consecutiveFailures: 1 }, now)).toBe("degraded");
    expect(endpointStatus({ ...endpoint, consecutiveFailures: 3 }, now)).toBe("major_outage");
    expect(endpointStatus({ ...endpoint, lastCheckedAt: "2026-09-26T09:00:00Z" }, now)).toBe("none");
  });

  it("rates a stretch of time by its failed probes", () => {
    expect(probeState(undefined)).toBe("none");
    expect(probeState({ checks: 60, failures: 0 })).toBe("operational");
    expect(probeState({ checks: 60, failures: 2 })).toBe("degraded");
    expect(probeState({ checks: 60, failures: 30 })).toBe("partial_outage");
    expect(probeState({ checks: 60, failures: 60 })).toBe("major_outage");
  });

  it("calls too few failed probes degraded, not an outage", () => {
    expect(probeState({ checks: 1, failures: 1 })).toBe("degraded");
    expect(probeState({ checks: 2, failures: 2 })).toBe("degraded");
    expect(probeState({ checks: 3, failures: 3 })).toBe("major_outage");
  });

  it("sums counts and averages latency over successful probes only", () => {
    const counts = sumCounts([
      { checks: 2, failures: 1, latencySum: 60 },
      { checks: 2, failures: 1, latencySum: 40 },
    ]);
    expect(counts).toEqual({ checks: 4, failures: 2, latencySum: 100 });
    expect(meanLatency(counts)).toBe(50);
    expect(meanLatency({ checks: 2, failures: 2, latencySum: 0 })).toBeNull();
    expect(probeUptime({ checks: 4, failures: 1 })).toBe(0.75);
    expect(probeUptime({ checks: 0, failures: 0 })).toBeNull();
  });
});
