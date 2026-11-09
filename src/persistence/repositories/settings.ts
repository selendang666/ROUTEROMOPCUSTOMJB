import { createDrizzlePG, type DrizzlePG } from "../db.js";
import { settings } from "../schema/pg.js";
import { eq, sql } from "drizzle-orm";

/**
 * `drizzle-orm/bun-sql` re-encodes bound `jsonb` parameters as a JSON
 * *string* scalar instead of an object — true for both `.set({ col: obj })`
 * and `sql\`${obj}::jsonb\`` bound-parameter forms. Embedding the escaped
 * JSON text as a SQL literal (not a bound parameter) sidesteps that layer
 * and lets Postgres's own `::jsonb` cast parse it correctly.
 */
function jsonbLiteral(value: unknown) {
  const text = JSON.stringify(value).replace(/'/g, "''");
  return sql.raw(`'${text}'::jsonb`);
}

/** Creates the settings repository over the canonical Drizzle PostgreSQL client. */
export function createSettingsRepository(db: DrizzlePG = createDrizzlePG()) {
  return {
    async ensure() {
      const rows = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
      if (rows[0]) return rows[0] as unknown as Record<string, unknown>;
      await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
      const again = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
      return again[0] as unknown as Record<string, unknown>;
    },
    async get() {
      const rows = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
      return (rows[0] as unknown as Record<string, unknown> | undefined) ?? null;
    },
    async getSettingsJson(): Promise<Record<string, unknown>> {
      const rows = await db.select({ settingsJson: settings.settingsJson }).from(settings).where(eq(settings.id, 1)).limit(1);
      const value = rows[0]?.settingsJson;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
      return {};
    },
    async patchSettingsJson(patch: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
      const rows = await db.select({ settingsJson: settings.settingsJson }).from(settings).where(eq(settings.id, 1)).limit(1);
      const current = rows[0]?.settingsJson;
      const base = current && typeof current === "object" && !Array.isArray(current)
        ? current as Record<string, unknown>
        : {};
      const merged = { ...base, ...patch };
      await db
        .update(settings)
        .set({ settingsJson: jsonbLiteral(merged) as unknown as Record<string, unknown>, updatedAt: sql`now()` as unknown as string })
        .where(eq(settings.id, 1));
      return merged;
    },
    async getAll() {
      const rows = await db
        .select({
          settingsJson: settings.settingsJson,
          passwordHash: settings.passwordHash,
          passwordVersion: settings.passwordVersion,
          updatedAt: settings.updatedAt,
        })
        .from(settings)
        .where(eq(settings.id, 1))
        .limit(1);
      return (rows[0] as unknown as Record<string, unknown> | undefined) ?? null;
    },
  };
}
