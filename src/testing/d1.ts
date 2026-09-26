/* A D1 stand-in for tests: an in-memory SQLite database with every
   migration applied, answering the subset of the D1 API the Worker uses. */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(fileURLToPath(import.meta.url), "../../../migrations");

type Value = string | number | boolean | null;

interface Executed {
  results: unknown[];
  success: true;
  meta: { changes: number };
}

interface Statement {
  bind: (...values: Value[]) => Statement;
  all: <T>() => Promise<{ results: T[]; success: true }>;
  first: <T>() => Promise<T | null>;
  run: () => Promise<Executed>;
  execute: () => Executed;
}

export interface TestD1 {
  sqlite: DatabaseSync;
  /** Statements run, for asserting on round trips. */
  batches: number;
}

export function testD1(): D1Database & TestD1 {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }

  const statement = (sql: string, values: Value[] = []): Statement => {
    const params = values.map((value): SQLInputValue => (typeof value === "boolean" ? Number(value) : value));
    const execute = () => {
      const prepared = sqlite.prepare(sql);
      if (prepared.columns().length > 0) {
        return { results: prepared.all(...params) as unknown[], success: true as const, meta: { changes: 0 } };
      }
      const { changes } = prepared.run(...params);
      return { results: [] as unknown[], success: true as const, meta: { changes: Number(changes) } };
    };
    return {
      bind: (...next) => statement(sql, next),
      all: async <T>() => execute() as { results: T[]; success: true },
      first: async <T>() => (execute().results[0] ?? null) as T | null,
      run: async () => execute(),
      execute,
    };
  };

  const db = {
    sqlite,
    batches: 0,
    prepare: (sql: string) => statement(sql),
    batch: async (list: Statement[]) => {
      db.batches += 1;
      sqlite.exec("BEGIN");
      try {
        const results = list.map((item) => item.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    withSession: () => db,
  };
  return db as unknown as D1Database & TestD1;
}
