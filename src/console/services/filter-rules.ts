import type { PostgresPool } from "../../persistence/pool.js";
import { createDrizzlePG } from "../../persistence/db.js";
import { createFilterRuleRepository } from "../../persistence/repositories/filter-rules.js";
import { validateFilterRuleInput } from "../../compression/filter-policy.js";

/**
 * FilterRules console service — verbatim from bootstrap 1172-1225.
 */
export function createFilterRulesService(pool: PostgresPool) {
  const repo = createFilterRuleRepository(createDrizzlePG(pool));
  return {
    async list() {
      const rules = await repo.list();
      return { count: rules.length, activeCount: rules.filter((r) => r.isActive).length, rules };
    },
    async create(body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      const input = {
        pattern: typeof v.pattern === "string" ? v.pattern : "",
        replacement: typeof v.replacement === "string" ? v.replacement : "",
        isRegex: v.isRegex !== false,
        isActive: v.isActive !== false,
        sortOrder: typeof v.sortOrder === "number" ? v.sortOrder : undefined,
        ruleId: typeof v.ruleId === "string" ? v.ruleId : undefined,
      };
      const validation = validateFilterRuleInput(input);
      if (!validation.ok) return { ok: false, status: 400, message: validation.reason };
      const created = await repo.create(input);
      return { ok: true, status: 201, data: created };
    },
    async update(id: string, body: unknown) {
      const numericId = Number(id);
      if (!Number.isInteger(numericId)) return { ok: false, status: 400, message: "invalid id" };
      const v = (body ?? {}) as Record<string, unknown>;
      const patch: { pattern?: string; replacement?: string; isRegex?: boolean; isActive?: boolean; sortOrder?: number } = {};
      if (v.pattern !== undefined) patch.pattern = String(v.pattern);
      if (v.replacement !== undefined) patch.replacement = String(v.replacement);
      if (v.isRegex !== undefined) patch.isRegex = Boolean(v.isRegex);
      if (v.isActive !== undefined) patch.isActive = Boolean(v.isActive);
      if (v.sortOrder !== undefined) patch.sortOrder = Number(v.sortOrder);
      if (patch.pattern !== undefined || patch.isRegex !== undefined) {
        const merged = {
          pattern: patch.pattern ?? (await repo.get(numericId))?.pattern ?? "",
          isRegex: patch.isRegex ?? (await repo.get(numericId))?.isRegex ?? true,
        };
        const validation = validateFilterRuleInput({ pattern: merged.pattern, replacement: "", isRegex: merged.isRegex });
        if (!validation.ok) return { ok: false, status: 400, message: validation.reason };
      }
      const updated = await repo.update(numericId, patch);
      if (updated === null) return { ok: false, status: 404, message: "filter rule not found" };
      return { ok: true, status: 200, data: updated };
    },
    async remove(id: string) {
      const numericId = Number(id);
      if (!Number.isInteger(numericId)) return { ok: false, status: 400, message: "invalid id" };
      const existed = await repo.get(numericId);
      if (existed === null) return { ok: false, status: 404, message: "filter rule not found" };
      await repo.remove(numericId);
      return { ok: true, status: 200, data: { ok: true } };
    },
  };
}
