import { cliTools, cliMappings } from "../schema/pg.js";
import { createDrizzlePG, type DrizzlePG } from "../db.js";
import { eq, and, sql } from "drizzle-orm";

export interface CliMappingRepositoryShape {
  getSettings(toolId: string): { enabled?: boolean; allowedApiKeyIds?: string[] } | null | Promise<{ enabled?: boolean; allowedApiKeyIds?: string[] } | null>;
  list(toolId: string): Array<{ slotKey: string; sourceModel: string; targetModel: string; enabled: boolean }> | Promise<Array<{ slotKey: string; sourceModel: string; targetModel: string; enabled: boolean }>>;
  setEnabled(toolId: string, enabled: boolean, allowedApiKeyIds?: readonly string[]): void | Promise<void>;
  upsert(input: { toolId: string; slotKey: string; sourceModel: string; targetModel: string; enabled: boolean }): void | Promise<void>;
  delete(toolId: string, slotKey: string): void | Promise<void>;
  reset(toolId: string): void | Promise<void>;
}

export function createCliMappingRepository(db: DrizzlePG = createDrizzlePG()): CliMappingRepositoryShape {
  return {
    async getSettings(toolId: string): Promise<{ enabled?: boolean; allowedApiKeyIds?: string[] } | null> {
      const rows = await db.select().from(cliTools).where(eq(cliTools.toolId, toolId)).limit(1);
      const row = rows[0] as unknown as { enabled: boolean; allowedApiKeyIds: unknown } | undefined;
      if (!row) return null;
      let allowed: string[] = [];
      try {
        const raw = row.allowedApiKeyIds;
        if (Array.isArray(raw)) allowed = raw.filter((v): v is string => typeof v === "string");
        else if (typeof raw === "string") {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) allowed = parsed.filter((v): v is string => typeof v === "string");
        }
      } catch {}
      return { enabled: Boolean(row.enabled), allowedApiKeyIds: allowed };
    },
    async list(toolId: string): Promise<Array<{ slotKey: string; sourceModel: string; targetModel: string; enabled: boolean }>> {
      const rows = await db.select().from(cliMappings).where(eq(cliMappings.toolId, toolId)).orderBy(cliMappings.slotKey);
      return rows.map((r) => ({ slotKey: r.slotKey, sourceModel: r.sourceModel, targetModel: r.targetModel, enabled: Boolean(r.enabled) }));
    },
    async setEnabled(toolId: string, enabled: boolean, allowedApiKeyIds: readonly string[] = []): Promise<void> {
      await db
        .insert(cliTools)
        .values({
          toolId,
          enabled,
          allowedApiKeyIds: allowedApiKeyIds as unknown as never,
          updatedAt: sql`now()` as unknown as string,
        })
        .onConflictDoUpdate({
          target: cliTools.toolId,
          set: {
            enabled,
            allowedApiKeyIds: allowedApiKeyIds as unknown as never,
            updatedAt: sql`now()` as unknown as string,
          },
        });
    },
    async upsert(input: { toolId: string; slotKey: string; sourceModel: string; targetModel: string; enabled: boolean }): Promise<void> {
      await db
        .insert(cliMappings)
        .values({
          toolId: input.toolId,
          slotKey: input.slotKey,
          sourceModel: input.sourceModel,
          targetModel: input.targetModel,
          enabled: input.enabled,
        })
        .onConflictDoUpdate({
          target: [cliMappings.toolId, cliMappings.slotKey],
          set: {
            sourceModel: input.sourceModel,
            targetModel: input.targetModel,
            enabled: input.enabled,
            updatedAt: sql`now()` as unknown as string,
          },
        });
    },
    async delete(toolId: string, slotKey: string): Promise<void> {
      await db.delete(cliMappings).where(and(eq(cliMappings.toolId, toolId), eq(cliMappings.slotKey, slotKey)));
    },
    async reset(toolId: string): Promise<void> {
      await db.delete(cliMappings).where(eq(cliMappings.toolId, toolId));
      await db.delete(cliTools).where(eq(cliTools.toolId, toolId));
    },
  };
}
