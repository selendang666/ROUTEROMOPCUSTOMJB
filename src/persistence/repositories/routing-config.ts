import { createDrizzlePG, type DrizzlePG } from "../db.js";
import { providerModels, modelAliases, combos } from "../schema/pg.js";
import { eq, sql } from "drizzle-orm";

function toSnakeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const [k, v] of Object.entries(row)) {
    const snake = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (!(snake in out)) out[snake] = v;
  }
  return out;
}

/** Owns model, alias, and combo configuration persisted for routing. */
export function createRoutingConfigRepository(
  db: DrizzlePG = createDrizzlePG(),
  options: { readonly onMutation?: () => void } = {},
) {
  // sql is imported per spec; reference to avoid unused-import error when jsonb is handled natively
  void sql;

  return {
    async listModels(provider?: string) {
      const rows = provider
        ? await db.select().from(providerModels).where(eq(providerModels.provider, provider)).orderBy(providerModels.modelId)
        : await db.select().from(providerModels).orderBy(providerModels.provider, providerModels.modelId);
      return rows.map((r) => toSnakeRow(r as unknown as Record<string, unknown>)) as unknown as Array<Record<string, unknown>>;
    },
    async listAliases() {
      const rows = await db.select().from(modelAliases).orderBy(modelAliases.alias);
      return rows.map((r) => toSnakeRow(r as unknown as Record<string, unknown>)) as unknown as Array<Record<string, unknown>>;
    },
    async createAlias(alias: string, model: string) {
      await db.insert(modelAliases).values({ alias, model }).onConflictDoUpdate({ target: modelAliases.alias, set: { model } });
      options.onMutation?.();
    },
    async removeAlias(alias: string) {
      await db.delete(modelAliases).where(eq(modelAliases.alias, alias));
      options.onMutation?.();
    },
    async listCombos() {
      const rows = await db.select().from(combos).orderBy(combos.name);
      return rows.map((r) => toSnakeRow(r as unknown as Record<string, unknown>)) as unknown as Array<Record<string, unknown>>;
    },
    async createCombo(input: { id: string; name: string; models: readonly string[]; strategy?: string; stickyLimit?: number }) {
      await db.insert(combos).values({
        id: input.id,
        name: input.name,
        modelsJson: input.models as unknown as never,
        strategy: (input.strategy ?? "fallback") as unknown as never,
        stickyLimit: (input.stickyLimit ?? 0) as unknown as never,
      } as never);
      options.onMutation?.();
      const rows = await db.select({ id: combos.id }).from(combos).where(eq(combos.id, input.id)).limit(1);
      return (rows[0] as unknown as Record<string, unknown>)!;
    },
    async removeCombo(id: string) {
      await db.delete(combos).where(eq(combos.id, id));
      options.onMutation?.();
    },
  };
}
