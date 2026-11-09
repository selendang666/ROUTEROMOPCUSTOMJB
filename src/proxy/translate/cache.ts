import type { CacheIntent, NormalizedMessage, NormalizedTool } from "../types/content.js";
import type { ProxyRequest } from "../types/request.js";
import { isRecord } from "../validation.js";
import { isWhitespaceCode, scanTrimEnd } from "../normalize/detection.js";

/**
 * Automatic, always-on section cache marking.
 *
 * Classifies a normalized request's content into stable and dynamic
 * sections in provider-neutral terms; adapters map the resulting plan to
 * their native marker (Anthropic `cache_control`, OpenAI `prompt_cache_key`,
 * or no-op). There is deliberately no toggle, config row, or persisted
 * content anywhere in this module: it is a pure in-memory classification.
 *
 * Section order: system/developer instructions -> tools and schemas ->
 * static context -> stable history -> dynamic history/current turn. Only the
 * last safe reusable prefix may receive a provider marker; dynamic
 * timestamps, secrets, mutable tool results, and unstable content stay after
 * the cache boundary.
 */
export type CacheSectionKind = "system" | "developer" | "tools" | "static_context" | "stable_history" | "dynamic";

export interface CacheSection {
  readonly kind: CacheSectionKind;
  /** Message index in the normalized request; null only for the tools section. */
  readonly messageIndex: number | null;
  /** Content-block index within that message; null for the tools section. */
  readonly blockIndex: number | null;
  readonly stable: boolean;
  /** Bounded character length (text blocks) or serialized size (tools). */
  readonly charLength: number;
}

export interface CachePlan {
  readonly sections: readonly CacheSection[];
  /** Non-empty tool list: tools and schemas are a stable prefix. */
  readonly toolsStable: boolean;
  readonly hasStablePrefix: boolean;
  /** Position (inclusive) of the last stable cacheable block, or null. */
  readonly prefixEndMessageIndex: number | null;
  readonly prefixEndBlockIndex: number | null;
  /** Bounded digest of the stable prefix; never content, never persisted. */
  readonly prefixFingerprint: string | null;
}

/** Threshold for lazy cache-plan construction: tiny prompts don't benefit from prefix caching. */
export const CACHE_PLAN_MESSAGE_THRESHOLD = 3;

/**
 * Returns true when cache-plan construction is worthwhile.
 * Only builds if tools are present or message count exceeds threshold.
 */
export function shouldBuildCachePlan(request: ProxyRequest, threshold = CACHE_PLAN_MESSAGE_THRESHOLD): boolean {
  return request.tools.length > 0 || request.messages.length > threshold;
}

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const PEM_BLOCK = /-----BEGIN [A-Z][A-Z ]*-----/;

function stablePrefixText(text: string): string | null {
  const matches = [ISO_TIMESTAMP.exec(text), UUID.exec(text), PEM_BLOCK.exec(text)]
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((left, right) => left.index - right.index);
  const firstVolatileIndex = matches[0]?.index ?? text.length;
  const rawPrefix = text.slice(0, firstVolatileIndex);
  const prefix = scanTrimEnd(rawPrefix);
  return prefix.length >= 128 ? prefix : null;
}

/**
 * Stability heuristic for cacheable text: rejects per-request timestamps,
 * UUIDs, and embedded private keys, which break prefix identity across calls.
 */
export function looksStableText(text: string): boolean {
  if (ISO_TIMESTAMP.test(text)) return false;
  if (UUID.test(text)) return false;
  if (PEM_BLOCK.test(text)) return false;
  return true;
}

export function markCacheSections(request: ProxyRequest): readonly CacheSection[] {
  const sections: CacheSection[] = [];
  let sawAssistant = false;
  for (let i = 0; i < request.messages.length; i++) {
    const message = request.messages[i];
    if (message === undefined) continue;
    if (message.role === "assistant") sawAssistant = true;
    for (let j = 0; j < message.content.length; j++) {
      const block = message.content[j];
      if (block === undefined) continue;
      const cacheableRole = message.role === "system" || message.role === "developer" || message.role === "user" || message.role === "assistant";
      const isText = block.type === "text" && block.text !== undefined;
      const stable = cacheableRole && isText && looksStableText(block.text ?? "");
      sections.push({
        kind: sectionKind(message.role, sawAssistant),
        messageIndex: i,
        blockIndex: j,
        stable,
        charLength: block.text?.length ?? 0,
      });
    }
  }
  if (request.tools.length > 0) {
    sections.splice(insertionIndex(sections), 0, {
      kind: "tools",
      messageIndex: null,
      blockIndex: null,
      stable: true,
      charLength: toolsCharLength(request.tools),
    });
  }
  return sections;
}

export function applyCachePlan(request: ProxyRequest, plan: CachePlan, affinityKey?: string | null): ProxyRequest {
  if (!plan.hasStablePrefix || plan.prefixFingerprint === null) return request;
  const cacheKey = request.cacheKey ?? fnv1a64([plan.prefixFingerprint, request.model, request.sourceSurface, affinityKey ?? "anonymous"]);
  const cacheIntent: CacheIntent = {
    key: cacheKey,
    stablePrefixFingerprint: plan.prefixFingerprint,
    affinityKey: affinityKey ?? null,
    policy: "automatic",
    ttl: null,
  };
  if (plan.prefixEndMessageIndex === null || plan.prefixEndBlockIndex === null) {
    return { ...request, cacheKey, cacheIntent };
  }
  const targetMsgIdx = plan.prefixEndMessageIndex;
  const targetBlkIdx = plan.prefixEndBlockIndex;
  const targetMsg = request.messages[targetMsgIdx];
  if (targetMsg === undefined) return { ...request, cacheKey, cacheIntent };
  const targetBlk = targetMsg.content[targetBlkIdx];
  if (targetBlk === undefined) return { ...request, cacheKey, cacheIntent };
  const messages = request.messages.map((message, messageIndex) => {
    if (messageIndex !== targetMsgIdx) return message;
    const content = message.content.flatMap((block, blockIndex) => {
      if (blockIndex !== targetBlkIdx || block.type !== "text" || block.text === undefined) return [block];
      const stablePrefix = stablePrefixText(block.text);
      if (stablePrefix === null || stablePrefix.length === block.text.length) return [{ ...block, cacheControl: "ephemeral" as const }];
      let suffixStart = 0;
      const rawSuffix = block.text.slice(stablePrefix.length);
      while (suffixStart < rawSuffix.length && isWhitespaceCode(rawSuffix.charCodeAt(suffixStart))) suffixStart++;
      const suffix = suffixStart === 0 ? rawSuffix : rawSuffix.slice(suffixStart);
      return [
        { ...block, text: stablePrefix, cacheControl: "ephemeral" as const },
        ...(suffix.length === 0 ? [] : [{ ...block, text: suffix, cacheControl: undefined }]),
      ];
    });
    return { ...message, content };
  });
  return { ...request, messages, cacheKey, cacheIntent };
}

export interface CacheBreakpointPosition {
  readonly messageIndex: number;
  readonly blockIndex: number;
}

/**
 * Finds the latest text block that can carry an explicit provider cache
 * breakpoint. Assistant/tool suffixes fall back to the nearest earlier
 * system, developer, or user text block because OpenAI only accepts
 * breakpoints on input content blocks.
 */
export function findCacheBreakpoint(request: ProxyRequest): CacheBreakpointPosition | null {
  let targetMessageIndex: number | null = null;
  let targetBlockIndex: number | null = null;
  for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
    const message = request.messages[messageIndex];
    if (message === undefined) continue;
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      if (message.content[blockIndex]?.cacheControl === "ephemeral") {
        targetMessageIndex = messageIndex;
        targetBlockIndex = blockIndex;
        break;
      }
    }
    if (targetMessageIndex !== null) break;
  }
  if (targetMessageIndex === null || targetBlockIndex === null) return null;
  for (let messageIndex = targetMessageIndex; messageIndex >= 0; messageIndex -= 1) {
    const message = request.messages[messageIndex];
    if (message === undefined || (message.role !== "system" && message.role !== "developer" && message.role !== "user")) continue;
    const start = messageIndex === targetMessageIndex ? targetBlockIndex : message.content.length - 1;
    for (let blockIndex = start; blockIndex >= 0; blockIndex -= 1) {
      if (message.content[blockIndex]?.type === "text") return { messageIndex, blockIndex };
    }
  }
  return null;
}

/** GPT-5.6+ accepts explicit OpenAI prompt cache breakpoints. */
export function supportsOpenAIPromptBreakpoints(model: string): boolean {
  const match = /(?:^|\/)gpt-5\.(\d+)(?:$|[-.])/i.exec(model);
  return match !== null && Number.parseInt(match[1] ?? "0", 10) >= 6;
}

export function buildCachePlan(request: ProxyRequest): CachePlan {
  // Lazy: small requests (<3 messages, no tools) don't benefit from cache plan — skip alloc
  if (request.messages.length < 3 && (request.tools?.length ?? 0) === 0) {
    return { sections: [], toolsStable: false, hasStablePrefix: false, prefixEndMessageIndex: null, prefixEndBlockIndex: null, prefixFingerprint: null };
  }
  // Fused single-pass: builds sections and stable prefix together, avoiding second traversal over sections.
  const sections: CacheSection[] = [];
  const prefixText: string[] = [];
  let prefixEndMessageIndex: number | null = null;
  let prefixEndBlockIndex: number | null = null;
  let inPrefix = true;
  let sawAssistant = false;
  for (let i = 0; i < request.messages.length; i++) {
    const message = request.messages[i];
    if (message === undefined) continue;
    if (message.role === "assistant") sawAssistant = true;
    for (let j = 0; j < message.content.length; j++) {
      const block = message.content[j];
      if (block === undefined) continue;
      const cacheableRole = message.role === "system" || message.role === "developer" || message.role === "user" || message.role === "assistant";
      const isText = block.type === "text" && block.text !== undefined;
      const stable = cacheableRole && isText && looksStableText(block.text ?? "");
      const kind = sectionKind(message.role, sawAssistant);
      const section: CacheSection = {
        kind,
        messageIndex: i,
        blockIndex: j,
        stable,
        charLength: block.text?.length ?? 0,
      };
      sections.push(section);
      if (!inPrefix) continue;
      if (block.cacheControl === "ephemeral") {
        prefixEndMessageIndex = i;
        prefixEndBlockIndex = j;
        prefixText.push(block.text ?? "");
        inPrefix = false;
        continue;
      }
      const cacheable = kind === "system" || kind === "developer" || kind === "static_context" || kind === "stable_history";
      const stableText = isText ? (stable ? (block.text as string) : stablePrefixText(block.text as string)) : null;
      if (cacheable && stableText !== null && stableText.length > 0) {
        prefixEndMessageIndex = i;
        prefixEndBlockIndex = j;
        prefixText.push(stableText);
        if (!stable) inPrefix = false;
      } else {
        inPrefix = false;
      }
    }
  }
  const toolsStable = request.tools.length > 0;
  if (toolsStable) {
    let insertIdx = 0;
    for (const s of sections) {
      if (s.kind === "system" || s.kind === "developer") insertIdx++;
      else break;
    }
    sections.splice(insertIdx, 0, {
      kind: "tools",
      messageIndex: null,
      blockIndex: null,
      stable: true,
      charLength: toolsCharLength(request.tools),
    });
  }
  const hasStablePrefix = prefixEndMessageIndex !== null;
  let prefixFingerprint: string | null = null;
  if (hasStablePrefix) {
    if (toolsStable) prefixText.push(boundJsonStringify(request.tools));
    prefixFingerprint = fnv1a64(prefixText);
  }
  return {
    sections,
    toolsStable,
    hasStablePrefix,
    prefixEndMessageIndex,
    prefixEndBlockIndex,
    prefixFingerprint,
  };
}

function sectionKind(role: NormalizedMessage["role"], sawAssistant: boolean): CacheSectionKind {
  switch (role) {
    case "system":
      return "system";
    case "developer":
      return "developer";
    case "user":
      return sawAssistant ? "stable_history" : "static_context";
    case "assistant":
      return "stable_history";
    case "tool":
      return "dynamic";
  }
}

function insertionIndex(sections: readonly CacheSection[]): number {
  let index = 0;
  for (const section of sections) {
    if (section.kind === "system" || section.kind === "developer") index += 1;
    else break;
  }
  return index;
}

function toolsCharLength(tools: readonly NormalizedTool[]): number {
  let total = 0;
  for (const tool of tools) {
    if (tool.kind === "function") {
      total += tool.name.length + (tool.description?.length ?? 0);
      total += tool.schemaJsonLength ?? estimateJsonLength(tool.inputSchema);
    } else {
      total += estimateJsonLength(tool);
    }
  }
  return total;
}

function boundJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function estimateJsonLength(value: unknown): number {
  const seen = new WeakSet<object>();
  const inner = (v: unknown): number => {
    if (v === null) return 4;
    const t = typeof v;
    if (t === "string") {
      const s = v as string;
      let extra = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 34 || c === 92) extra += 1;
        else if (c < 32) {
          if (c === 8 || c === 9 || c === 10 || c === 12 || c === 13) extra += 1;
          else extra += 5;
        }
      }
      return 2 + s.length + extra;
    }
    if (t === "number") return String(v).length;
    if (t === "boolean") return v ? 4 : 5;
    if (t === "undefined") return 0;
    if (Array.isArray(v)) {
      const arr = v as unknown[];
      if (seen.has(arr as object)) throw new Error("circular");
      seen.add(arr as object);
      if (arr.length === 0) {
        seen.delete(arr as object);
        return 2;
      }
      let len = 1;
      for (let i = 0; i < arr.length; i++) {
        if (i > 0) len += 1;
        const item = arr[i];
        if (item === undefined || typeof item === "function" || typeof (item as unknown) === "symbol") len += 4;
        else len += inner(item);
      }
      len += 1;
      seen.delete(arr as object);
      return len;
    }
    if (t === "object") {
      const obj = v as Record<string, unknown>;
      if (seen.has(obj)) throw new Error("circular");
      seen.add(obj);
      const keys = Object.keys(obj);
      let filtered: string[] = [];
      for (const k of keys) {
        const val = obj[k];
        if (val === undefined || typeof val === "function" || typeof (val as unknown) === "symbol") continue;
        filtered.push(k);
      }
      if (filtered.length === 0) {
        seen.delete(obj);
        return 2;
      }
      let len = 1;
      for (let i = 0; i < filtered.length; i++) {
        if (i > 0) len += 1;
        const k = filtered[i]!;
        let extra = 0;
        for (let j = 0; j < k.length; j++) {
          const c = k.charCodeAt(j);
          if (c === 34 || c === 92) extra += 1;
          else if (c < 32) {
            if (c === 8 || c === 9 || c === 10 || c === 12 || c === 13) extra += 1;
            else extra += 5;
          }
        }
        len += 2 + k.length + extra + 1;
        len += inner(obj[k]);
      }
      len += 1;
      seen.delete(obj);
      return len;
    }
    return 0;
  };
  return inner(value);
}

/** FNV-1a 64-bit hex digest: deterministic, bounded (16 hex chars). */
function fnv1a64(parts: readonly string[]): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let partIndex = 0;
  for (const part of parts) {
    if (partIndex > 0) {
      hash = (hash * prime) & mask;
      hash = (hash * prime) & mask;
    }
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index);
      hash ^= BigInt(code & 0xff);
      hash = (hash * prime) & mask;
      hash ^= BigInt(code >> 8);
      hash = (hash * prime) & mask;
    }
    partIndex += 1;
  }
  return hash.toString(16).padStart(16, "0");
}

const EXPLICIT_CACHE_BREAKPOINT = { mode: "explicit" } as const;

/** Applies OpenAI Chat explicit prompt-cache metadata at the selected text block. */
export function applyOpenAIChatCacheBreakpoint(payload: Record<string, unknown>, request: ProxyRequest, model = request.model, explicitCache = true): void {
  if (!explicitCache || !supportsOpenAIPromptBreakpoints(model) || request.cacheKey === undefined) return;
  const position = findCacheBreakpoint(request);
  if (position === null) return;
  if (payload.prompt_cache_options === undefined) payload.prompt_cache_options = { ...EXPLICIT_CACHE_BREAKPOINT, ttl: "30m" };
  const messages = payload.messages;
  if (!Array.isArray(messages)) return;
  const message = messages[position.messageIndex];
  if (!isRecord(message)) return;
  const content = message.content;
  if (typeof content === "string" && content.length > 0) {
    message.content = [{ type: "text", text: content, prompt_cache_breakpoint: EXPLICIT_CACHE_BREAKPOINT }];
    return;
  }
  if (!Array.isArray(content)) return;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!isRecord(block) || block.type !== "text") continue;
    content[index] = { ...block, prompt_cache_breakpoint: EXPLICIT_CACHE_BREAKPOINT };
    return;
  }
}

/** Applies OpenAI Responses explicit prompt-cache metadata to a message's input items. */
export function applyOpenAIResponsesCacheBreakpoint(
  payload: Record<string, unknown>,
  request: ProxyRequest,
  itemsForMessage: (message: NormalizedMessage) => readonly Record<string, unknown>[],
  model = request.model,
  explicitCache = true,
): void {
  if (!explicitCache || !supportsOpenAIPromptBreakpoints(model) || request.cacheKey === undefined) return;
  const position = findCacheBreakpoint(request);
  if (position === null) return;
  if (payload.prompt_cache_options === undefined) payload.prompt_cache_options = { ...EXPLICIT_CACHE_BREAKPOINT, ttl: "30m" };
  const input = payload.input;
  if (!Array.isArray(input)) return;
  let wireIndex = 0;
  for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
    const message = request.messages[messageIndex];
    if (message === undefined) continue;
    const items = itemsForMessage(message);
    if (messageIndex === position.messageIndex) {
      for (let offset = 0; offset < items.length; offset += 1) {
        const candidate = input[wireIndex + offset];
        if (!isRecord(candidate) || (candidate.role !== "system" && candidate.role !== "developer" && candidate.role !== "user")) continue;
        const content = candidate.content;
        if (typeof content === "string" && content.length > 0) {
          candidate.content = [{ type: "input_text", text: content, prompt_cache_breakpoint: EXPLICIT_CACHE_BREAKPOINT }];
          return;
        }
        if (!Array.isArray(content)) continue;
        for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
          const block = content[blockIndex];
          if (!isRecord(block) || block.type !== "input_text") continue;
          content[blockIndex] = { ...block, prompt_cache_breakpoint: EXPLICIT_CACHE_BREAKPOINT };
          return;
        }
      }
      return;
    }
    wireIndex += items.length;
  }
}

/** Removes optional explicit cache fields while preserving prompt_cache_key. */
export function stripOpenAIPromptCacheMetadata(payload: Record<string, unknown>): void {
  delete payload.prompt_cache_options;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    delete value.prompt_cache_breakpoint;
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload.input);
  visit(payload.messages);
}

export function resolvePromptCacheKey(request: ProxyRequest, plan: CachePlan, identity?: { sessionId?: string; conversationId?: string; metadataUserId?: string } | null): string | undefined {
  const parts: string[] = [];
  if (plan.prefixFingerprint !== null) parts.push(plan.prefixFingerprint);
  const sessionId = identity?.sessionId?.trim();
  if (sessionId && sessionId.length > 0) parts.push(sessionId.slice(0, 256));
  const conversationId = identity?.conversationId?.trim();
  if (conversationId && conversationId.length > 0) parts.push(conversationId.slice(0, 256));
  const metadataUserId = identity?.metadataUserId?.trim();
  if (metadataUserId && metadataUserId.length > 0) parts.push(metadataUserId.slice(0, 256));
  if (parts.length === 0) return request.cacheKey ?? undefined;
  const affinityKey = identity?.conversationId ?? identity?.metadataUserId ?? identity?.sessionId ?? null;
  if (affinityKey !== null && affinityKey.length > 0) parts.push(affinityKey.slice(0, 256));
  if (request.cacheKey !== undefined) parts.push(request.cacheKey.slice(0, 256));
  if (request.model.length > 0) parts.push(request.model.slice(0, 256));
  if (request.sourceSurface.length > 0) parts.push(request.sourceSurface.slice(0, 256));
  return fnv1a64(parts);
}
