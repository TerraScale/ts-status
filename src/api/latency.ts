/* Regional latency from the latest completed UTC hour of D1 rollups. */

import { percentile } from "../domain/histogram";
import type { TimelineState } from "../domain/status";
import { HOUR, startOfHour } from "../format";
import type { Measurements } from "../measure";
import type { RegionOverview } from "../overview";
import { VANTAGES } from "../probe/vantages";

const statuses: Record<TimelineState, "operational" | "degraded" | "down" | "planned"> = {
  operational: "operational",
  degraded: "degraded",
  partial_outage: "down",
  major_outage: "down",
  maintenance: "planned",
  none: "planned",
};

export function regionLatencyDocument(regions: readonly RegionOverview[], measurements: Measurements, now: number) {
  const to = startOfHour(now);
  return {
    generated_at: new Date(now).toISOString(),
    window: "1h",
    regions: regions.map((region) => {
      const ids = region.clusters.map((cluster) => cluster.id);
      const stats = (vantage: string) => {
        const { hist } = measurements.counts(ids, vantage, to - HOUR, to, HOUR);
        return {
          median_ms: percentile(hist, 0.5),
          p95_ms: percentile(hist, 0.95),
          samples: hist.reduce((sum, count) => sum + count, 0),
        };
      };
      return {
        code: region.code.toLowerCase(),
        name: region.name,
        ping_url: region.pingUrl,
        status: statuses[region.status],
        consensus: stats("all"),
        vantages: VANTAGES.map(({ code, name }) => ({ code, name, ...stats(code) })),
      };
    }),
  };
}
