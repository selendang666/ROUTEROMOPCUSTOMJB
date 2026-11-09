/**
 * CLI Tools console port — thin adapter over CliToolService.
 *
 * Exposes the operations consumed by the console router. The router registers
 * the HTTP routes inline (so the shared session guard applies); this module
 * only owns request-body parsing + service dispatch.
 *
 * Endpoints served by the console router:
 *   GET    /console/api/cli-tools/registry
 *   GET    /console/api/cli-tools/all-statuses
 *   GET    /console/api/cli-tools/:toolId
 *   GET    /console/api/cli-tools/:toolId/mappings
 *   POST   /console/api/cli-tools/:toolId
 *   POST   /console/api/cli-tools/:toolId/mappings
 *   DELETE /console/api/cli-tools/:toolId
 *   POST   /console/api/cli-tools/:toolId/download
 *
 * Adapted from Oh My Omop - Router-20-beta/src/console/cli-tools/api-routes.ts for
 * PostgreSQL persistence (src/persistence/store). MITM tools are not included.
 */

import type { CliMappingRepositoryShape } from "../../persistence/repositories/cli-tools.js";
import { CliToolService } from "./service.js";
import type { ApplyInput, ApplyResult, CliMappingInput, CliMappingSettings, DownloadResult, ToolStatus } from "./types.js";

export function parseMapping(value: unknown): CliMappingInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const rawMappings = Array.isArray(candidate.mappings) ? candidate.mappings : [];
  const mappings = rawMappings.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.slotKey !== "string" || typeof row.sourceModel !== "string" || typeof row.targetModel !== "string") return [];
    return [{
      slotKey: row.slotKey,
      sourceModel: row.sourceModel,
      targetModel: row.targetModel,
      enabled: row.enabled !== false,
    }];
  });
  const rawAllowed = Array.isArray(candidate.allowedApiKeyIds) ? candidate.allowedApiKeyIds.filter((v): v is string => typeof v === "string") : [];
  return { enabled: candidate.enabled === true, mappings, allowedApiKeyIds: rawAllowed };
}

export function parseApplyInput(body: unknown): ApplyInput {
  const value = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const rawSlots = typeof value.modelSlots === "object" && value.modelSlots !== null && !Array.isArray(value.modelSlots) ? value.modelSlots as Record<string, unknown> : {};
  return {
    endpoint: typeof value.endpoint === "string" ? value.endpoint : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    models: Array.isArray(value.models) ? value.models.filter((model): model is string => typeof model === "string") : [],
    modelSlots: Object.fromEntries(Object.entries(rawSlots).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    activeModel: typeof value.activeModel === "string" ? value.activeModel : undefined,
    subagentModel: typeof value.subagentModel === "string" ? value.subagentModel : undefined,
    mapping: parseMapping(value.mapping),
    bypassPermissions: value.bypassPermissions === true,
  };
}

/** Console-facing port surface for CLI tools. */
export interface CliToolsPort {
  registry(): ReturnType<CliToolService["getRegistry"]>;
  allStatuses(): Promise<Readonly<Record<string, ToolStatus>>>;
  status(toolId: string): Promise<ToolStatus | null>;
  isValidTool(toolId: string): boolean;
  getMappings(toolId: string): Promise<CliMappingSettings>;
  saveMappings(toolId: string, body: unknown): Promise<CliMappingSettings | { ok: false; status: number; message: string } | { error: string }>;
  apply(toolId: string, body: unknown): Promise<ApplyResult>;
  reset(toolId: string): Promise<ApplyResult>;
  download(toolId: string, body: unknown): Promise<DownloadResult | null>;
}

/** Build the console CLI-tools port from the CLI mapping repository. */
export function createCliToolsPort(cliModelMappings: CliMappingRepositoryShape): CliToolsPort {
  const service = new CliToolService({ cliModelMappings });
  return {
    registry: () => service.getRegistry(),
    allStatuses: () => service.getAllStatuses(),
    status: (toolId) => service.getStatus(toolId),
    isValidTool: (toolId) => service.isValidTool(toolId),
    getMappings: (toolId) => service.getMappings(toolId),
    async saveMappings(toolId, body) {
      const input = parseMapping(body);
      if (input === undefined) return { error: "Invalid mapping payload" };
      try {
        return await service.saveMappings(toolId, input);
      } catch (e) {
        return { error: e instanceof Error ? e.message : "Invalid mapping payload" };
      }
    },
    apply: (toolId, body) => service.applyConfig(toolId, parseApplyInput(body)),
    reset: (toolId) => service.resetConfig(toolId),
    async download(toolId, body) {
      const input = parseApplyInput(body);
      if (!input.endpoint || !input.apiKey) return null;
      return service.downloadConfig(toolId, input);
    },
  };
}
