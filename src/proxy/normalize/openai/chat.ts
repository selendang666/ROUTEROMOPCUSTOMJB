import type { ProxyRequest } from "../../types/request.js";
import type { ContentPart, ImageReference, NormalizedMessage, NormalizedTool, PdfReference, ReasoningConfig, VideoReference } from "../../types/content.js";
import type { ReasoningEffort, ReasoningSummary } from "../../types/surface.js";
import { MAX_BLOCKS_PER_MESSAGE, MAX_MESSAGE_COUNT, MAX_MODEL_LENGTH, MAX_OUTPUT_TOKENS, MAX_TEXT_BLOCK_LENGTH, MAX_TOOL_ARGUMENT_LENGTH, MAX_TOOL_CALLS_PER_MESSAGE, MAX_TOOL_NAME_LENGTH, boundJsonLength, isRecord, narrowArray, narrowBoolean, narrowMessageArray, narrowNumber, narrowObject, narrowString, normalizeStream } from "../../validation.js";
import { abortedError, isProtocolError, protocolError } from "../../errors.js";
import type { ProtocolError } from "../../errors.js";
import { classifyImageReference, pushImageReference } from "../../media-guard.js";
import { normalizeFail, normalizeOk } from "../../protocol-request.js";
import type { NormalizeInput, NormalizeResult } from "../../protocol-request.js";
import { normalizeToolList } from "../tools.js";
import { normalizeClientEffort } from "../../translate/policy.js";
import { stringifyToolArguments } from "../../events/repair.js";
import { parseReasoningConfig } from "./reasoning.js";
import { normalizeToolChoice } from "./shared.js";

export function normalizeChatRequest(body: unknown, input: NormalizeInput): NormalizeResult {
  const aborted = abortedError(input.signal);
  if (aborted !== null) return normalizeFail(aborted);
  const root = narrowObject(body, "body");
  if (isProtocolError(root)) return normalizeFail(root);

  const model = narrowString(root["model"], "model", MAX_MODEL_LENGTH);
  if (isProtocolError(model)) return normalizeFail(model);
  if (model.trim() === "") return normalizeFail(protocolError("model", "model: must not be empty"));

  const stream = normalizeStream(root["stream"]);
  if (isProtocolError(stream)) return normalizeFail(stream);

  const responseFormat = normalizeResponseFormat(root["response_format"]);
  if (isProtocolError(responseFormat)) return normalizeFail(responseFormat);
  const controls = normalizeChatControls(root);
  if (isProtocolError(controls)) return normalizeFail(controls);
  const wirePayload = input.includeWirePayload ? (root as Readonly<Record<string, unknown>>) : undefined;
  const reasoningState = { seen: false };
  const images: ImageReference[] = [];
  const messages = normalizeMessages(root["messages"], images, reasoningState);
  if (isProtocolError(messages)) return normalizeFail(messages);

  const tools = normalizeTools(root["tools"]);
  if (isProtocolError(tools)) return normalizeFail(tools);

  const reasoning = finalizeReasoning(root, reasoningState);
  if (isProtocolError(reasoning)) return normalizeFail(reasoning);
  const finalFlag = reasoningState.seen && reasoning.flag === "default" ? "enabled" : reasoning.flag;
  const maxOutputTokens = normalizeMaxOutputTokens(root);
  if (isProtocolError(maxOutputTokens)) return normalizeFail(maxOutputTokens);


  const rawCacheKey = root["prompt_cache_key"];
  const cacheKey = typeof rawCacheKey === "string" && rawCacheKey.length <= 256 ? rawCacheKey : undefined;
  return normalizeOk({
    model,
    operation: input.operation ?? "invoke",
    messages,
    tools,
    stream,
    responseFormat: responseFormat.constraint,
    ...controls,
    maxOutputTokens,
    reasoning: finalFlag,
    reasoningConfig: reasoning.config,
    images,
    sourceSurface: "openai-chat",
    signal: input.signal,
    limits: input.limits,
    ...(wirePayload !== undefined ? { wirePayload } : {}),
    ...(cacheKey === undefined ? {} : { cacheKey }),
  });
}

interface NormalizedResponseFormat {
  readonly constraint: ProxyRequest["responseFormat"];
}

function normalizeResponseFormat(raw: unknown): NormalizedResponseFormat | ProtocolError {
  if (raw === undefined || raw === null) return { constraint: { kind: "text" } };
  const format = narrowObject(raw, "response_format");
  if (isProtocolError(format)) return format;
  const type = format["type"];
  if (type === "text" || type === "json_object") return { constraint: { kind: type } };
  if (type === "json_schema") {
    const schema = narrowObject(format["json_schema"], "response_format.json_schema");
    if (isProtocolError(schema)) return schema;
    const bound = boundJsonLength(schema, "response_format.json_schema", MAX_TEXT_BLOCK_LENGTH);
    if (bound !== null) return bound;
    return { constraint: { kind: "json_schema", schema: { ...schema } } };
  }
  if (typeof type === "string") return protocolError("response_format.type", `response_format.type: unsupported format "${type}"`);
  return protocolError("response_format.type", 'response_format.type: expected "text", "json_object", or "json_schema"');
}

interface NormalizedChatControls {
  readonly temperature?: number;
  readonly topP?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly seed?: number;
  readonly user?: string;
  readonly verbosity?: string;
  readonly stop?: readonly string[];
  readonly parallelToolCalls?: boolean;
  readonly toolChoice?: ProxyRequest["toolChoice"];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function normalizeChatControls(root: Record<string, unknown>): NormalizedChatControls | ProtocolError {
  const temperature = optionalNumber(root["temperature"], "temperature", { min: 0, max: 2 });
  if (isProtocolError(temperature)) return temperature;
  const topP = optionalNumber(root["top_p"], "top_p", { min: 0, max: 1 });
  if (isProtocolError(topP)) return topP;
  const frequencyPenalty = optionalNumber(root["frequency_penalty"], "frequency_penalty", { min: -2, max: 2 });
  if (isProtocolError(frequencyPenalty)) return frequencyPenalty;
  const presencePenalty = optionalNumber(root["presence_penalty"], "presence_penalty", { min: -2, max: 2 });
  if (isProtocolError(presencePenalty)) return presencePenalty;
  const seed = optionalNumber(root["seed"], "seed", { integer: true, min: 0, max: 2_147_483_647 });
  if (isProtocolError(seed)) return seed;
  const user = root["user"] === undefined ? undefined : narrowString(root["user"], "user", 256);
  if (isProtocolError(user)) return user;
  const verbosity = root["verbosity"] === undefined ? undefined : narrowString(root["verbosity"], "verbosity", 32);
  if (isProtocolError(verbosity)) return verbosity;
  const stop = normalizeStop(root["stop"]);
  if (isProtocolError(stop)) return stop;
  const parallelToolCalls = optionalBoolean(root["parallel_tool_calls"], "parallel_tool_calls");
  if (isProtocolError(parallelToolCalls)) return parallelToolCalls;
  const toolChoice = normalizeToolChoice(root["tool_choice"]);
  if (isProtocolError(toolChoice)) return toolChoice;
  const metadata = normalizeMetadata(root["metadata"]);
  if (isProtocolError(metadata)) return metadata;
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(frequencyPenalty === undefined ? {} : { frequencyPenalty }),
    ...(presencePenalty === undefined ? {} : { presencePenalty }),
    ...(seed === undefined ? {} : { seed }),
    ...(user === undefined ? {} : { user }),
    ...(verbosity === undefined ? {} : { verbosity }),
    ...(stop === undefined ? {} : { stop }),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function optionalNumber(raw: unknown, field: string, options: { readonly min: number; readonly max: number; readonly integer?: boolean }): number | undefined | ProtocolError {
  if (raw === undefined || raw === null) return undefined;
  return narrowNumber(raw, field, options);
}

function optionalBoolean(raw: unknown, field: string): boolean | undefined | ProtocolError {
  if (raw === undefined || raw === null) return undefined;
  return narrowBoolean(raw, field);
}

function normalizeStop(raw: unknown): readonly string[] | undefined | ProtocolError {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    const value = narrowString(raw, "stop", 256);
    return isProtocolError(value) ? value : [value];
  }
  const list = narrowArray(raw, "stop", 16);
  if (isProtocolError(list)) return list;
  const values: string[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const value = narrowString(list[index], `stop[${index}]`, 256);
    if (isProtocolError(value)) return value;
    values.push(value);
  }
  return values;
}


function normalizeMetadata(raw: unknown): Readonly<Record<string, unknown>> | undefined | ProtocolError {
  if (raw === undefined || raw === null) return undefined;
  const value = narrowObject(raw, "metadata");
  if (isProtocolError(value)) return value;
  const bound = boundJsonLength(value, "metadata", MAX_TEXT_BLOCK_LENGTH);
  if (bound !== null) return bound;
  return { ...value };
}

function normalizeMaxOutputTokens(root: Record<string, unknown>): number | null | ProtocolError {
  const field = root["max_completion_tokens"] !== undefined ? "max_completion_tokens" : "max_tokens";
  const raw = root["max_completion_tokens"] ?? root["max_tokens"];
  if (raw === undefined || raw === null) return null;
  const value = narrowNumber(raw, field, { integer: true, min: 0, max: MAX_OUTPUT_TOKENS });
  if (isProtocolError(value)) return value;
  return value;
}

function finalizeReasoning(root: Record<string, unknown>, state: { readonly seen: boolean }): { flag: "enabled" | "disabled" | "default"; config: ReasoningConfig | undefined } | ProtocolError {
  // An assistant `reasoning_content` block in history forces thinking on, since
  // OpenAI requires it to be replayed whenever the prior turn used thinking.
  const reasoning = root["reasoning"];
  const hasReasoningObject = reasoning !== undefined && reasoning !== null;
  if (hasReasoningObject && !isRecord(reasoning)) return protocolError("reasoning", "reasoning: expected an object");
  const reasoningObj = hasReasoningObject ? (reasoning as Record<string, unknown>) : undefined;
  if (reasoningObj !== undefined && ("mode" in reasoningObj || "context" in reasoningObj)) {
    return protocolError("reasoning", "reasoning.mode and reasoning.context are only supported on the Responses surface");
  }

  // The Chat surface also accepts a top-level `reasoning_effort` string (the
  // alternate spelling). Normalize it into the config effort slot so builders
  // can forward a single canonical value downstream.
  const topEffort = root["reasoning_effort"];
  const parsed = reasoningObj !== undefined ? parseReasoningConfig(reasoningObj, "reasoning", reasoningObj["enabled"]) : null;
  if (parsed !== null && isProtocolError(parsed)) return parsed;

  const config: { effort?: ReasoningEffort; maxTokens?: number; exclude?: boolean; enabled?: boolean; summary?: ReasoningSummary } = {};
  if (parsed !== null && parsed.config !== undefined) Object.assign(config, parsed.config);
  if (topEffort !== undefined && config.effort === undefined) {
    const effort = normalizeClientEffort(topEffort);
    if (effort !== undefined) config.effort = effort;
  }
  const flag = state.seen || config.effort !== undefined || config.enabled === true || config.maxTokens !== undefined
    ? "enabled"
    : parsed !== null ? parsed.flag : "default";
  return { flag, config: Object.keys(config).length > 0 ? config : undefined };
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
    messages.push(message);
  }
  return messages;
}

function normalizeMessage(raw: unknown, field: string, images: ImageReference[], reasoningState: { seen: boolean }): NormalizedMessage | ProtocolError {
  const obj = narrowObject(raw, field);
  if (isProtocolError(obj)) return obj;
  const role = narrowString(obj["role"], `${field}.role`, 32);
  if (isProtocolError(role)) return role;
  if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant" && role !== "tool") {
    return protocolError(`${field}.role`, `unsupported role "${role}"`);
  }
  const content = normalizeContent(obj["content"], `${field}.content`, images);
  if (isProtocolError(content)) return content;
  if (role === "assistant") {
    const calls = normalizeToolCalls(obj["tool_calls"], `${field}.tool_calls`);
    if (isProtocolError(calls)) return calls;
    if (calls.length > 0) content.push(...calls);
    const rawReasoningContent = obj["reasoning_content"];
    if (typeof rawReasoningContent === "string" && rawReasoningContent !== "") {
      content.push({ type: "reasoning", reasoningText: rawReasoningContent, reasoningSourceSurface: "openai-responses" });
      reasoningState.seen = true;
    }
  } else if (role === "tool") {
    const callId = narrowString(obj["tool_call_id"], `${field}.tool_call_id`, 128);
    if (isProtocolError(callId)) return callId;
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (block === undefined) continue;
      content[i] = { ...block, type: "tool_result", toolCallId: callId };
    }
  }
  return { role, content };
}

function normalizeContent(raw: unknown, field: string, images: ImageReference[]): ContentPart[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    if (raw.length > MAX_TEXT_BLOCK_LENGTH) return protocolError(field, `${field}: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
    return [{ type: "text", text: raw }];
  }
  const list = narrowArray(raw, field, MAX_BLOCKS_PER_MESSAGE);
  if (isProtocolError(list)) return list;
  const blocks: ContentPart[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const blockField = `${field}[${i}]`;
    if (item === undefined) continue;
    const obj = narrowObject(item, blockField);
    if (isProtocolError(obj)) return obj;
    const type = obj["type"];
    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = narrowString(obj["text"], `${blockField}.text`, MAX_TEXT_BLOCK_LENGTH);
      if (isProtocolError(text)) return text;
      blocks.push({ type: "text", text });
    } else if (type === "image_url") {
      const image = normalizeImageUrl(obj["image_url"], `${blockField}.image_url`, images);
      if (isProtocolError(image)) return image;
      blocks.push({ type: "image", image });
    } else if (type === "video_url") {
      const video = normalizeFileReference(obj["video_url"], `${blockField}.video_url`, images, "video", null);
      if (isProtocolError(video)) return video;
      blocks.push({ type: "video", video } as ContentPart);
    } else if (type === "document") {
      const source = narrowObject(obj["source"], `${blockField}.source`);
      if (isProtocolError(source)) return source;
      const sourceType = source["type"];
      if (sourceType !== "base64" && sourceType !== "url") {
        return protocolError(`${blockField}.source.type`, "document source type must be base64 or url");
      }
      const value = sourceType === "base64" ? source["data"] : source["url"];
      const filename = typeof source["filename"] === "string" ? source["filename"] : null;
      const sourceValue = sourceType === "base64" && typeof value === "string" && !value.startsWith("data:")
        ? `data:application/pdf;base64,${value}`
        : value;
      const pdf = normalizeFileReference(sourceValue, `${blockField}.source`, images, "pdf", filename);
      if (isProtocolError(pdf)) return pdf;
      blocks.push({ type: "pdf", pdf } as ContentPart);
    } else if (type === "file" || type === "input_file") {
      const file = obj["file"] ?? obj;
      const filename = typeof (file as Record<string, unknown>)["filename"] === "string" ? (file as Record<string, unknown>)["filename"] as string : null;
      const url = (file as Record<string, unknown>)["file_data"] ?? (file as Record<string, unknown>)["url"] ?? (file as Record<string, unknown>)["file_url"];
      if (typeof url === "string") {
        const wireMediaType = (file as Record<string, unknown>)["file_media_type"];
        const wireFormat = (file as Record<string, unknown>)["format"];
        let mediaType: string | null = null;
        if (typeof wireMediaType === "string") {
          mediaType = wireMediaType;
        } else if (typeof wireFormat === "string") {
          mediaType = wireFormat;
        }
        const lower = (mediaType ?? filename ?? "").toLowerCase();
        if (lower.includes("pdf")) {
          const fileValue = !url.startsWith("data:") && !url.startsWith("http") ? `data:application/pdf;base64,${url}` : url;
          const pdf = normalizeFileReference(fileValue, `${blockField}.file`, images, "pdf", filename);
          if (isProtocolError(pdf)) return pdf;
          blocks.push({ type: "pdf", pdf } as ContentPart);
        } else if (lower.includes("video") || lower.endsWith(".mp4") || lower.endsWith(".mov") || lower.endsWith(".webm")) {
          const video = normalizeFileReference(url, `${blockField}.file`, images, "video", filename);
          if (isProtocolError(video)) return video;
          blocks.push({ type: "video", video } as ContentPart);
        } else {
          const image = normalizeImageUrl(url, `${blockField}.file`, images);
          if (!isProtocolError(image)) blocks.push({ type: "image", image });
          else blocks.push({ type: "native", nativeType: type as string, nativePayload: { ...obj }, raw: obj });
        }
      } else {
        const bound = boundJsonLength(obj, blockField, MAX_TEXT_BLOCK_LENGTH);
        if (bound !== null) return bound;
        blocks.push({ type: "native", nativeType: type as string, nativePayload: { ...obj }, raw: obj });
      }
    } else if (typeof type === "string") {
      const bound = boundJsonLength(obj, blockField, MAX_TEXT_BLOCK_LENGTH);
      if (bound !== null) return bound;
      blocks.push({ type: "native", nativeType: type, nativePayload: { ...obj }, raw: obj });
    } else {
      return protocolError(`${blockField}.type`, "content block type must be a string");
    }
  }
  return blocks;
}

function normalizeImageUrl(raw: unknown, field: string, images: ImageReference[]): ImageReference | ProtocolError {
  const url = isRecord(raw) ? raw["url"] : raw;
  const classification = classifyImageReference(url, `${field}.url`);
  if (!classification.ok) return classification.error;
  const bound = pushImageReference(images, classification.reference, field);
  if (bound !== null) return bound;
  return classification.reference;
}

function normalizeFileReference(raw: unknown, field: string, images: ImageReference[], kind: "pdf" | "video", filename: string | null): PdfReference | VideoReference | ProtocolError {
  const classification = classifyImageReference(raw, field);
  if (!classification.ok) return classification.error;
  const bound = pushImageReference(images, classification.reference as unknown as ImageReference, field);
  if (bound !== null) return bound;
  if (kind === "pdf") return { kind: classification.reference.kind, value: classification.reference.value, mediaType: classification.reference.mediaType ?? "application/pdf", ...(filename === null ? {} : { filename }) } as PdfReference;
  return { kind: classification.reference.kind, value: classification.reference.value, mediaType: classification.reference.mediaType ?? "video/mp4", ...(filename === null ? {} : { filename }) } as VideoReference;
}

function toolCallThoughtSignature(obj: Record<string, unknown>, fn: Record<string, unknown>): string | undefined {
  const sources: unknown[] = [obj["extra_content"], fn["extra_content"], obj["thought_signature"], fn["thought_signature"], obj["thoughtSignature"], fn["thoughtSignature"]];
  for (const source of sources) {
    if (typeof source === "string" && source.length > 0) return source;
    if (!isRecord(source)) continue;
    const google = isRecord(source["google"]) ? source["google"] : source;
    const signature = google["thought_signature"] ?? google["thoughtSignature"];
    if (typeof signature === "string" && signature.length > 0) return signature;
  }
  return undefined;
}

function normalizeToolCalls(raw: unknown, field: string): ContentPart[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  const list = narrowArray(raw, field, MAX_TOOL_CALLS_PER_MESSAGE);
  if (isProtocolError(list)) return list;
  const blocks: ContentPart[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const itemField = `${field}[${i}]`;
    if (item === undefined) continue;
    const obj = narrowObject(item, itemField);
    if (isProtocolError(obj)) return obj;
    const type = obj["type"];
    if (type !== undefined && type !== "function") {
      return protocolError(`${itemField}.type`, `unsupported tool call type "${String(type)}"`);
    }
    const fn = narrowObject(obj["function"], `${itemField}.function`);
    if (isProtocolError(fn)) return fn;
    const name = narrowString(fn["name"], `${itemField}.function.name`, MAX_TOOL_NAME_LENGTH);
    if (isProtocolError(name)) return name;
    if (name.trim() === "") return protocolError(`${itemField}.function.name`, "tool call name must not be empty");
    const id = narrowString(obj["id"], `${itemField}.id`, 128);
    if (isProtocolError(id)) return id;
    let argumentsValue: string;
    try {
      argumentsValue = stringifyToolArguments(fn["arguments"] ?? "{}");
    } catch {
      return protocolError(`${itemField}.function.arguments`, `function arguments exceed ${MAX_TOOL_ARGUMENT_LENGTH} characters`);
    }
    const reasoningSignature = toolCallThoughtSignature(obj, fn);
    blocks.push({ type: "tool_use", toolName: name, toolCallId: id, toolArguments: argumentsValue, ...(reasoningSignature === undefined ? {} : { reasoningSignature }) });
  }
  return blocks;
}

function normalizeTools(raw: unknown): NormalizedTool[] | ProtocolError {
  return normalizeToolList(raw, { unwrapFunction: true, schemaField: "parameters", schemaRequired: false, sourceSurface: "openai-chat" });
}

