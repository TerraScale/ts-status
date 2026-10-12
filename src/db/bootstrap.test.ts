import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import schema from "../../schema.sql?raw";
import { isId, newId } from "../ids";
import type { Env } from "../env";
import { bootstrap } from "./bootstrap";

const tables = [
  "component_groups",
  "components",
  "endpoints",
  "incidents",
  "incident_updates",
  "subscribers",
  "outbox",
];

describe("clean D1 bootstrap", () => {
  it("recreates an empty store on startup and preserves IDs and operator edits on repeat", async () => {
    const sqlite = new DatabaseSync(":memory:");
    let executions = 0;
    const env = {
      STATUS_DB: {
        exec: async (sql: string) => {
          executions++;
          for (const statement of sql.trim().split("\n")) sqlite.exec(statement);
        },
      },
    } as unknown as Env;
    try {
      await Promise.all([bootstrap(env), bootstrap(env)]);
      expect(executions).toBe(1);
      const ids = sqlite.prepare("SELECT id FROM endpoints ORDER BY id").all();
      expect(ids).toHaveLength(17);
      expect(ids.every((row) => isId(row.id))).toBe(true);
      const incidentId = newId();
      sqlite
        .prepare("INSERT INTO incidents (id, title, status, impact) VALUES (?, 'Outage', 'investigating', 'minor')")
        .run(incidentId);
      sqlite.exec(
        "UPDATE endpoints SET live_since = '2026-10-11 00:00:00'; UPDATE components SET lifecycle = 'planned'",
      );
      sqlite.exec(schema);
      expect(sqlite.prepare("SELECT id FROM endpoints ORDER BY id").all()).toEqual(ids);
      expect(sqlite.prepare("SELECT id FROM incidents").get()?.id).toBe(incidentId);
      expect(sqlite.prepare("SELECT count(*) AS n FROM endpoints WHERE live_since IS NULL").get()?.n).toBe(0);
      expect(sqlite.prepare("SELECT count(*) AS n FROM components WHERE lifecycle = 'active'").get()?.n).toBe(0);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("enforces canonical, non-null primary IDs in every entity table", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(schema);
      const incident = newId(),
        update = newId(),
        subscriber = newId();
      sqlite
        .prepare("INSERT INTO incidents (id, title, status, impact) VALUES (?, 'Outage', 'investigating', 'minor')")
        .run(incident);
      sqlite
        .prepare(
          "INSERT INTO incident_updates (id, incident_id, status, body) VALUES (?, ?, 'investigating', 'Looking.')",
        )
        .run(update, incident);
      sqlite
        .prepare("INSERT INTO subscribers (id, channel, target) VALUES (?, 'email', 'test@example.com')")
        .run(subscriber);
      sqlite
        .prepare("INSERT INTO outbox (id, subscriber_id, kind, update_id) VALUES (?, ?, 'update', ?)")
        .run(newId(), subscriber, update);
      for (const table of tables) {
        const row = sqlite.prepare("SELECT id FROM " + table + " LIMIT 1").get();
        expect(row).toBeDefined();
        for (const id of [null, "legacy", "01m4e7g1w82vkfpf5fj9avk1cv", "8ZZZZZZZZZZZZZZZZZZZZZZZZZ"])
          expect(() => sqlite.prepare("UPDATE " + table + " SET id = ? WHERE id = ?").run(id, row!.id!)).toThrow();
      }
      expect(() =>
        sqlite.exec(
          "INSERT INTO incidents (id, title, status, impact) VALUES ('uuid', 'Outage', 'investigating', 'minor')",
        ),
      ).toThrow(/CHECK/);
    } finally {
      sqlite.close();
    }
  });
});
