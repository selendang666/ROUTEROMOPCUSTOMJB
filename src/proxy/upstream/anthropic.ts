import { buildMessagesPayload, mapAnthropicUsage } from "../normalize/anthropic.js";
import { classifyCompatibilityRejection, recordCompatibilityFallback, removeCompatibilityProjection } from "../translate/policy.js";
import type { ModelCapabilities } from "../translate/policy.js";
import { isRecord } from "../validation.js";
import { internalFailureFromUnknown } from "../errors.js";
import { nullableNumber } from "../validation.js";
import type { Adapter, ProviderOutput, ProviderRequest } from "../types/request.js";
import type { ApplicationErrorKind, InternalFailure } from "../types/error-types.js";
import type { CompatibilityProfile, CompatibilityRequestRule, OpenAIAdapterConfig, ProviderCaps, ProviderCatalogAdapter, ProviderMeta } from "../types/provider.js";
import type { ProviderQuirkPolicy } from "../types/provider.js";
import type { ProviderUsage } from "../types/telemetry.js";
import type { RouteTarget } from "../types/routing.js";
import type { SseEvent, StopReason, StreamEvent, StreamMapper } from "../types/stream.js";
import type { Surface } from "../types/surface.js";
import { lineLimit, parseSseData } from "../transport/sse.js";
import { UpstreamError, parseUpstreamFailure } from "../transport/errors.js";
import { executeFetch } from "../transport/fetch.js";
import { dispatchWithCoordinator } from "./dispatch.js";
import { applyRequiredProviderHeaders } from "../policy/projection.js";
import { providerQuirkPolicy } from "../policy/profiles.js";

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) result[name] = value;
  return result;
}
/** Anthropic upstream — HTTP build, response parsing, and SSE mapping. */

// ---------------------------------------------------------------- SSE mapping

function mapAnthropicStopReason(stopReason: string): StopReason {
  switch (stopReason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_call";
    case "refusal":
      return "content_filter";
    case "compaction":
      return "compaction";
    case "pause_turn":
      return "pause_turn";
    case "end_turn":
    case "stop_sequence":
    default:
      return "completed";
  }
}

function isNativeAnthropicBlock(block: Record<string, unknown>): boolean {
  const type = block.type;
  return typeof type === "string" && type.startsWith("server_");
}

function isServerToolResultBlock(block: Record<string, unknown>): boolean {
  const type = block.type;
  return typeof type === "string" && type.endsWith("_tool_result");
}

function mapAnthropicStreamError(type: string): { kind: ApplicationErrorKind; retryable: boolean; routeScope: "account" | "provider" } {
  switch (type) {
    case "rate_limit_error":
      return { kind: "provider_rate_limited", retryable: true, routeScope: "account" };
    case "overloaded_error":
    case "api_error":
      return { kind: "provider_unavailable", retryable: true, routeScope: "provider" };
    case "authentication_error":
      return { kind: "authentication_failed", retryable: false, routeScope: "account" };
    case "permission_error":
      return { kind: "authorization_denied", retryable: false, routeScope: "account" };
    case "invalid_request_error":
    case "request_too_large":
    case "not_found_error":
      return { kind: "invalid_request", retryable: false, routeScope: "provider" };
    default:
      return { kind: "provider_protocol_error", retryable: false, routeScope: "provider" };
  }
}

/**
 * Messages SSE mapper: message_start carries the upstream id, thinking and
 * text deltas map to thinking_delta/text_delta, tool input JSON fragments
 * map to tool_call_delta, native server-tool blocks retain their lifecycle
 * and payloads, message_delta emits aggregated usage and pause_turn, and
 * message_stop terminates with the mapped stop reason.
 */
export function transformAnthropicMessagesStream(
  providerId: string,
  toolNameTransform: (name: string) => string = (name) => name,
): StreamMapper {
  let started = false;
  let id: string | null = null;
  let inputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheWriteTokens: number | null = null;
  let outputTokens: number | null = null;
  let stopReason: StopReason | null = null;
  const toolIds = new Map<number, string>();
  const nativeBlockIndexes = new Set<number>();
  const compactionBlocks = new Set<number>();
  return (sse: SseEvent): StreamEvent | readonly StreamEvent[] | null => {
    const parsed = parseSseData(sse.data);
    if (!isRecord(parsed)) return null;
    const type = parsed.type;
    if (typeof type !== "string") return null;
    switch (type) {
      case "message_start": {
        const message = parsed.message;
        if (isRecord(message)) {
          if (typeof message.id === "string") id = message.id;
          const usage = message.usage;
          if (isRecord(usage)) {
            inputTokens = nullableNumber(usage.input_tokens);
            cacheReadTokens = nullableNumber(usage.cache_read_input_tokens);
            cacheWriteTokens = nullableNumber(usage.cache_creation_input_tokens);
          }
        }
        if (started) return null;
        started = true;
        return { type: "message_start", id: id ?? `msg_${crypto.randomUUID()}` };
      }
      case "content_block_start": {
        const index = nullableNumber(parsed.index) ?? -1;
        const block = parsed.content_block;
        if (isRecord(block) && block.type === "compaction") {
          compactionBlocks.add(index);
          return { type: "compaction_start" };
        }
        if (isRecord(block) && block.type === "tool_use" && typeof block.id === "string") {
          const name = toolNameTransform(typeof block.name === "string" ? block.name : "");
          toolIds.set(index, block.id);
          return { type: "tool_call_start", callId: block.id, name };
        }
        if (isRecord(block) && isServerToolResultBlock(block)) return { type: "server_tool_result", block };
        if (isRecord(block) && isNativeAnthropicBlock(block)) {
          nativeBlockIndexes.add(index);
          return { type: "native_block_start", index, block };
        }
        return null;
      }
      case "content_block_delta": {
        const index = nullableNumber(parsed.index) ?? -1;
        const delta = parsed.delta;
        if (!isRecord(delta)) return null;
        if (delta.type === "compaction_delta") {
          const content = delta.content;
          return compactionBlocks.has(index) && typeof content === "string" && content.length > 0 ? { type: "compaction_delta", text: content } : null;
        }
        if (nativeBlockIndexes.has(index)) return { type: "native_block_delta", index, delta };
        if (delta.type === "text_delta") {
          const text = delta.text;
          return typeof text === "string" && text.length > 0 ? { type: "text_delta", text } : null;
        }
        if (delta.type === "thinking_delta") {
          const thinking = delta.thinking;
          return typeof thinking === "string" && thinking.length > 0 ? { type: "thinking_delta", text: thinking } : null;
        }
        if (delta.type === "input_json_delta") {
          const partial = delta.partial_json;
          const callId = toolIds.get(index);
          return typeof partial === "string" && partial.length > 0 && callId !== undefined ? { type: "tool_call_delta", callId, delta: partial } : null;
        }
        return null;
      }
      case "content_block_stop": {
        const index = nullableNumber(parsed.index) ?? -1;
        if (nativeBlockIndexes.delete(index)) return { type: "native_block_stop", index };
        if (compactionBlocks.delete(index)) return { type: "compaction_stop" };
        const callId = toolIds.get(index);
        if (callId === undefined) return null;
        toolIds.delete(index);
        return { type: "tool_call_end", callId };
      }
      case "message_delta": {
        const delta = parsed.delta;
        if (isRecord(delta) && typeof delta.stop_reason === "string") stopReason = mapAnthropicStopReason(delta.stop_reason);
        const usage = parsed.usage;
        if (isRecord(usage)) outputTokens = nullableNumber(usage.output_tokens);
        const usageEvent = mapAnthropicUsage({
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: cacheWriteTokens,
        });
        return { type: "usage", usage: usageEvent };
      }
      case "message_stop":
        return { type: "message_stop", reason: stopReason ?? "completed" };
      case "error": {
        const error = parsed.error;
        const errorType = isRecord(error) && typeof error.type === "string" ? error.type : "";
        const mapped = mapAnthropicStreamError(errorType);
        const message = isRecord(error) && typeof error.message === "string" ? error.message : "Upstream stream error";
        throw new UpstreamError({
          kind: mapped.kind,
          message,
          retryable: mapped.retryable,
          routeScope: mapped.routeScope,
        }).toInternalFailure({
          providerId,
          transport: "sse",
          statusCode: null,
          providerCode: errorType || null,
          providerType: errorType || null,
          requestId: null,
          retryAfterMs: null,
          rawMessage: message || null,
          bodyTruncated: false,
        });
      }
      default:
        return null;
    }
  };
}

/** Executes an Anthropic Messages request after the provider supplies auth headers. */
export async function dispatchAnthropic(
  input: ProviderRequest,
  baseUrl: string,
  headers: Record<string, string>,
  capabilities: ProviderCaps,
  modelCapabilities?: ModelCapabilities,
  options: { readonly quirks?: ProviderQuirkPolicy } = {},
): Promise<ProviderOutput> {
  const { signal, network } = input;
  const quirks = options.quirks ?? providerQuirkPolicy(input.target.providerId);
  const payload = buildMessagesPayload(input.request, capabilities, { modelCapabilities, quirks });
  payload.model = input.target.upstreamModelId;
  const requestHeaders = headersToRecord(applyRequiredProviderHeaders(new Headers(headers), quirks));
  const endpoint = `${baseUrl}/messages`;
  return dispatchWithCoordinator({
    url: endpoint,
    headers: requestHeaders,
    body: JSON.stringify(payload),
    signal,
    timeouts: {
      connectTimeoutMs: input.request.limits.connectTimeoutMs,
      firstByteTimeoutMs: input.request.limits.firstByteTimeoutMs,
      idleTimeoutMs: input.request.limits.idleTimeoutMs,
      totalTimeoutMs: input.request.limits.totalTimeoutMs,
    },
    network,
    capture: input.capture ?? undefined,
    stream: input.request.stream,
    mapStream: transformAnthropicMessagesStream(input.target.providerId),
    mapNonStream: (body) => {
      const usageRecord = isRecord(body.usage) ? body.usage : null;
      return { mode: "non_stream", body, usage: usageRecord !== null ? mapAnthropicUsage(usageRecord) : undefined };
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
        return executeFetch(endpoint, { method: "POST", headers: requestHeaders, body: JSON.stringify(payload) }, coordinator, network, input.capture);
      }
    },
    streamConfig: { maxLineBytes: lineLimit(input.request.limits), idleTimeoutMs: input.request.limits.idleTimeoutMs },
  });
}
