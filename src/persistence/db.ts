import { drizzle as drizzleBunSql } from "drizzle-orm/bun-sql";
import type { SQL } from "bun";

import { getPool } from "./pool.js";
import * as pgSchema from "./schema/pg.js";

/**
 * Create a Drizzle PostgreSQL client wrapping the existing Bun.SQL singleton.
 *
 * @param client - Bun SQL client; defaults to the process singleton from pool.ts
 * @returns typed Drizzle PG database bound to the canonical PostgreSQL schema
 */
export function createDrizzlePG(
  client: SQL = getPool() as unknown as SQL,
) {
  return drizzleBunSql(client as unknown as never, { schema: pgSchema });
}

export type DrizzlePG = ReturnType<typeof createDrizzlePG>;
