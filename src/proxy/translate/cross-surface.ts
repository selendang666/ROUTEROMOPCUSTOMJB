import { translateAnthropicResponse } from "../normalize/anthropic.js";
import { normalizeMessagesRequest } from "../normalize/anthropic.js";
import { foldResponseEvents } from "../events/assembly.js";
import type { ProxyEndpoint as DetectionEndpoint } from "../types/routing.js";
import { ProtocolCodecError } from "../errors.js";
import { transformGeminiResponse } from "../upstream/gemini.js";
import { normalizeChatRequest, normalizeResponsesRequest } from "../normalize/openai.js";
import { translateOpenAIChatResponse, translateOpenAIResponsesResponse } from "./response.js";
import { lookupResponseTranslation } from "../events/assembly.js";
import type { ProviderUsage, TranslationDiagnostic, TranslationDiagnosticAction, TranslationDiagnosticStage } from "../types/telemetry.js";
import type { ContentPart, RequestLimits } from "../types/content.js";
import type { StopReason, StreamEvent } from "../types/stream.js";
import type { Surface } from "../types/surface.js";
import type { ResponseDocument } from "../events/assembly.js";
import { orderedResponseItems } from "../events/assembly.js";

import { registerResponseTranslation } from "../events/assembly.js";
import type { ResponseTranslationContext } from "../events/assembly.js";
import { fullPromptTokens, usageNumber } from "../usage.js";
import { isRecord, narrowList, narrowRecord, narrowText, nullableNumber } from "../validation.js";
import { jsonObject, normalizeFail } from "../protocol-request.js";
import { protocolError } from "../errors.js";
import type { NormalizeInput, NormalizeResult } from "../protocol-request.js";
import type { ProtocolError } from "../errors.js";

import type { HeaderSnapshot } from "../protocol-request.js";
import { isWhitespaceCode, scanTrim, scanTrimEnd } from "../normalize/detection.js";
import type { FormatDetectionResult } from "../normalize/detection.js";

// Cross-surface detection and projection helpers.
export type {
  ClientFormat,
  ClientProfileName,
  DetectionSource,
  DetectionConfidence,
  ClientProfile,
  FormatDetectionResult,
  ClientIdentity,
  ClientName,
  ClientDetectionSource,
} from "../normalize/detection.js";
export { detectClientFormat, normalizationEndpoint, clientIdentityForProfile } from "../normalize/detection.js";

/**
 * Pathname-to-proxy-endpoint lookup: the single source of truth for HTTP
 * routing. Returns the endpoint + client surface for proxy paths, null for
 * everything else (console, static, /v1/models, unknown).
 */
export function lookupProxyEndpoint(pathname: string): { readonly endpoint: DetectionEndpoint; readonly surface: Surface } | null {
  switch (pathname) {
    case "/v1/chat/completions":
      return { endpoint: "/v1/chat/completions", surface: "openai-chat" };
    case "/v1/messages":
      return { endpoint: "/v1/messages", surface: "anthropic-messages" };
    case "/v1/responses":
      return { endpoint: "/v1/responses", surface: "openai-responses" };
    case "/v1/responses/compact":
      return { endpoint: "/v1/responses/compact", surface: "openai-responses" };
    default:
      return null;
  }
}

/** Authoritative endpoint-to-surface mapping for this proxy's surfaces. */
export function detectSurface(endpoint: DetectionEndpoint): Surface | null {
  switch (endpoint) {
    case "/v1/chat/completions":
      return "openai-chat";
    case "/v1/messages":
      return "anthropic-messages";
    case "/v1/responses":
      return "openai-responses";
    case "/v1/responses/compact":
      return "openai-responses";
    case "/v1/models":
      return null;
  }
}

/**
 * Endpoint-driven dispatch: validates and normalizes the wire body into the
 * application `NormalizedProviderRequest`, or returns a typed, sanitized failure.
 * Non-stream/stream semantics are carried by the narrowed `stream` boolean;
 * NDJSON-style multi-object bodies are rejected here (batch framing is a
 * transport concern, one request per HTTP call).
 */
export function normalizeRequest(endpoint: DetectionEndpoint, body: unknown, input: NormalizeInput): NormalizeResult {
  switch (endpoint) {
    case "/v1/chat/completions":
      return normalizeChatRequest(body, input);
    case "/v1/messages":
      return normalizeMessagesRequest(body, input);
    case "/v1/responses":
      return normalizeResponsesRequest(body, input);
    case "/v1/responses/compact":
      return normalizeResponsesRequest(body, { ...input, operation: "compact" });
    case "/v1/models":
      return normalizeFail(protocolError("endpoint", "model listing has no request body to normalize"));
  }
}

/**
 * Parses a raw request body under the pipeline byte bound (approximated by
 * UTF-16 length; transport slices may pre-validate exact bytes). Accepts
 * exactly one JSON object; NDJSON batch payloads (multiple JSON values) are
 * rejected with a typed error rather than silently using the first line.
 */
export function parseRequestBody(text: string, limits: RequestLimits): unknown | ProtocolError {
  if (Buffer.byteLength(text, "utf8") > limits.maxBodyBytes) return protocolError("body", `request body exceeds ${limits.maxBodyBytes} bytes`);
  let start = 0;
  let end = text.length;
  while (start < end && isWhitespaceCode(text.charCodeAt(start))) start++;
  while (end > start && isWhitespaceCode(text.charCodeAt(end - 1))) end--;
  if (start >= end) return protocolError("body", "request body is empty");
  const trimmed = start === 0 && end === text.length ? text : text.slice(start, end);
  if (trimmed[0] !== "{") return protocolError("body", "request body must be a single JSON object (NDJSON batch bodies are not accepted)");
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return protocolError("body", "request body must be a JSON object");
    return parsed;
  } catch {
    return protocolError("body", "request body is not valid JSON");
  }
}

function toResponseUsageBody(usage: ProviderUsage | null): Record<string, unknown> | undefined {
  if (usage === null) return undefined;
  const input = usageNumber(usage.inputTokens);
  const output = usageNumber(usage.outputTokens);
  const cached = usageNumber(usage.cacheReadTokens);
  const written = usageNumber(usage.cacheWriteTokens);
  const prompt = fullPromptTokens(usage);
  return {
    input_tokens: prompt,
    output_tokens: output,
    total_tokens: usageNumber(usage.totalTokens) || prompt + output,
    input_tokens_details: {
      cached_tokens: cached,
      ...(written > 0 ? { cache_write_tokens: written } : {}),
    },
    output_tokens_details: { reasoning_tokens: usageNumber(usage.reasoningTokens ?? null) },
  };
}

function openAIStop(reason: StopReason, hasTool: boolean): string {
  if (reason === "error") return "error";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "content_filter";
  if (reason === "tool_call" || hasTool) return "tool_calls";
  return "stop";
}

function anthropicStop(reason: StopReason): string {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_call") return "tool_use";
  if (reason === "content_filter") return "refusal";
  if (reason === "compaction") return "compaction";
  if (reason === "pause_turn") return "pause_turn";
  return "end_turn";
}

function responseStatus(reason: StopReason): "completed" | "incomplete" | "failed" {
  if (reason === "error") return "failed";
  return reason === "length" || reason === "content_filter" ? "incomplete" : "completed";
}

function responseIncompleteReason(reason: StopReason): string | undefined {
  if (reason === "length") return "max_output_tokens";
  if (reason === "content_filter") return "content_filter";
  return undefined;
}

function messageContent(events: readonly StreamEvent[]): readonly Record<string, unknown>[] {
  return orderedResponseItems(events).flatMap((item) => {
    if (item.kind === "thinking") return [{ type: "thinking", thinking: item.text }];
    if (item.kind === "text") return [{ type: "text", text: item.text }];
    if (item.kind === "server_tool") return [{ ...item.block }];
    if (item.kind === "compaction") return [{ type: "compaction", content: item.text }];
    if (item.kind === "context") return [{ ...item.item }];
    return [{ type: "tool_use", id: item.callId, name: item.name, input: jsonObject(item.arguments) }];
  });
}

function transformWebSearchResponse(body: Record<string, unknown>, model: string): ResponseDocument {
  const id = narrowText(body.id) ?? `search-${crypto.randomUUID()}`;
  const events: StreamEvent[] = [{ type: "message_start", id }];
  const results = narrowList(body.search_results).filter(isRecord);
  if (results.length > 0) events.push({ type: "server_tool_result", block: { type: "web_search_tool_result", content: results } });
  const choice = narrowRecord(narrowList(body.choices)[0]);
  const message = narrowRecord(choice?.message);
  const text = narrowText(message?.content) ?? narrowText(body.output_text);
  if (text !== null && text.length > 0) events.push({ type: "text_delta", text });
  events.push({ type: "message_stop", reason: "completed" });
  return { sourceSurface: "web-search", model, events, rawBody: body };
}

/**
 * Translates web-search tool results (web_search_tool_result) into openai-compatible tool_result ContentParts.
 * Used for vice versa: web-search surface → openai-chat tool_result, and handles highlights/citations/images from exa/perplexity/parallel.
 */
export function translateWebSearchToolResult(results: readonly Record<string, unknown>[]): readonly ContentPart[] {
  return results.map((result) => ({
    type: "tool_result" as const,
    toolCallId: String(result.id ?? result.tool_call_id ?? crypto.randomUUID()),
    text: [
      result.title ? `Title: ${String(result.title)}` : null,
      result.url ? `URL: ${String(result.url)}` : null,
      result.summary ? String(result.summary) : null,
      result.highlight ? String(result.highlight) : null,
      result.text ? String(result.text) : null,
      Array.isArray(result.highlights) ? (result.highlights as unknown[]).map((h) => String((h as Record<string, unknown>).text ?? h)).join("\n") : null,
      Array.isArray(result.citations) ? (result.citations as unknown[]).map((c) => String(c)).join("\n") : null,
      result.image ? `Image: ${String((result.image as Record<string, unknown>).url ?? result.image)}` : null,
    ]
      .filter((part): part is string => part !== null && part.length > 0)
      .join("\n\n"),
  }));
}

/** Transforms a provider response body into the shared semantic event document. */
export function transformProviderResponse(surface: Surface, body: Record<string, unknown>, model: string): ResponseDocument {
  if (surface === "openai-chat") return translateOpenAIChatResponse(body, model);
  if (surface === "openai-responses") return translateOpenAIResponsesResponse(body, model);
  if (surface === "anthropic-messages") return translateAnthropicResponse(body, model);
  if (surface === "web-search") return transformWebSearchResponse(body, model);
  return transformGeminiResponse(body, model);
}

/** Translates canonical response events into a client-facing non-stream body. */
export function translateResponseDocument(targetSurface: Surface, document: ResponseDocument): Record<string, unknown> {
  const folded = foldResponseEvents(document.events);
  const id = folded.id || `${targetSurface}-${crypto.randomUUID()}`;
  const toolCalls = folded.toolCalls.map((call) => ({ id: call.callId, type: "function", function: { name: call.name, arguments: call.arguments } }));
  if (targetSurface === "openai-chat") {
    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: document.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: folded.text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...(folded.thinking.length > 0 ? { reasoning_content: folded.thinking } : {}),
        },
        finish_reason: openAIStop(folded.reason, toolCalls.length > 0),
      }],
      ...(folded.usage === null ? {} : {
        usage: {
          prompt_tokens: fullPromptTokens(folded.usage),
          completion_tokens: usageNumber(folded.usage.outputTokens),
          total_tokens: usageNumber(folded.usage.totalTokens) || fullPromptTokens(folded.usage) + usageNumber(folded.usage.outputTokens),
          prompt_tokens_details: {
            cached_tokens: usageNumber(folded.usage.cacheReadTokens),
            ...(usageNumber(folded.usage.cacheWriteTokens) > 0 ? { cache_write_tokens: usageNumber(folded.usage.cacheWriteTokens) } : {}),
          },
          completion_tokens_details: { reasoning_tokens: usageNumber(folded.usage.reasoningTokens ?? null) },
        },
      }),
    };
  }
  if (targetSurface === "anthropic-messages") {
    const content = messageContent(document.events);
    const output = content.length > 0 ? content : [{ type: "text", text: "" }];
    return {
      id,
      type: "message",
      role: "assistant",
      model: document.model,
      content: output,
      stop_reason: anthropicStop(folded.reason),
      stop_sequence: null,
      ...(folded.usage === null ? {} : { usage: { input_tokens: usageNumber(folded.usage.inputTokens), output_tokens: usageNumber(folded.usage.outputTokens), cache_read_input_tokens: usageNumber(folded.usage.cacheReadTokens), cache_creation_input_tokens: usageNumber(folded.usage.cacheWriteTokens) } }),
    };
  }
  if (targetSurface === "openai-responses") {
    const output: Record<string, unknown>[] = [];
    let reasoningCount = 0;
    let messageCount = 0;
    for (const item of orderedResponseItems(document.events)) {
      if (item.kind === "thinking") {
        const suffix = reasoningCount === 0 ? "" : `-${reasoningCount}`;
        output.push({ type: "reasoning", id: `${id}-reasoning${suffix}`, summary: [{ type: "summary_text", text: item.text }] });
        reasoningCount += 1;
      } else if (item.kind === "text") {
        const suffix = messageCount === 0 ? "" : `-${messageCount}`;
        output.push({ type: "message", id: `${id}-message${suffix}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: item.text, annotations: [] }] });
        messageCount += 1;
      } else if (item.kind === "tool_call") output.push({ type: "function_call", id: item.callId, call_id: item.callId, name: item.name, arguments: item.arguments, status: "completed" });
    }
    const status = responseStatus(folded.reason);
    const body: Record<string, unknown> = { id, object: "response", created_at: Math.floor(Date.now() / 1000), status, model: document.model, output, output_text: folded.text };
    const usage = toResponseUsageBody(folded.usage);
    if (usage !== undefined) body.usage = usage;
    const incompleteReason = responseIncompleteReason(folded.reason);
    if (incompleteReason !== undefined) body.incomplete_details = { reason: incompleteReason };
    if (folded.error !== undefined) body.error = folded.error;
    return body;
  }
  throw new ProtocolCodecError({ kind: "capability_unsupported", message: `Non-stream response encoding is unsupported for surface "${targetSurface}"`, statusCode: 400, routeScope: null });
}

function projectDocument(document: ResponseDocument, context: ResponseTranslationContext): ResponseDocument {
  return { ...document, sourceSurface: context.targetSurface, model: context.model };
}

function registerBuiltInResponseTranslations(): void {
  const edges: readonly [Surface, Surface][] = [
    ["openai-chat", "openai-responses"],
    ["openai-responses", "openai-chat"],
    ["openai-chat", "anthropic-messages"],
    ["anthropic-messages", "openai-chat"],
    ["web-search", "anthropic-messages"],
    ["web-search", "openai-chat"],
    ["web-search", "openai-responses"],
  ];
  for (const [from, to] of edges) registerResponseTranslation(from, to, projectDocument);
}

registerBuiltInResponseTranslations();

/** Translates a non-stream response through a direct semantic projection edge. */
export function translateNonStreamResponse(body: Record<string, unknown>, sourceSurface: Surface, targetSurface: Surface, model: string): Record<string, unknown> {
  if (sourceSurface === targetSurface) return body;
  if (sourceSurface === "images" || targetSurface === "images") {
    throw new ProtocolCodecError({ kind: "capability_unsupported", message: `Non-stream translation from ${sourceSurface} to ${targetSurface} is unsupported`, statusCode: 400, routeScope: null });
  }
  const document = transformProviderResponse(sourceSurface, body, model);
  const projector = lookupResponseTranslation(sourceSurface, targetSurface);
  if (projector === undefined) {
    throw new ProtocolCodecError({ kind: "capability_unsupported", message: `No direct non-stream translation from ${sourceSurface} to ${targetSurface}`, statusCode: 400, routeScope: null });
  }
  const projected = projector(document, { sourceSurface, targetSurface, model });
  return translateResponseDocument(targetSurface, projected);
}

const MAX_DIAGNOSTICS = 32;
const MAX_DIAGNOSTIC_VALUE_LENGTH = 160;
const SAFE_FORMATS = new Set(["openai-chat", "openai-responses", "anthropic-messages", "cursor-chat-hybrid", "gemini", "gemini-cli", "codex", "unknown"]);

export interface TranslationDiagnosticInput {
  readonly stage: TranslationDiagnosticStage;
  readonly sourceFormat: string;
  readonly targetSurface: Surface;
  readonly fieldCategory: string;
  readonly action: TranslationDiagnosticAction;
  readonly reason: string;
}

/** Builds bounded, allowlisted metadata without accepting request payload data. */
export function boundedTranslationDiagnostics(inputs: readonly TranslationDiagnosticInput[]): readonly TranslationDiagnostic[] {
  const seen = new Set<string>();
  const diagnostics: TranslationDiagnostic[] = [];
  for (const input of inputs) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
    const diagnostic: TranslationDiagnostic = {
      stage: input.stage,
      sourceFormat: SAFE_FORMATS.has(input.sourceFormat) ? input.sourceFormat : "unknown",
      targetSurface: input.targetSurface,
      fieldCategory: clampDiagnostic(input.fieldCategory, 64),
      action: input.action,
      reason: sanitizeDiagnosticReason(input.reason),
    };
    const key = `${diagnostic.stage}|${diagnostic.sourceFormat}|${diagnostic.targetSurface}|${diagnostic.fieldCategory}|${diagnostic.action}|${diagnostic.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

/** Records bounded format-adaptation diagnostics without payload values. */
export function diagnosticsForDetection(
  endpoint: DetectionEndpoint,
  targetSurface: Surface,
  detection: FormatDetectionResult,
  normalizedEndpoint: DetectionEndpoint,
): readonly TranslationDiagnostic[] {
  const inputs: TranslationDiagnosticInput[] = [];
  if (endpoint !== normalizedEndpoint) {
    inputs.push({
      stage: "normalization",
      sourceFormat: detection.profile.format,
      targetSurface,
      fieldCategory: "wire-surface",
      action: "adapted",
      reason: `body shape selected ${normalizedEndpoint} translation`,
    });
  }
  for (const conflict of detection.conflicts.slice(0, 8)) {
    inputs.push({
      stage: "detection",
      sourceFormat: detection.profile.format,
      targetSurface,
      fieldCategory: "client-format",
      action: "adapted",
      reason: conflict,
    });
  }
  return boundedTranslationDiagnostics(inputs);
}

function sanitizeDiagnosticReason(value: string): string {
  const normalized = normalizeDiagnosticText(value);
  if (/[{}\[\]]/.test(normalized)) return "redacted structured detail";
  return clampDiagnostic(
    normalized
      .replace(/\bbearer\s+\S+/gi, "bearer [redacted]")
      .replace(/\b(authorization|api[-_]?key|secret|password|token)\b\s*[:=]\s*\S+/gi, "$1 [redacted]"),
    MAX_DIAGNOSTIC_VALUE_LENGTH,
  );
}

function clampDiagnostic(value: string, limit: number): string {
  const normalized = normalizeDiagnosticText(value);
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function normalizeDiagnosticText(value: string): string {
  return scanTrim(value.replace(/[\u0000-\u001f\u007f]/g, " "));
}
