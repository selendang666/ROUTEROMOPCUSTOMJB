import { isWebSearchTool } from "../routing/capability.js";
import type { ModelCapabilities } from "./policy.js";
import { boundedReasoningSummary } from "../events/assembly.js";
import { ProtocolCodecError } from "../errors.js";
import { usageFromTotalInput } from "../usage.js";
import { normalizeClientEffort, projectEffort, preserveWireExtensions } from "./policy.js";
import type { CacheIntent, ContentPart, ImageReference, NormalizedFunctionTool, NormalizedMessage, NormalizedTool, PdfReference, ReasoningConfig, VideoReference } from "../types/content.js";
import type { ProviderUsage } from "../types/telemetry.js";
import type { ProxyRequest, ResponseFormatConstraint } from "../types/request.js";
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
import { applyOpenAIChatCacheBreakpoint, applyOpenAIResponsesCacheBreakpoint } from "./cache.js";
import type { NormalizeInput, NormalizeResult } from "../protocol-request.js";
import type { ProtocolError } from "../errors.js";


// OpenAI Chat wire codec
/**
 * Translates the normalized request into the OpenAI Chat Completions wire
 * payload while preserving supported response, sampling, tool, and metadata
 * controls through the canonical request contract.
 */
export function buildChatPayload(
  request: ProxyRequest,
  options: {
    readonly allowNativeTools?: boolean;
    readonly upstreamModel?: string;
    readonly explicitCache?: boolean;
    readonly capabilities?: ModelCapabilities;
    readonly streamUsage?: "always" | "never" | "auto";
    readonly structuredOutputs?: { readonly supported: boolean; readonly strictByDefault?: boolean };
  } = {},
): Record<string, unknown> {
  const upstreamModel = options.upstreamModel ?? request.model;
  const tools = functionTools(request.tools);
  const payload: Record<string, unknown> = {
    model: upstreamModel,
    stream: request.stream,
    messages: request.messages.flatMap(toChatMessages),
  };
  if (tools.length > 0) {
    payload.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? undefined,
        parameters: tool.inputSchema,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      },
    }));
  }
  if (request.maxOutputTokens !== null) payload.max_tokens = request.maxOutputTokens;
  if (request.cacheKey !== undefined) payload.prompt_cache_key = request.cacheKey;
  const _rawFormat = (request as unknown as { responseFormat?: unknown }).responseFormat;
  const _formatKind = typeof _rawFormat === "string" ? _rawFormat : (_rawFormat != null && typeof _rawFormat === "object" && "kind" in (_rawFormat as Record<string, unknown>) ? String((_rawFormat as Record<string, unknown>)["kind"]) : "text");
  const responseFormat = typeof _rawFormat === "string" ? { kind: _rawFormat as "text" | "json_object" | "json_schema", schema: (request as unknown as { responseFormatSchema?: Record<string, unknown> }).responseFormatSchema } as unknown as ResponseFormatConstraint : (_rawFormat != null && typeof _rawFormat === "object" && "kind" in (_rawFormat as Record<string, unknown>) ? (_rawFormat as ResponseFormatConstraint) : ({ kind: "text" } as ResponseFormatConstraint));
  if (_formatKind !== "text") {
    if (responseFormat.kind === "json_schema" && options.structuredOutputs?.supported === false) {
      throw new ProtocolCodecError({
        kind: "capability_unsupported",
        message: "The selected OpenAI-compatible provider does not support JSON schema structured output.",
        statusCode: 400,
        routeScope: "provider",
      });
    }
    payload.response_format = responseFormat.kind === "json_schema" && (responseFormat as Extract<ResponseFormatConstraint, { kind: "json_schema" }>).schema !== undefined
      ? {
          type: "json_schema",
          json_schema: {
            ...(responseFormat as Extract<ResponseFormatConstraint, { kind: "json_schema" }>).schema,
            ...(((responseFormat as Extract<ResponseFormatConstraint, { kind: "json_schema" }>).schema as Record<string, unknown>).strict === undefined && options.structuredOutputs?.strictByDefault === true ? { strict: true } : {}),
          },
        }
      : { type: "json_object" };
  }
  if (request.temperature !== undefined) payload.temperature = request.temperature;
  if (request.topP !== undefined) payload.top_p = request.topP;
  if (request.frequencyPenalty !== undefined) payload.frequency_penalty = request.frequencyPenalty;
  if (request.presencePenalty !== undefined) payload.presence_penalty = request.presencePenalty;
  if (request.seed !== undefined) payload.seed = request.seed;
  if (request.user !== undefined) payload.user = request.user;
  if (request.verbosity !== undefined) payload.verbosity = request.verbosity;
  if (request.stop !== undefined) payload.stop = request.stop;
  if (request.parallelToolCalls !== undefined) payload.parallel_tool_calls = request.parallelToolCalls;
  if (request.toolChoice !== undefined && request.tools.length > 0) {
    const choice = downgradeForcedToolChoice(request.toolChoice as unknown as ProxyRequest["toolChoice"], options.capabilities?.tools.forcedChoice) as unknown as ProxyRequest["toolChoice"];
    if (choice !== undefined) payload.tool_choice = toOpenAIToolChoice(choice);
  }
  if (request.metadata !== undefined && request.sourceSurface === "openai-chat") payload.metadata = request.metadata;
  if (request.reasoning === "enabled" || request.reasoningConfig !== undefined) {
    const cfg = request.reasoningConfig;
    if (cfg?.effort !== undefined) {
      const effort = projectEffort(cfg.effort, "openai-chat", options.capabilities?.reasoning.efforts);
      if (effort !== undefined && options.capabilities?.reasoning.supported !== false) payload.reasoning_effort = effort;
    }
    else if (request.reasoning === "enabled" && options.capabilities?.reasoning.supported !== false) payload.reasoning_effort = "medium";
    if (cfg !== undefined && (cfg.summary !== undefined || cfg.maxTokens !== undefined || cfg.exclude !== undefined || cfg.enabled !== undefined)) {
      const reasoningWire: Record<string, unknown> = {};
      if (cfg.summary !== undefined && options.capabilities?.reasoning.summary !== false) reasoningWire.summary = cfg.summary;
      if (cfg.maxTokens !== undefined && options.capabilities?.reasoning.maxTokens === "supported") reasoningWire.max_tokens = cfg.maxTokens;
      if (cfg.exclude !== undefined) reasoningWire.exclude = cfg.exclude;
      if (cfg.enabled !== undefined) reasoningWire.enabled = cfg.enabled;
      payload.reasoning = reasoningWire;
    }
  }
  if (request.stream && (options.streamUsage === undefined || options.streamUsage === "always")) {
    payload.stream_options = { include_usage: true };
  }
  preserveWireExtensions(payload, request, "openai-chat", ["model", "stream", "messages", "tools", "max_tokens", "max_completion_tokens", "prompt_cache_key", "prompt_cache_options", "response_format", "temperature", "top_p", "frequency_penalty", "presence_penalty", "seed", "user", "verbosity", "stop", "parallel_tool_calls", "tool_choice", "metadata", "reasoning_effort", "reasoning", "stream_options"]);
  if (Object.prototype.hasOwnProperty.call(payload, "reasoning_effort")) {
    const safeEffort = normalizeClientEffort(payload.reasoning_effort);
    if (safeEffort === undefined) delete payload.reasoning_effort;
    else payload.reasoning_effort = safeEffort;
  }
  clampPreservedReasoning(payload, "openai-chat", options.capabilities);
  applyOpenAIChatCacheBreakpoint(payload, request, upstreamModel, options.explicitCache !== false);
  return payload;
}

function functionTools(tools: readonly NormalizedTool[]): readonly NormalizedFunctionTool[] {
  const unsupported = tools.find((tool) => tool.kind !== "function");
  if (unsupported !== undefined) {
    throw new ProtocolCodecError({
      kind: "capability_unsupported",
      message: `OpenAI Chat cannot represent ${unsupported.kind} tools`,
      statusCode: 400,
      routeScope: "provider",
    });
  }
  return tools.filter((tool): tool is NormalizedFunctionTool => tool.kind === "function");
}

function toChatMessages(message: NormalizedMessage): readonly Record<string, unknown>[] {
  if (message.role !== "tool") return [toChatMessage(message)];
  return message.content
    .filter((block): block is Extract<ContentPart, { type: "tool_result" }> => block.type === "tool_result")
    .map((block) => ({ role: "tool", tool_call_id: block.toolCallId, content: block.text }));
}

function toChatMessage(message: NormalizedMessage): Record<string, unknown> {
  switch (message.role) {
    case "system":
      return { role: "system", content: messageText(message) };
    case "developer":
      return { role: "developer", content: messageText(message) };
    case "user": {
      const hasMedia = message.content.some((block) => block.type === "image" || block.type === "pdf" || block.type === "video");
      const content = [
        messageText(message),
        ...message.content.filter((block): block is Extract<ContentPart, { type: "tool_result" }> => block.type === "tool_result").map((block) => block.text ?? ""),
      ].filter((part) => part.length > 0).join("\n");
      if (!hasMedia) return { role: "user", content };
      return { role: "user", content: message.content.flatMap(toChatUserBlock) };
    }
    case "assistant": {
      const text = messageText(message);
      const calls = message.content.filter((block): block is Extract<ContentPart, { type: "tool_use" }> => block.type === "tool_use").map(toChatToolCall);
      const msg: Record<string, unknown> = { role: "assistant" };
      msg.content = text.length > 0 ? text : calls.length > 0 ? null : "";
      if (calls.length > 0) msg.tool_calls = calls;
      const reasoning = message.content.find((block): block is Extract<ContentPart, { type: "reasoning" }> => block.type === "reasoning");
      if (reasoning !== undefined) msg.reasoning_content = reasoning.reasoningText;
      return msg;
    }
    case "tool": {
      const block = message.content.find((b): b is Extract<ContentPart, { type: "tool_result" }> => b.type === "tool_result");
      return { role: "tool", tool_call_id: block?.toolCallId ?? "", content: message.content.filter((b): b is Extract<ContentPart, { type: "tool_result" }> => b.type === "tool_result").map((item) => item.text).join("\n") };
    }
  }
}

function toChatUserBlock(block: ContentPart): readonly Record<string, unknown>[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text }];
    case "image":
      return [{ type: "image_url", image_url: { url: toOpenAIImageUrl(block.image) } }];
    case "pdf":
      return [{ type: "file", file: { file_data: toOpenAIFileUrl(block.pdf), filename: block.pdf.filename ?? "document.pdf" } }];
    case "video":
      return [{ type: "file", file: { file_data: toOpenAIFileUrl(block.video), filename: block.video.filename ?? "video.mp4" } }];
    case "tool_result":
      return [{ type: "text", text: block.text }];
    default:
      return [];
  }
}

function toChatToolCall(block: Extract<ContentPart, { type: "tool_use" }>): Record<string, unknown> {
  const name = block.toolName;
  return {
    id: block.toolCallId,
    type: "function",
    function: { name, arguments: block.toolArguments },
  };
}

function toDataUrl(value: string, mediaType: string | null | undefined, fallback: string): string {
  return value.startsWith("data:") ? value : `data:${mediaType ?? fallback};base64,${value}`;
}

export function toOpenAIImageUrl(image: ImageReference | undefined): string {
  if (!image) return "";
  if (image.kind === "url") return image.value;
  if (image.kind === "data") return toDataUrl(image.value, image.mediaType, "image/png");
  throw new ProtocolCodecError({
    kind: "capability_unsupported",
    message: "file-kind image references cannot be inlined to upstream providers",
    statusCode: 400,
    routeScope: null,
  });
}

function toOpenAIFileUrl(ref: PdfReference | VideoReference): string {
  if (ref.kind === "url") return ref.value;
  if (ref.kind === "data") return toDataUrl(ref.value, ref.mediaType, "application/octet-stream");
  throw new ProtocolCodecError({ kind: "capability_unsupported", message: "file-kind references cannot be inlined", statusCode: 400, routeScope: null });
}

// OpenAI Responses wire codec
/**
 * Translates the normalized request into the OpenAI Responses wire payload.
 * json_schema response formats are approximated as json_object because the
 * normalized request carries no schema body.
 */
export function buildResponsesPayload(request: ProxyRequest, options: { readonly includeContextManagement?: boolean; readonly upstreamModel?: string; readonly explicitCache?: boolean; readonly capabilities?: ModelCapabilities } = {}): Record<string, unknown> {
  const upstreamModel = options.upstreamModel ?? request.model;
  const payload: Record<string, unknown> = {
    model: upstreamModel,
    stream: request.stream,
    input: request.messages.flatMap(toResponsesItem),
  };
  if (request.tools.length > 0) payload.tools = request.tools.map(toResponsesTool);
  if (request.maxOutputTokens !== null) payload.max_output_tokens = request.maxOutputTokens;
  if (request.cacheKey !== undefined) payload.prompt_cache_key = request.cacheKey;
  const _rawRespFmt = (request as unknown as { responseFormat?: unknown }).responseFormat;
  const responsesFormat = typeof _rawRespFmt === "string" ? { kind: _rawRespFmt as "text" | "json_object" | "json_schema" } as unknown as ResponseFormatConstraint : (_rawRespFmt != null && typeof _rawRespFmt === "object" && "kind" in (_rawRespFmt as Record<string, unknown>) ? (_rawRespFmt as ResponseFormatConstraint) : ({ kind: "text" } as ResponseFormatConstraint));
  const _respFmtKind = typeof _rawRespFmt === "string" ? _rawRespFmt : (_rawRespFmt != null && typeof _rawRespFmt === "object" && "kind" in (_rawRespFmt as Record<string, unknown>) ? String((_rawRespFmt as Record<string, unknown>)["kind"]) : "text");
  if (_respFmtKind !== "text") {
    payload.text = _respFmtKind === "json_schema" && (responsesFormat as Extract<ResponseFormatConstraint, { kind: "json_schema" }>).schema !== undefined
      ? { format: { type: "json_schema", ...(responsesFormat as Extract<ResponseFormatConstraint, { kind: "json_schema" }>).schema } }
      : { format: { type: "json_object" } };
  }
  if (request.temperature !== undefined) payload.temperature = request.temperature;
  if (request.topP !== undefined) payload.top_p = request.topP;
  if (request.parallelToolCalls !== undefined) payload.parallel_tool_calls = request.parallelToolCalls;
  if (request.toolChoice !== undefined) {
    const choice = downgradeForcedToolChoice(request.toolChoice as unknown as ProxyRequest["toolChoice"], options.capabilities?.tools.forcedChoice) as unknown as ProxyRequest["toolChoice"];
    if (choice !== undefined) payload.tool_choice = toOpenAIToolChoice(choice);
  }
  if (request.metadata !== undefined && request.sourceSurface === "openai-responses") payload.metadata = request.metadata;
  if (request.reasoning === "enabled" || request.reasoningConfig !== undefined) {
    payload.reasoning = buildReasoningWire(request.reasoning, request.reasoningConfig, options.capabilities);
  }
  if (request.include !== undefined && request.include.length > 0) payload.include = [...request.include];
  if (options.includeContextManagement !== false && request.contextManagement !== undefined) {
    const contextManagement = request.contextManagement;
    if (Array.isArray(contextManagement)) payload.context_management = [...contextManagement];
    else if (isRecord(contextManagement) && Array.isArray(contextManagement.edits)) payload.context_management = contextManagement.edits;
  }
  preserveWireExtensions(payload, request, "openai-responses", options.includeContextManagement === false
    ? ["model", "stream", "input", "tools", "max_output_tokens", "prompt_cache_key", "prompt_cache_options", "text", "reasoning", "include", "temperature", "top_p", "parallel_tool_calls", "tool_choice", "metadata"]
    : ["model", "stream", "input", "tools", "max_output_tokens", "prompt_cache_key", "prompt_cache_options", "text", "reasoning", "include", "context_management", "temperature", "top_p", "parallel_tool_calls", "tool_choice", "metadata"]);
  clampPreservedReasoning(payload, "openai-responses", options.capabilities);
  applyOpenAIResponsesCacheBreakpoint(payload, request, toResponsesItem, upstreamModel, options.explicitCache !== false);
  return payload;
}

/**
 * Builds the `reasoning` wire object, preserving structured effort, summary,
 * mode, context, maxTokens, exclude, or enabled controls. Concise summaries
 * are the default so terminal clients do not receive verbose reasoning.
 */
function clampPreservedReasoning(payload: Record<string, unknown>, surface: "openai-chat" | "openai-responses", capabilities?: ModelCapabilities): void {
  const preservedReasoning = payload.reasoning;
  if (isRecord(preservedReasoning)) {
    if (Object.prototype.hasOwnProperty.call(preservedReasoning, "effort")) {
      const safeEffort = projectEffort(preservedReasoning.effort, surface, capabilities?.reasoning.efforts);
      if (safeEffort === undefined) delete preservedReasoning.effort;
      else preservedReasoning.effort = safeEffort;
    }
    if (capabilities !== undefined && capabilities.reasoning.maxTokens !== "supported") delete preservedReasoning.max_tokens;
  } else if (preservedReasoning !== undefined && preservedReasoning !== null) {
    delete payload.reasoning;
  }
}

function buildReasoningWire(flag: "enabled" | "disabled" | "default", config: ReasoningConfig | undefined, capabilities?: ModelCapabilities): Record<string, unknown> {
  if (config !== undefined) {
    const wire: Record<string, unknown> = {};
    const effort = config.effort === undefined ? undefined : projectEffort(config.effort, "openai-responses", capabilities?.reasoning.efforts);
    if (effort !== undefined && capabilities?.reasoning.supported !== false) wire.effort = effort;
    if (config.summary !== undefined && capabilities?.reasoning.summary !== false) wire.summary = config.summary;
    else if (config.enabled !== false && capabilities?.reasoning.summary !== false) wire.summary = "concise";
    if (config.maxTokens !== undefined && capabilities?.reasoning.maxTokens === "supported") wire.max_tokens = config.maxTokens;
    if (config.exclude !== undefined) wire.exclude = config.exclude;
    if (config.enabled !== undefined) wire.enabled = config.enabled;
    if (config.mode !== undefined && (capabilities === undefined || capabilities.reasoning.modes.includes(config.mode))) wire.mode = config.mode;
    if (config.context !== undefined) wire.context = config.context;
    return Object.keys(wire).length > 0 ? wire : { enabled: false };
  }
  return flag === "enabled" && capabilities?.reasoning.supported !== false ? { effort: "medium", summary: "concise" } : { enabled: false };
}

function toResponsesTool(tool: NormalizedTool): Record<string, unknown> {
  if (tool.kind === "hosted") return { type: tool.hostedType, ...(tool.nativeOptions ?? {}) };
  if (tool.kind === "function") return { type: "function", name: tool.name, description: tool.description ?? undefined, parameters: tool.inputSchema };
  throw new ProtocolCodecError({
    kind: "capability_unsupported",
    message: `OpenAI Responses cannot represent ${tool.kind} tool "${tool.nativeType}"`,
    statusCode: 400,
    routeScope: "provider",
  });
}

function toOpenAIToolChoice(choice: NonNullable<ProxyRequest["toolChoice"]>): string | Record<string, unknown> {
  if (choice.kind === "function") return { type: "function", function: { name: choice.name } };
  return choice.kind;
}

function toResponsesReasoningItem(block: Extract<ContentPart, { type: "reasoning" }>): Record<string, unknown> {
  const raw = (block as { raw?: unknown }).raw as Record<string, unknown> | undefined;
  const item: Record<string, unknown> = { type: "reasoning" };
  if (isRecord(raw)) {
    if (typeof raw.id === "string") item.id = raw.id;
    if (typeof raw.encrypted_content === "string") item.encrypted_content = raw.encrypted_content;
    if (Array.isArray(raw.summary)) item.summary = raw.summary;
  }
  if (typeof item.encrypted_content !== "string" && block.reasoningEncryptedContent !== undefined) {
    item.encrypted_content = block.reasoningEncryptedContent;
  }
  if (!Array.isArray(item.summary)) {
    item.summary = block.reasoningSummary ?? [{ type: "summary_text", text: block.reasoningText }];
  }
  return item;
}

function toResponsesItem(message: NormalizedMessage): readonly Record<string, unknown>[] {
  switch (message.role) {
    case "system":
    case "developer":
      return [{ role: message.role, content: messageText(message) }];
    case "user": {
      const hasMedia = message.content.some((block) => block.type === "image" || block.type === "pdf" || block.type === "video");
      if (!hasMedia) return [{ role: "user", content: messageText(message) }];
      const blocks: Record<string, unknown>[] = [];
      for (const block of message.content) {
        if (block.type === "text") blocks.push({ type: "input_text", text: block.text });
        else if (block.type === "image") blocks.push({ type: "input_image", image_url: toOpenAIImageUrl(block.image) });
        else if (block.type === "pdf") blocks.push({ type: "input_file", file_data: block.pdf.value, filename: block.pdf.filename ?? "document.pdf" } as unknown as Record<string, unknown>);
        else if (block.type === "video") blocks.push({ type: "input_file", file_data: block.video.value, filename: block.video.filename ?? "video.mp4" } as unknown as Record<string, unknown>);
      }
      return [{ role: "user", content: blocks }];
    }
    case "assistant": {
      const items: Record<string, unknown>[] = [];
      for (const block of message.content) {
        if (block.type === "compaction") {
          const comp = block as Extract<ContentPart, { type: "compaction" }>;
          const raw = (comp as { raw?: unknown }).raw as Record<string, unknown> | undefined;
          items.push(raw !== undefined ? { ...raw } : { type: "compaction", content: comp.text });
        } else if (block.type === "reasoning") items.push(toResponsesReasoningItem(block as Extract<ContentPart, { type: "reasoning" }>));
      }
      const text = messageText(message);
      const calls = message.content.filter((block): block is Extract<ContentPart, { type: "tool_use" }> => block.type === "tool_use");
      if (text.length > 0 || calls.length === 0) {
        items.push({ role: "assistant", content: [{ type: "output_text", text }], ...(message.phase === undefined ? {} : { phase: message.phase }) });
      }
      for (const block of calls) {
        items.push({
          type: "function_call",
          call_id: block.toolCallId,
          name: block.toolName,
          arguments: block.toolArguments,
        });
      }
      return items;
    }
    case "tool":
      return [
        ...message.content
          .filter((block): block is Extract<ContentPart, { type: "tool_result" }> => block.type === "tool_result")
          .map((block) => ({ type: "function_call_output", call_id: block.toolCallId, output: block.text })),
      ];
  }
}
export {
  applyCachePlan,
  applyOpenAIChatCacheBreakpoint,
  applyOpenAIResponsesCacheBreakpoint,
  buildCachePlan,
  CACHE_PLAN_MESSAGE_THRESHOLD,
  findCacheBreakpoint,
  looksStableText,
  markCacheSections,
  resolvePromptCacheKey,
  shouldBuildCachePlan,
  stripOpenAIPromptCacheMetadata,
  supportsOpenAIPromptBreakpoints,
} from "./cache.js";

export type { CacheBreakpointPosition, CachePlan, CacheSection, CacheSectionKind } from "./cache.js";

export { detectClientFormat, normalizationEndpoint } from "../normalize/detection.js";
