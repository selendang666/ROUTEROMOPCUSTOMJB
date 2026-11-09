/**
 * CliToolService — orchestrates registry + injectors.
 *
 * The service is the application-layer boundary: API routes call it, it
 * dispatches to the correct injector, and it sanitizes results. It does not
 * touch the filesystem directly — that is each injector's job.
 */

import type { CliMappingRepositoryShape } from "../../persistence/repositories/cli-tools.js";
import type { AllStatusesResult, ApplyInput, ApplyResult, CliMappingInput, CliMappingSettings, DownloadResult, ToolInjector, ToolStatus, ToolDef } from "./types.js";
import { TOOL_IDS, TOOL_REGISTRY, getToolDef, type ToolId } from "./registry.js";
import { INJECTORS } from "./injectors/injectors-map.js";

/** Flattened registry entry sent to the frontend — all optional fields are included when present. */
interface ToolRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly description: string;
  readonly configType: string;
  readonly surface: string;
  readonly mappingMode?: "remote" | "custom";
  readonly mappingSupported: boolean;
  readonly defaultModels: readonly {
    readonly id: string;
    readonly name: string;
    readonly alias: string;
    readonly roleLabel?: string;
    readonly roleKind?: "primary" | "subagent" | "secondary" | "review";
    readonly envKey?: string;
    readonly defaultValue?: string;
  }[];
  readonly settingsFile?: string;
  readonly docsUrl?: string;
  readonly notes?: readonly { readonly type: string; readonly text: string }[];
  readonly guideSteps?: readonly { readonly step: number; readonly title: string; readonly desc?: string; readonly value?: string; readonly copyable?: boolean; readonly type?: string }[];
  readonly codeBlock?: { readonly language: string; readonly code: string };
  readonly defaultMappingTarget?: string;
}

/** Get the injector for a tool ID, or null if the tool is not in the registry. */
function injectorFor(toolId: string): ToolInjector | null {
  const injector = INJECTORS[toolId as ToolId];
  return injector ?? null;
}

/** Sanitize a ToolStatus — never leak the full API key. */
function sanitizeStatus(status: ToolStatus): ToolStatus {
  return status;
}

/** Minimal persistence surface consumed by the CLI tool service. */
export interface CliToolPersistence {
  readonly cliModelMappings: CliMappingRepositoryShape;
}

export class CliToolService {
  constructor(private readonly config: CliToolPersistence) {}

  /** Get status for a single tool. */
  async getStatus(toolId: string): Promise<ToolStatus | null> {
    const injector = injectorFor(toolId);
    if (injector === null) return null;
    return sanitizeStatus(await injector.getStatus());
  }

  /** Get status for all tools in one batch — one round-trip for the frontend. */
  async getAllStatuses(): Promise<AllStatusesResult> {
    const entries = await Promise.all(
      TOOL_IDS.map(async (id) => {
        try {
          const status = await INJECTORS[id].getStatus();
          return [id, sanitizeStatus(status)] as const;
        } catch {
          // A single tool failure should not break the batch.
          return [id, {
            toolId: id,
            installed: false,
            configured: false,
            settingsPath: null,
            currentEndpoint: null,
            currentApiKeyPrefix: null,
            currentModels: null,
            message: "Failed to read status",
          } satisfies ToolStatus] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  /** Apply Oh My Omop - Router config to a tool's config files and mapping store. */
  async applyConfig(toolId: string, input: ApplyInput): Promise<ApplyResult> {
    const injector = injectorFor(toolId);
    const def = getToolDef(toolId);
    if (injector === null || def === null) return { success: false, message: `Unknown tool: ${toolId}` };
    if (!input.endpoint) return { success: false, message: "Endpoint is required" };
    if (!input.apiKey) return { success: false, message: "API key is required" };
    if (def.id !== "claude" && input.models.length === 0) return { success: false, message: "At least one model is required" };
    try {
      const result = await injector.apply(input);
      if (result.success && input.mapping !== undefined) await this.saveMappings(toolId, input.mapping);
      return result;
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Failed to apply config" };
    }
  }

  /** Reset a tool's Oh My Omop - Router-specific config fields and mappings. */
  async resetConfig(toolId: string): Promise<ApplyResult> {
    const injector = injectorFor(toolId);
    if (injector === null) return { success: false, message: `Unknown tool: ${toolId}` };
    try {
      const result = await injector.reset();
      if (result.success) await this.config.cliModelMappings.reset(toolId);
      return result;
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Failed to reset config" };
    }
  }

  /** Read persisted harness-specific mappings for a CLI tool. */
  async getMappings(toolId: string): Promise<CliMappingSettings> {
    const settings = await this.config.cliModelMappings.getSettings(toolId);
    const rows = await this.config.cliModelMappings.list(toolId);
    return {
      toolId,
      // Mapping is opt-out: an absent row means the native slot routes are enabled.
      enabled: settings?.enabled !== false,
      mappings: rows.map((mapping) => ({
        slotKey: mapping.slotKey,
        sourceModel: mapping.sourceModel,
        targetModel: mapping.targetModel,
        enabled: mapping.enabled,
      })),
      allowedApiKeyIds: settings?.allowedApiKeyIds ?? [],
    };
  }

  /** Persist harness-specific mappings without changing the native CLI file. */
  async saveMappings(toolId: string, input: CliMappingInput): Promise<CliMappingSettings | { ok: false; status: number; message: string }> {
    if (!this.isValidTool(toolId)) return { ok: false, status: 400, message: `Unknown tool: ${toolId}` };
    const def: ToolDef = TOOL_REGISTRY[toolId as ToolId];
    if (def.mappingSupported !== true) return { ok: false, status: 400, message: `${def.name} does not support model mapping` };
    const knownSlots = new Set(def.defaultModels.map((model) => model.alias));
    const incomingSlots = new Set<string>();
    for (const mapping of input.mappings) {
      if (!knownSlots.has(mapping.slotKey)) return { ok: false, status: 400, message: `Unknown mapping slot: ${mapping.slotKey}` };
      if (!mapping.sourceModel.trim() || !mapping.targetModel.trim()) return { ok: false, status: 400, message: "Mapping source and target are required" };
      if (def.mappingMode === "custom" && mapping.sourceModel.trim() !== mapping.targetModel.trim()) return { ok: false, status: 400, message: `${def.name} custom mapping cannot define a remote source-to-target route` };
      incomingSlots.add(mapping.slotKey);
    }
    const allowed = Array.isArray(input.allowedApiKeyIds) ? input.allowedApiKeyIds.filter((v): v is string => typeof v === "string") : [];
    await this.config.cliModelMappings.setEnabled(toolId, input.enabled, allowed);
    for (const mapping of input.mappings) {
      await this.config.cliModelMappings.upsert({
        toolId,
        slotKey: mapping.slotKey,
        sourceModel: mapping.sourceModel.trim(),
        targetModel: mapping.targetModel.trim(),
        enabled: mapping.enabled,
      });
    }
    const existing = await this.config.cliModelMappings.list(toolId);
    for (const row of existing) {
      if (!incomingSlots.has(row.slotKey)) await this.config.cliModelMappings.delete(toolId, row.slotKey);
    }
    return this.getMappings(toolId);
  }
  /** Download a tool's config as text (no filesystem write). */
  async downloadConfig(toolId: string, input: ApplyInput): Promise<DownloadResult | null> {
    const injector = injectorFor(toolId);
    if (injector === null) return null;
    if (!input.endpoint || !input.apiKey) return null;
    try {
      return await injector.download(input);
    } catch {
      return null;
    }
  }

  /** Get the full tool registry (metadata for all tools) — sent to frontend. */
  getRegistry(): readonly ToolRegistryEntry[] {
    return TOOL_IDS.map((id) => {
      const def: ToolDef = TOOL_REGISTRY[id];
      return {
        id: def.id,
        name: def.name,
        color: def.color,
        description: def.description,
        configType: def.configType,
        surface: def.surface,
        mappingMode: def.mappingMode,
        mappingSupported: def.mappingSupported === true,
        defaultModels: def.defaultModels.map((m) => ({
          id: m.id,
          name: m.name,
          alias: m.alias,
          roleLabel: m.roleLabel,
          roleKind: m.roleKind,
          envKey: m.envKey,
          defaultValue: m.defaultValue,
        })),
        settingsFile: def.settingsFile,
        docsUrl: def.docsUrl,
        notes: def.notes,
        guideSteps: def.guideSteps,
        defaultMappingTarget: def.defaultMappingTarget,
      } satisfies ToolRegistryEntry;
    });
  }

  /** Check if a tool ID is valid. */
  isValidTool(toolId: string): boolean {
    return getToolDef(toolId) !== null;
  }
}
