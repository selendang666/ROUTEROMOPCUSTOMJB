import type { ClientIdentity, ClientName } from "../types/request.js";

/** A single source-to-target route for one CLI model slot. */
export interface CliModelMappingEntry {
  readonly sourceModel: string;
  readonly targetModel: string;
  readonly enabled: boolean;
}

/** Immutable mapping settings used by the request hot path. */
export interface CliModelMappingSnapshot {
  readonly enabled: boolean;
  readonly entries: readonly CliModelMappingEntry[];
  /** Present allowlists, including an empty list, restrict mappings to listed API keys. */
  readonly allowedApiKeyIds?: readonly string[];
}

const CLIENT_TOOL_IDS: Readonly<Partial<Record<ClientName, string>>> = {
  claude_code: "claude",
  codex: "codex",
  opencode: "opencode",
  cline: "cline",
  cursor: "cursor",
  github_copilot: "copilot",
  gemini_cli: "gemini-cli",
};

/** Converts the request detector's client name to the CLI registry ID. */
export function cliToolIdForClient(clientName: ClientName): string | null {
  return CLIENT_TOOL_IDS[clientName] ?? null;
}

const CLAUDE_MODEL_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable", "mythos"]);

function normalizeClaudeModel(model: string): string {
  return model.trim().toLowerCase();
}

function matchesClaudeModel(sourceModel: string, requestModel: string): boolean {
  const source = normalizeClaudeModel(sourceModel);
  const request = normalizeClaudeModel(requestModel);
  if (source.startsWith("claude/") || request.startsWith("claude/")) return false;
  if (source === request) return true;
  return CLAUDE_MODEL_FAMILIES.has(source) && request.includes(source);
}

/** Resolves a client-scoped model override while preserving the raw model when no mapping applies. */
export function resolveCliModelMapping(
  client: ClientIdentity,
  sourceModel: string,
  apiKeyIdOrMappings: string | null | ReadonlyMap<string, CliModelMappingSnapshot>,
  mappings?: ReadonlyMap<string, CliModelMappingSnapshot>,
): string {
  let apiKeyId: string | null;
  let resolvedMappings: ReadonlyMap<string, CliModelMappingSnapshot>;
  if (typeof apiKeyIdOrMappings !== "string" && apiKeyIdOrMappings !== null) {
    apiKeyId = null;
    resolvedMappings = apiKeyIdOrMappings;
  } else {
    apiKeyId = apiKeyIdOrMappings;
    resolvedMappings = mappings ?? new Map();
  }
  const toolId = cliToolIdForClient(client.name);
  if (toolId === null) return sourceModel;
  const settings = resolvedMappings.get(toolId);
  if (settings === undefined || !settings.enabled) return sourceModel;
  if (settings.allowedApiKeyIds !== undefined && (apiKeyId === null || !settings.allowedApiKeyIds.includes(apiKeyId))) return sourceModel;
  const entry = settings.entries.find((candidate) =>
    candidate.enabled
    && (toolId === "claude"
      ? matchesClaudeModel(candidate.sourceModel, sourceModel)
      : candidate.sourceModel.trim().toLowerCase() === sourceModel.trim().toLowerCase())
  );
  return entry?.targetModel ?? sourceModel;
}
