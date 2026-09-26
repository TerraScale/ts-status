import { describe, expect, it } from "vitest";
import type { Recent } from "../db/reads";
import type { Incident } from "../domain/status";
import { badge } from "./badge";
import { atom, calendar, rss } from "./feeds";

const base: Incident = {
  id: "i1",
  kind: "incident",
  title: "Dashboard <down>",
  status: "resolved",
  impact: "major",
  source: "manual",
  message: "Fixed, finally; really.",
  components: ["dashboard"],
  scheduledStart: null,
  scheduledEnd: null,
  createdAt: "2026-09-26T10:00:00Z",
  updatedAt: "2026-09-26T11:00:00Z",
  resolvedAt: "2026-09-26T11:00:00Z",
};

const recent: Recent = {
  incidents: [
    base,
    {
      ...base,
      id: "m1",
      kind: "maintenance",
      title: "A very long maintenance title that goes on and on, well past the folding limit of calendars",
      status: "scheduled",
      scheduledStart: "2026-10-01T02:00:00Z",
      scheduledEnd: "2026-10-01T03:00:00Z",
      resolvedAt: null,
    },
  ],
  updates: [
    { id: "u1", incidentId: "i1", status: "resolved", body: "Fixed <now>.", createdAt: "2026-09-26T11:00:00Z" },
  ],
  components: [],
};

describe("feeds", () => {
  it("escapes Atom and RSS entries", () => {
    const feed = atom(recent, "https://s.test", 0);
    expect(feed).toContain("<title>Incident: Dashboard &lt;down&gt;</title>");
    expect(feed).toContain("&lt;p&gt;&lt;strong&gt;resolved");
    expect(feed).toContain("Fixed &amp;lt;now&amp;gt;.");
    expect(rss(recent, "https://s.test", 0)).toContain('<guid isPermaLink="true">https://s.test/incidents/i1</guid>');
  });

  it("writes a valid calendar of maintenance only, with folded lines", () => {
    const ics = calendar(recent, "https://s.test", 0);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain("DTSTART:20261001T020000Z");
    expect(ics).toContain(String.raw`DESCRIPTION:Fixed\, finally\; really.`);
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
});

describe("badge", () => {
  it("names the state in color and escapes its label", () => {
    const svg = badge("A&B", "degraded");
    expect(svg).toContain("A&amp;B");
    expect(svg).toContain("#fbbf24");
    expect(svg).toContain("Degraded performance");
  });
});
