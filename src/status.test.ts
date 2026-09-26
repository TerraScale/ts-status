import { describe, expect, it } from "vitest";
import {
  buckets,
  combine,
  endpointStatus,
  meanLatency,
  overallStatus,
  probeHourState,
  probeUptime,
  regionStatus,
  segments,
  serviceChanges,
  uptime,
  type Service,
} from "./status";

const H = 3_600_000;

describe("overallStatus", () => {
  it("reports operational when services and incidents are clear", () => {
    expect(overallStatus([{ status: "operational" }], [])).toBe("operational");
  });

  it("takes the worst service status", () => {
    expect(overallStatus([{ status: "degraded" }, { status: "partial_outage" }], [])).toBe("partial_outage");
    expect(overallStatus([{ status: "major_outage" }], [])).toBe("major_outage");
  });

  it("maps active incident impact onto the headline", () => {
    expect(overallStatus([{ status: "operational" }], [{ status: "investigating", impact: "minor" }])).toBe("degraded");
    expect(overallStatus([{ status: "operational" }], [{ status: "monitoring", impact: "critical" }])).toBe(
      "major_outage",
    );
  });

  it("ignores resolved incidents", () => {
    expect(overallStatus([{ status: "operational" }], [{ status: "resolved", impact: "critical" }])).toBe(
      "operational",
    );
  });

  it("treats maintenance as its own state when no outage exists", () => {
    expect(overallStatus([{ status: "maintenance" }], [])).toBe("maintenance");
  });
});

describe("segments", () => {
  it("opens the window in the state already in effect", () => {
    const list = segments(
      [
        { at: 0, status: "major_outage" },
        { at: 5 * H, status: "operational" },
      ],
      2 * H,
      10 * H,
    );
    expect(list).toEqual([
      { from: 2 * H, to: 5 * H, state: "major_outage" },
      { from: 5 * H, to: 10 * H, state: "operational" },
    ]);
  });

  it("marks time before the first event as having no data", () => {
    expect(segments([{ at: 4 * H, status: "operational" }], 0, 8 * H)).toEqual([
      { from: 0, to: 4 * H, state: "none" },
      { from: 4 * H, to: 8 * H, state: "operational" },
    ]);
  });

  it("merges repeated states", () => {
    const list = segments(
      [
        { at: 0, status: "operational" },
        { at: H, status: "operational" },
      ],
      0,
      2 * H,
    );
    expect(list).toEqual([{ from: 0, to: 2 * H, state: "operational" }]);
  });
});

describe("buckets", () => {
  it("shows the worst state inside each bucket", () => {
    const list = segments(
      [
        { at: 0, status: "operational" },
        { at: 1.5 * H, status: "degraded" },
        { at: 1.6 * H, status: "operational" },
      ],
      0,
      3 * H,
    );
    expect(buckets(list, 0, 3 * H, 3).map((bucket) => bucket.state)).toEqual([
      "operational",
      "degraded",
      "operational",
    ]);
  });
});

describe("combine", () => {
  it("takes the worst state across timelines at every moment", () => {
    const a = segments(
      [
        { at: 0, status: "operational" },
        { at: 2 * H, status: "major_outage" },
        { at: 3 * H, status: "operational" },
      ],
      0,
      4 * H,
    );
    const b = segments(
      [
        { at: 0, status: "degraded" },
        { at: H, status: "operational" },
      ],
      0,
      4 * H,
    );
    expect(combine([a, b], 0, 4 * H)).toEqual([
      { from: 0, to: H, state: "degraded" },
      { from: H, to: 2 * H, state: "operational" },
      { from: 2 * H, to: 3 * H, state: "major_outage" },
      { from: 3 * H, to: 4 * H, state: "operational" },
    ]);
  });
});

describe("uptime", () => {
  it("counts outages as downtime and ignores time without data", () => {
    const list = segments(
      [
        { at: H, status: "operational" },
        { at: 3 * H, status: "partial_outage" },
        { at: 4 * H, status: "degraded" },
      ],
      0,
      5 * H,
    );
    expect(uptime(list)).toBe(0.75);
  });

  it("returns null without data", () => {
    expect(uptime(segments([], 0, H))).toBeNull();
  });
});

describe("serviceChanges", () => {
  const service: Service = {
    id: "api",
    name: "API",
    description: "",
    status: "degraded",
    updatedAt: "2026-09-20T10:00:00Z",
  };

  it("closes the timeline with the current status when no event recorded it", () => {
    const changes = serviceChanges(service, [
      { serviceId: "api", status: "operational", label: "", createdAt: "2026-09-20T08:00:00Z" },
      { serviceId: "proxy", status: "major_outage", label: "", createdAt: "2026-09-20T09:00:00Z" },
    ]);
    expect(changes).toEqual([
      { at: Date.parse("2026-09-20T08:00:00Z"), status: "operational" },
      { at: Date.parse("2026-09-20T10:00:00Z"), status: "degraded" },
    ]);
  });
});

describe("regions", () => {
  const now = Date.parse("2026-09-26T10:15:00Z");
  const endpoint = {
    id: "e",
    regionCode: "GRU",
    serviceId: "api",
    cluster: "c",
    provider: "fly" as const,
    lastCheckedAt: "2026-09-26T10:14:00Z",
    lastOk: 1,
    lastLatencyMs: 40,
    consecutiveFailures: 0,
  };

  it("derives a cluster state from its latest probes", () => {
    expect(endpointStatus(endpoint, now)).toBe("operational");
    expect(endpointStatus({ ...endpoint, lastLatencyMs: 4_000 }, now)).toBe("degraded");
    expect(endpointStatus({ ...endpoint, consecutiveFailures: 1 }, now)).toBe("degraded");
    expect(endpointStatus({ ...endpoint, consecutiveFailures: 3 }, now)).toBe("major_outage");
    expect(endpointStatus({ ...endpoint, lastCheckedAt: "2026-09-26T09:00:00Z" }, now)).toBe("none");
  });

  it("reports a region down only when every cluster is down", () => {
    expect(regionStatus(["major_outage", "major_outage"])).toBe("major_outage");
    expect(regionStatus(["major_outage", "operational"])).toBe("partial_outage");
    expect(regionStatus(["degraded", "operational", "none"])).toBe("degraded");
    expect(regionStatus([])).toBe("none");
  });

  it("rates an hour by its failed probes", () => {
    expect(probeHourState(undefined)).toBe("none");
    expect(probeHourState({ checks: 60, failures: 0 })).toBe("operational");
    expect(probeHourState({ checks: 60, failures: 2 })).toBe("degraded");
    expect(probeHourState({ checks: 60, failures: 30 })).toBe("partial_outage");
    expect(probeHourState({ checks: 60, failures: 60 })).toBe("major_outage");
  });

  it("averages latency over successful probes only", () => {
    expect(meanLatency([{ checks: 4, failures: 2, latencySum: 100 }])).toBe(50);
    expect(meanLatency([{ checks: 2, failures: 2, latencySum: 0 }])).toBeNull();
    expect(probeUptime([{ checks: 4, failures: 1 }])).toBe(0.75);
  });

  it("lets a measured outage drive the headline", () => {
    expect(overallStatus([{ status: "operational" }], [], ["partial_outage", "none"])).toBe("partial_outage");
  });
});
