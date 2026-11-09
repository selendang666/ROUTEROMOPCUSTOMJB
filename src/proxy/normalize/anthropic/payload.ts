import type { ProxyRequest } from "../../types/request.js";
import { findCacheBreakpoint } from "../../translate/cache.js";
import type { ModelCapabilities } from "../../translate/policy.js";
import { ProtocolCodecError } from "../../errors.js";
import { projectEffort, preserveWireExtensions } from "../../translate/policy.js";
import { applyProviderQuirkPolicy } from "../../policy/projection.js";
import type { ContentPart, ImageReference, NormalizedMessage, PdfReference, VideoReference } from "../../types/content.js";
import type { ProviderCaps, ProviderQuirkPolicy } from "../../types/provider.js";
import { isRecord } from "../../validation.js";
import { messageText } from "../../protocol-request.js";
import { validateReasoningSignatures } from "../../events/signature.js";

const DEFAULT_MAX_TOKENS = 4_096;
const MAX_THINKING_BUDGET = 32_000;

// Anthropic Messages wire codec
/**
 * Translates the normalized request into the Anthropic Messages wire
 * payload. max_tokens is required upstream and defaults to 4096. Explicit
 * prompt caching (cache_control on system and the last user text block,
 * plus the beta header in `call`) is emitted only when the adapter declares
 * explicitCache and promptCacheKey.
 */
export function buildMessagesPayload(request: ProxyRequest, capabilities: ProviderCaps, options: { readonly includeContextManagement?: boolean; readonly modelCapabilities?: ModelCapabilities; readonly quirks?: ProviderQuirkPolicy } = {}): Record<string, unknown> {
  const quirks = options.quirks;
  const validated = validateReasoningSignatures(request, quirks?.signatures);
  const normalizedRequest = validated.request;
  const _rawFmtAnth = (request as unknown as { responseFormat?: unknown }).responseFormat;
  const responseFormatKind = typeof _rawFmtAnth === "string" ? _rawFmtAnth : (_rawFmtAnth != null && typeof _rawFmtAnth === "object" && "kind" in (_rawFmtAnth as Record<string, unknown>) ? String((_rawFmtAnth as Record<string, unknown>)["kind"]) : "text");
  if (responseFormatKind !== "text") {
    throw new ProtocolCodecError({ kind: "capability_unsupported", message: "Anthropic Messages cannot represent OpenAI response-format constraints", statusCode: 400, routeScope: "provider" });
  }
  const systemMessages = normalizedRequest.messages
    .filter((message) => message.role === "system" || message.role === "developer")
  const systemText = systemMessages
    .map((message) => messageText(message))
    .filter((text) => text.length > 0)
    .join("\n\n");
  const systemBlocks = systemMessages
    .flatMap((message) => message.content)
    .filter((block): block is Extract<ContentPart, { type: "text" }> => block.type === "text")
    .flatMap(toAnthropicUserBlock);
  const cacheEnabled = capabilities.explicitCache && request.cacheKey !== undefined;
  const payload: Record<string, unknown> = {
    model: normalizedRequest.model,
    max_tokens: normalizedRequest.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    stream: normalizedRequest.stream,
    messages: normalizedRequest.messages
      .filter((message) => message.role !== "system" && message.role !== "developer")
      .map((message) => toAnthropicMessage(message, capabilities)),
  };
  if (systemBlocks.length > 0) payload.system = systemBlocks;
  else if (systemText.length > 0) payload.system = systemText;
  if (normalizedRequest.metadata !== undefined) payload.metadata = normalizedRequest.metadata;
  if (normalizedRequest.mcpServers !== undefined) payload.mcp_servers = normalizedRequest.mcpServers;
  if (normalizedRequest.tools.length > 0) {
    payload.tools = normalizedRequest.tools.map((tool) => {
      if (tool.kind === "native") {
        return { type: tool.nativeType, ...(tool.nativeOptions ?? {}) };
      }
      if (tool.kind !== "function") throw new ProtocolCodecError({ kind: "capability_unsupported", message: `Anthropic cannot represent ${tool.kind} tools`, statusCode: 400, routeScope: "provider" });
      const definition: Record<string, unknown> = {
        name: tool.name,
        description: tool.description ?? undefined,
        input_schema: tool.inputSchema,
      };
      if (tool.deferLoading !== undefined) definition.defer_loading = tool.deferLoading;
      if (tool.allowedCallers !== undefined) definition.allowed_callers = tool.allowedCallers;
      if (tool.inputExamples !== undefined) definition.input_examples = tool.inputExamples;
      return definition;
    });
  }
  const disableParallelToolUse = normalizedRequest.anthropic?.disableParallelToolUse ?? (normalizedRequest.parallelToolCalls === undefined ? undefined : !normalizedRequest.parallelToolCalls);
  if (normalizedRequest.toolChoice?.kind === "none") {
    throw new ProtocolCodecError({ kind: "capability_unsupported", message: "Anthropic Messages cannot represent tool_choice none with declared tools", statusCode: 400, routeScope: "provider" });
  }
  if (normalizedRequest.toolChoice !== undefined || disableParallelToolUse !== undefined) {
    const type = normalizedRequest.toolChoice?.kind === "required" ? "any" : normalizedRequest.toolChoice?.kind === "function" ? "tool" : "auto";
    payload.tool_choice = {
      type,
      ...(normalizedRequest.toolChoice?.kind === "function" ? { name: normalizedRequest.toolChoice.name } : {}),
      ...(disableParallelToolUse === undefined ? {} : { disable_parallel_tool_use: disableParallelToolUse }),
    };
  }
  if (normalizedRequest.anthropic?.speed !== undefined) payload.speed = normalizedRequest.anthropic.speed;
  if (normalizedRequest.anthropic?.inferenceGeo !== undefined) payload.inference_geo = normalizedRequest.anthropic.inferenceGeo;
  if (normalizedRequest.anthropic?.taskBudgetTokens !== undefined) {
    payload.task_budget = { type: "tokens", total: normalizedRequest.anthropic.taskBudgetTokens };
  }
  if (options.includeContextManagement !== false && normalizedRequest.contextManagement !== undefined) payload.context_management = normalizedRequest.contextManagement;
  const reasoningSupported = options.modelCapabilities?.reasoning.supported ?? capabilities.reasoning;
  if (normalizedRequest.reasoning === "enabled" && reasoningSupported) {
    const config = normalizedRequest.reasoningConfig;
    const safeEffort = config?.effort === undefined ? undefined : projectEffort(config.effort, "anthropic-messages", options.modelCapabilities?.reasoning.efforts);
    if (safeEffort !== undefined) {
      payload.thinking = { type: "adaptive" };
      payload.output_config = { effort: safeEffort };
    } else if (options.modelCapabilities?.reasoning.maxTokens !== "unsupported") {
      payload.thinking = { type: "enabled", budget_tokens: Math.min(config?.maxTokens ?? normalizedRequest.maxOutputTokens ?? DEFAULT_MAX_TOKENS, MAX_THINKING_BUDGET) };
    }
  }
  preserveWireExtensions(payload, normalizedRequest, "anthropic-messages", options.includeContextManagement === false ? ["model", "max_tokens", "stream", "messages", "system", "mcp_servers", "tools", "thinking", "output_config"] : ["model", "max_tokens", "stream", "messages", "system", "mcp_servers", "tools", "context_management", "thinking", "output_config"]);
  const preservedOutputConfig = payload.output_config;
  if (isRecord(preservedOutputConfig)) {
    const safeEffort = projectEffort(preservedOutputConfig.effort, "anthropic-messages");
    if (safeEffort === undefined) delete payload.output_config;
    else payload.output_config = { ...preservedOutputConfig, effort: safeEffort };
  } else if (preservedOutputConfig !== undefined) {
    delete payload.output_config;
  }
  if (
    normalizedRequest.anthropic?.structuredOutputMode === "output_format" &&
    normalizedRequest.sourceSurface === "anthropic-messages" &&
    isRecord(normalizedRequest.wirePayload?.output_config) &&
    isRecord(normalizedRequest.wirePayload.output_config.format)
  ) {
    payload.output_config = {
      ...(isRecord(payload.output_config) ? payload.output_config : {}),
      format: normalizedRequest.wirePayload.output_config.format,
    };
  }
  if (cacheEnabled) applyAnthropicCacheControl(payload, normalizedRequest);
  return applyProviderQuirkPolicy(payload, quirks);
}

function applyAnthropicCacheControl(payload: Record<string, unknown>, request: ProxyRequest): void {
  const position = findCacheBreakpoint(request);
  if (position !== null) {
    const target = request.messages[position.messageIndex];
    if (target?.role === "system" || target?.role === "developer") {
      applySystemCacheControl(payload);
      return;
    }
    const messages = payload.messages;
    if (Array.isArray(messages)) {
      let wireIndex = 0;
      for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
        const message = request.messages[messageIndex];
        if (message === undefined || message.role === "system" || message.role === "developer") continue;
        if (messageIndex === position.messageIndex && markAnthropicMessage(messages[wireIndex])) return;
        wireIndex += 1;
      }
    }
  }
  applySystemCacheControl(payload);
  applyLastUserCacheControl(payload);
}

function markAnthropicMessage(message: unknown): boolean {
  if (!isRecord(message)) return false;
  const content = message.content;
  if (typeof content === "string" && content.length > 0) {
    message.content = [{ type: "text", text: content, cache_control: { type: "ephemeral" } }];
    return true;
  }
  if (!Array.isArray(content)) return false;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!isRecord(block) || block.type !== "text") continue;
    content[index] = { ...block, cache_control: { type: "ephemeral" } };
    return true;
  }
  return false;
}

function applySystemCacheControl(payload: Record<string, unknown>): void {
  const system = payload.system;
  if (typeof system === "string" && system.length > 0) {
    payload.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
    return;
  }
  if (!Array.isArray(system)) return;
  let marked = false;
  const blocks = system.map((block) => {
    if (!isRecord(block) || block.type !== "text" || marked) return block;
    marked = true;
    return { ...block, cache_control: { type: "ephemeral" } };
  });
  if (marked) payload.system = blocks;
}

function applyLastUserCacheControl(payload: Record<string, unknown>): void {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string" && content.length > 0) {
      payload.messages = messages.map((item, index) => index === i ? { ...message, content: [{ type: "text", text: content, cache_control: { type: "ephemeral" } }] } : item);
      return;
    }
    if (!Array.isArray(content)) continue;
    let marked = false;
    const updatedContent = content.map((block) => {
      if (!isRecord(block) || block.type !== "text" || marked) return block;
      marked = true;
      return { ...block, cache_control: { type: "ephemeral" } };
    });
    if (marked) {
      payload.messages = messages.map((item, index) => index === i ? { ...message, content: updatedContent } : item);
      return;
    }
  }
}

function toAnthropicMessage(message: NormalizedMessage, capabilities: ProviderCaps): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content.flatMap(toAnthropicUserBlock) };
    case "assistant": {
      const content: Record<string, unknown>[] = [];
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text, ...anthropicBlockOptions(block) });
        else if (block.type === "image") content.push({ type: "image", source: toAnthropicImageSource(block.image), ...anthropicBlockOptions(block) });
        else if (block.type === "pdf") {
          content.push({
            type: "document",
            source: toAnthropicDocumentSource(block.pdf),
            ...(block.pdf.title === undefined || block.pdf.title === null ? {} : { title: block.pdf.title }),
            ...(block.pdf.context === undefined || block.pdf.context === null ? {} : { context: block.pdf.context }),
            ...anthropicBlockOptions(block),
          });
        }
        else if (block.type === "video") content.push({ type: "video", source: toAnthropicVideoSource(block.video) });
        else if (block.type === "reasoning" && capabilities.reasoning && block.reasoningText.length > 0) content.push({ type: "thinking", thinking: block.reasoningText, ...(block.reasoningSignature === undefined ? {} : { signature: block.reasoningSignature }) });
        else if (block.type === "compaction") content.push((block as Extract<ContentPart, { type: "compaction" }>).raw ?? { type: "compaction", content: block.text });
        else if (block.type === "tool_use") content.push(toAnthropicToolUse(block as Extract<ContentPart, { type: "tool_use" }>));
        else if (block.type === "native" && capabilities.toolCalls && isRecord(block.nativePayload)) content.push({ ...block.nativePayload });
      }
      return { role: "assistant", content };
    }
    case "tool": {
      const content: Array<Readonly<Record<string, unknown>>> = [];
      for (const block of message.content) {
        if (block.type === "tool_result") {
          const toolResult = block as Extract<ContentPart, { type: "tool_result" }>;
          const inner = toolResult.text;
          content.push({
            type: "tool_result",
            tool_use_id: toolResult.toolCallId,
            content: inner,
            ...(toolResult.isError || toolResult.toolResultIsError ? { is_error: true } : {}),
          });
        } else if (block.type === "text") {
          content.push({ type: "tool_result", tool_use_id: "", content: block.text });
        } else if (block.type === "image") {
          content.push({ type: "tool_result", tool_use_id: "", content: [{ type: "image", source: toAnthropicImageSource(block.image) }] });
        } else if (block.type === "pdf") {
          content.push({ type: "tool_result", tool_use_id: "", content: [{ type: "document", source: toAnthropicDocumentSource(block.pdf) }] });
        } else if (block.type === "video") {
          content.push({ type: "tool_result", tool_use_id: "", content: [{ type: "video", source: toAnthropicVideoSource(block.video) }] });
        }
      }
      return { role: "user", content };
    }
    case "system":
    case "developer":
      return { role: "user", content: [{ type: "text", text: messageText(message) }] };
  }
}

function toAnthropicToolUse(block: Extract<ContentPart, { type: "tool_use" }>): Record<string, unknown> {
  const raw = block.toolArguments;
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new ProtocolCodecError({
      kind: "invalid_request",
      message: `Tool_use arguments for "${block.toolName}" are not valid JSON`,
      statusCode: 400,
      routeScope: null,
    });
  }
  return {
    type: "tool_use",
    id: block.toolCallId,
    name: block.toolName,
    input: isRecord(input) ? input : {},
    ...(block.reasoningSignature === undefined ? {} : { signature: block.reasoningSignature }),
  };
}

function toAnthropicUserBlock(block: ContentPart): readonly Record<string, unknown>[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text, ...anthropicBlockOptions(block) }];
    case "image":
      return [{ type: "image", source: toAnthropicImageSource(block.image), ...anthropicBlockOptions(block) }];
    case "pdf":
      return [{
        type: "document",
        source: toAnthropicDocumentSource(block.pdf),
        ...(block.pdf.title === undefined || block.pdf.title === null ? {} : { title: block.pdf.title }),
        ...(block.pdf.context === undefined || block.pdf.context === null ? {} : { context: block.pdf.context }),
        ...anthropicBlockOptions(block),
      }];
    case "video":
      return [{ type: "video", source: toAnthropicVideoSource(block.video) }];
    case "tool_result":
      return [{ type: "tool_result", tool_use_id: block.toolCallId, content: block.text, ...(block.isError || block.toolResultIsError ? { is_error: true } : {}) }];
    case "native":
      return isRecord(block.nativePayload) ? [{ ...block.nativePayload }] : [];
    default:
      return [];
  }
}

function anthropicBlockOptions(block: ContentPart): Record<string, unknown> {
  const cacheControl = block.cacheControl;
  let cache: { readonly type: "ephemeral"; readonly ttl?: "5m" | "1h" } | undefined;
  if (cacheControl === "ephemeral") {
    cache = { type: "ephemeral" };
  } else if (cacheControl !== undefined) {
    cache = cacheControl;
  }
  return {
    ...(cache === undefined ? {} : { cache_control: cache }),
    ...(block.citations === undefined ? {} : { citations: block.citations }),
  };
}

function toAnthropicImageSource(image: ImageReference | undefined): Record<string, unknown> {
  if (!image) return { type: "url", url: "" };
  if (image.kind === "url") return { type: "url", url: image.value };
  if (image.kind === "data") {
    let data = image.value;
    let mediaType = image.mediaType ?? "image/png";
    if (data.startsWith("data:")) {
      const comma = data.indexOf(",");
      if (comma !== -1) {
        const meta = data.slice(5, comma);
        data = data.slice(comma + 1);
        const extracted = meta.split(";")[0];
        if (extracted) mediaType = extracted;
      }
    }
    return {
      type: "base64",
      media_type: mediaType,
      data,
      ...(image.transformations === undefined ? {} : { transformations: image.transformations }),
    };
  }
  return {
    type: "file",
    file_id: image.value,
    ...(image.transformations === undefined ? {} : { transformations: image.transformations }),
  };
}

function toAnthropicDocumentSource(pdf: PdfReference): Record<string, unknown> {
  if (pdf.kind === "url") return { type: "url", url: pdf.value };
  if (pdf.kind === "file") return { type: "file", file_id: pdf.value };
  if (pdf.contentBlocks !== undefined) return { type: "content", content: pdf.contentBlocks };
  if (pdf.kind === "data") {
    if (pdf.mediaType === "text/plain") return { type: "plain_text", data: pdf.value };
    let data = pdf.value;
    let mediaType = pdf.mediaType ?? "application/pdf";
    if (data.startsWith("data:")) {
      const comma = data.indexOf(",");
      if (comma !== -1) {
        const meta = data.slice(5, comma);
        data = data.slice(comma + 1);
        const extracted = meta.split(";")[0];
        if (extracted) mediaType = extracted;
      }
    }
    return { type: "base64", media_type: mediaType, data };
  }
  throw new ProtocolCodecError({ kind: "capability_unsupported", message: "Unsupported Anthropic document reference.", statusCode: 400, routeScope: null });
}

function toAnthropicVideoSource(video: VideoReference): Record<string, unknown> {
  if (video.kind === "url") return { type: "url", url: video.value };
  if (video.kind === "data") {
    let data = video.value;
    let mediaType = video.mediaType ?? "video/mp4";
    if (data.startsWith("data:")) {
      const comma = data.indexOf(",");
      if (comma !== -1) {
        const meta = data.slice(5, comma);
        data = data.slice(comma + 1);
        const extracted = meta.split(";")[0];
        if (extracted) mediaType = extracted;
      }
    }
    return { type: "base64", media_type: mediaType, data };
  }
  throw new ProtocolCodecError({ kind: "capability_unsupported", message: "file-kind video references cannot be inlined", statusCode: 400, routeScope: null });
}

