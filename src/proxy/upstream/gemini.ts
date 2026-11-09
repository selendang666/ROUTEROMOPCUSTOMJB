import type { Adapter, ProviderOutput, ProviderRequest } from "../types/request.js";
import type { ApplicationErrorKind, InternalFailure } from "../types/error-types.js";
import type { CompatibilityProfile, CompatibilityRequestRule, OpenAIAdapterConfig, ProviderCaps, ProviderCatalogAdapter, ProviderMeta } from "../types/provider.js";
import type { RouteTarget } from "../types/routing.js";
import type { SseEvent, StreamMapper } from "../types/stream.js";
import { UpstreamError, parseUpstreamFailure } from "../transport/errors.js";
import { dispatchWithCoordinator } from "./dispatch.js";
import { lineLimit } from "../transport/sse.js";
import type { ContentPart, ImageReference, PdfReference, VideoReference } from "../types/content.js";
import type { ProviderUsage } from "../types/telemetry.js";
import type { ProxyRequest } from "../types/request.js";
import type { StopReason, StreamEvent } from "../types/stream.js";
import type { Surface } from "../types/surface.js";
import type { ResponseDocument } from "../events/assembly.js";
import { internalFailureFromTrace, ProtocolCodecError } from "../errors.js";
import { usageFromTotalInput } from "../usage.js";
import { isRecord, nullableNumber } from "../validation.js";
import { messageText } from "../protocol-request.js";
import { mapGeminiToolName, normalizeGeminiRole, projectReasoningOutputTokens } from "../policy/projection.js";
import { providerQuirkPolicy } from "../policy/profiles.js";


const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "propertyOrdering",
  "minProperties",
  "maxProperties",
  "items",
  "anyOf",
]);

function sanitizeGeminiSchema(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const schema: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === "type") {
      if (typeof child === "string") {
        if (child === "null") schema.nullable = true;
        else schema.type = child;
      } else if (Array.isArray(child)) {
        const types = child.filter((type): type is string => typeof type === "string");
        const nonNullTypes = types.filter((type) => type !== "null");
        if (types.includes("null")) schema.nullable = true;
        if (nonNullTypes.length === 1) {
          schema.type = nonNullTypes[0];
        } else if (nonNullTypes.length > 1) {
          schema.anyOf = nonNullTypes.map((type) => ({ type }));
        }
      }
    } else if (key === "properties" && isRecord(child)) {
      schema.properties = Object.fromEntries(Object.entries(child).map(([name, property]) => [name, sanitizeGeminiSchema(property)]));
    } else if (key === "items" && isRecord(child)) {
      schema.items = sanitizeGeminiSchema(child);
    } else if (key === "anyOf" && Array.isArray(child)) {
      schema.anyOf = child.map(sanitizeGeminiSchema);
    } else if (key === "required" && Array.isArray(child)) {
      schema.required = child.filter((name): name is string => typeof name === "string");
    } else {
      schema[key] = child;
    }
  }
  return schema;
}

export function buildGeminiPayload(request: ProxyRequest): Record<string, unknown> {
  const quirks = providerQuirkPolicy("gemini");
  const system = request.messages.filter((message) => message.role === "system" || message.role === "developer").flatMap((message) => {
    const t = messageText(message);
    return t ? [{ text: t }] : [];
  });
  const toolNames = new Map<string, string>();
  for (const message of request.messages) {
    for (const block of message.content) {
      if (isToolUsePart(block) && block.toolCallId.length > 0) toolNames.set(block.toolCallId, mapGeminiToolName(block.toolName, quirks));
    }
  }
  const contents = request.messages
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .map((message) => ({ role: normalizeGeminiRole(message.role === "assistant" ? "assistant" : "user", quirks), parts: message.content.flatMap((block) => toGeminiPart(block, toolNames, quirks)) }));
  const payload: Record<string, unknown> = { contents };
  if (system.length > 0) payload.systemInstruction = { role: "user", parts: system };
  const functionTools = request.tools.filter((tool): tool is import("../types/content.js").NormalizedFunctionTool => tool.kind === "function");
  if (functionTools.length !== request.tools.length) {
    throw new ProtocolCodecError({ kind: "capability_unsupported", message: "Gemini cannot represent hosted or native tools", statusCode: 400, routeScope: "provider" });
  }
  if (functionTools.length > 0) payload.tools = [{ functionDeclarations: functionTools.map((tool) => ({ name: mapGeminiToolName(tool.name, quirks), description: tool.description ?? "", parameters: sanitizeGeminiSchema(tool.inputSchema) })) }];
  const generationConfig: Record<string, unknown> = {};
  if (request.maxOutputTokens !== null) generationConfig.maxOutputTokens = request.maxOutputTokens;
  const _rawFmtGem = (request as unknown as { responseFormat?: unknown }).responseFormat;
  const geminiResponseFormatKind = typeof _rawFmtGem === "string" ? _rawFmtGem : (_rawFmtGem != null && typeof _rawFmtGem === "object" && "kind" in (_rawFmtGem as Record<string, unknown>) ? String((_rawFmtGem as Record<string, unknown>)["kind"]) : "text");
  if (geminiResponseFormatKind !== "text") generationConfig.responseMimeType = "application/json";
  const thinkingBudget = projectReasoningOutputTokens(request.maxOutputTokens, request.reasoning === "enabled", quirks, 32_768);
  if (thinkingBudget !== null && request.reasoning === "enabled") generationConfig.thinkingConfig = { thinkingBudget };
  if (Object.keys(generationConfig).length > 0) payload.generationConfig = generationConfig;
  return payload;
}

function toGeminiPart(block: ContentPart, toolNames: ReadonlyMap<string, string>, quirks = providerQuirkPolicy("gemini")): Record<string, unknown>[] {
  if (isTextPart(block)) return [{ text: block.text ?? "" }];
  if (isReasoningPart(block)) return [{ text: block.reasoningText ?? "", thought: true, ...(block.reasoningSignature === undefined ? {} : { thoughtSignature: block.reasoningSignature }) }];
  if (isImagePart(block) && block.image !== undefined) return [toGeminiImage(block.image)];
  if (isPdfPart(block) && block.pdf !== undefined) return [toGeminiPdf(block.pdf)];
  if (isVideoPart(block) && block.video !== undefined) return [toGeminiVideo(block.video)];
  if (isToolUsePart(block)) {
    const toolCallId = block.toolCallId ?? "";
    return [{ functionCall: { name: mapGeminiToolName(block.toolName ?? "tool", quirks), args: parseJsonObject(block.toolArguments ?? "{}"), ...(toolCallId.length > 0 ? { id: toolCallId } : {}) }, ...(block.reasoningSignature === undefined ? {} : { thoughtSignature: block.reasoningSignature }) }];
  }
  if (isToolResultPart(block)) {
    const toolCallId = block.toolCallId ?? "";
    return [{ functionResponse: { name: (toolNames.get(toolCallId) ?? toolCallId) || "tool", response: parseJsonObject(block.text ?? ""), ...(toolCallId.length > 0 ? { id: toolCallId } : {}) } }];
  }
  if (isNativePart(block)) return [{ text: JSON.stringify(block.nativePayload) }];
  return [];
}

function toGeminiImage(image: ImageReference): Record<string, unknown> {
  if (image.kind === "data") return { inlineData: { mimeType: image.mediaType ?? "image/png", data: image.value.replace(/^data:[^;,]+;base64,/, "") } };
  return { fileData: { fileUri: image.value, mimeType: image.mediaType ?? "application/octet-stream" } };
}

function toGeminiPdf(pdf: PdfReference): Record<string, unknown> {
  if (pdf.kind === "data") return { inlineData: { mimeType: pdf.mediaType ?? "application/pdf", data: pdf.value.replace(/^data:[^;,]+;base64,/, "") } };
  return { fileData: { fileUri: pdf.value, mimeType: pdf.mediaType ?? "application/pdf" } };
}

function toGeminiVideo(video: VideoReference): Record<string, unknown> {
  if (video.kind === "data") return { inlineData: { mimeType: video.mediaType ?? "video/mp4", data: video.value.replace(/^data:[^;,]+;base64,/, "") } };
  return { fileData: { fileUri: video.value, mimeType: video.mediaType ?? "video/mp4" } };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { content: value };
  } catch {
    return value.length > 0 ? { content: value } : {};
  }
}

function isTextPart(part: ContentPart): part is Extract<ContentPart, { type: "text" }> {
  return part.type === "text";
}

function isImagePart(part: ContentPart): part is Extract<ContentPart, { type: "image" }> {
  return part.type === "image";
}

function isPdfPart(part: ContentPart): part is Extract<ContentPart, { type: "pdf" }> {
  return part.type === "pdf";
}

function isVideoPart(part: ContentPart): part is Extract<ContentPart, { type: "video" }> {
  return part.type === "video";
}

function isToolUsePart(part: ContentPart): part is Extract<ContentPart, { type: "tool_use" }> {
  return part.type === "tool_use";
}

function isToolResultPart(part: ContentPart): part is Extract<ContentPart, { type: "tool_result" }> {
  return part.type === "tool_result";
}

function isReasoningPart(part: ContentPart): part is Extract<ContentPart, { type: "reasoning" }> {
  return part.type === "reasoning";
}

function isNativePart(part: ContentPart): part is Extract<ContentPart, { type: "native" }> {
  return part.type === "native";
}

/** Extracts the Gemini response, first candidate, and bounded content parts. */
export function geminiCandidate(body: Record<string, unknown>): { readonly response: Record<string, unknown>; readonly candidate: Record<string, unknown>; readonly parts: readonly Record<string, unknown>[] } {
  const response = isRecord(body.response) ? body.response : body;
  const candidates = response.candidates;
  const candidate = Array.isArray(candidates) && isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(candidate.content) ? candidate.content : {};
  const parts = Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
  return { response, candidate, parts };
}

/** Folds Gemini text, thought, function-call, and inline image parts. */
export function responseParts(parts: readonly Record<string, unknown>[]): {
  readonly text: string;
  readonly calls: readonly { readonly id: string; readonly name: string; readonly args: Record<string, unknown>; readonly reasoningSignature?: string }[];
  readonly thought: string;
  readonly reasoningSignature?: string;
  readonly images: readonly { readonly data: string; readonly mimeType: string | null }[];
} {
  const text: string[] = [];
  const thought: string[] = [];
  const calls: Array<{ id: string; name: string; args: Record<string, unknown>; reasoningSignature?: string }> = [];
  const images: Array<{ data: string; mimeType: string | null }> = [];
  let reasoningSignature: string | undefined;
  let callIndex = 0;
  for (const part of parts) {
    const thoughtSignature = typeof part.thoughtSignature === "string"
      ? part.thoughtSignature
      : typeof part.thought_signature === "string"
        ? part.thought_signature
        : undefined;
    if (typeof part.text === "string") {
      if (part.thought === true) {
        thought.push(part.text);
        if (thoughtSignature !== undefined) reasoningSignature ??= thoughtSignature;
      } else text.push(part.text);
    }
    const inlineData = isRecord(part.inlineData) ? part.inlineData : null;
    if (inlineData !== null && typeof inlineData.data === "string") images.push({ data: inlineData.data, mimeType: typeof inlineData.mimeType === "string" ? inlineData.mimeType : null });
    if (isRecord(part.functionCall) && typeof part.functionCall.name === "string") {
      calls.push({ id: typeof part.functionCall.id === "string" ? part.functionCall.id : `call_${callIndex++}`, name: part.functionCall.name, args: isRecord(part.functionCall.args) ? part.functionCall.args : {}, ...(thoughtSignature === undefined ? {} : { reasoningSignature: thoughtSignature }) });
    }
  }
  return { text: text.join(""), calls, thought: thought.join(""), reasoningSignature, images };
}

/** Maps Gemini usageMetadata into the provider-neutral usage shape. */
export function mapGeminiUsage(body: Record<string, unknown>): ProviderUsage {
  const usage = isRecord(body.usageMetadata) ? body.usageMetadata : {};
  return usageFromTotalInput(
    nullableNumber(usage.promptTokenCount),
    nullableNumber(usage.candidatesTokenCount),
    nullableNumber(usage.cachedContentTokenCount),
    null,
    nullableNumber(usage.totalTokenCount),
  );
}

function stopReason(candidate: Record<string, unknown>, calls: number): StopReason {
  if (calls > 0) return "tool_call";
  if (candidate.finishReason === "MAX_TOKENS") return "length";
  return "completed";
}

export function transformGeminiResponse(body: Record<string, unknown>, model: string): ResponseDocument {
  const { response, candidate, parts } = geminiCandidate(body);
  const output = responseParts(parts);
  const id = typeof response.responseId === "string" ? response.responseId : `gemini-${crypto.randomUUID()}`;
  const events: StreamEvent[] = [{ type: "message_start", id }];
  if (output.thought.length > 0) events.push({ type: "thinking_delta", text: output.thought, ...(output.reasoningSignature === undefined ? {} : { reasoningSignature: output.reasoningSignature }) });
  if (output.text.length > 0) events.push({ type: "text_delta", text: output.text });
  for (const call of output.calls) events.push({ type: "tool_call_start", callId: call.id, name: call.name, ...(call.reasoningSignature === undefined ? {} : { reasoningSignature: call.reasoningSignature }) }, { type: "tool_call_delta", callId: call.id, delta: JSON.stringify(call.args) }, { type: "tool_call_end", callId: call.id });
  const usage = mapGeminiUsage(body);
  if (usage.inputTokens !== null || usage.outputTokens !== null || usage.totalTokens !== null) events.push({ type: "usage", usage });
  events.push({ type: "message_stop", reason: stopReason(candidate, output.calls.length) });
  return { sourceSurface: "openai-chat", model, events, rawBody: body };
}

/** Translates a Gemini body into a requested text surface. */
export function translateGeminiResponse(body: Record<string, unknown>, surface: Surface, model: string): Record<string, unknown> {
  if (surface !== "openai-chat" && surface !== "openai-responses" && surface !== "anthropic-messages") {
    throw new ProtocolCodecError({
      kind: "capability_unsupported",
      message: `Gemini does not support surface "${surface}"`,
      statusCode: 400,
      routeScope: null,
    });
  }
  const document = transformGeminiResponse(body, model);
  const events = document.events;
  let text = "";
  let thinking = "";
  const calls: Array<{ id: string; name: string; arguments: string; reasoningSignature?: string }> = [];
  let usage: ProviderUsage | null = null;
  let reason: StopReason = "completed";
  let thinkingSignature: string | undefined;
  for (const event of events) {
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "thinking_delta") { thinking += event.text; thinkingSignature ??= event.reasoningSignature; }
    else if (event.type === "tool_call_start") calls.push({ id: event.callId, name: event.name, arguments: "", ...(event.reasoningSignature === undefined ? {} : { reasoningSignature: event.reasoningSignature }) });
    else if (event.type === "tool_call_delta") {
      const call = calls.find((item) => item.id === event.callId);
      if (call !== undefined) call.arguments += event.delta;
    } else if (event.type === "usage") usage = event.usage;
    else if (event.type === "message_stop") reason = event.reason;
  }
  const id = typeof body.responseId === "string" ? body.responseId : `gemini-${crypto.randomUUID()}`;
  const usageBase = usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, cachedTokens: 0, source: "provider" as const };
  if (surface === "anthropic-messages") return { id, type: "message", role: "assistant", model, content: [...(thinking ? [{ type: "thinking", thinking, ...(thinkingSignature === undefined ? {} : { signature: thinkingSignature }) }] : []), ...(text ? [{ type: "text", text }] : []), ...calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: parseArguments(call.arguments), ...(call.reasoningSignature === undefined ? {} : { signature: call.reasoningSignature }) }))], stop_reason: reason === "tool_call" ? "tool_use" : reason === "length" ? "max_tokens" : "end_turn", stop_sequence: null, usage: { input_tokens: usageBase.inputTokens ?? 0, output_tokens: usageBase.outputTokens ?? 0 } };
  if (surface === "openai-responses") return { id, object: "response", created_at: Math.floor(Date.now() / 1000), status: reason === "length" ? "incomplete" : "completed", model, output: [...(thinking ? [{ type: "reasoning", id: `${id}-reasoning`, summary: [{ type: "summary_text", text: thinking }] }] : []), ...(text ? [{ type: "message", id: `${id}-message`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }] : []), ...calls.map((call) => ({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments }))], output_text: text, usage: { input_tokens: usageBase.inputTokens ?? 0, output_tokens: usageBase.outputTokens ?? 0, total_tokens: usageBase.totalTokens ?? 0 } };
  return { id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: text || null, ...(calls.length > 0 ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments }, ...(call.reasoningSignature === undefined ? {} : { extra_content: { google: { thought_signature: call.reasoningSignature } } }) })) } : {}), ...(thinking ? { reasoning_content: thinking } : {}) }, finish_reason: reason === "tool_call" ? "tool_calls" : reason === "length" ? "length" : "stop" }], usage: { prompt_tokens: (usageBase.promptTokens ?? usageBase.inputTokens ?? 0), completion_tokens: (usageBase.completionTokens ?? usageBase.outputTokens ?? 0), total_tokens: usageBase.totalTokens ?? 0 } };
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** SSE stream mapper for Gemini-style generateContent streams. */
export function transformGeminiGenerateContentStream(providerId: string): StreamMapper {
  let started = false;
  let stopped = false;
  const activeCalls = new Set<string>();
  return (sse: SseEvent): StreamEvent | readonly StreamEvent[] | null => {
    let parsed: unknown;
    try { parsed = JSON.parse(sse.data); } catch { return null; }
    if (!isRecord(parsed)) return null;
    if (isRecord(parsed.error)) {
      throw internalFailureFromTrace(
        {
          providerId,
          transport: "sse",
          statusCode: null,
          providerCode: null,
          providerType: null,
          requestId: null,
          retryAfterMs: null,
          rawMessage: typeof parsed.error.message === "string" ? parsed.error.message : null,
          bodyTruncated: false,
        },
        { kind: "provider_protocol_error", retryable: false, routeScope: "provider" },
      );
    }
    const { response, candidate, parts } = geminiCandidate(parsed);
    const output = responseParts(parts);
    const events: StreamEvent[] = [];
    if (!started) { started = true; events.push({ type: "message_start", id: typeof response.responseId === "string" ? response.responseId : `gemini-${crypto.randomUUID()}` }); }
    if (output.thought) events.push({ type: "thinking_delta", text: output.thought, ...(output.reasoningSignature === undefined ? {} : { reasoningSignature: output.reasoningSignature }) });
    if (output.text) events.push({ type: "text_delta", text: output.text });
    for (const call of output.calls) {
      if (!activeCalls.has(call.id)) {
        activeCalls.add(call.id);
        events.push({ type: "tool_call_start", callId: call.id, name: call.name, ...(call.reasoningSignature === undefined ? {} : { reasoningSignature: call.reasoningSignature }) });
      }
      const argumentsText = JSON.stringify(call.args);
      if (argumentsText.length > 0 && argumentsText !== "{}") events.push({ type: "tool_call_delta", callId: call.id, delta: argumentsText });
    }
    if (isRecord(parsed.usageMetadata)) {
      const usage = mapGeminiUsage(parsed);
      events.push({ type: "usage", usage });
    }
    if (typeof candidate.finishReason === "string" && !stopped) {
      stopped = true;
      for (const callId of activeCalls) events.push({ type: "tool_call_end", callId });
      activeCalls.clear();
      events.push({ type: "message_stop", reason: candidate.finishReason === "MAX_TOKENS" ? "length" : output.calls.length > 0 ? "tool_call" : "completed" });
    }
    return events.length > 0 ? events : null;
  };
}

/** Executes a Gemini generateContent request after the provider supplies credentials. */
export async function dispatchGemini(input: ProviderRequest, baseUrl: string, credential: string): Promise<ProviderOutput> {
  const { request, signal, network } = input;
  const action = request.stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const url = `${baseUrl}/models/${encodeURIComponent(input.target.upstreamModelId)}:${action}`;
  return dispatchWithCoordinator({
    url,
    headers: {
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
      "x-goog-api-key": credential,
    },
    body: JSON.stringify(buildGeminiPayload(request)),
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
    mapStream: transformGeminiGenerateContentStream(input.target.providerId),
    mapNonStream: (body) => {
      const translated = translateGeminiResponse(body, input.target.surface, request.model);
      return { mode: "non_stream", body: translated, usage: mapGeminiUsage(body) };
    },
    parseFailure: (response) => parseUpstreamFailure(response, input.target.providerId),
    streamConfig: { maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs },
  });
}
