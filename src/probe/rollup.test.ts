import { describe, expect, it } from "vitest";
import { sqlTime } from "../db/reads";
import { testD1 } from "../testing/d1";
import { rollupStatements } from "./rollup";

const at = (text: string) => Date.parse(text);

function seed() {
  const db = testD1();
  const insert = db.sqlite.prepare(
    "INSERT INTO probe_samples (endpoint_id, at, state, ok, total, latency_ms, results) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const sample = (time: string, state: string, results: { v: string; ok: number; ms: number }[]) => {
    const passed = results.filter((result) => result.ok === 1).map((result) => result.ms);
    insert.run(
      "git-forgejo",
      sqlTime(at(time)),
      state,
      passed.length,
      results.length,
      passed.length ? passed.sort((a, b) => a - b)[Math.floor(passed.length / 2)]! : null,
      JSON.stringify(results.map((result) => ({ ...result, e: null }))),
    );
  };
  sample("2026-09-26T10:00:00Z", "operational", [
    { v: "sfo", ok: 1, ms: 40 },
    { v: "fra", ok: 1, ms: 120 },
  ]);
  sample("2026-09-26T10:00:30Z", "degraded", [
    { v: "sfo", ok: 1, ms: 60 },
    { v: "fra", ok: 0, ms: 5_000 },
  ]);
  sample("2026-09-26T10:01:00Z", "major_outage", [
    { v: "sfo", ok: 0, ms: 5_000 },
    { v: "fra", ok: 0, ms: 5_000 },
  ]);
  // A round only one vantage answered is not judged.
  sample("2026-09-26T10:01:30Z", "none", [{ v: "sfo", ok: 1, ms: 50 }]);
  return db;
}

describe("rollupStatements", () => {
  it("rebuilds the consensus and per-vantage hours, idempotently", async () => {
    const db = seed();
    const now = at("2026-09-26T10:10:00Z");
    await db.batch(rollupStatements(db, ["git-forgejo"], now));
    await db.batch(rollupStatements(db, ["git-forgejo"], now));

    const hours = db.sqlite
      .prepare("SELECT vantage, checks, failures, degraded, latency_sum, latency_max FROM probe_hours ORDER BY vantage")
      .all();
    expect(hours).toEqual([
      { vantage: "all", checks: 3, failures: 1, degraded: 1, latency_sum: 120 + 60, latency_max: 120 },
      { vantage: "fra", checks: 3, failures: 2, degraded: 0, latency_sum: 120, latency_max: 120 },
      { vantage: "sfo", checks: 4, failures: 1, degraded: 0, latency_sum: 150, latency_max: 60 },
    ]);
    const days = db.sqlite.prepare("SELECT vantage, checks, failures, hist FROM probe_days ORDER BY vantage").all();
    expect(days[0]).toMatchObject({ vantage: "all", checks: 3, failures: 1 });
    expect(JSON.parse(String(days[0]?.hist)).slice(0, 3)).toEqual([0, 1, 1]);
  });

  it("settles the previous hour and day, and prunes once a day", () => {
    const db = testD1();
    const count = (now: string) => rollupStatements(db, ["a"], at(now)).length;
    // Mid-hour: this hour (all + vantages), no day refresh off the ten-minute mark.
    expect(count("2026-09-26T10:31:00Z")).toBe(2);
    // On the ten-minute mark the open day is refreshed too.
    expect(count("2026-09-26T10:30:00Z")).toBe(3);
    // Just after midnight: both hours, yesterday and today.
    expect(count("2026-09-27T00:02:00Z")).toBe(4 + 2);
    // Once yesterday settles: this hour, yesterday, and the three prunes.
    expect(count("2026-09-27T00:03:30Z")).toBe(2 + 1 + 3);
  });
});
