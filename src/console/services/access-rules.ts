import type { PostgresPool } from "../../persistence/pool.js";

/**
 * Routes (access_rules) console service — verbatim from bootstrap 871-884.
 */
export function createRoutesService(pool: PostgresPool) {
  return {
    async list() { const rows = (await pool`SELECT scope, mode FROM access_rules ORDER BY scope`) as unknown as unknown[]; return rows; },
    async create(body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      await pool`INSERT INTO access_rules (scope, mode, entries_json) VALUES (${String(v.scope ?? "default")}, ${String(v.mode ?? "open")}, ${v.entries ?? []}::jsonb) ON CONFLICT (scope) DO UPDATE SET mode = EXCLUDED.mode, entries_json = EXCLUDED.entries_json`;
      return { ok: true, status: 201, data: {} };
    },
    async update(id: string, body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      await pool`UPDATE access_rules SET mode = ${String(v.mode ?? "open")}, entries_json = ${v.entries ?? []}::jsonb, updated_at = now() WHERE scope = ${id}`;
      return { ok: true, status: 200, data: {} };
    },
    async remove(id: string) { await pool`DELETE FROM access_rules WHERE scope = ${id}`; return { ok: true, status: 200, data: {} }; },
  };
}
