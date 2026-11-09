import type { ProxyRequest } from "../../types/request.js";
import type { ContentPart, ImageReference, NormalizedMessage, NormalizedTool, PdfReference, ReasoningConfig, VideoReference } from "../../types/content.js";
import { MAX_BLOCKS_PER_MESSAGE, MAX_MESSAGE_COUNT, MAX_MODEL_LENGTH, MAX_OUTPUT_TOKENS, MAX_TEXT_BLOCK_LENGTH, MAX_TOOL_ARGUMENT_LENGTH, MAX_TOOL_CALLS_PER_MESSAGE, MAX_TOOL_NAME_LENGTH, boundJsonLength, isRecord, narrowArray, narrowMessageArray, narrowNumber, narrowObject, narrowString, normalizeStream } from "../../validation.js";
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

export function normalizeResponsesRequest(body: unknown, input: NormalizeInput): NormalizeResult {
  const aborted = abortedError(input.signal);
  if (aborted !== null) return normalizeFail(aborted);
  const root = narrowObject(body, "body");
  if (isProtocolError(root)) return normalizeFail(root);

  const model = narrowString(root["model"], "model", MAX_MODEL_LENGTH);
  if (isProtocolError(model)) return normalizeFail(model);
  if (model.trim() === "") return normalizeFail(protocolError("model", "model: must not be empty"));

  const stream = normalizeStream(root["stream"]);
  if (isProtocolError(stream)) return normalizeFail(stream);
  const responseFormat = normalizeResponsesFormat(root["text"]);
  if (isProtocolError(responseFormat)) return normalizeFail(responseFormat);
  const reasoning = normalizeReasoning(root["reasoning"]);
  if (isProtocolError(reasoning)) return normalizeFail(reasoning);
  let reasoningConfig = reasoning.config;
  const topEffort = root["reasoning_effort"];
  if (topEffort !== undefined && reasoningConfig?.effort === undefined) {
    const effort = normalizeClientEffort(topEffort);
    if (effort !== undefined) reasoningConfig = { ...reasoningConfig, effort };
  }


  const contextManagement = normalizeContextManagement(root["context_management"]);
  if (isProtocolError(contextManagement)) return normalizeFail(contextManagement);

  const maxOutputTokens = normalizeResponsesMaxOutputTokens(root["max_output_tokens"]);
  if (isProtocolError(maxOutputTokens)) return normalizeFail(maxOutputTokens);
  const controls = normalizeResponsesControls(root);
  if (isProtocolError(controls)) return normalizeFail(controls);

  const wirePayload = input.includeWirePayload ? (root as Readonly<Record<string, unknown>>) : undefined;
  const reasoningState = { seen: false };
  const images: ImageReference[] = [];
  const inputMessages = normalizeInput(root["input"], images, reasoningState);
  if (isProtocolError(inputMessages)) return normalizeFail(inputMessages);

  const instructions = normalizeInstructions(root["instructions"]);
  if (isProtocolError(instructions)) return normalizeFail(instructions);

  const tools = normalizeResponsesTools(root["tools"]);
  if (isProtocolError(tools)) return normalizeFail(tools);

  const include = normalizeInclude(root["include"]);
  if (isProtocolError(include)) return normalizeFail(include);

  const rawCacheKey = root["prompt_cache_key"];
  const cacheKey = typeof rawCacheKey === "string" && rawCacheKey.length <= 256 ? rawCacheKey : undefined;
  const rawSessionId = root["session_id"];
  const sessionId = typeof rawSessionId === "string" && rawSessionId.length <= 256 ? rawSessionId : undefined;
  const rawConversationId = root["conversation_id"];
  const conversationId = typeof rawConversationId === "string" && rawConversationId.length <= 256 ? rawConversationId : undefined;
  const finalReasoning = reasoningState.seen || reasoningConfig?.effort !== undefined || reasoningConfig?.enabled === true || reasoningConfig?.maxTokens !== undefined ? "enabled" : reasoning.flag;

  return normalizeOk({
    model,
    operation: input.operation ?? "invoke",
    messages: [...instructions, ...inputMessages.messages],
    tools,
    stream,
    ...controls,
    responseFormat: responseFormat.constraint,
    reasoning: finalReasoning,
    reasoningConfig,
    include,
    ...(contextManagement === undefined ? {} : { contextManagement }),
    maxOutputTokens,
    images,
    sourceSurface: "openai-responses",
    signal: input.signal,
    limits: input.limits,
    ...(wirePayload !== undefined ? { wirePayload } : {}),
    ...(cacheKey === undefined ? {} : { cacheKey }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(conversationId === undefined ? {} : { conversationId }),
  });
}

function normalizeInstructions(raw: unknown): NormalizedMessage[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "string") return protocolError("instructions", "instructions: expected a string");
  if (raw.length > MAX_TEXT_BLOCK_LENGTH) return protocolError("instructions", `instructions: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
  return [{ role: "system", content: [{ type: "text", text: raw }] }];
}

interface NormalizedResponsesFormat {
  readonly constraint: ProxyRequest["responseFormat"];
}

function normalizeResponsesFormat(raw: unknown): NormalizedResponsesFormat | ProtocolError {
  if (raw === undefined || raw === null) return { constraint: { kind: "text" } };
  const text = narrowObject(raw, "text");
  if (isProtocolError(text)) return text;
  const format = text["format"];
  if (format === undefined || format === null) return { constraint: { kind: "text" } };
  const formatObj = narrowObject(format, "text.format");
  if (isProtocolError(formatObj)) return formatObj;
  const type = formatObj["type"];
  if (type === "text" || type === "json_object") return { constraint: { kind: type } };
  if (type === "json_schema") {
    const schema = narrowObject(formatObj["json_schema"], "text.format.json_schema");
    if (isProtocolError(schema)) return schema;
    const bound = boundJsonLength(schema, "text.format.json_schema", MAX_TEXT_BLOCK_LENGTH);
    if (bound !== null) return bound;
    return { constraint: { kind: "json_schema", schema: { ...schema } } };
  }
  if (typeof type === "string") return protocolError("text.format.type", `text.format.type: unsupported format "${type}"`);
  return protocolError("text.format.type", 'text.format.type: expected "text", "json_object", or "json_schema"');
}


function normalizeInput(raw: unknown, images: ImageReference[], reasoningState: { seen: boolean }): { messages: NormalizedMessage[] } | ProtocolError {
  if (typeof raw === "string") {
    if (raw.length > MAX_TEXT_BLOCK_LENGTH) return protocolError("input", `input: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
    return { messages: [{ role: "user", content: [{ type: "text", text: raw }] }] };
  }
  const list = narrowMessageArray(raw, "input", MAX_MESSAGE_COUNT);
  if (isProtocolError(list)) return list;
  const messages: NormalizedMessage[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const field = `input[${i}]`;
    if (item === undefined) continue;
    if (typeof item === "string") {
      if (item.length > MAX_TEXT_BLOCK_LENGTH) return protocolError(field, `${field}: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
      messages.push({ role: "user", content: [{ type: "text", text: item }] });
      continue;
    }
    const obj = narrowObject(item, field);
    if (isProtocolError(obj)) return obj;
    const type = obj["type"];
    if (type === "message" || (type === undefined && typeof obj["role"] === "string")) {
      const message = normalizeMessageItem(obj, field, images, reasoningState);
      if (isProtocolError(message)) return message;
      messages.push(message);
    } else if (type === "function_call") {
      const block = normalizeFunctionCallItem(obj, field);
      if (isProtocolError(block)) return block;
      messages.push({ role: "assistant", content: [block] });
    } else if (type === "function_call_output") {
      const block = normalizeFunctionCallOutputItem(obj, field);
      if (isProtocolError(block)) return block;
      messages.push({ role: "tool", content: [block] });
    } else if (type === "reasoning") {
      const normalized = normalizeReasoningItem(obj, field);
      if (isProtocolError(normalized)) return normalized;
      const summary = Array.isArray(normalized.summary) ? normalized.summary.filter(isRecord) : undefined;
      messages.push({
        role: "assistant",
        content: [{
          type: "reasoning",
          reasoningText: "",
          reasoningSourceSurface: "openai-responses",
          nativeType: "reasoning",
          nativePayload: normalized,
          raw: normalized,
          ...(typeof normalized.encrypted_content === "string" ? { reasoningEncryptedContent: normalized.encrypted_content } : {}),
          ...(summary === undefined ? {} : { reasoningSummary: summary }),
        }],
      });
      reasoningState.seen = true;
    } else if (type === "compaction") {
      const bound = boundJsonLength(obj, field, MAX_TEXT_BLOCK_LENGTH);
      if (bound !== null) return bound;
      messages.push({ role: "assistant", content: [{ type: "compaction", text: typeof obj["content"] === "string" ? obj["content"] : "", raw: obj }] });
    } else if (type === "additional_tools") {
      // Codex code-mode sends this Responses-only opaque item. Same-surface
      // payload preservation restores it byte-for-byte; cross-surface
      // translations intentionally omit it rather than inventing a tool shape.
      const bound = boundJsonLength(obj, field, MAX_TEXT_BLOCK_LENGTH);
      if (bound !== null) return bound;
    } else if (typeof type === "string") {
      return protocolError(`${field}.type`, `unsupported input item type "${type}"`);
    } else {
      return protocolError(`${field}.type`, "input item type must be a string");
    }
  }
  return { messages };
}

function normalizeReasoning(raw: unknown): { flag: "enabled" | "disabled" | "default"; config: ReasoningConfig | undefined } | ProtocolError {
  if (raw === undefined || raw === null) return { flag: "default", config: undefined };
  const obj = narrowObject(raw, "reasoning");
  if (isProtocolError(obj)) return obj;
  return parseReasoningConfig(obj, "reasoning", obj["enabled"]);

}

function normalizeContextManagement(raw: unknown): readonly Readonly<Record<string, unknown>>[] | ProtocolError | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = narrowArray(raw, "context_management", 16);
  if (isProtocolError(list)) return list;
  const result: Readonly<Record<string, unknown>>[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = narrowObject(list[i], `context_management[${i}]`);
    if (isProtocolError(item)) return item;
    result.push(item);
  }
  const bound = boundJsonLength(result, "context_management", 64 * 1024);
  return bound === null ? result : bound;
}

/** Normalizes the Responses `include` array (e.g. `reasoning.encrypted_content`). */
function normalizeInclude(raw: unknown): readonly string[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return protocolError("include", "include: expected an array of strings");
  const items: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "string" || item.length === 0) return protocolError(`include[${i}]`, "include: expected a non-empty string");
    if (item.length > 128) return protocolError(`include[${i}]`, `include[${i}]: exceeds maximum length of 128 characters`);
    if (!items.includes(item)) items.push(item);
  }
  return items;
}

function normalizeResponsesMaxOutputTokens(raw: unknown): number | null | ProtocolError {
  if (raw === undefined || raw === null) return null;
  const value = narrowNumber(raw, "max_output_tokens", { integer: true, min: 0, max: MAX_OUTPUT_TOKENS });
  if (isProtocolError(value)) return value;
  return value;
}

interface NormalizedResponsesControls {
  readonly temperature?: number;
  readonly topP?: number;
  readonly parallelToolCalls?: boolean;
  readonly toolChoice?: ProxyRequest["toolChoice"];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function normalizeResponsesControls(root: Record<string, unknown>): NormalizedResponsesControls | ProtocolError {
  const temperature = optionalResponsesNumber(root["temperature"], "temperature", 0, 2);
  if (isProtocolError(temperature)) return temperature;
  const topP = optionalResponsesNumber(root["top_p"], "top_p", 0, 1);
  if (isProtocolError(topP)) return topP;
  const parallelToolCalls = optionalResponsesBoolean(root["parallel_tool_calls"], "parallel_tool_calls");
  if (isProtocolError(parallelToolCalls)) return parallelToolCalls;
  const toolChoice = normalizeToolChoice(root["tool_choice"]);
  if (isProtocolError(toolChoice)) return toolChoice;
  const metadataRaw = root["metadata"];
  let metadata: Readonly<Record<string, unknown>> | undefined;
  if (metadataRaw !== undefined && metadataRaw !== null) {
    const value = narrowObject(metadataRaw, "metadata");
    if (isProtocolError(value)) return value;
    const bound = boundJsonLength(value, "metadata", MAX_TEXT_BLOCK_LENGTH);
    if (bound !== null) return bound;
    metadata = { ...value };
  }
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function optionalResponsesNumber(raw: unknown, field: string, min: number, max: number): number | undefined | ProtocolError {
  if (raw === undefined || raw === null) return undefined;
  return narrowNumber(raw, field, { min, max });
}

function optionalResponsesBoolean(raw: unknown, field: string): boolean | undefined | ProtocolError {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") return protocolError(field, `${field}: expected a boolean`);
  return raw;
}

function normalizeMessageItem(obj: Record<string, unknown>, field: string, images: ImageReference[], reasoningState: { seen: boolean }): NormalizedMessage | ProtocolError {
  const role = narrowString(obj["role"], `${field}.role`, 32);
  if (isProtocolError(role)) return role;
  if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant") {
    return protocolError(`${field}.role`, `unsupported message role "${role}"`);
  }
  const phaseRaw = obj["phase"];
  if (phaseRaw !== undefined && role !== "assistant") return protocolError(`${field}.phase`, `${field}.phase is only valid for assistant messages`);
  if (phaseRaw !== undefined && phaseRaw !== "commentary" && phaseRaw !== "final_answer") return protocolError(`${field}.phase`, `${field}.phase: expected "commentary" or "final_answer"`);
  const content = normalizeMessageContent(obj["content"], `${field}.content`, images, reasoningState);
  if (isProtocolError(content)) return content;
  return { role, content, ...(phaseRaw === undefined ? {} : { phase: phaseRaw }) };
}

function normalizeReasoningItem(obj: Record<string, unknown>, field: string): Record<string, unknown> | ProtocolError {
  const item: Record<string, unknown> = { type: "reasoning" };
  for (const key of ["id", "encrypted_content"] as const) {
    const value = obj[key];
    if (value === undefined) continue;
    const text = narrowString(value, `${field}.${key}`, MAX_TEXT_BLOCK_LENGTH);
    if (isProtocolError(text)) return text;
    item[key] = text;
  }
  const summary = obj["summary"];
  if (summary !== undefined) {
    if (!Array.isArray(summary) || summary.length > MAX_BLOCKS_PER_MESSAGE) return protocolError(`${field}.summary`, `${field}.summary: expected at most ${MAX_BLOCKS_PER_MESSAGE} summary items`);
    const normalized: Record<string, unknown>[] = [];
    for (let i = 0; i < summary.length; i++) {
      const entry = summary[i];
      const entryField = `${field}.summary[${i}]`;
      const entryObject = narrowObject(entry, entryField);
      if (isProtocolError(entryObject)) return entryObject;
      const type = entryObject["type"];
      if (type !== "summary_text" && type !== "reasoning_text") return protocolError(`${entryField}.type`, `${entryField}.type: unsupported summary type`);
      const text = narrowString(entryObject["text"], `${entryField}.text`, MAX_TEXT_BLOCK_LENGTH);
      if (isProtocolError(text)) return text;
      normalized.push({ type, text });
    }
    item.summary = normalized;
  }
  const bound = boundJsonLength(item, field, MAX_TEXT_BLOCK_LENGTH);
  return bound === null ? item : bound;
}

function normalizeMessageContent(raw: unknown, field: string, images: ImageReference[], reasoningState: { seen: boolean }): ContentPart[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  const list = narrowArray(raw, field, MAX_BLOCKS_PER_MESSAGE);
  if (isProtocolError(list)) return list;
  const blocks: ContentPart[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const blockField = `${field}[${i}]`;
    if (isRecord(item) && item["type"] === "reasoning") {
      const normalized = normalizeReasoningItem(item, blockField);
      if (isProtocolError(normalized)) return normalized;
      reasoningState.seen = true;
      const summary = Array.isArray(normalized.summary) ? normalized.summary.filter(isRecord) : undefined;
      blocks.push({ type: "reasoning", reasoningText: typeof normalized.content === "string" ? normalized.content : "", nativeType: "reasoning", nativePayload: { ...normalized }, ...(typeof normalized.encrypted_content === "string" ? { reasoningEncryptedContent: normalized.encrypted_content } : {}), ...(summary === undefined ? {} : { reasoningSummary: summary }) } as unknown as ContentPart);
      continue;
    }
    const block = normalizeResponseBlock(item, blockField, images);
    if (isProtocolError(block)) return block;
    blocks.push(block);
  }
  return blocks;
}

function normalizeResponseBlock(raw: unknown, field: string, images: ImageReference[]): ContentPart | ProtocolError {
  const obj = narrowObject(raw, field);
  if (isProtocolError(obj)) return obj;
  const type = obj["type"];
  switch (type) {
    case "input_text":
    case "output_text": {
      const text = narrowString(obj["text"], `${field}.text`, MAX_TEXT_BLOCK_LENGTH);
      if (isProtocolError(text)) return text;
      return { type: "text", text };
    }
    case "input_image": {
      const image = normalizeInputImage(obj["image_url"], `${field}.image_url`, images);
      if (isProtocolError(image)) return image;
      return { type: "image", image };
    }
    case "input_file": {
      const fileData = (obj["file_data"] as unknown) ?? obj["file_url"] ?? obj["file_id"];
      if (typeof fileData === "string") {
        const lower = (fileData.toLowerCase().includes("pdf") ? "pdf" : fileData.toLowerCase().includes("video") ? "video" : "pdf");
        const ref = normalizeResponsesFileReference(fileData, `${field}.file`, images, lower as "pdf" | "video");
        if (isProtocolError(ref)) return ref;
        if (lower === "pdf") return { type: "pdf", pdf: ref as PdfReference };
        return { type: "video", video: ref as VideoReference };
      }
      return { type: "native", nativeType: type, nativePayload: { ...obj }, raw: obj };
    }
    case "function_call": {
      const callId = narrowString(obj["call_id"], `${field}.call_id`, 128);
      if (isProtocolError(callId)) return callId;
      if (callId === "") return protocolError(`${field}.call_id`, "call_id must not be empty");
      const name = narrowString(obj["name"], `${field}.name`, MAX_TOOL_NAME_LENGTH);
      if (isProtocolError(name)) return name;
      if (name.trim() === "") return protocolError(`${field}.name`, "function call name must not be empty");
      const argumentsValue = normalizeToolArguments(obj["arguments"], `${field}.arguments`);
      if (isProtocolError(argumentsValue)) return argumentsValue;
      return { type: "tool_use", toolName: name, toolCallId: callId, toolArguments: argumentsValue };
    }
    case "function_call_output": {
      const callId = narrowString(obj["call_id"], `${field}.call_id`, 128);
      if (isProtocolError(callId)) return callId;
      if (callId === "") return protocolError(`${field}.call_id`, "call_id must not be empty");
      const output = normalizeToolOutput(obj["output"], `${field}.output`);
      if (isProtocolError(output)) return output;
      return { type: "tool_result", text: output, toolCallId: callId };
    }
    case "refusal":
      return { type: "unknown", raw: obj };
    default:
      if (typeof type === "string") return { type: "native", nativeType: type, nativePayload: { ...obj }, raw: obj };
      return protocolError(`${field}.type`, "content block type must be a string");
  }
}

function normalizeFunctionCallItem(obj: Record<string, unknown>, field: string): ContentPart | ProtocolError {
  const callId = narrowString(obj["call_id"], `${field}.call_id`, 128);
  if (isProtocolError(callId)) return callId;
  if (callId === "") return protocolError(`${field}.call_id`, "call_id must not be empty");
  const name = narrowString(obj["name"], `${field}.name`, MAX_TOOL_NAME_LENGTH);
  if (isProtocolError(name)) return name;
  if (name.trim() === "") return protocolError(`${field}.name`, "function call name must not be empty");
  const argumentsValue = normalizeToolArguments(obj["arguments"], `${field}.arguments`);
  if (isProtocolError(argumentsValue)) return argumentsValue;
  return { type: "tool_use", toolName: name, toolCallId: callId, toolArguments: argumentsValue };
}

function normalizeFunctionCallOutputItem(obj: Record<string, unknown>, field: string): ContentPart | ProtocolError {
  const callId = narrowString(obj["call_id"], `${field}.call_id`, 128);
  if (isProtocolError(callId)) return callId;
  if (callId === "") return protocolError(`${field}.call_id`, "call_id must not be empty");
  const output = normalizeToolOutput(obj["output"], `${field}.output`);
  if (isProtocolError(output)) return output;
  return { type: "tool_result", text: output, toolCallId: callId };
}

function normalizeToolArguments(raw: unknown, field: string): string | ProtocolError {
  try {
    return stringifyToolArguments(raw ?? "{}");
  } catch {
    return protocolError(field, `${field}: exceeds ${MAX_TOOL_ARGUMENT_LENGTH} characters`);
  }
}

function normalizeToolOutput(raw: unknown, field: string): string | ProtocolError {
  if (typeof raw === "string") {
    if (raw.length > MAX_TEXT_BLOCK_LENGTH) return protocolError(field, `${field}: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
    return raw;
  }
  try {
    const output = stringifyToolArguments(raw ?? "{}");
    if (output.length > MAX_TEXT_BLOCK_LENGTH) return protocolError(field, `${field}: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
    return output;
  } catch {
    return protocolError(field, `${field}: exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
  }
}

function normalizeInputImage(raw: unknown, field: string, images: ImageReference[]): ImageReference | ProtocolError {
  const url = isRecord(raw) ? raw["url"] : raw;
  const classification = classifyImageReference(url, field);
  if (!classification.ok) return classification.error;
  const bound = pushImageReference(images, classification.reference, field);
  if (bound !== null) return bound;
  return classification.reference;
}

function normalizeResponsesFileReference(raw: unknown, field: string, images: ImageReference[], kind: "pdf" | "video"): PdfReference | VideoReference | ProtocolError {
  const classification = classifyImageReference(raw, field);
  if (!classification.ok) return classification.error;
  const bound = pushImageReference(images, classification.reference as unknown as ImageReference, field);
  if (bound !== null) return bound;
  if (kind === "pdf") return { kind: classification.reference.kind, value: classification.reference.value, mediaType: classification.reference.mediaType ?? "application/pdf" } as PdfReference;
  return { kind: classification.reference.kind, value: classification.reference.value, mediaType: classification.reference.mediaType ?? "video/mp4" } as VideoReference;
}

function normalizeResponsesTools(raw: unknown): NormalizedTool[] | ProtocolError {
  return normalizeToolList(raw, { unwrapFunction: false, schemaField: "parameters", schemaRequired: false, sourceSurface: "openai-responses" });
}

