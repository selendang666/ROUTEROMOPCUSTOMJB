import { createInternalFailure } from "../errors.js";
import { sanitizeMessage } from "../types/error-types.js";
import { numberField, usageFromTotalInput } from "../usage.js";
import { STREAM_BOUNDS, StreamError } from "../transport/sse.js";
import { parseSseData } from "../transport/sse.js";
import { buildChatPayload, buildResponsesPayload } from "../translate/request.js";
import { mapChatUsage, mapResponsesUsage } from "../translate/response.js";
import { capabilitiesOf, classifyCompatibilityRejection, recordCompatibilityFallback, removeCompatibilityProjection } from "../translate/policy.js";
import { applyProviderQuirkPolicy, applyResponsesToolCloak, applyRequiredProviderHeaders } from "../policy/projection.js";
import type { ModelCapabilities } from "../translate/policy.js";
import { isRecord } from "../validation.js";
import { internalFailureFromUnknown } from "../errors.js";
import { providerQuirkPolicy } from "../policy/profiles.js";

import type { Adapter, ProviderOutput, ProviderRequest } from "../types/request.js";
import type { ApplicationErrorKind, InternalFailure } from "../types/error-types.js";
import type { CompatibilityProfile, CompatibilityRequestRule, OpenAIAdapterConfig, ProviderCaps, ProviderCatalogAdapter, ProviderMeta } from "../types/provider.js";
import type { ProviderUsage } from "../types/telemetry.js";
import type { RouteTarget } from "../types/routing.js";
import type { SseEvent, StopReason, StreamEvent, StreamMapper } from "../types/stream.js";
import type { Surface } from "../types/surface.js";
import { lineLimit } from "../transport/sse.js";
import { parseUpstreamFailure, UpstreamError } from "../transport/errors.js";
import { executeFetch } from "../transport/fetch.js";
import { compatibilityUrl, applyCompatibilityRequestRules, compatibilityResponseMetadata } from "./compatibility.js";
import { dispatchWithCoordinator } from "./dispatch.js";

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) result[name] = value;
  return result;
}

/**
 * Executes a Chat Completions upstream call (shared with the native adapter,
 * which speaks the same upstream format). Streams are transformed through the chat
 * SSE mapper; the coordinator's lifetime is handed off to the stream.
 */
export async function dispatchChatCompletions(
  input: ProviderRequest,
  baseUrl: string,
  headers: Record<string, string>,
  payloadOverrides: Readonly<Record<string, unknown>> = {},
  options: {
    readonly explicitCache?: boolean;
    readonly capabilities?: ModelCapabilities;
    readonly compatibility?: CompatibilityProfile;
    readonly quirks?: import("../types/provider.js").ProviderQuirkPolicy;
  } = { explicitCache: false },
): Promise<ProviderOutput> {
  const { request, signal, network } = input;
  const quirks = options.quirks ?? providerQuirkPolicy(input.target.providerId);
  const payload = applyProviderQuirkPolicy(
    applyCompatibilityRequestRules(
    {
      ...buildChatPayload(request, {
        upstreamModel: input.target.upstreamModelId,
        explicitCache: options.explicitCache,
        capabilities: options.capabilities,
        streamUsage: options.compatibility?.streamUsage,
        structuredOutputs: options.compatibility?.structuredOutputs,
      }),
      ...payloadOverrides,
      model: input.target.upstreamModelId,
    },
    options.compatibility?.requestRules,
    ),
    quirks,
  );
  const finalHeaders = headersToRecord(applyRequiredProviderHeaders(new Headers(headers), quirks));
  const endpoint = compatibilityUrl(baseUrl, "/chat/completions", options.compatibility);
  return dispatchWithCoordinator({
    url: endpoint,
    headers: finalHeaders,
    body: JSON.stringify(payload),
    signal,
    timeouts: {
      connectTimeoutMs: request.limits.connectTimeoutMs,
      firstByteTimeoutMs: request.limits.firstByteTimeoutMs,
      idleTimeoutMs: request.limits.idleTimeoutMs,
      totalTimeoutMs: request.limits.totalTimeoutMs,
    },
    network,
    capture: input.capture ?? undefined,
    stream: request.stream,
    mapStream: transformOpenAIChatStream(),
    mapNonStream: (body, headers) => {
      const usageRecord = isRecord(body.usage) ? body.usage : null;
      const metadata = compatibilityResponseMetadata(headers, body, options.compatibility);
      return {
        mode: "non_stream",
        body,
        usage: usageRecord !== null ? mapChatUsage(usageRecord) : undefined,
        ...(metadata === undefined ? {} : { metadata }),
      };
    },
    mapStreamOutput: (events, headers) => {
      const metadata = compatibilityResponseMetadata(headers, undefined, options.compatibility);
      return { mode: "stream", events, ...(metadata === undefined ? {} : { metadata }) };
    },
    parseFailure: (response) => parseUpstreamFailure(response, input.target.providerId),
    retryOnFailure: async (failedResponse, coordinator) => {
      try {
        await parseUpstreamFailure(failedResponse, input.target.providerId);
        return null;
      } catch (error) {
        const rejection = error instanceof UpstreamError ? classifyCompatibilityRejection(internalFailureFromUnknown(error)) : null;
        if (rejection === null || !rejection.retryable || !removeCompatibilityProjection(payload, rejection)) throw error;
        recordCompatibilityFallback(input, rejection);
        return executeFetch(endpoint, { method: "POST", headers: finalHeaders, body: JSON.stringify(payload) }, coordinator, network, input.capture);
      }
    },
    streamConfig: { maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs },
  });
}

/**
 * Executes a Responses upstream call. Streams are transformed through the responses
 * SSE mapper; the coordinator's lifetime is handed off to the stream.
 */
export async function dispatchResponses(
  input: ProviderRequest,
  baseUrl: string,
  headers: Record<string, string>,
  options: {
    readonly explicitCache?: boolean;
    readonly capabilities?: ModelCapabilities;
    readonly compatibility?: CompatibilityProfile;
    readonly payloadOverrides?: Readonly<Record<string, unknown>>;
    readonly quirks?: import("../types/provider.js").ProviderQuirkPolicy;
  } = { explicitCache: false },
): Promise<ProviderOutput> {
  const { request, signal, network } = input;
  const quirks = options.quirks ?? providerQuirkPolicy(input.target.providerId);
  const payload = applyProviderQuirkPolicy(
    applyCompatibilityRequestRules(
    {
      ...buildResponsesPayload(request, {
        upstreamModel: input.target.upstreamModelId,
        explicitCache: options.explicitCache,
        capabilities: options.capabilities,
      }),
      ...options.payloadOverrides,
    },
    options.compatibility?.requestRules,
    ),
    quirks,
  );
  const finalPayload = applyResponsesToolCloak(payload, quirks);
  const finalHeaders = headersToRecord(applyRequiredProviderHeaders(new Headers(headers), quirks));
  const endpoint = compatibilityUrl(baseUrl, "/responses", options.compatibility);
  const dispatchPayload = JSON.stringify(finalPayload);
  return dispatchWithCoordinator({
    url: endpoint,
    headers: finalHeaders,
    body: dispatchPayload,
    signal,
    timeouts: {
      connectTimeoutMs: request.limits.connectTimeoutMs,
      firstByteTimeoutMs: request.limits.firstByteTimeoutMs,
      idleTimeoutMs: request.limits.idleTimeoutMs,
      totalTimeoutMs: request.limits.totalTimeoutMs,
    },
    network,
    capture: input.capture ?? undefined,
    stream: request.stream,
    mapStream: transformOpenAIResponsesStream(input.target.providerId),
    mapNonStream: (body, headers) => {
      const usageRecord = isRecord(body.usage) ? body.usage : null;
      const metadata = compatibilityResponseMetadata(headers, body, options.compatibility);
      return {
        mode: "non_stream",
        body,
        usage: usageRecord !== null ? mapResponsesUsage(usageRecord) : undefined,
        ...(metadata === undefined ? {} : { metadata }),
      };
    },
    mapStreamOutput: (events, headers) => {
      const metadata = compatibilityResponseMetadata(headers, undefined, options.compatibility);
      return { mode: "stream", events, ...(metadata === undefined ? {} : { metadata }) };
    },
    parseFailure: (response) => parseUpstreamFailure(response, input.target.providerId),
    retryOnFailure: async (failedResponse, coordinator) => {
      try {
        await parseUpstreamFailure(failedResponse, input.target.providerId);
        return null;
      } catch (error) {
        const rejection = error instanceof UpstreamError ? classifyCompatibilityRejection(internalFailureFromUnknown(error)) : null;
        if (rejection === null || !rejection.retryable || !removeCompatibilityProjection(payload, rejection)) throw error;
        recordCompatibilityFallback(input, rejection);
        return executeFetch(endpoint, { method: "POST", headers: finalHeaders, body: JSON.stringify(applyResponsesToolCloak(payload, quirks)) }, coordinator, network, input.capture);
      }
    },
    streamConfig: { maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs },
  });
}

export const OPENAI_SURFACES = ["openai-chat", "openai-responses"] as const;

export const OPENAI_FALLBACK_CAPS = capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true, images: true });

/** Shared OpenAI-compatible auth headers — dedupes 15 providers. */
export function openaiAuthHeaders(credential: string, stream: boolean, extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    authorization: `Bearer ${credential}`,
    ...(extra ?? {}),
  };
}

// ── AI SDK / OpenAI-compatible chat mapper ──────────────────────────────────
/**
 * Maps OpenAI-compatible chat SSE events (including AI SDK shapes) to canonical
 * StreamEvents. Features:
 *  - content / reasoning / reasoning_content → thinking/text deltas
 *  - tool_calls buffering until function.name exists
 *  - extra_content.google.thought_signature preserved as reasoningSignature
 *  - usage-only choices:[] chunk → usage event
 *  - [DONE] sentinel → terminal message_stop
 *  - finish_reason → StopReason
 */

function deltaString(delta: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = delta[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function reasoningDetailsText(delta: Record<string, unknown>): string | null {
  const candidates: unknown[] = [delta["reasoning_details"], delta["reasoning_detail"], delta["reasoning_details_text"]];
  for (const raw of candidates) {
    if (Array.isArray(raw)) {
      const parts: string[] = [];
      for (const entry of raw) {
        if (typeof entry === "string" && entry.length > 0) parts.push(entry);
        else if (entry !== null && typeof entry === "object") {
          const r = entry as Record<string, unknown>;
          const t = typeof r.text === "string" ? r.text : typeof r.content === "string" ? r.content : typeof r.reasoning === "string" ? r.reasoning : "";
          if (t.length > 0) parts.push(t);
        }
      }
      if (parts.length > 0) return parts.join("\n");
    } else if (typeof raw === "string" && raw.length > 0) return raw;
  }
  return null;
}

function extractThinkTag(text: string): { thinking: string | null; remaining: string | null } {
  const m = text.match(/<think(?:ing)?[^>]*>([\s\S]*?)<\/think(?:ing)?>/i);
  if (!m || m[1] === undefined) return { thinking: null, remaining: null };
  const thinking = m[1].trim();
  const remaining = text.replace(m[0], "").trim();
  return { thinking: thinking.length > 0 ? thinking : null, remaining: remaining.length > 0 ? remaining : null };
}

function thoughtSignatureFrom(delta: Record<string, unknown>): string | undefined {
  // extra_content.google.thought_signature (AI SDK / OpenAI-compatible)
  const extra = isRecord(delta.extra_content) ? delta.extra_content : null;
  if (extra) {
    const google = isRecord(extra.google) ? extra.google : null;
    if (google && typeof google.thought_signature === "string" && google.thought_signature.length > 0) return google.thought_signature;
    if (google && typeof (google as Record<string, unknown>).thoughtSignature === "string" && ((google as Record<string, unknown>).thoughtSignature as string).length > 0)
      return (google as Record<string, unknown>).thoughtSignature as string;
  }
  // direct thought_signature on delta (some providers)
  if (typeof delta.thought_signature === "string" && delta.thought_signature.length > 0) return delta.thought_signature;
  if (typeof delta.thoughtSignature === "string" && delta.thoughtSignature.length > 0) return delta.thoughtSignature;
  // reasoning signature variants (Anthropic signature / OpenAI encrypted_content)
  if (typeof delta.signature === "string" && delta.signature.length > 0) return delta.signature;
  if (typeof delta.encrypted_content === "string" && delta.encrypted_content.length > 0) return delta.encrypted_content;
  return undefined;
}

function mapChatFinishReason(v: string | null): StopReason {
  if (v === "length") return "length";
  if (v === "tool_calls" || v === "function_call") return "tool_call";
  if (v === "content_filter") return "content_filter";
  if (v === "error") return "error";
  return "completed";
}

export function transformOpenAIChatStream(): StreamMapper {
  let started = false;
  let id: string | null = null;
  let lastFinishReason: string | null = null;

  // index -> state
  const toolByIndex = new Map<number, { callId: string; name: string | null; signature?: string; pending: string[]; emittedStart: boolean }>();

  type ToolCallState = { callId: string; name: string | null; signature?: string; pending: string[]; emittedStart: boolean; existed: boolean };
  const getOrCreate = (index: number, incomingId: string | null, fnName: string | null, sig: string | undefined): ToolCallState => {
    const existing = toolByIndex.get(index);
    if (existing) {
      if (incomingId && existing.callId.startsWith("tool_call_")) existing.callId = incomingId;
      if (fnName && !existing.name) existing.name = fnName;
      if (sig && !existing.signature) existing.signature = sig;
      return { ...existing, existed: true };
    }
    const callId = incomingId ?? `tool_call_${index}`;
    const entry = { callId, name: fnName, signature: sig, pending: [] as string[], emittedStart: false };
    toolByIndex.set(index, entry);
    return { ...entry, existed: false };
  };

  return (sse: SseEvent): StreamEvent | readonly StreamEvent[] | null => {
    if (sse.data === "[DONE]") {
      const events: StreamEvent[] = [];
      for (const [, info] of toolByIndex) {
        if (info.emittedStart) events.push({ type: "tool_call_end", callId: info.callId });
      }
      toolByIndex.clear();
      events.push({ type: "message_stop", reason: mapChatFinishReason(lastFinishReason) });
      return events;
    }

    const parsed = parseSseData(sse.data);
    if (!isRecord(parsed)) return null;

    const events: StreamEvent[] = [];
    if (typeof parsed.id === "string") id = parsed.id;

    // usage may appear either top-level or alongside choices — emit regardless of choices
    const rawUsage = isRecord(parsed.usage) ? parsed.usage : null;
    if (rawUsage) {
      // detect Responses vs Chat usage shape by key
      const isResponses = "input_tokens" in rawUsage;
      events.push({ type: "usage", usage: isResponses ? mapResponsesUsage(rawUsage) : mapChatUsage(rawUsage) });
    }

    const choices = parsed.choices;
    if (!Array.isArray(choices)) {
      // usage-only chunk (choices: [] or absent) — return usage if any, else null
      if (events.length > 0) {
        if (!started) {
          events.unshift({ type: "message_start", id: id ?? `chatcmpl-${crypto.randomUUID()}` });
          started = true;
        }
        return events;
      }
      return events.length > 0 ? events : null;
    }

    if (choices.length === 0) {
      // usage-only chunk, e.g. { choices: [], usage: {...} }
      if (events.length > 0) {
        if (!started) {
          events.unshift({ type: "message_start", id: id ?? `chatcmpl-${crypto.randomUUID()}` });
          started = true;
        }
        return events;
      }
      return null;
    }

    const first = choices[0];
    if (!isRecord(first)) return events.length > 0 ? events : null;
    if (typeof first.finish_reason === "string") lastFinishReason = first.finish_reason;

    // ensure message_start exactly once, before any content
    const ensureStarted = (): void => {
      if (!started) {
        events.unshift({ type: "message_start", id: id ?? `chatcmpl-${crypto.randomUUID()}` });
        started = true;
      }
    };

    const delta = isRecord(first.delta) ? first.delta : null;
    if (delta) {
      const sig = thoughtSignatureFrom(delta);
      const thinkingRaw = deltaString(delta, ["reasoning_content", "reasoning", "thinking"]) ?? reasoningDetailsText(delta);
      let thinking: string | null = thinkingRaw;
      // Some compat providers embed <think> inside content; split it out
      let thinkFromContent: string | null = null;
      let contentFromDelta: string | null = deltaString(delta, ["content"]);
      if (thinking === null && contentFromDelta !== null && /<think/i.test(contentFromDelta)) {
        const extracted = extractThinkTag(contentFromDelta);
        if (extracted.thinking !== null) {
          thinking = extracted.thinking;
          contentFromDelta = extracted.remaining;
        }
      }
      if (thinking !== null) {
        ensureStarted();
        // frame bound check
        if (events.length >= STREAM_BOUNDS.framesPerPush)
          throw new StreamError({ kind: "provider_protocol_error", message: `Stream frame exceeds ${STREAM_BOUNDS.framesPerPush} per push`, routeScope: "provider" });
        events.push({ type: "thinking_delta", text: thinking, ...(sig === undefined ? {} : { reasoningSignature: sig }) });
      }
      if (contentFromDelta !== null) {
        ensureStarted();
        if (events.length >= STREAM_BOUNDS.framesPerPush)
          throw new StreamError({ kind: "provider_protocol_error", message: `Stream frame exceeds ${STREAM_BOUNDS.framesPerPush} per push`, routeScope: "provider" });
        events.push({ type: "text_delta", text: contentFromDelta });
      }

      const toolCalls = delta.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const raw of toolCalls) {
          if (!isRecord(raw)) continue;
          const index = typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 0 ? raw.index : 0;
          const fn = isRecord(raw.function) ? raw.function : null;
          const incomingId = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null;
          const fnName = fn && typeof fn.name === "string" && fn.name.length > 0 ? fn.name : null;
          const args = fn && typeof fn.arguments === "string" ? fn.arguments : "";
          const callSig = (fn && isRecord(fn.extra_content) ? thoughtSignatureFrom(fn as unknown as Record<string, unknown>) : undefined) ?? (isRecord(raw.extra_content) ? thoughtSignatureFrom(raw as Record<string, unknown>) : undefined) ?? sig;

          getOrCreate(index, incomingId, fnName, callSig);
          const info = toolByIndex.get(index)!;

          // if still no name, buffer args
          if (!info.name) {
            if (args.length > 0) info.pending.push(args);
            continue;
          }

          // emit start if not yet emitted (now that name exists)
          if (!info.emittedStart) {
            ensureStarted();
            if (events.length >= STREAM_BOUNDS.framesPerPush)
              throw new StreamError({ kind: "provider_protocol_error", message: `Stream frame exceeds ${STREAM_BOUNDS.framesPerPush} per push`, routeScope: "provider" });
            events.push({ type: "tool_call_start", callId: info.callId, name: info.name, ...(info.signature === undefined ? {} : { reasoningSignature: info.signature }) });
            info.emittedStart = true;
            // flush pending
            for (const p of info.pending) {
              if (events.length >= STREAM_BOUNDS.framesPerPush)
                throw new StreamError({ kind: "provider_protocol_error", message: `Stream frame exceeds ${STREAM_BOUNDS.framesPerPush} per push`, routeScope: "provider" });
              events.push({ type: "tool_call_delta", callId: info.callId, delta: p });
            }
            info.pending = [];
          }

          if (args.length > 0) {
            if (events.length >= STREAM_BOUNDS.framesPerPush)
              throw new StreamError({ kind: "provider_protocol_error", message: `Stream frame exceeds ${STREAM_BOUNDS.framesPerPush} per push`, routeScope: "provider" });
            events.push({ type: "tool_call_delta", callId: info.callId, delta: args });
          }
        }
      }

      // some providers send tool_calls as top-level delta function call (single)
      // already covered; no extra handling needed
    }

    // handle non-delta message with finish_reason but no delta (final usage chunk)
    if (events.length === 0 && rawUsage) {
      ensureStarted();
      return events;
    }

    return events.length > 0 ? events : null;
  };
}

// Generic alias for AI SDK compatibility
export const createOpenAICompatibleStreamMapper = transformOpenAIChatStream;

// Responses mapper is re-exported for providers that need it; thin wrapper preserved
export function transformOpenAIResponsesStream(providerId: string): StreamMapper {
  const activeTools = new Map<string, string>();
  let started = false;
  let responseId: string | null = null;
  const knownKinds: Record<string, true> = {
    invalid_request: true,
    authentication_failed: true,
    authorization_denied: true,
    quota_exceeded: true,
    concurrency_exceeded: true,
    model_not_found: true,
    capability_unsupported: true,
    credential_unavailable: true,
    network_unavailable: true,
    provider_rate_limited: true,
    provider_unavailable: true,
    provider_protocol_error: true,
    stream_timeout: true,
    stream_truncated: true,
    client_aborted: true,
    internal_error: true,
  };
  return (sse) => {
    if (sse.data === "[DONE]") return { type: "message_stop", reason: "completed" };
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(sse.data);
      if (!isRecord(parsed)) return null;
      body = parsed;
    } catch {
      throw new UpstreamError({ kind: "provider_protocol_error", message: "Invalid JSON in stream event", retryable: false, routeScope: "provider" });
    }
    const type = typeof body.type === "string" ? body.type : (sse as SseEvent).event;
    if (type === "response.created") {
      const response = isRecord(body.response) ? body.response : {};
      if (typeof response.id === "string") responseId = response.id;
      else responseId ??= crypto.randomUUID();
      started = true;
      return { type: "message_start", id: responseId };
    }
    if (type === "response.output_text.delta") {
      if (typeof body.delta !== "string") return null;
      if (!started) {
        started = true;
        return [{ type: "message_start", id: responseId ?? crypto.randomUUID() }, { type: "text_delta", text: body.delta }];
      }
      return { type: "text_delta", text: body.delta };
    }
    if (type === "response.output_item.added") {
      const item = isRecord(body.item) ? body.item : {};
      if (item.type !== "function_call") return null;
      const callId = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : crypto.randomUUID();
      const name = typeof item.name === "string" ? item.name : "";
      activeTools.set(typeof item.id === "string" ? item.id : callId, callId);
      if (!started) {
        started = true;
        const startId = responseId ?? crypto.randomUUID();
        responseId = startId;
        return [{ type: "message_start", id: startId }, { type: "tool_call_start", callId, name }];
      }
      return { type: "tool_call_start", callId, name };
    }
    if (type === "response.function_call_arguments.delta") {
      const itemId = typeof body.item_id === "string" ? body.item_id : "";
      const callId = activeTools.get(itemId) ?? [...activeTools.values()][0];
      return callId === undefined || typeof body.delta !== "string" ? null : { type: "tool_call_delta", callId, delta: body.delta };
    }
    if (type === "response.output_item.done") {
      const item = isRecord(body.item) ? body.item : {};
      const itemId = typeof item.id === "string" ? item.id : "";
      const callId = activeTools.get(itemId) ?? (typeof item.call_id === "string" ? item.call_id : undefined);
      if (callId === undefined) return null;
      activeTools.delete(itemId);
      return { type: "tool_call_end", callId };
    }
    if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_content.delta") {
      if (typeof body.delta !== "string") return null;
      if (!started) {
        started = true;
        return [{ type: "message_start", id: responseId ?? crypto.randomUUID() }, { type: "thinking_delta", text: body.delta }];
      }
      return { type: "thinking_delta", text: body.delta };
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      const response = isRecord(body.response) ? body.response : {};
      const usage = isRecord(response.usage) ? usageFromTotalInput(
        numberField(response.usage, "input_tokens"),
        numberField(response.usage, "output_tokens"),
        isRecord(response.usage.input_tokens_details) ? numberField(response.usage.input_tokens_details, "cached_tokens") : null,
        null,
        numberField(response.usage, "total_tokens"),
        isRecord(response.usage.output_tokens_details) ? numberField(response.usage.output_tokens_details, "reasoning_tokens") : null,
      ) : null;
      const reason = type === "response.failed" ? "error" : type === "response.incomplete" ? "incomplete" : "completed";
      if (type === "response.failed") {
        const failure = isRecord(response.error) ? response.error : {};
        const rawCode = typeof failure.code === "string" ? failure.code : "";
        const rawMessage = typeof failure.message === "string" ? failure.message : "";
        const combined = `${rawCode} ${rawMessage}`.toLowerCase();
        let kind: ApplicationErrorKind;
        if (combined.includes("rate_limit") || combined.includes("rate limit") || combined.includes("too_many_requests") || combined.includes("too many requests")) kind = "provider_rate_limited";
        else if (combined.includes("overload") || combined.includes("temporarily_unavailable") || combined.includes("capacity_exhausted") || combined.includes("model_capacity")) kind = "provider_unavailable";
        else if (rawCode !== "" && knownKinds[rawCode] === true) kind = rawCode as ApplicationErrorKind;
        else kind = "provider_protocol_error";
        const message = sanitizeMessage(rawMessage.length > 0 ? rawMessage : "provider request failed");
        const events: StreamEvent[] = [];
        if (!started) {
          const startId = responseId ?? (typeof response.id === "string" ? response.id : crypto.randomUUID());
          responseId = startId;
          events.push({ type: "message_start", id: startId });
          started = true;
        }
        for (const [, callId] of [...activeTools.entries()]) {
          events.push({ type: "tool_call_end", callId });
        }
        activeTools.clear();
        events.push({
          type: "message_stop",
          reason,
          error: createInternalFailure({
            kind,
            safeMessage: message,
            upstream: {
              providerId,
              transport: "sse",
              statusCode: null,
              providerCode: rawCode || null,
              providerType: null,
              requestId: null,
              retryAfterMs: null,
              bodyTruncated: false,
            },
          }),
        });
        return events;
      }
      return usage === null ? { type: "message_stop", reason } : [{ type: "usage", usage }, { type: "message_stop", reason }];
    }
    return null;
  };
}
