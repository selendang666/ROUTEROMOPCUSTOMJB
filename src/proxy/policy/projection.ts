import type { CachePlan } from "../translate/cache.js";
import type { ProviderQuirkPolicy } from "../types/provider.js";
import { isRecord } from "../validation.js";

/** Pure provider-quirk projection; no mutation of adapter payload. */
export function applyProviderQuirkPolicy(payload: Readonly<Record<string, unknown>>, policy: ProviderQuirkPolicy | undefined): Record<string, unknown> {
  if (policy === undefined) return { ...payload };
  const result: Record<string, unknown> = { ...payload };
  for (const field of policy.droppedFields ?? []) delete result[field];
  for (const [field, bounds] of Object.entries(policy.clampedFields ?? {})) {
    const value = result[field];
    if (typeof value !== "number") continue;
    const min = bounds.min ?? value;
    const max = bounds.max ?? value;
    result[field] = Math.min(max, Math.max(min, value));
  }
  return result;
}

export function applyRequiredProviderHeaders(headers: Headers, policy: ProviderQuirkPolicy | undefined): Headers {
  const result = new Headers(headers);
  for (const [name, value] of Object.entries(policy?.requiredHeaders ?? {})) result.set(name, value);
  return result;
}

/** Adds provider-required Responses decoy tools without mutating the input payload. */
export function applyResponsesToolCloak(payload: Readonly<Record<string, unknown>>, policy: ProviderQuirkPolicy | undefined): Record<string, unknown> {
  const cloak = policy?.responsesToolCloak;
  if (cloak === undefined) return { ...payload };
  const model = payload.model;
  if (typeof model !== "string" || !cloak.models.includes(model)) return { ...payload };
  const result: Record<string, unknown> = { ...payload };
  const existing = Array.isArray(payload.tools) ? payload.tools.filter(isRecord).map((tool) => ({ ...tool })) : [];
  const names = new Set(existing.map((tool) => {
    if (typeof tool.name === "string") return tool.name;
    const fn = tool.function;
    return isRecord(fn) && typeof fn.name === "string" ? fn.name : null;
  }).filter((name): name is string => name !== null));
  for (const tool of cloak.tools) {
    const name = typeof tool.name === "string" ? tool.name : null;
    if (name !== null && !names.has(name)) {
      existing.push({ ...tool });
      names.add(name);
    }
  }
  result.tools = existing;
  if (cloak.forceToolChoiceAuto === true) result.tool_choice = "auto";
  return result;
}

export function mapGeminiToolName(name: string, policy: ProviderQuirkPolicy | undefined): string {
  const quirk = policy?.toolNames;
  if (!quirk) return name;
  let sanitized = name.replace(/[^A-Za-z0-9_-]/g, quirk.replacement);
  if (sanitized.length > quirk.maxLength) sanitized = sanitized.slice(0, quirk.maxLength);
  if (sanitized.length === 0) sanitized = "tool";
  return sanitized;
}

export function normalizeGeminiRole(role: string, policy: ProviderQuirkPolicy | undefined): string {
  if (policy?.roles === "gemini-alternating") {
    if (role === "system") return "user";
    if (role === "assistant" || role === "model") return "model";
    if (role === "user") return "user";
  }
  return role;
}

export function projectReasoningOutputTokens(
  requestedMax: number | null,
  thinkingEnabled: boolean,
  policy: ProviderQuirkPolicy | undefined,
  modelMax: number | null,
): number | null {
  let value = requestedMax;
  if (thinkingEnabled && policy?.reasoning?.minimumOutputTokens !== undefined) {
    const min = policy.reasoning.minimumOutputTokens;
    if (value === null || value < min) value = min;
  }
  if (policy?.reasoning?.maximumOutputTokens !== undefined && value !== null) {
    value = Math.min(value, policy.reasoning.maximumOutputTokens);
  }
  if (modelMax !== null && value !== null) value = Math.min(value, modelMax);
  return value;
}

export function finalAnthropicCacheAnchors(
  payload: Record<string, unknown>,
  plan?: CachePlan,
  policy?: ProviderQuirkPolicy,
): Record<string, unknown> {
  const cache = policy?.cache;
  const result: Record<string, unknown> = { ...payload };
  const system = result.system;
  if (typeof system === "string") {
    const systemBlock = system.length === 0 ? null : { type: "text", text: system };
    if (systemBlock !== null) result.system = [withCacheControl(systemBlock, cache?.systemTtl)];
  } else if (Array.isArray(system)) {
    const blocks = cloneBlocks(system);
    const systemIndex = lastTextBlockIndex(blocks);
    const systemBlock = systemIndex !== -1 ? blocks[systemIndex] : undefined;
    if (systemIndex !== -1 && isRecord(systemBlock)) blocks[systemIndex] = withCacheControl(systemBlock, cache?.systemTtl);
    result.system = blocks;
  }

  if (Array.isArray(result.tools)) {
    const tools = cloneBlocks(result.tools);
    const toolIndex = tools.length - 1;
    const tool = toolIndex >= 0 ? tools[toolIndex] : undefined;
    if (toolIndex >= 0 && isRecord(tool)) tools[toolIndex] = withCacheControl(tool, cache?.toolsTtl);
    result.tools = tools;
  }

  if (Array.isArray(result.messages)) {
    const messages = result.messages.map((message) => {
      if (!isRecord(message)) return message;
      const cloned: Record<string, unknown> = { ...message };
      const content = cloned.content;
      if (typeof content === "string" || Array.isArray(content)) {
        cloned.content = typeof content === "string" ? content : cloneBlocks(content);
      }
      return cloned;
    });
    if (plan?.prefixEndMessageIndex != null) anchorLastHistoryMessage(messages, cache?.historyTtl);
    result.messages = messages;
  }

  return result;
}

function cloneBlocks(blocks: readonly unknown[]): Record<string, unknown>[] {
  return blocks.map((block) => {
    if (isRecord(block)) return stripCacheControl(block);
    const fallback: Record<string, unknown> = { value: block };
    return fallback;
  });
}

function stripCacheControl(block: Record<string, unknown>): Record<string, unknown> {
  const cloned: Record<string, unknown> = { ...block };
  delete cloned.cache_control;
  return cloned;
}

function withCacheControl(block: Record<string, unknown>, ttl?: "1h" | "5m"): Record<string, unknown> {
  const cloned = stripCacheControl(block);
  cloned.cache_control = ttl === undefined ? { type: "ephemeral" } : { type: "ephemeral", ttl };
  return cloned;
}

function anchorLastHistoryMessage(messages: Record<string, unknown>[], ttl?: "1h" | "5m"): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    const content = message.content;
    if (typeof content === "string") {
      if (content.length === 0) continue;
      message.content = [{ type: "text", text: content, cache_control: ttl === undefined ? { type: "ephemeral" } : { type: "ephemeral", ttl } }];
      return;
    }
    if (!Array.isArray(content)) continue;
    const historyIndex = lastTextBlockIndex(content);
    if (historyIndex === -1) continue;
    content[historyIndex] = withCacheControl(isRecord(content[historyIndex]) ? content[historyIndex] : { type: "text" }, ttl);
    return;
  }
}

function lastTextBlockIndex(blocks: readonly unknown[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (isRecord(block) && block.type === "text") return index;
  }
  return -1;
}
