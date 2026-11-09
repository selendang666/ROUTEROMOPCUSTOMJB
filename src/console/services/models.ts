import type { PostgresPool } from "../../persistence/pool.js";

/**
 * Models + aliases + combos console service — verbatim from bootstrap 836-870.
 */
export function createModelsService(pool: PostgresPool, onMutation: () => void = () => {}) {
  return {
    async list() {
      const rows = (await pool`SELECT provider, model_id, enabled FROM provider_models ORDER BY provider, model_id`) as unknown as unknown[];
      return rows;
    },
    aliases: {
      async list() { const rows = (await pool`SELECT alias, model FROM model_aliases ORDER BY alias`) as unknown as unknown[]; return rows; },
      async create(body: unknown) {
        const v = (body ?? {}) as Record<string, unknown>;
        if (!v.alias || !v.model) return { ok: false, status: 400, message: "alias and model required" };
        await pool`INSERT INTO model_aliases (alias, model) VALUES (${String(v.alias)}, ${String(v.model)}) ON CONFLICT (alias) DO UPDATE SET model = EXCLUDED.model`;
        onMutation();
        return { ok: true, status: 201, data: {} };
      },
      async patch(id: string, body: unknown) {
        const v = (body ?? {}) as Record<string, unknown>;
        if (!v.model) return { ok: false, status: 400, message: "model required" };
        await pool`UPDATE model_aliases SET model = ${String(v.model)} WHERE alias = ${id}`;
        onMutation();
        return { ok: true, status: 200, data: {} };
      },
      async remove(id: string) { await pool`DELETE FROM model_aliases WHERE alias = ${id}`; onMutation(); return { ok: true, status: 200, data: {} }; },
    },
    combos: {
      async list() { const rows = (await pool`SELECT id, name FROM combos ORDER BY name`) as unknown as unknown[]; return rows; },
      async create(body: unknown) {
        const v = (body ?? {}) as Record<string, unknown>;
        const id = typeof v.id === "string" ? v.id : crypto.randomUUID();
        await pool`INSERT INTO combos (id, name, models_json) VALUES (${id}, ${String(v.name ?? id)}, ${v.models ?? []}::jsonb)`;
        onMutation();
        return { ok: true, status: 201, data: { id } };
      },
      async remove(id: string) { await pool`DELETE FROM combos WHERE id = ${id}`; onMutation(); return { ok: true, status: 200, data: {} }; },
      async patch(id: string, body: unknown) {
        const v = (body ?? {}) as Record<string, unknown>;
        if (v.name !== undefined) await pool`UPDATE combos SET name = ${String(v.name)}, updated_at = now() WHERE id = ${id}`;
        if (v.models !== undefined) await pool`UPDATE combos SET models_json = ${v.models}::jsonb, updated_at = now() WHERE id = ${id}`;
        if (v.strategy !== undefined) await pool`UPDATE combos SET strategy = ${String(v.strategy)}, updated_at = now() WHERE id = ${id}`;
        const sticky = (v.stickyLimit as unknown) ?? (v.sticky_limit as unknown);
        if (sticky !== undefined) await pool`UPDATE combos SET sticky_limit = ${Number(sticky as number)}, updated_at = now() WHERE id = ${id}`;
        onMutation();
        return { ok: true, status: 200, data: {} };
      },
    },
  };
}
