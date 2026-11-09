import type { ProtocolError } from "../errors.js";
import { applicationError, isProtocolError, protocolError } from "../errors.js";
import type { ContentPart, NormalizedMessage, NormalizedTool } from "../types/content.js";
import type { ProxyRequest } from "../types/request.js";
import { boundJsonLength, narrowArray, narrowBoolean, narrowObject, narrowString, MAX_TEXT_BLOCK_LENGTH, MAX_TOOL_COUNT, MAX_TOOL_DESCRIPTION_LENGTH, MAX_TOOL_NAME_LENGTH, MAX_TOOL_SCHEMA_LENGTH } from "../validation.js";

/** Options controlling how a codec's raw tool list is normalized. */
export interface NormalizeToolListOptions {
  /** When true, the tool body is wrapped under a `function` field (OpenAI Chat). */
  readonly unwrapFunction: boolean;
  /** Wire field holding the JSON schema (`parameters` or `input_schema`). */
  readonly schemaField: string;
  /** When true, the schema is required and a missing/non-object value errors. */
  readonly schemaRequired: boolean;
  /** Source declaration surface used to distinguish hosted from provider-native tools. */
  readonly sourceSurface: "openai-chat" | "openai-responses" | "anthropic-messages";
}

/**
 * Shared tool-list normalization for every chat/responses/anthropic codec.
 *
 * The three codecs differ only in tool wrapper shape (`function` unwrap vs
 * direct), the schema field name (`parameters` vs `input_schema`), and whether
 * the schema is required. Claude's server-side tools are preserved as bounded
 * native metadata; target adapters decide whether they can forward or
 * explicitly adapt them.
 */
const ANTHROPIC_WEB_SEARCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: { type: "string", description: "The search query." },
    allowed_domains: { type: "array", items: { type: "string" } },
    blocked_domains: { type: "array", items: { type: "string" } },
  },
  required: ["query"],
  additionalProperties: false,
};

const ANTHROPIC_WEB_FETCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to fetch." },
    allowed_domains: { type: "array", items: { type: "string" } },
    blocked_domains: { type: "array", items: { type: "string" } },
  },
  required: ["url"],
  additionalProperties: false,
};

export const ANTHROPIC_NATIVE_TOOL_TYPES: Record<string, string> = {
  web_search_20250305: "web_search_20250305",
  web_search_20260209: "web_search_20260209",
  web_search_20260318: "web_search_20260318",
  web_fetch_20250910: "web_fetch_20250910",
  web_fetch_20260209: "web_fetch_20260209",
  web_fetch_20260318: "web_fetch_20260318",
  code_execution_20250825: "code_execution_20250825",
  code_execution_20260120: "code_execution_20260120",
  code_execution_20260521: "code_execution_20260521",
  tool_search_tool_regex_20251119: "tool_search_tool_regex_20251119",
  tool_search_tool_bm25_20251119: "tool_search_tool_bm25_20251119",
  tool_search_tool_regex: "tool_search_tool_regex",
  tool_search_tool_bm25: "tool_search_tool_bm25",
  mcp_toolset: "mcp_toolset",
};

const ANTHROPIC_NATIVE_TOOL_NAMES: Record<string, string> = {
  web_search_20250305: "web_search",
  web_search_20260209: "web_search",
  web_search_20260318: "web_search",
  web_fetch_20250910: "web_fetch",
  web_fetch_20260209: "web_fetch",
  web_fetch_20260318: "web_fetch",
  code_execution_20250825: "code_execution",
  code_execution_20260120: "code_execution",
  code_execution_20260521: "code_execution",
  tool_search_tool_regex_20251119: "tool_search_tool_regex",
  tool_search_tool_bm25_20251119: "tool_search_tool_bm25",
  tool_search_tool_regex: "tool_search_tool_regex",
  tool_search_tool_bm25: "tool_search_tool_bm25",
  mcp_toolset: "mcp_toolset",
};

function isAnthropicWebToolType(value: string | undefined): boolean {
  return value?.startsWith("web_search_") === true || value?.startsWith("web_fetch_") === true;
}

export function normalizeToolList(raw: unknown, options: NormalizeToolListOptions): NormalizedTool[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  const list = narrowArray(raw, "tools", MAX_TOOL_COUNT);
  if (isProtocolError(list)) return list;
  const tools: NormalizedTool[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const field = `tools[${i}]`;
    if (item === undefined) continue;
    const obj = narrowObject(item, field);
    if (isProtocolError(obj)) return obj;
    const type = typeof obj["type"] === "string" ? obj["type"] : undefined;
    const isFunction = type === undefined || type === "function";
    const source = options.unwrapFunction && isFunction
      ? narrowObject(obj["function"], `${field}.function`)
      : obj;
    if (isProtocolError(source)) return source;
    if (!isFunction) {
      const nativeType = type;
      const optionsObject = { ...obj };
      delete optionsObject.type;
      const nativeOptionsError = boundJsonLength(optionsObject, field, MAX_TEXT_BLOCK_LENGTH);
      if (nativeOptionsError !== null) return nativeOptionsError;
      if (
        options.sourceSurface === "openai-responses"
        && (nativeType === "web_search" || nativeType === "web_fetch")
      ) {
        tools.push({
          kind: "hosted",
          hostedType: nativeType,
          nativeOptions: optionsObject,
          raw: obj,
        });
      } else if (ANTHROPIC_NATIVE_TOOL_TYPES[nativeType] !== undefined) {
        tools.push({
          kind: "native",
          nativeType,
          nativeOptions: optionsObject,
          raw: obj,
        });
      } else {
        tools.push({
          kind: "opaque",
          nativeType,
          nativeOptions: optionsObject,
          raw: obj,
        });
      }
      continue;
    }
    const nameField = options.unwrapFunction ? `${field}.function.name` : `${field}.name`;
    const name = narrowString(source["name"], nameField, MAX_TOOL_NAME_LENGTH);
    if (isProtocolError(name)) return name;
    if (name.trim() === "") return protocolError(nameField, "tool name must not be empty");
    let description: string | null = null;
    const descriptionRaw = source["description"];
    if (descriptionRaw !== undefined && descriptionRaw !== null) {
      const descriptionField = options.unwrapFunction ? `${field}.function.description` : `${field}.description`;
      const descriptionValue = narrowString(descriptionRaw, descriptionField, MAX_TOOL_DESCRIPTION_LENGTH);
      if (isProtocolError(descriptionValue)) return descriptionValue;
      description = descriptionValue;
    }
    const schemaFieldPath = options.unwrapFunction ? `${field}.function.${options.schemaField}` : `${field}.${options.schemaField}`;
    const schemaRaw = source[options.schemaField];
    let inputSchema: Record<string, unknown>;
    if (schemaRaw === undefined || schemaRaw === null) {
      if (options.schemaRequired) return protocolError(schemaFieldPath, `${schemaFieldPath}: expected an object`);
      inputSchema = {};
    } else {
      const schema = narrowObject(schemaRaw, schemaFieldPath);
      if (isProtocolError(schema)) return schema;
      inputSchema = schema;
    }
    let schemaJsonLength = 0;
    try {
      schemaJsonLength = JSON.stringify(inputSchema)?.length ?? 0;
    } catch {
      return protocolError(`${field}.${options.schemaField}`, `${field}.${options.schemaField}: could not be serialized`);
    }
    if (schemaJsonLength > MAX_TOOL_SCHEMA_LENGTH) {
      return protocolError(`${field}.${options.schemaField}`, `${field}.${options.schemaField}: exceeds ${MAX_TOOL_SCHEMA_LENGTH} characters when serialized`);
    }
    let deferLoading: boolean | undefined;
    if (source["defer_loading"] !== undefined) {
      const value = narrowBoolean(source["defer_loading"], `${field}.defer_loading`);
      if (isProtocolError(value)) return value;
      deferLoading = value;
    }
    let allowedCallers: readonly string[] | undefined;
    if (source["allowed_callers"] !== undefined) {
      const values = narrowArray(source["allowed_callers"], `${field}.allowed_callers`, MAX_TOOL_COUNT);
      if (isProtocolError(values)) return values;
      const normalized: string[] = [];
      for (let j = 0; j < values.length; j++) {
        const value = narrowString(values[j], `${field}.allowed_callers[${j}]`, MAX_TOOL_NAME_LENGTH);
        if (isProtocolError(value)) return value;
        normalized.push(value);
      }
      allowedCallers = normalized;
    }
    let inputExamples: readonly Record<string, unknown>[] | undefined;
    if (source["input_examples"] !== undefined) {
      const values = narrowArray(source["input_examples"], `${field}.input_examples`, 10);
      if (isProtocolError(values)) return values;
      const normalized: Record<string, unknown>[] = [];
      for (let j = 0; j < values.length; j++) {
        const value = narrowObject(values[j], `${field}.input_examples[${j}]`);
        if (isProtocolError(value)) return value;
        normalized.push(value);
      }
      inputExamples = normalized;
    }
    tools.push({
      kind: "function",
      name,
      description,
      inputSchema,
      ...(typeof source["strict"] === "boolean" ? { strict: source["strict"] } : {}),
      raw: obj,
      schemaJsonLength,
      ...(deferLoading !== undefined ? { deferLoading } : {}),
      ...(allowedCallers !== undefined ? { allowedCallers } : {}),
      ...(inputExamples !== undefined ? { inputExamples } : {}),
    });
  }
  return tools;
}

