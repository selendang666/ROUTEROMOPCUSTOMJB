import { applyOpenAIChatCacheBreakpoint, applyOpenAIResponsesCacheBreakpoint } from "./request.js";
import { isWebSearchTool } from "../routing/capability.js";
import type { ModelCapabilities } from "./policy.js";
import { boundedReasoningSummary } from "../events/assembly.js";
import { ProtocolCodecError } from "../errors.js";
import { usageFromTotalInput } from "../usage.js";
import { normalizeClientEffort, projectEffort, preserveWireExtensions } from "./policy.js";
import type { ContentPart, ImageReference, NormalizedMessage, NormalizedTool, PdfReference, ReasoningConfig, VideoReference } from "../types/content.js";
import type { ProviderUsage } from "../types/telemetry.js";
import type { ProxyRequest } from "../types/request.js";
import type { ReasoningContext, ReasoningEffort, ReasoningMode, ReasoningSummary } from "../types/surface.js";
import type { StopReason, StreamEvent } from "../types/stream.js";
import type { ResponseDocument } from "../events/assembly.js";
import { createReasoningBlock } from "../events/assembly.js";
import { downgradeForcedToolChoice, stringifyToolArguments } from "../events/repair.js";


import { MAX_BLOCKS_PER_MESSAGE, MAX_MESSAGE_COUNT, MAX_MODEL_LENGTH, MAX_OUTPUT_TOKENS, MAX_TEXT_BLOCK_LENGTH, MAX_TOOL_ARGUMENT_LENGTH, MAX_TOOL_CALLS_PER_MESSAGE, MAX_TOOL_NAME_LENGTH, boundJsonLength, isRecord, narrowArray, narrowBoolean, narrowList, narrowMessageArray, narrowNumber, narrowObject, narrowRecord, narrowString, narrowText, normalizeStream, nullableNumber } from "../validation.js";
import { abortedError, isProtocolError, protocolError } from "../errors.js";
import { classifyImageReference, pushImageReference } from "../media-guard.js";
import { messageText, normalizeFail, normalizeOk } from "../protocol-request.js";
import { normalizeToolList } from "../normalize/tools.js";
import type { NormalizeInput, NormalizeResult } from "../protocol-request.js";
import type { ProtocolError } from "../errors.js";


function chatStopReason(value: string | null): StopReason {
  if (value === "length") return "length";
  if (value === "tool_calls" || value === "function_call") return "tool_call";
  if (value === "content_filter") return "content_filter";
  return "completed";
}

function responsesStopReason(body: Record<string, unknown>, sawTool: boolean): StopReason {
  if (sawTool) return "tool_call";
  const details = narrowRecord(body.incomplete_details);
  if (narrowText(details?.reason) === "max_output_tokens") return "length";
  if (narrowText(details?.reason) === "content_filter") return "content_filter";
  if (narrowText(body.status) === "failed") return "error";
  return "completed";
}

function responsesWebSearchBlock(item: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const id = typeof item.id === "string" && item.id.length > 0 ? item.id : `web_search_${crypto.randomUUID()}`;
  const action = isRecord(item.action) ? item.action : null;
  const query = typeof action?.query === "string"
    ? action.query
    : Array.isArray(action?.queries)
      ? action.queries.filter((value): value is string => typeof value === "string").join("\n")
      : undefined;
  return {
    type: "server_tool_use",
    id,
    name: "web_search",
    input: query === undefined ? {} : { query },
  };
}

/** Maps an OpenAI Chat usage record into the shared provider usage contract. */
export function mapChatUsage(usage: Record<string, unknown>): ProviderUsage {
  const inputDetails = narrowRecord(usage.prompt_tokens_details);
  const outputDetails = narrowRecord(usage.completion_tokens_details);
  return usageFromTotalInput(
    nullableNumber(usage.prompt_tokens),
    nullableNumber(usage.completion_tokens),
    nullableNumber(inputDetails?.cached_tokens),
    nullableNumber(inputDetails?.cache_write_tokens),
    nullableNumber(usage.total_tokens),
    nullableNumber(outputDetails?.reasoning_tokens),
  );
}

/** Maps an OpenAI Responses usage record into the shared provider usage contract. */
export function mapResponsesUsage(usage: Record<string, unknown>): ProviderUsage {
  const inputDetails = narrowRecord(usage.input_tokens_details);
  const outputDetails = narrowRecord(usage.output_tokens_details);
  return usageFromTotalInput(
    nullableNumber(usage.input_tokens),
    nullableNumber(usage.output_tokens),
    nullableNumber(inputDetails?.cached_tokens),
    nullableNumber(inputDetails?.cache_write_tokens),
    nullableNumber(usage.total_tokens),
    nullableNumber(outputDetails?.reasoning_tokens),
  );
}

/** Transforms an OpenAI Chat Completions body into canonical response events. */
export function translateOpenAIChatResponse(body: Record<string, unknown>, model: string): ResponseDocument {
  const choices = body.choices;
  if (!Array.isArray(choices)) {
    throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "OpenAI Chat response choices must be an array", statusCode: 502, routeScope: "provider" });
  }
  const choice = narrowRecord(choices[0]) ?? {};
  const message = narrowRecord(choice.message) ?? {};
  const id = narrowText(body.id) ?? `chatcmpl-${crypto.randomUUID()}`;
  const events: StreamEvent[] = [{ type: "message_start", id }];
  const reasoningContent = narrowText(message.reasoning_content);
  if (reasoningContent !== null && reasoningContent.length > 0) events.push({ type: "thinking_delta", text: reasoningContent });
  const content = message.content;
  if (typeof content === "string" && content.length > 0) events.push({ type: "text_delta", text: content });
  if (Array.isArray(content)) {
    for (const raw of content) {
      const part = narrowRecord(raw);
      const text = narrowText(part?.text) ?? narrowText(part?.content);
      if (text !== null && text.length > 0) events.push({ type: "text_delta", text });
    }
  }
  for (const raw of narrowList(message.tool_calls)) {
    const call = narrowRecord(raw);
    const fn = narrowRecord(call?.function);
    if (fn === null) continue;
    const callId = narrowText(call?.id) ?? `call_${crypto.randomUUID()}`;
    const name = narrowText(fn.name) ?? "";
    const args = narrowText(fn.arguments) ?? "{}";
    events.push({ type: "tool_call_start", callId, name }, { type: "tool_call_delta", callId, delta: args }, { type: "tool_call_end", callId });
  }
  const usage = isRecord(body.usage) ? mapChatUsage(body.usage) : null;
  if (usage !== null) events.push({ type: "usage", usage });
  events.push({ type: "message_stop", reason: chatStopReason(narrowText(choice.finish_reason)) });
  return { sourceSurface: "openai-chat", model, events, rawBody: body };
}

/** Transforms an OpenAI Responses body into canonical response events. */
export function translateOpenAIResponsesResponse(body: Record<string, unknown>, model: string): ResponseDocument {
  const output = body.output;
  if (output !== undefined && !Array.isArray(output)) {
    throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "OpenAI Responses output must be an array", statusCode: 502, routeScope: "provider" });
  }
  const id = narrowText(body.id) ?? `resp_${crypto.randomUUID()}`;
  const events: StreamEvent[] = [{ type: "message_start", id }];
  let sawTool = false;
  for (const raw of narrowList(output)) {
    const item = narrowRecord(raw);
    if (item === null) continue;
    const type = narrowText(item.type);
    if (type === "message") {
      for (const rawPart of narrowList(item.content)) {
        const part = narrowRecord(rawPart);
        const text = narrowText(part?.text);
        if ((part?.type === "output_text" || part?.type === "text") && text !== null) events.push({ type: "text_delta", text });
      }
    } else if (type === "reasoning") {
      const summary = boundedReasoningSummary(item.summary);
      const reasoning = createReasoningBlock({ encryptedContent: narrowText(item.encrypted_content) ?? undefined, summary });
      const reasoningText = reasoning.reasoningText ?? "";
    if (reasoningText.length > 0) events.push({ type: "thinking_delta", text: reasoningText });
      if (summary !== undefined) {
        for (const entry of summary) {
          const text = narrowText(entry.text);
          if (text !== null && text.length > 0) {
            const already = events.some((e) => e.type === "thinking_delta" && e.text === text);
            if (!already) events.push({ type: "thinking_delta", text });
          }
        }
      }
    } else if (type === "function_call") {
      sawTool = true;
      const callId = narrowText(item.call_id) ?? narrowText(item.id) ?? `call_${events.length}`;
      const name = narrowText(item.name) ?? "";
      const args = narrowText(item.arguments) ?? "{}";
      events.push({ type: "tool_call_start", callId, name }, { type: "tool_call_delta", callId, delta: args }, { type: "tool_call_end", callId });
    } else if (type === "web_search_call") {
      const block = responsesWebSearchBlock(item);
      // Use 1-based native index to match existing fixture expectations (first native block is index 1).
      const nextIndex = events.filter((e) => e.type === "native_block_start").length + 1;
      events.push({ type: "native_block_start", index: nextIndex, block }, { type: "native_block_stop", index: nextIndex });
    } else if (type === "compaction") {
      const text = narrowText(item.content) ?? "";
      if (text.length > 0) events.push({ type: "text_delta", text });
    }
  }
  const hasTextDelta = events.some((event) => event.type === "text_delta");
  if (narrowText(body.output_text) !== null && !hasTextDelta) events.push({ type: "text_delta", text: narrowText(body.output_text) ?? "" });
  const usage = isRecord(body.usage) ? mapResponsesUsage(body.usage) : null;
  if (usage !== null) events.push({ type: "usage", usage });
  events.push({ type: "message_stop", reason: responsesStopReason(body, sawTool) });
  return { sourceSurface: "openai-responses", model, events, rawBody: body };
}




