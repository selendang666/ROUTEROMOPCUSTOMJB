import { applicationError } from "../errors.js";
import { isRecord, MAX_TOOL_ARGUMENT_LENGTH } from "../validation.js";
import type { ContentPart, NormalizedMessage } from "../types/content.js";
import type { ExtendedStreamEvent, StopReason, StreamEvent } from "../types/stream.js";
import type { ProviderUsage } from "../types/telemetry.js";
import type { Surface } from "../types/surface.js";
import type { PresentedProxyResponse, ProviderOutput } from "../types/request.js";
import type { InternalFailure, PublicErrorBody } from "../types/error-types.js";
import { ProtocolCodecError } from "../errors.js";

/** Canonical non-stream response representation shared by all provider surfaces. */
export interface ResponseDocument {
  readonly sourceSurface: Surface;
  readonly model: string;
  readonly events: readonly StreamEvent[];
  readonly rawBody?: Record<string, unknown>;
}

export interface ResponseTranslationContext {
  readonly sourceSurface: Surface;
  readonly targetSurface: Surface;
  readonly model: string;
}

export type ResponseProjector = (
  document: ResponseDocument,
  context: ResponseTranslationContext,
) => ResponseDocument;

const registry = new Map<Surface, Map<Surface, ResponseProjector>>();

/** Registers one direct semantic response projection edge. */
export function registerResponseTranslation(from: Surface, to: Surface, projector: ResponseProjector): void {
  let targets = registry.get(from);
  if (targets === undefined) {
    targets = new Map<Surface, ResponseProjector>();
    registry.set(from, targets);
  }
  targets.set(to, projector);
}

/** Looks up a direct semantic response projection edge. */
export function lookupResponseTranslation(from: Surface, to: Surface): ResponseProjector | undefined {
  return registry.get(from)?.get(to);
}

const MAX_REASONING_TEXT = 64 * 1024;

/** Builds a bounded non-visible reasoning content block. */
export function createReasoningBlock(input: {
  readonly text?: string;
  readonly encryptedContent?: string;
  readonly summary?: readonly Readonly<Record<string, unknown>>[];
  readonly raw?: Readonly<Record<string, unknown>>;
}): ContentPart {
  const text = input.text === undefined ? undefined : input.text.slice(0, MAX_REASONING_TEXT);
  const encryptedContent = input.encryptedContent === undefined ? undefined : input.encryptedContent.slice(0, MAX_REASONING_TEXT);
  const summary = input.summary === undefined ? undefined : input.summary.slice(0, 128).map((item) => ({ ...item }));
  return {
    type: "reasoning",
    reasoningText: text ?? "",
    ...(encryptedContent === undefined ? {} : { reasoningEncryptedContent: encryptedContent }),
    ...(summary === undefined ? {} : { reasoningSummary: summary }),
  } as ContentPart;
}

/** Extracts visible summary text from an event sequence without exposing encrypted content. */
export function reasoningTextFromEvents(events: readonly StreamEvent[]): string {
  let text = "";
  for (const event of events) if (event.type === "thinking_delta") text += event.text;
  return text;
}

/** Validates and bounds a native reasoning summary list. */
export function boundedReasoningSummary(value: unknown): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: Readonly<Record<string, unknown>>[] = [];
  for (const item of value.slice(0, 128)) {
    if (!isRecord(item)) continue;
    entries.push({ ...item });
  }
  return entries;
}

export interface FoldedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

export interface FoldedResponse {
  readonly id: string;
  readonly text: string;
  readonly thinking: string;
  readonly toolCalls: readonly FoldedToolCall[];
  readonly contextItems: readonly Readonly<Record<string, unknown>>[];
  readonly usage: ProviderUsage | null;
  readonly reason: StopReason;
  readonly error?: Readonly<Record<string, unknown>>;
}

export type FoldedResponseItem =
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool_call"; readonly callId: string; readonly name: string; readonly arguments: string }
  | { readonly kind: "server_tool"; readonly block: Readonly<Record<string, unknown>> }
  | { readonly kind: "compaction"; readonly text: string }
  | { readonly kind: "context"; readonly item: Readonly<Record<string, unknown>> };

/** Folds canonical stream semantics into the state needed by non-stream translation. */
export function foldResponseEvents(events: readonly StreamEvent[]): FoldedResponse {
  let id = "";
  let usage: ProviderUsage | null = null;
  let reason: StopReason = "completed";
  let error: Readonly<Record<string, unknown>> | undefined;
  const textChunks: string[] = [];
  const thinkingChunks: string[] = [];
  // insertion-ordered so parallel tool calls keep their arrival order
  const calls = new Map<string, { name: string; argLength: number; argumentChunks: string[] }>();
  // deltas that arrive before their tool_call_start are buffered here, never
  // materialized as an anonymous `name:""` call (would be rejected downstream).
  const pendingDeltas = new Map<string, string[]>();

  const appendDelta = (target: { argLength: number; argumentChunks: string[] }, callId: string, delta: string): void => {
    target.argLength += delta.length;
    if (target.argLength > MAX_TOOL_ARGUMENT_LENGTH) {
      throw applicationError("invalid_request", 413, `toolCalls.${callId}.arguments`, `streamed tool arguments exceed ${MAX_TOOL_ARGUMENT_LENGTH} characters`);
    }
    target.argumentChunks.push(delta);
  };

  for (const event of events) {
    if (event.type === "message_start") id = event.id;
    else if (event.type === "thinking_delta") thinkingChunks.push(event.text);
    else if (event.type === "text_delta") textChunks.push(event.text);
    else if (event.type === "tool_call_start") {
      if (!event.callId || event.callId.trim() === "" || !event.name || event.name.trim() === "") {
        throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "tool_call_start missing name or id", statusCode: 502, routeScope: "provider" });
      }
      const entry = { name: event.name, argLength: 0, argumentChunks: [] as string[] };
      // Fold any deltas that arrived before this start.
      const buffered = pendingDeltas.get(event.callId);
      if (buffered !== undefined) {
        for (const delta of buffered) appendDelta(entry, event.callId, delta);
        pendingDeltas.delete(event.callId);
      }
      calls.set(event.callId, entry);
    } else if (event.type === "tool_call_delta") {
      const current = calls.get(event.callId);
      if (current === undefined) {
        // No start yet — buffer, bounding total pending size too.
        const buffered = pendingDeltas.get(event.callId) ?? [];
        const pendingLength = buffered.reduce((sum, chunk) => sum + chunk.length, 0);
        if (pendingLength + event.delta.length > MAX_TOOL_ARGUMENT_LENGTH) {
          throw applicationError("invalid_request", 413, `toolCalls.${event.callId}.arguments`, `streamed tool arguments exceed ${MAX_TOOL_ARGUMENT_LENGTH} characters`);
        }
        buffered.push(event.delta);
        pendingDeltas.set(event.callId, buffered);
      } else {
        appendDelta(current, event.callId, event.delta);
      }
    } else if (event.type === "tool_call_end") {
      // A start is required to name the call; an end without start (and its
      // buffered deltas) is dropped rather than emitted as an anonymous call.
      pendingDeltas.delete(event.callId);
    }
    else if (event.type === "usage") usage = event.usage;
    else if (event.type === "message_stop") {
      reason = event.reason;
      error = event.error === undefined ? undefined : { kind: event.error.kind, message: event.error.safeMessage };
    }
  }

  return {
    id,
    text: textChunks.join(""),
    thinking: thinkingChunks.join(""),
    toolCalls: [...calls.entries()].map(([callId, value]) => ({ callId, name: value.name, arguments: value.argumentChunks.join("") || "{}" })),
    contextItems: [],
    usage,
    reason,
    ...(error === undefined ? {} : { error }),
  };
}

/** Folds text, reasoning, native blocks, and tool calls without changing event order. */
export function orderedResponseItems(events: readonly StreamEvent[]): readonly FoldedResponseItem[] {
  const items: FoldedResponseItem[] = [];
  const toolIndexes = new Map<string, number>();
  const toolArgumentChunks = new Map<string, string[]>();
  for (const event of events) {
    if (event.type === "thinking_delta") items.push({ kind: "thinking", text: event.text });
    else if (event.type === "text_delta") items.push({ kind: "text", text: event.text });
    else if (event.type === "tool_call_start") {
      toolIndexes.set(event.callId, items.length);
      toolArgumentChunks.set(event.callId, []);
      items.push({ kind: "tool_call", callId: event.callId, name: event.name, arguments: "" });
    } else if (event.type === "tool_call_delta") {
      const chunks = toolArgumentChunks.get(event.callId);
      if (chunks === undefined) toolArgumentChunks.set(event.callId, [event.delta]);
      else chunks.push(event.delta);
    } else if (event.type === "tool_call_end") {
      const index = toolIndexes.get(event.callId);
      const current = index === undefined ? undefined : items[index];
      if (index !== undefined && current?.kind === "tool_call") {
        items[index] = { ...current, arguments: toolArgumentChunks.get(event.callId)?.join("") || "{}" };
      }
    }
  }
  for (const [callId, index] of toolIndexes) {
    const current = items[index];
    if (current?.kind === "tool_call" && current.arguments.length === 0) {
      items[index] = { ...current, arguments: toolArgumentChunks.get(callId)?.join("") || "{}" };
    }
  }
  return items;
}

/** Returns the last provider usage event, or null when the source omitted usage. */
export function responseUsage(events: readonly StreamEvent[]): ProviderUsage | null {
  let usage: ProviderUsage | null = null;
  for (const event of events) if (event.type === "usage") usage = event.usage;
  return usage;
}

