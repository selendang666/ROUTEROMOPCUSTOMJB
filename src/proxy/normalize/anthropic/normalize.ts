import type { AnthropicRequestOptions, ContentPart, ImageReference, NormalizedMessage, NormalizedTool, PdfReference, VideoReference } from "../../types/content.js";
import type { ReasoningEffort, ReasoningSummary } from "../../types/surface.js";
import {
  MAX_BLOCKS_PER_MESSAGE,
  MAX_DATA_URL_LENGTH,
  MAX_MEDIA_TYPE_LENGTH,
  MAX_MESSAGE_COUNT,
  MAX_MODEL_LENGTH,
  MAX_OUTPUT_TOKENS,
  MAX_TEXT_BLOCK_LENGTH,
  MAX_TOOL_ARGUMENT_LENGTH,
  MAX_TOOL_COUNT,
  MAX_TOOL_NAME_LENGTH,
  boundJsonLength,
  isRecord,
  narrowArray,
  narrowMessageArray,
  narrowNumber,
  narrowObject,
  narrowString,
  normalizeStream,
} from "../../validation.js";
import { abortedError, isProtocolError, protocolError } from "../../errors.js";
import { classifyImageReference, pushImageReference } from "../../media-guard.js";
import { normalizeFail, normalizeOk } from "../../protocol-request.js";
import { normalizeToolList } from "../tools.js";
import type { NormalizeInput, NormalizeResult } from "../../protocol-request.js";
import type { ProtocolError } from "../../errors.js";
import { projectEffort } from "../../translate/policy.js";

const MAX_THINKING_BUDGET = 32_000;
const REASONING_SUMMARIES: readonly ReasoningSummary[] = ["auto", "concise", "detailed"];

export function normalizeMessagesRequest(body: unknown, input: NormalizeInput): NormalizeResult {
  const aborted = abortedError(input.signal);
  if (aborted !== null) return normalizeFail(aborted);
  const root = narrowObject(body, "body");
  if (isProtocolError(root)) return normalizeFail(root);

  const model = narrowString(root["model"], "model", MAX_MODEL_LENGTH);
  if (isProtocolError(model)) return normalizeFail(model);
  if (model.trim() === "") return normalizeFail(protocolError("model", "model: must not be empty"));

  const stream = normalizeStream(root["stream"]);
  if (isProtocolError(stream)) return normalizeFail(stream);

  const maxTokens = normalizeMaxTokens(root);
  if (isProtocolError(maxTokens)) return normalizeFail(maxTokens);

  const thinking = normalizeThinking(root["thinking"]);
  if (isProtocolError(thinking)) return normalizeFail(thinking);
  const outputConfig = normalizeOutputConfig(root["output_config"]);
  if (isProtocolError(outputConfig)) return normalizeFail(outputConfig);

  const contextManagement = normalizeContextManagement(root["context_management"]);
  if (isProtocolError(contextManagement)) return normalizeFail(contextManagement);

  const reasoningState = { seen: false };
  const images: ImageReference[] = [];
  const messages = normalizeMessages(root["messages"], images, reasoningState);
  if (isProtocolError(messages)) return normalizeFail(messages);
  const anthropicReasoning = normalizeReasoning(root["reasoning"]);
  if (isProtocolError(anthropicReasoning)) return normalizeFail(anthropicReasoning);

  const system = normalizeSystem(root["system"]);
  if (isProtocolError(system)) return normalizeFail(system);

  const tools = normalizeTools(root["tools"]);
  if (isProtocolError(tools)) return normalizeFail(tools);
  const mcpServers = normalizeMcpServers(root["mcp_servers"]);
  if (isProtocolError(mcpServers)) return normalizeFail(mcpServers);

  const metadata = normalizeMetadata(root["metadata"]);
  if (isProtocolError(metadata)) return normalizeFail(metadata);
  const metadataUserId = isRecord(metadata) && typeof metadata.user_id === "string" && metadata.user_id.length <= 4096 ? metadata.user_id : undefined;
  const reasoning = reasoningState.seen ? "enabled" : thinking.flag;
  const reasoningConfig = {
    ...(thinking.budgetTokens === undefined ? {} : { maxTokens: thinking.budgetTokens }),
    ...(outputConfig.effort === undefined ? {} : { effort: outputConfig.effort }),
    ...(anthropicReasoning?.summary === undefined ? {} : { summary: anthropicReasoning.summary }),
  };
  const anthropic = normalizeAnthropicOptions(root);
  if (isProtocolError(anthropic)) return normalizeFail(anthropic);
  return normalizeOk({
    model,
    operation: input.operation ?? "invoke",
    stream,
    messages: [...system, ...messages],
    tools,
    responseFormat: { kind: "text" },
    reasoning,
    ...(Object.keys(reasoningConfig).length === 0 ? {} : { reasoningConfig }),
    maxOutputTokens: maxTokens,
    images,
    sourceSurface: "anthropic-messages",
    signal: input.signal,
    limits: input.limits,
    wirePayload: root,
    ...(contextManagement === undefined ? {} : { contextManagement }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(metadataUserId === undefined ? {} : { metadataUserId }),
    ...(anthropic === undefined ? {} : { anthropic }),
  });
}

function normalizeAnthropicOptions(root: Record<string, unknown>): AnthropicRequestOptions | ProtocolError | undefined {
  const options: {
    speed?: "fast" | "standard";
    inferenceGeo?: "us" | "global";
    taskBudgetTokens?: number;
    structuredOutputMode?: "output_format" | "json_tool" | "auto";
    disableParallelToolUse?: boolean;
  } = {};
  const speed = root["speed"];
  if (speed !== undefined) {
    if (speed !== "fast" && speed !== "standard") return protocolError("speed", 'speed must be "fast" or "standard"');
    options.speed = speed;
  }
  const inferenceGeo = root["inference_geo"];
  if (inferenceGeo !== undefined) {
    if (inferenceGeo !== "us" && inferenceGeo !== "global") return protocolError("inference_geo", 'inference_geo must be "us" or "global"');
    options.inferenceGeo = inferenceGeo;
  }
  const taskBudget = root["task_budget"];
  if (taskBudget !== undefined) {
    const budget = narrowObject(taskBudget, "task_budget");
    if (isProtocolError(budget)) return budget;
    const total = narrowNumber(budget["total"], "task_budget.total", { integer: true, min: 1, max: MAX_OUTPUT_TOKENS * 100 });
    if (isProtocolError(total)) return total;
    options.taskBudgetTokens = total;
  }
  const toolChoice = root["tool_choice"];
  if (isRecord(toolChoice) && toolChoice["disable_parallel_tool_use"] !== undefined) {
    if (typeof toolChoice["disable_parallel_tool_use"] !== "boolean") {
      return protocolError("tool_choice.disable_parallel_tool_use", "tool_choice.disable_parallel_tool_use must be boolean");
    }
    options.disableParallelToolUse = toolChoice["disable_parallel_tool_use"];
  }
  const output = root["output_config"];
  if (isRecord(output) && output["format"] !== undefined) {
    const format = narrowObject(output["format"], "output_config.format");
    if (isProtocolError(format)) return format;
    options.structuredOutputMode = format["type"] === "json_schema" ? "output_format" : "auto";
  }
  return Object.keys(options).length === 0 ? undefined : options;
}

function normalizeReasoning(raw: unknown): { readonly summary?: ReasoningSummary } | ProtocolError | undefined {
  if (raw === undefined || raw === null) return undefined;
  const reasoning = narrowObject(raw, "reasoning");
  if (isProtocolError(reasoning)) return reasoning;
  const summaryRaw = reasoning["summary"];
  if (summaryRaw === undefined || summaryRaw === null) return undefined;
  if (typeof summaryRaw !== "string") return protocolError("reasoning.summary", "reasoning.summary: expected a string");
  const summary = REASONING_SUMMARIES.includes(summaryRaw as ReasoningSummary) ? (summaryRaw as ReasoningSummary) : null;
  if (summary === null) return undefined;
  return { summary };
}

function normalizeMaxTokens(root: Record<string, unknown>): number | ProtocolError {
  const raw = root["max_tokens"];
  if (raw === undefined || raw === null) return protocolError("max_tokens", "max_tokens: is required for Anthropic Messages");
  const value = narrowNumber(raw, "max_tokens", { integer: true, min: 1, max: MAX_OUTPUT_TOKENS });
  if (isProtocolError(value)) return value;
  return value;
}

interface NormalizedThinking {
  readonly flag: "enabled" | "disabled" | "default";
  readonly budgetTokens?: number;
}

function normalizeCacheControl(raw: unknown, field: string): { readonly type: "ephemeral"; readonly ttl?: "5m" | "1h" } | undefined | ProtocolError {
  if (raw === undefined || raw === null) return undefined;
  const cache = narrowObject(raw, field);
  if (isProtocolError(cache)) return cache;
  if (cache["type"] !== "ephemeral") return protocolError(`${field}.type`, `${field}.type must be "ephemeral"`);
  const ttl = cache["ttl"];
  if (ttl === undefined || ttl === null) return { type: "ephemeral" };
  if (ttl === "5m" || ttl === "1h") return { type: "ephemeral", ttl };
  return protocolError(`${field}.ttl`, `${field}.ttl must be "5m" or "1h"`);
}

function normalizeThinking(raw: unknown): NormalizedThinking | ProtocolError {
  if (raw === undefined || raw === null) return { flag: "default" };
  const obj = narrowObject(raw, "thinking");
  if (isProtocolError(obj)) return obj;
  const type = obj["type"];
  if (type === "disabled") return { flag: "disabled" };
  if (type !== "enabled" && type !== "adaptive") {
    if (typeof type === "string") return protocolError("thinking.type", `thinking.type: unsupported mode "${type}"`);
    return protocolError("thinking.type", 'thinking.type: expected "enabled", "adaptive", or "disabled"');
  }
  const budgetRaw = obj["budget_tokens"];
  if (budgetRaw === undefined || budgetRaw === null) return { flag: "enabled" };
  const budgetTokens = narrowNumber(budgetRaw, "thinking.budget_tokens", { integer: true, min: 1, max: MAX_THINKING_BUDGET });
  if (isProtocolError(budgetTokens)) return budgetTokens;
  return { flag: "enabled", budgetTokens };
}

function normalizeOutputConfig(raw: unknown): { readonly effort?: ReasoningEffort } | ProtocolError {
  if (raw === undefined || raw === null) return {};
  const obj = narrowObject(raw, "output_config");
  if (isProtocolError(obj)) return obj;
  if (obj["effort"] === undefined) return {};
  const rawEffort = obj["effort"];
  if (typeof rawEffort !== "string") return protocolError("output_config.effort", "output_config.effort must be a string");
  const lower = rawEffort.trim().toLowerCase().replace(/[-_\s]/g, "");
  const strictAllowed: Record<string, true> = { xhigh: true, high: true, medium: true, low: true, minimal: true, none: true };
  const aliasAllowed: Record<string, true> = { max: true, maximum: true, ultra: true, ultrahigh: true, ultracode: true, auto: true, default: true, off: true, disabled: true };
  if (!strictAllowed[lower] && !aliasAllowed[lower]) {
    return protocolError("output_config.effort", `output_config.effort: unsupported value "${String(rawEffort)}"`);
  }
  const effort = projectEffort(rawEffort, "anthropic-messages");
  if (effort === undefined) return protocolError("output_config.effort", `output_config.effort: unsupported value "${String(rawEffort)}"`);
  return { effort };
}

function normalizeMetadata(raw: unknown): Readonly<Record<string, unknown>> | undefined | ProtocolError {
  if (raw === undefined || raw === null) return undefined;
  const metadata = narrowObject(raw, "metadata");
  if (isProtocolError(metadata)) return metadata;
  const bound = boundJsonLength(metadata, "metadata", MAX_TEXT_BLOCK_LENGTH);
  return bound === null ? { ...metadata } : bound;
}

function normalizeContextManagement(raw: unknown): Readonly<Record<string, unknown>> | ProtocolError | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = narrowObject(raw, "context_management");
  if (isProtocolError(value)) return value;
  const bound = boundJsonLength(value, "context_management", 64 * 1024);
  return bound === null ? value : bound;
}

function normalizeSystem(raw: unknown): NormalizedMessage[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    const text = normalizeTextBlock(raw, "system");
    if (isProtocolError(text)) return text;
    return [{ role: "system", content: [{ type: "text", text }] }];
  }
  const list = narrowArray(raw, "system", MAX_BLOCKS_PER_MESSAGE);
  if (isProtocolError(list)) return list;
  const blocks: ContentPart[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const field = `system[${i}]`;
    if (item === undefined) continue;
    const obj = narrowObject(item, field);
    if (isProtocolError(obj)) return obj;
    const type = obj["type"];
    if (type === "text") {
      const text = normalizeTextBlock(obj["text"], `${field}.text`);
      if (isProtocolError(text)) return text;
      blocks.push({ type: "text", text });
    } else if (typeof type === "string") {
      blocks.push({ type: "unknown", text: typeof obj["text"] === "string" ? obj["text"] : undefined });
    } else {
      return protocolError(`${field}.type`, "system block type must be a string");
    }
  }
  return [{ role: "system", content: blocks }];
}

/**
 * Validates context text without imposing a smaller proxy-side limit. The
 * request body is already bounded at the transport layer, and cross-protocol
 * adapters must receive the client's exact text.
 */
function normalizeTextBlock(value: unknown, field: string): string | ProtocolError {
  if (typeof value !== "string") return protocolError(field, `${field}: expected a string`);
  return value;
}

function normalizeMessages(raw: unknown, images: ImageReference[], reasoningState: { seen: boolean }): NormalizedMessage[] | ProtocolError {
  const list = narrowMessageArray(raw, "messages", MAX_MESSAGE_COUNT);
  if (isProtocolError(list)) return list;
  const messages: NormalizedMessage[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const field = `messages[${i}]`;
    if (item === undefined) continue;
    const message = normalizeMessage(item, field, images, reasoningState);
    if (isProtocolError(message)) return message;
    messages.push(...expandToolResultMessages(message));
  }
  return messages;
}

function expandToolResultMessages(message: NormalizedMessage): NormalizedMessage[] {
  if (!message.content.some((block) => block.type === "tool_result")) return [message];
  const expanded: NormalizedMessage[] = [];
  let visibleBlocks: ContentPart[] = [];
  let toolBlocks: ContentPart[] = [];
  const flushVisible = () => {
    if (visibleBlocks.length > 0) {
      expanded.push({ ...message, role: "user", content: visibleBlocks });
      visibleBlocks = [];
    }
  };
  const flushTools = () => {
    if (toolBlocks.length > 0) {
      expanded.push({ ...message, role: "tool", content: toolBlocks });
      toolBlocks = [];
    }
  };
  for (const block of message.content) {
    if (block.type === "tool_result") {
      flushVisible();
      toolBlocks.push(block);
    } else {
      flushTools();
      visibleBlocks.push(block);
    }
  }
  flushTools();
  flushVisible();
  return expanded;
}

function normalizeMessage(raw: unknown, field: string, images: ImageReference[], reasoningState: { seen: boolean }): NormalizedMessage | ProtocolError {
  const obj = narrowObject(raw, field);
  if (isProtocolError(obj)) return obj;
  const role = narrowString(obj["role"], `${field}.role`, 32);
  if (isProtocolError(role)) return role;
  if (role !== "user" && role !== "assistant" && role !== "system") {
    return protocolError(`${field}.role`, `unsupported role "${role}" (Anthropic messages use user, assistant, or system)`);
  }
  const content = normalizeContent(obj["content"], `${field}.content`, images, reasoningState);
  if (isProtocolError(content)) return content;
  return { role, content };
}

function normalizeContent(raw: unknown, field: string, images: ImageReference[], reasoningState: { seen: boolean }): ContentPart[] | ProtocolError {
  if (typeof raw === "string") {
    const text = normalizeTextBlock(raw, field);
    if (isProtocolError(text)) return text;
    return [{ type: "text", text }];
  }
  const list = narrowArray(raw, field, MAX_BLOCKS_PER_MESSAGE);
  if (isProtocolError(list)) return list;
  const blocks: ContentPart[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const blockField = `${field}[${i}]`;
    if (item === undefined) continue;
    if (isRecord(item) && item["type"] === "thinking") {
      const thinking = normalizeTextBlock(item["thinking"], `${blockField}.thinking`);
      if (isProtocolError(thinking)) return thinking;
      const signature = item["signature"];
      if (signature !== undefined && (typeof signature !== "string" || signature.length > MAX_TEXT_BLOCK_LENGTH)) {
        return protocolError(`${blockField}.signature`, `${blockField}.signature: expected a bounded string`);
      }
      reasoningState.seen = true;
      blocks.push({ type: "reasoning", nativeType: "thinking", reasoningText: thinking, ...(typeof signature === "string" ? { reasoningSignature: signature } : {}), nativePayload: { ...item }, raw: item });
      continue;
    }
    if (isRecord(item) && item["type"] === "tool_result") {
      const callId = narrowString(item["tool_use_id"], `${blockField}.tool_use_id`, 128);
      if (isProtocolError(callId)) return callId;
      if (callId === "") return protocolError(`${blockField}.tool_use_id`, "tool_use_id must not be empty");
      const isError = item["is_error"] === true;
      const results = normalizeToolResult(item["content"], blockField, callId, images);
      if (isProtocolError(results)) return results;
      blocks.push(...results.map((block) => isError ? { ...block, toolResultIsError: true } : block));
      continue;
    }
    const block = normalizeBlock(item, blockField, images);
    if (isProtocolError(block)) return block;
    blocks.push(block);
  }
  return blocks;
}

function normalizeBlock(raw: unknown, field: string, images: ImageReference[]): ContentPart | ProtocolError {
  const obj = narrowObject(raw, field);
  if (isProtocolError(obj)) return obj;
  const type = obj["type"];
  switch (type) {
    case "text": {
      const text = normalizeTextBlock(obj["text"], `${field}.text`);
      if (isProtocolError(text)) return text;
      const cacheControl = normalizeCacheControl(obj["cache_control"], `${field}.cache_control`);
      if (isProtocolError(cacheControl)) return cacheControl;
      const citations = obj["citations"];
      if (citations !== undefined && !Array.isArray(citations)) return protocolError(`${field}.citations`, `${field}.citations must be an array`);
      const citationEntries = Array.isArray(citations) ? citations.filter(isRecord).slice(0, 64).map((citation) => ({ ...citation })) : undefined;
      return {
        type: "text",
        text,
        ...(cacheControl === undefined ? {} : { cacheControl }),
        ...(citationEntries === undefined ? {} : { citations: citationEntries }),
      };
    }
    case "image": {
      const image = normalizeImage(obj["source"], `${field}.source`, images);
      if (isProtocolError(image)) return image;
      const cacheControl = normalizeCacheControl(obj["cache_control"], `${field}.cache_control`);
      if (isProtocolError(cacheControl)) return cacheControl;
      return { type: "image", image, ...(cacheControl === undefined ? {} : { cacheControl }) };
    }
    case "document": {
      const pdf = normalizeDocumentSource(obj["source"], `${field}.source`, images);
      if (isProtocolError(pdf)) return pdf;
      const title = obj["title"] === undefined ? undefined : narrowString(obj["title"], `${field}.title`, 1_024);
      if (isProtocolError(title)) return title;
      const context = obj["context"] === undefined ? undefined : narrowString(obj["context"], `${field}.context`, MAX_TEXT_BLOCK_LENGTH);
      if (isProtocolError(context)) return context;
      const cacheControl = normalizeCacheControl(obj["cache_control"], `${field}.cache_control`);
      if (isProtocolError(cacheControl)) return cacheControl;
      const citations = isRecord(obj["citations"]) ? { ...obj["citations"] } : undefined;
      return {
        type: "pdf",
        pdf: {
          ...pdf,
          ...(title === undefined ? {} : { title }),
          ...(context === undefined ? {} : { context }),
          ...(citations === undefined ? {} : { citations }),
        },
        ...(cacheControl === undefined ? {} : { cacheControl }),
        ...(citations === undefined ? {} : { citations: [citations] }),
      };
    }
    case "video": {
      const video = normalizeVideoSource(obj["source"], `${field}.source`, images);
      if (isProtocolError(video)) return video;
      return { type: "video", video };
    }
    case "tool_use": {
      const id = narrowString(obj["id"], `${field}.id`, 128);
      if (isProtocolError(id)) return id;
      if (id === "") return protocolError(`${field}.id`, "tool use id must not be empty");
      const name = narrowString(obj["name"], `${field}.name`, MAX_TOOL_NAME_LENGTH);
      if (isProtocolError(name)) return name;
      if (name.trim() === "") return protocolError(`${field}.name`, "tool use name must not be empty");
      const input = narrowObject(obj["input"] ?? {}, `${field}.input`);
      if (isProtocolError(input)) return input;
      const bound = boundJsonLength(input, `${field}.input`, MAX_TOOL_ARGUMENT_LENGTH);
      if (bound !== null) return bound;
      const signature = obj["signature"];
      if (signature !== undefined && (typeof signature !== "string" || signature.length > MAX_TEXT_BLOCK_LENGTH)) return protocolError(`${field}.signature`, `${field}.signature: expected a bounded string`);
      return { type: "tool_use", toolName: name, toolCallId: id, toolArguments: JSON.stringify(input), ...(typeof signature === "string" ? { reasoningSignature: signature } : {}) };
    }
    case "compaction": {
      const content = obj["content"];
      if (content !== undefined && content !== null && typeof content !== "string") return protocolError(`${field}.content`, `${field}.content: expected a string or null`);
      return { type: "compaction", text: typeof content === "string" ? content : "", raw: obj } as ContentPart;
    }
    default:
      if (typeof type === "string") {
        return { type: "native", nativeType: type, nativePayload: { ...obj }, raw: obj };
      }
      return protocolError(`${field}.type`, "content block type must be a string");
  }
}

function normalizeToolResult(raw: unknown, field: string, callId: string, images: ImageReference[]): ContentPart[] | ProtocolError {
  if (raw === undefined || raw === null) return [{ type: "tool_result", toolCallId: callId, text: "" }];
  if (typeof raw === "string") {
    const text = normalizeTextBlock(raw, field);
    if (isProtocolError(text)) return text;
    return [{ type: "tool_result", text, toolCallId: callId }];
  }
  const list = narrowArray(raw, field, MAX_BLOCKS_PER_MESSAGE);
  if (isProtocolError(list)) return list;
  const blocks: ContentPart[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const itemField = `${field}[${i}]`;
    if (item === undefined) continue;
    const obj = narrowObject(item, itemField);
    if (isProtocolError(obj)) return obj;
    const type = obj["type"];
    if (type === "text") {
      const text = normalizeTextBlock(obj["text"], `${itemField}.text`);
      if (isProtocolError(text)) return text;
      blocks.push({ type: "tool_result", text, toolCallId: callId });
    } else if (type === "image") {
      const image = normalizeImage(obj["source"], `${itemField}.source`, images);
      if (isProtocolError(image)) return image;
      blocks.push({ type: "image", image, cacheControl: undefined } as ContentPart);
      blocks.push({ type: "tool_result", text: typeof obj["text"] === "string" ? obj["text"] : "", toolCallId: callId });
    } else if (type === "document") {
      const pdf = normalizeDocumentSource(obj["source"], `${itemField}.source`, images);
      if (isProtocolError(pdf)) return pdf;
      blocks.push({ type: "pdf", pdf } as ContentPart);
      blocks.push({ type: "tool_result", text: typeof obj["text"] === "string" ? obj["text"] : "", toolCallId: callId });
    } else if (type === "video") {
      const video = normalizeVideoSource(obj["source"], `${itemField}.source`, images);
      if (isProtocolError(video)) return video;
      blocks.push({ type: "video", video } as ContentPart);
      blocks.push({ type: "tool_result", text: typeof obj["text"] === "string" ? obj["text"] : "", toolCallId: callId });
    } else if (typeof type === "string") {
      const serialized = typeof obj["text"] === "string" ? obj["text"] : JSON.stringify(obj);
      blocks.push({ type: "tool_result", text: serialized, toolCallId: callId, nativeType: type, nativePayload: { ...obj }, raw: obj });
    } else {
      return protocolError(`${itemField}.type`, "tool result block must have a string type");
    }
  }
  return blocks;
}

function normalizeImage(raw: unknown, field: string, images: ImageReference[]): ImageReference | ProtocolError {
  const source = narrowObject(raw, field);
  if (isProtocolError(source)) return source;
  const type = source["type"];
  if (type === "base64") {
    const mediaType = narrowString(source["media_type"], `${field}.media_type`, MAX_MEDIA_TYPE_LENGTH);
    if (isProtocolError(mediaType)) return mediaType;
    if (mediaType === "") return protocolError(`${field}.media_type`, "media_type must not be empty");
    const data = narrowString(source["data"], `${field}.data`, MAX_DATA_URL_LENGTH);
    if (isProtocolError(data)) return data;
    if (data === "") return protocolError(`${field}.data`, "base64 data must not be empty");
    const reference: ImageReference = { kind: "data", value: data, mediaType };
    const bound = pushImageReference(images, reference, field);
    if (bound !== null) return bound;
    return reference;
  }
  if (type === "url") {
    const classification = classifyImageReference(source["url"], `${field}.url`);
    if (!classification.ok) return classification.error;
    const bound = pushImageReference(images, classification.reference, field);
    if (bound !== null) return bound;
    return classification.reference;
  }
  if (type === "file") {
    const fileId = narrowString(source["file_id"], `${field}.file_id`, 512);
    if (isProtocolError(fileId)) return fileId;
    if (fileId.length === 0) return protocolError(`${field}.file_id`, "file_id must not be empty");
    const transformations = source["transformations"];
    if (transformations !== undefined && !isRecord(transformations)) return protocolError(`${field}.transformations`, "transformations must be an object");
    const normalizedTransformations = isRecord(transformations)
      ? Object.fromEntries(
          Object.entries(transformations)
            .filter(([key, value]) => key === "oversized_image" && (value === "downsize" || value === "error"))
            .map(([key, value]) => [key, value as "downsize" | "error"]),
        )
      : undefined;
    const reference: ImageReference = {
      kind: "file",
      value: fileId,
      mediaType: null,
      ...(normalizedTransformations === undefined ? {} : { transformations: normalizedTransformations }),
    };
    const bound = pushImageReference(images, reference, field);
    if (bound !== null) return bound;
    return reference;
  }
  if (typeof type === "string") return protocolError(`${field}.type`, `unsupported image source type "${type}"`);
  return protocolError(`${field}.type`, "image source type must be a string");
}

function normalizeDocumentSource(raw: unknown, field: string, images: ImageReference[]): PdfReference | ProtocolError {
  const source = narrowObject(raw, field);
  if (isProtocolError(source)) return source;
  const type = source["type"];
  if (type === "base64") {
    const mediaType = narrowString(source["media_type"], `${field}.media_type`, MAX_MEDIA_TYPE_LENGTH);
    if (isProtocolError(mediaType)) return mediaType;
    const data = narrowString(source["data"], `${field}.data`, MAX_DATA_URL_LENGTH);
    if (isProtocolError(data)) return data;
    const reference: PdfReference = { kind: "data", value: data, mediaType: mediaType || "application/pdf" };
    const bound = pushImageReference(images, reference as unknown as ImageReference, field);
    if (bound !== null) return bound;
    return reference;
  }
  if (type === "url") {
    const classification = classifyImageReference(source["url"], `${field}.url`);
    if (!classification.ok) return classification.error;
    return { kind: classification.reference.kind, value: classification.reference.value, mediaType: classification.reference.mediaType ?? "application/pdf" };
  }
  if (type === "file") {
    const fileId = narrowString(source["file_id"], `${field}.file_id`, 512);
    if (isProtocolError(fileId)) return fileId;
    if (fileId.length === 0) return protocolError(`${field}.file_id`, "file_id must not be empty");
    return { kind: "file", value: fileId, mediaType: "application/pdf" };
  }
  if (type === "plain_text") {
    const data = narrowString(source["data"], `${field}.data`, MAX_TEXT_BLOCK_LENGTH);
    if (isProtocolError(data)) return data;
    return { kind: "data", value: data, mediaType: "text/plain" };
  }
  if (type === "content") {
    const content = narrowArray(source["content"], `${field}.content`, MAX_BLOCKS_PER_MESSAGE);
    if (isProtocolError(content)) return content;
    const blocks: Readonly<Record<string, unknown>>[] = [];
    for (let index = 0; index < content.length; index += 1) {
      const block = narrowObject(content[index], `${field}.content[${index}]`);
      if (isProtocolError(block)) return block;
      blocks.push({ ...block });
    }
    return { kind: "data", value: "", mediaType: "application/x-anthropic-content", contentBlocks: blocks };
  }
  return protocolError(`${field}.type`, "document source type must be base64, url, file, plain_text, or content");
}

function normalizeVideoSource(raw: unknown, field: string, images: ImageReference[]): VideoReference | ProtocolError {
  const source = narrowObject(raw, field);
  if (isProtocolError(source)) return source;
  const type = source["type"];
  if (type === "base64") {
    const mediaType = narrowString(source["media_type"], `${field}.media_type`, MAX_MEDIA_TYPE_LENGTH);
    if (isProtocolError(mediaType)) return mediaType;
    const data = narrowString(source["data"], `${field}.data`, MAX_DATA_URL_LENGTH);
    if (isProtocolError(data)) return data;
    const reference: VideoReference = { kind: "data", value: data, mediaType: mediaType || "video/mp4" };
    const bound = pushImageReference(images, reference as unknown as ImageReference, field);
    if (bound !== null) return bound;
    return reference;
  }
  if (type === "url") {
    const classification = classifyImageReference(source["url"], `${field}.url`);
    if (!classification.ok) return classification.error;
    return { kind: classification.reference.kind, value: classification.reference.value, mediaType: classification.reference.mediaType ?? "video/mp4" };
  }
  return protocolError(`${field}.type`, "video source type must be base64 or url");
}

function normalizeTools(raw: unknown): NormalizedTool[] | ProtocolError {
  return normalizeToolList(raw, { unwrapFunction: false, schemaField: "input_schema", schemaRequired: true, sourceSurface: "anthropic-messages" });
}

function normalizeMcpServers(raw: unknown): readonly Readonly<Record<string, unknown>>[] | ProtocolError | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = narrowArray(raw, "mcp_servers", MAX_TOOL_COUNT);
  if (isProtocolError(list)) return list;
  const servers: Readonly<Record<string, unknown>>[] = [];
  for (let i = 0; i < list.length; i++) {
    const field = `mcp_servers[${i}]`;
    const server = narrowObject(list[i], field);
    if (isProtocolError(server)) return server;
    const sizeError = boundJsonLength(server, field, MAX_TEXT_BLOCK_LENGTH);
    if (sizeError !== null) return sizeError;
    servers.push(server);
  }
  return servers;
}
