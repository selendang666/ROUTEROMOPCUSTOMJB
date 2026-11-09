import { describe, expect, test } from "bun:test";
import { getMigrationStatus, runMigrations } from "./migrate.js";
import type { PostgresPool } from "./pool.js";

interface LedgerRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at?: string;
}

interface MockPoolState {
  readonly applied: Map<number, LedgerRow>;
  readonly events: string[];
  readonly appliedSql: string[];
}

function createMockPool(seed: readonly LedgerRow[] = []): { readonly pool: PostgresPool; readonly state: MockPoolState } {
  const state: MockPoolState = {
    applied: new Map(seed.map((row) => [row.version, row])),
    events: [],
    appliedSql: [],
  };

  const query = async (strings: TemplateStringsArray, values: readonly unknown[]): Promise<unknown[]> => {
    const text = strings.join("?");
    if (text.includes("CREATE TABLE IF NOT EXISTS schema_migrations")) return [];
    if (text.includes("pg_advisory_lock")) {
      state.events.push("lock");
      return [];
    }
    if (text.includes("pg_advisory_unlock")) {
      state.events.push("unlock");
      return [];
    }
    if (text.includes("SELECT version, name, checksum, applied_at FROM schema_migrations")) {
      return [...state.applied.values()]
        .sort((a, b) => a.version - b.version)
        .map((row) => ({ ...row, applied_at: row.applied_at ?? "2024-01-01T00:00:00.000Z" }));
    }
    if (text.includes("SELECT version, name, checksum FROM schema_migrations")) {
      return [...state.applied.values()]
        .sort((a, b) => a.version - b.version)
        .map((row) => ({ version: row.version, name: row.name, checksum: row.checksum }));
    }
    if (text.includes("INSERT INTO schema_migrations")) {
      const [version, name, checksum] = values;
      state.applied.set(Number(version), { version: Number(version), name: String(name), checksum: String(checksum) });
      state.events.push(`ledger:${String(version)}`);
      return [];
    }
    return [];
  };

  const pool = (async (strings: TemplateStringsArray, ...values: unknown[]) => query(strings, values)) as unknown as PostgresPool;
  (pool as unknown as { begin: (callback: (tx: PostgresPool) => Promise<void>) => Promise<void> }).begin = async (callback) => {
    state.events.push("begin");
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => query(strings, values)) as unknown as PostgresPool;
    (tx as unknown as { unsafe: (sql: string) => Promise<unknown[]> }).unsafe = async (sql) => {
      state.appliedSql.push(sql);
      state.events.push("sql");
      return [];
    };
    await callback(tx);
    state.events.push("commit");
  };

  return { pool, state };
}

describe("Drizzle-backed PostgreSQL migrations", () => {
  test("reports pending then clean status after applying Drizzle output migrations", async () => {
    const { pool, state } = createMockPool();

    const before = await getMigrationStatus(pool);
    expect(before.ok).toBe(false);
    expect(before.currentVersion).toBeNull();
    expect(before.expectedVersion).toBe(25);
    expect(before.pending).toHaveLength(25);
    expect(before.pending[0]?.name).toBe("001_initial.sql");

    const result = await runMigrations(pool);
    expect(result).toEqual({ applied: 25, currentVersion: 25 });
    expect(state.appliedSql).toHaveLength(25);
    expect(state.appliedSql[0]).toContain("CREATE TABLE IF NOT EXISTS settings");

    const after = await getMigrationStatus(pool);
    expect(after.ok).toBe(true);
    expect(after.currentVersion).toBe(25);
    expect(after.pending).toHaveLength(0);
  });

  test("fails closed when an applied migration checksum differs", async () => {
    const { pool: sourcePool } = createMockPool();
    const sourceStatus = await getMigrationStatus(sourcePool);
    const first = sourceStatus.pending[0];
    expect(first).toBeDefined();

    const { pool, state } = createMockPool([{ version: first!.version, name: first!.name, checksum: "bad-checksum" }]);
    await expect(runMigrations(pool)).rejects.toThrow("checksum/name mismatch");
    expect(state.events).toEqual(["lock", "unlock"]);
  });

  test("detects gaps in the applied migration ledger", async () => {
    const { pool: sourcePool } = createMockPool();
    const sourceStatus = await getMigrationStatus(sourcePool);
    const second = sourceStatus.pending[1];
    expect(second).toBeDefined();

    const { pool } = createMockPool([{ version: second!.version, name: second!.name, checksum: second!.checksum }]);
    await expect(runMigrations(pool)).rejects.toThrow("Missing migration 1");
  });

  test("uses the PostgreSQL advisory lock around migration execution", async () => {
    const { pool, state } = createMockPool();
    await runMigrations(pool);

    expect(state.events[0]).toBe("lock");
    expect(state.events.at(-1)).toBe("unlock");
    expect(state.events.indexOf("unlock")).toBeGreaterThan(state.events.lastIndexOf("commit"));
  });
});
