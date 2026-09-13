import { describe, expect, it } from "vitest";
import { overallStatus } from "./status";
describe("overallStatus", () => {
  it("reports operational when services and incidents are clear", () => { expect(overallStatus([{ status: "operational" }], [])).toBe("operational"); });
  it("prioritizes a major outage and active critical incident", () => {
    expect(overallStatus([{ status: "major_outage" }], [])).toBe("major_outage");
    expect(overallStatus([{ status: "operational" }], [{ status: "investigating", impact: "critical" }])).toBe("major_outage");
  });
  it("treats maintenance as its own state when no outage exists", () => { expect(overallStatus([{ status: "maintenance" }], [])).toBe("maintenance"); });
});
