import type { ProtocolError } from "../errors.js";
import { applicationError, isProtocolError, protocolError } from "../errors.js";
import type { ContentPart, NormalizedMessage, NormalizedTool } from "../types/content.js";
import type { ProxyRequest } from "../types/request.js";
import { boundJsonLength, narrowArray, narrowBoolean, narrowObject, narrowString, MAX_TEXT_BLOCK_LENGTH, MAX_TOOL_COUNT, MAX_TOOL_DESCRIPTION_LENGTH, MAX_TOOL_NAME_LENGTH, MAX_TOOL_SCHEMA_LENGTH } from "../validation.js";

export interface ToolCallRecord {
  readonly sourceId: string;
  readonly targetId: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ToolResultRecord {
  readonly sourceId: string;
  readonly targetId: string;
  readonly isError: boolean;
}

export type ToolRepairKind = "generated-id" | "sanitized-id" | "duplicate-result" | "missing-result" | "merged-message" | "orphan-result";

export interface ToolRepairChange {
  readonly kind: ToolRepairKind;
  readonly sourceId?: string;
  readonly targetId?: string;
  readonly messageIndex?: number;
}

export interface ToolRepairResult {
  readonly request: ProxyRequest;
  readonly ledger: ToolCallLedger;
  readonly changes: readonly ToolRepairChange[];
}

export interface ToolCallLedger {
  readonly calls: ReadonlyMap<string, ToolCallRecord>;
  readonly results: ReadonlyMap<string, ToolResultRecord>;
  repair(): ToolRepairResult;
}

const MAX_TOOL_CALL_ID_LENGTH = 64;

const MAX_SERIALIZED_TOOL_ARGUMENT_LENGTH = 128_000;

/** Ensures every normalized tool-use block has a stable call identifier. */
export function ensureToolCallIds(request: ProxyRequest): ProxyRequest {
  let changed = false;
  const messages = request.messages.map((message, messageIndex): NormalizedMessage => {
    let messageChanged = false;
    const content = message.content.map((block, blockIndex): ContentPart => {
      if (block.type !== "tool_use" || (block.toolCallId ?? "").length > 0) return block;
      messageChanged = true;
      changed = true;
      return { ...block, toolCallId: `call_${messageIndex}_${blockIndex}` } as ContentPart;
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? { ...request, messages } : request;
}

/** Repairs tool identifiers, results, and adjacent conversation boundaries immutably. */
export function repairToolCallRequest(request: ProxyRequest): ToolRepairResult {
  return createToolCallLedger(sanitizeMalformedToolCalls(request)).repair();
}

/**
 * Drops malformed tool calls before translation — a `tool_use` with an empty
 * `toolName` or empty `toolCallId` cannot be paired or dispatched and, if sent
 * to the wire, wedges upstreams into a 400 loop (observed with GLM-family
 * models). Any `tool_result` whose id matched a dropped call is removed too, so
 * no orphan result survives. Idempotent: a clean request is returned as-is.
 *
 * Canonical-first: run before dedupe/pairing. It never fabricates ids and
 * never rewrites valid calls.
 */
export function sanitizeMalformedToolCalls(request: ProxyRequest): ProxyRequest {
  // Fast path: detect any malformed tool_use without allocating.
  let hasMalformed = false;
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      const tu = block as Extract<ContentPart, { type: "tool_use" }>;
      if ((tu.toolName ?? "").trim() === "" || (tu.toolCallId ?? "").trim() === "") { hasMalformed = true; break; }
    }
    if (hasMalformed) break;
  }
  if (!hasMalformed) return request;

  const droppedIds = new Set<string>();
  const messages = request.messages.map((message): NormalizedMessage => {
    const content = message.content.filter((block) => {
      if (block.type !== "tool_use") return true;
      const tu = block as Extract<ContentPart, { type: "tool_use" }>;
      const malformed = (tu.toolName ?? "").trim() === "" || (tu.toolCallId ?? "").trim() === "";
      if (malformed) {
        const id = (tu.toolCallId ?? "").trim();
        if (id !== "") droppedIds.add(id);
        return false;
      }
      return true;
    });
    return content.length === message.content.length ? message : { ...message, content };
  }).map((message): NormalizedMessage => {
    if (droppedIds.size === 0) return message;
    const content = message.content.filter((block) => {
      if (block.type !== "tool_result") return true;
      const id = (block as Extract<ContentPart, { type: "tool_result" }>).toolCallId.trim();
      return !droppedIds.has(id);
    });
    return content.length === message.content.length ? message : { ...message, content };
  });
  return { ...request, messages };
}

/** Creates a deterministic ledger for one canonical request. */
export function createToolCallLedger(request: ProxyRequest): ToolCallLedger {
  const calls = new Map<string, ToolCallRecord>();
  const results = new Map<string, ToolResultRecord>();
  const idMapOccurrences = new Map<string, string[]>();
  const idMapPointer = new Map<string, number>();
  const usedIds = new Set<string>();
  const changes: ToolRepairChange[] = [];

  for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
    const message = request.messages[messageIndex];
    if (message === undefined) continue;
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex];
      if (block === undefined || block.type !== "tool_use") continue;
      const sourceId = block.toolCallId?.trim() || `call_${messageIndex}_${blockIndex}`;
      const targetId = allocateTargetId(sourceId, usedIds);
      const arr = idMapOccurrences.get(sourceId) ?? [];
      arr.push(targetId);
      idMapOccurrences.set(sourceId, arr);
      if (sourceId !== targetId) changes.push({ kind: block.toolCallId === undefined ? "generated-id" : "sanitized-id", sourceId, targetId, messageIndex });
      calls.set(targetId, {
        sourceId,
        targetId,
        name: block.toolName ?? "tool",
        arguments: stringifyToolArguments(block.toolArguments),
      });
    }
  }

  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const sourceId = block.toolCallId?.trim() ?? "";
      const occList = idMapOccurrences.get(sourceId);
      let targetId: string;
      if (occList !== undefined) {
        const pointer = idMapPointer.get(sourceId) ?? 0;
        if (pointer < occList.length) {
          targetId = occList[pointer]!;
          idMapPointer.set(sourceId, pointer + 1);
        } else {
          targetId = allocateTargetId(sourceId || "orphan", usedIds);
          // do not push to occList for orphan beyond known calls
          changes.push({ kind: "orphan-result", sourceId, targetId });
        }
      } else {
        targetId = allocateTargetId(sourceId || "orphan", usedIds);
        changes.push({ kind: "orphan-result", sourceId, targetId });
      }
      if (!results.has(targetId)) results.set(targetId, { sourceId, targetId, isError: block.toolResultIsError === true });
    }
  }

  return {
    calls,
    results,
    repair(): ToolRepairResult {
      const responded = new Set(results.keys());
      const seenResults = new Set<string>();
      const repairedMessages: NormalizedMessage[] = [];
      let changed = false;
      const repairUsePointer = new Map<string, number>();
      const repairResultPointer = new Map<string, number>();

      for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
        const message = request.messages[messageIndex];
        if (message === undefined) continue;
        const content: ContentPart[] = [];
        for (const block of message.content) {
          if (block.type === "tool_use") {
            const sourceId = (block as Extract<ContentPart, { type: "tool_use" }>).toolCallId.trim() || `call_${messageIndex}_${content.length}`;
            const occList = idMapOccurrences.get(sourceId);
            let targetId: string;
            if (occList !== undefined) {
              const idx = repairUsePointer.get(sourceId) ?? 0;
              targetId = occList[idx] ?? occList[0] ?? allocateTargetId(sourceId, usedIds);
              repairUsePointer.set(sourceId, idx + 1);
            } else {
              targetId = allocateTargetId(sourceId, usedIds);
            }
            const tu = block as Extract<ContentPart, { type: "tool_use" }>;
            const repaired = { ...tu, toolCallId: targetId, toolArguments: stringifyToolArguments(tu.toolArguments) } as ContentPart;
            content.push(repaired);
            if ((repaired as Extract<ContentPart, { type: "tool_use" }>).toolCallId !== tu.toolCallId || (repaired as Extract<ContentPart, { type: "tool_use" }>).toolArguments !== tu.toolArguments) changed = true;
            continue;
          }
          if (block.type === "tool_result") {
            const sourceId = (block as Extract<ContentPart, { type: "tool_result" }>).toolCallId.trim();
            const occListRes = idMapOccurrences.get(sourceId);
            let targetId: string;
            if (occListRes !== undefined) {
              const idx = repairResultPointer.get(sourceId) ?? 0;
              targetId = occListRes[idx] ?? occListRes[0] ?? sourceId;
              repairResultPointer.set(sourceId, idx + 1);
            } else {
              targetId = sourceId;
            }            if (targetId !== "" && seenResults.has(targetId)) {
              changes.push({ kind: "duplicate-result", sourceId, targetId });
              changed = true;
              continue;
            }
            if (targetId !== "") seenResults.add(targetId);
            const tr = block as Extract<ContentPart, { type: "tool_result" }>;
            content.push(targetId === tr.toolCallId ? block : { ...tr, toolCallId: targetId } as ContentPart);
            continue;
          }
          content.push(block);
        }
        const repairedMessage = content.length === message.content.length && content.every((block, index) => block === message.content[index])
          ? message
          : { ...message, content };
        repairedMessages.push(repairedMessage);
        if (message.role === "assistant") {
          const missing = repairedMessage.content
            .filter((block): block is Extract<ContentPart, { type: "tool_use" }> => block.type === "tool_use" && !responded.has((block as Extract<ContentPart, { type: "tool_use" }>).toolCallId))
            .map((block) => ({ type: "tool_result" as const, toolCallId: block.toolCallId, text: "No result provided", toolResultIsError: true }));
          if (missing.length > 0) {
            repairedMessages.push({ role: "tool", content: missing });
            for (const block of missing) responded.add(block.toolCallId);
            changes.push(...missing.map((block) => ({ kind: "missing-result" as const, targetId: block.toolCallId, messageIndex })));
            changed = true;
          }
        }
      }

      const merged = mergeAdjacentMessages(repairedMessages, changes);
      if (merged.length !== repairedMessages.length) changed = true;
      return { request: changed ? { ...request, messages: merged } : request, ledger: this, changes: [...changes] };
    },
  };
}

/**
 * Converts object arguments into bounded JSON strings for wire formats that
 * require strings. Oversized values are truncated into a still-parseable JSON
 * object instead of throwing — a raw `RangeError` here would abort request
 * normalization for the whole request (crash). The truncation is bounded and self-describing so
 * downstream tools can detect it.
 */
export function stringifyToolArguments(value: unknown): string {
  if (typeof value === "string") {
    if (value.length > MAX_SERIALIZED_TOOL_ARGUMENT_LENGTH) return truncatedToolArguments(value);
    return value;
  }
  if (value === undefined || value === null) return "{}";
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return "{}";
  if (serialized.length > MAX_SERIALIZED_TOOL_ARGUMENT_LENGTH) return truncatedToolArguments(serialized);
  return serialized;
}

/** Bounded, parseable representation for tool arguments that exceed the wire limit. */
function truncatedToolArguments(raw: string): string {
  // Reserve room for the JSON envelope so the result stays under the limit.
  const previewBudget = Math.max(0, MAX_SERIALIZED_TOOL_ARGUMENT_LENGTH - 128);
  const preview = raw.slice(0, previewBudget);
  return JSON.stringify({ __ohmyomop_router_truncated__: true, original_length: raw.length, preview });
}

/**
 * Downgrades a forced tool choice (`required` or a named function) to
 * `auto` when the model does not support forced choice. `auto` and `none` are
 * always safe and pass through. When `forcedToolChoice` is `undefined` the
 * caller's choice is preserved (no capability signal → no change).
 */
export function downgradeForcedToolChoice(
  toolChoice: ProxyRequest["toolChoice"] | string | Record<string, unknown>,
  forcedToolChoice: boolean | undefined,
): ProxyRequest["toolChoice"] | string | Record<string, unknown> {
  if (toolChoice === undefined) return toolChoice;
  // Legacy string/object callers during migration (tests, older payloads) — normalize to kind check
  if (typeof toolChoice === "string") {
    if (forcedToolChoice !== false) return toolChoice;
    if (toolChoice === "auto" || toolChoice === "none") return toolChoice;
    return "auto";
  }
  if (typeof (toolChoice as Record<string, unknown>).type === "string") {
    if (forcedToolChoice !== false) return toolChoice;
    return "auto";
  }
  if (forcedToolChoice !== false) return toolChoice;
  if (toolChoice.kind === "auto" || toolChoice.kind === "none") return toolChoice;
  return { kind: "auto" };
}

function allocateTargetId(sourceId: string, usedIds: Set<string>): string {
  const base = sanitizeToolCallId(sourceId);
  let target = base;
  let suffix = 2;
  while (usedIds.has(target)) target = `${base.slice(0, MAX_TOOL_CALL_ID_LENGTH - String(suffix).length - 1)}_${suffix++}`;
  usedIds.add(target);
  return target;
}

function sanitizeToolCallId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+/, "").slice(0, MAX_TOOL_CALL_ID_LENGTH);
  return normalized === "" ? "call_generated" : normalized;
}

function mergeAdjacentMessages(messages: readonly NormalizedMessage[], changes: ToolRepairChange[]): NormalizedMessage[] {
  const merged: NormalizedMessage[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous === undefined || previous.role !== message.role) {
      merged.push(message);
      continue;
    }
    merged[merged.length - 1] = { ...previous, content: [...previous.content, ...message.content] };
    changes.push({ kind: "merged-message" });
  }
  return merged;
}

