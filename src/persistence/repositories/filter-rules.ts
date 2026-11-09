import { toIso } from "../crypto.js";
import { filterRules } from "../schema/pg.js";
import { createDrizzlePG, type DrizzlePG } from "../db.js";
import { eq, sql } from "drizzle-orm";

export interface FilterRuleRecord {
  readonly id: number;
  readonly ruleId: string;
  readonly pattern: string;
  readonly replacement: string;
  readonly isActive: boolean;
  readonly isRegex: boolean;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FilterRuleRepositoryShape {
  list(): Promise<readonly FilterRuleRecord[]>;
  get(id: number): Promise<FilterRuleRecord | null>;
  create(input: { pattern: string; replacement: string; isRegex: boolean; isActive?: boolean; sortOrder?: number; ruleId?: string }): Promise<FilterRuleRecord>;
  update(id: number, patch: { pattern?: string; replacement?: string; isRegex?: boolean; isActive?: boolean; sortOrder?: number }): Promise<FilterRuleRecord | null>;
  remove(id: number): Promise<boolean>;
}

function mapFilterRow(row: Record<string, unknown>): FilterRuleRecord {
  // Drizzle returns camelCase keys; support snake_case fallback for legacy mocks
  const r = row as unknown as {
    id?: unknown;
    ruleId?: unknown;
    rule_id?: unknown;
    pattern?: unknown;
    replacement?: unknown;
    isActive?: unknown;
    is_active?: unknown;
    isRegex?: unknown;
    is_regex?: unknown;
    sortOrder?: unknown;
    sort_order?: unknown;
    createdAt?: unknown;
    created_at?: unknown;
    updatedAt?: unknown;
    updated_at?: unknown;
  };
  return {
    id: Number(r.id),
    ruleId: String(r.ruleId ?? r.rule_id),
    pattern: String(r.pattern),
    replacement: String(r.replacement),
    isActive: Boolean(r.isActive ?? r.is_active),
    isRegex: Boolean(r.isRegex ?? r.is_regex),
    sortOrder: Number(r.sortOrder ?? r.sort_order),
    createdAt: toIso(r.createdAt ?? r.created_at)!,
    updatedAt: toIso(r.updatedAt ?? r.updated_at)!,
  };
}

export function createFilterRuleRepository(db: DrizzlePG = createDrizzlePG()): FilterRuleRepositoryShape {
  return {
    async list(): Promise<readonly FilterRuleRecord[]> {
      const rows = await db.select().from(filterRules).orderBy(filterRules.sortOrder, filterRules.id);
      return rows.map((r) => mapFilterRow(r as unknown as Record<string, unknown>));
    },

    async get(id: number): Promise<FilterRuleRecord | null> {
      const rows = await db.select().from(filterRules).where(eq(filterRules.id, id)).limit(1);
      const row = rows[0] as unknown as Record<string, unknown> | undefined;
      return row ? mapFilterRow(row) : null;
    },

    async create(input: { pattern: string; replacement: string; isRegex: boolean; isActive?: boolean; sortOrder?: number; ruleId?: string }): Promise<FilterRuleRecord> {
      const ruleId = input.ruleId?.trim() || `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const maxRows = await db
          .select({ m: sql<number>`COALESCE(MAX(${filterRules.sortOrder}), 0)` })
          .from(filterRules);
        const firstMax = maxRows[0] as unknown as { m: number | null } | undefined;
        const maxValue = firstMax?.m;
        sortOrder = Number(maxValue ?? 0) + 10;
      }
      const rows = await db
        .insert(filterRules)
        .values({
          ruleId,
          pattern: input.pattern,
          replacement: input.replacement,
          isActive: input.isActive !== false,
          isRegex: input.isRegex,
          sortOrder: sortOrder as number,
        } as never)
        .returning();
      return mapFilterRow(rows[0] as unknown as Record<string, unknown>);
    },

    async update(id: number, patch: { pattern?: string; replacement?: string; isRegex?: boolean; isActive?: boolean; sortOrder?: number }): Promise<FilterRuleRecord | null> {
      const set: Record<string, unknown> = {};
      if (patch.pattern !== undefined) set.pattern = patch.pattern;
      if (patch.replacement !== undefined) set.replacement = patch.replacement;
      if (patch.isRegex !== undefined) set.isRegex = patch.isRegex;
      if (patch.isActive !== undefined) set.isActive = patch.isActive;
      if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;

      if (Object.keys(set).length === 0) {
        await db
          .update(filterRules)
          .set({ updatedAt: sql`now()` as unknown as string } as never)
          .where(eq(filterRules.id, id));
      } else {
        await db
          .update(filterRules)
          .set({ ...set, updatedAt: sql`now()` as unknown as string } as never)
          .where(eq(filterRules.id, id));
      }
      const rows = await db.select().from(filterRules).where(eq(filterRules.id, id)).limit(1);
      const row = rows[0] as unknown as Record<string, unknown> | undefined;
      return row ? mapFilterRow(row) : null;
    },

    async remove(id: number): Promise<boolean> {
      const existing = await db.select({ id: filterRules.id }).from(filterRules).where(eq(filterRules.id, id)).limit(1);
      if (existing.length === 0) return false;
      await db.delete(filterRules).where(eq(filterRules.id, id));
      const check = await db.select({ id: filterRules.id }).from(filterRules).where(eq(filterRules.id, id)).limit(1);
      return check.length === 0;
    },
  };
}
