import { describe, expect, test } from "bun:test";
import { ANTHROPIC_NATIVE_TOOL_TYPES, normalizeToolList } from "./tools.js";
import { repairToolCallRequest } from "../events/repair.js";
import type { ProxyRequest } from "../types/request.js";

const limits = {
  maxBodyBytes: 1_000_000,
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
};

function proxyRequest(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    model: "test-model",
    messages: [],
    tools: [],
    stream: false,
    responseFormat: { kind: "text" },
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits,
    ...overrides,
  };
}

describe("normalizeToolList", () => {
  test("returns empty for undefined", () => {
    const result = normalizeToolList(undefined, { unwrapFunction: true, schemaField: "parameters", schemaRequired: false, sourceSurface: "openai-chat" });
    expect(Array.isArray(result) && result.length === 0).toBe(true);
  });

  test("classifies function tools (openai-chat)", () => {
    const result = normalizeToolList(
      [{ type: "function", function: { name: "my_func", description: "desc", parameters: { type: "object" } } }],
      { unwrapFunction: true, schemaField: "parameters", schemaRequired: false, sourceSurface: "openai-chat" },
    );
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0]?.kind).toBe("function");
      if (result[0]?.kind === "function") expect(result[0].name).toBe("my_func");
    }
  });

  test("classifies hosted web_search on openai-responses", () => {
    const result = normalizeToolList(
      [{ type: "web_search", query: "hello" }],
      { unwrapFunction: false, schemaField: "parameters", schemaRequired: false, sourceSurface: "openai-responses" },
    );
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0]?.kind).toBe("hosted");
      if (result[0]?.kind === "hosted") expect(result[0].hostedType).toBe("web_search");
    }
  });

  test("classifies native tools (anthropic)", () => {
    const nativeType = Object.keys(ANTHROPIC_NATIVE_TOOL_TYPES)[0] ?? "web_search_20250305";
    const result = normalizeToolList(
      [{ type: nativeType, query: "test" }],
      { unwrapFunction: false, schemaField: "input_schema", schemaRequired: true, sourceSurface: "anthropic-messages" },
    );
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0]?.kind).toBe("native");
    }
  });

  test("classifies opaque tools for unknown native type", () => {
    const result = normalizeToolList(
      [{ type: "unknown_tool_xyz", foo: "bar" }],
      { unwrapFunction: false, schemaField: "input_schema", schemaRequired: true, sourceSurface: "anthropic-messages" },
    );
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0]?.kind).toBe("opaque");
    }
  });

  test("rejects empty function name", () => {
    const result = normalizeToolList(
      [{ type: "function", function: { name: "", parameters: {} } }],
      { unwrapFunction: true, schemaField: "parameters", schemaRequired: false, sourceSurface: "openai-chat" },
    );
    expect(result).toHaveProperty("kind");
    // protocol error has kind field
    const err = result as unknown as { kind: string };
    expect(err.kind).toBeDefined();
  });

  test("rejects missing schema when required", () => {
    const result = normalizeToolList(
      [{ name: "fn", description: "d" }],
      { unwrapFunction: false, schemaField: "input_schema", schemaRequired: true, sourceSurface: "anthropic-messages" },
    );
    expect(result).toHaveProperty("kind");
  });

  test("allows missing schema when not required", () => {
    const result = normalizeToolList(
      [{ type: "function", function: { name: "fn", parameters: undefined } }],
      { unwrapFunction: true, schemaField: "parameters", schemaRequired: false, sourceSurface: "openai-chat" },
    );
    expect(Array.isArray(result)).toBe(true);
  });

  test("preserves defer_loading and allowed_callers", () => {
    const result = normalizeToolList(
      [
        {
          type: "function",
          function: {
            name: "fn",
            parameters: { type: "object" },
            defer_loading: true,
            allowed_callers: ["a"],
          },
        },
      ],
      { unwrapFunction: true, schemaField: "parameters", schemaRequired: false, sourceSurface: "openai-chat" },
    );
    if (Array.isArray(result) && result[0]?.kind === "function") {
      expect(result[0].deferLoading).toBe(true);
      expect(result[0].allowedCallers).toEqual(["a"]);
    }
  });

  test("rejects oversized schema", () => {
    const bigSchema = { type: "object", properties: { x: { type: "string", description: "a".repeat(70000) } } };
    const result = normalizeToolList(
      [{ type: "function", function: { name: "fn", parameters: bigSchema } }],
      { unwrapFunction: true, schemaField: "parameters", schemaRequired: false, sourceSurface: "openai-chat" },
    );
    expect(result).toHaveProperty("kind");
  });
});

describe("repairToolCallRequest", () => {
  test("generates missing tool_call ids", () => {
    const req = proxyRequest({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", toolCallId: "", toolName: "fn", toolArguments: "{}" }] },
      ],
    });
    const result = repairToolCallRequest(req);
    const repairedId = result.request.messages[0]?.content[0];
    if (repairedId && "toolCallId" in repairedId) {
      expect((repairedId as { toolCallId: string }).toolCallId.length).toBeGreaterThan(0);
    }
  });

  test("marks orphan tool_result without matching call", () => {
    const req = proxyRequest({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", toolCallId: "call_1", toolName: "fn", toolArguments: "{}" }] },
        { role: "tool", content: [{ type: "tool_result", toolCallId: "orphan", text: "result" }] },
      ],
    });
    const result = repairToolCallRequest(req);
    // orphan is preserved but reported as orphan-result change
    expect(result.changes.some((c) => c.kind === "orphan-result")).toBe(true);
    const hasOrphan = result.request.messages.some((m) => m.content.some((b) => b.type === "tool_result" && (b as { toolCallId: string }).toolCallId === "orphan"));
    expect(hasOrphan).toBe(true);
  });

  test("preserves matched tool call and result", () => {
    const req = proxyRequest({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", toolCallId: "call_1", toolName: "fn", toolArguments: "{}" }] },
        { role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", text: "ok" }] },
      ],
    });
    const result = repairToolCallRequest(req);
    expect(result.request.messages).toHaveLength(2);
  });

  test("handles duplicate tool_call ids", () => {
    const req = proxyRequest({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", toolCallId: "dup", toolName: "fn", toolArguments: "{}" }] },
        { role: "assistant", content: [{ type: "tool_use", toolCallId: "dup", toolName: "fn2", toolArguments: "{}" }] },
      ],
    });
    const result = repairToolCallRequest(req);
    // second duplicate should be deduplicated or renamed
    expect(result.changes.length).toBeGreaterThan(0);
  });

  test("drops malformed tool_use with empty name", () => {
    const req = proxyRequest({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", toolCallId: "call_1", toolName: "", toolArguments: "{}" }] },
        { role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", text: "x" }] },
      ],
    });
    const result = repairToolCallRequest(req);
    const hasEmpty = result.request.messages.some((m) => m.content.some((b) => b.type === "tool_use" && (b as { toolName: string }).toolName === ""));
    expect(hasEmpty).toBe(false);
  });

  test("idempotent on clean request", () => {
    const req = proxyRequest({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", toolCallId: "call_1", toolName: "fn", toolArguments: '{"x":1}' }] },
        { role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", text: "ok" }] },
      ],
    });
    const first = repairToolCallRequest(req);
    const second = repairToolCallRequest(first.request);
    expect(second.changes.length).toBe(0);
  });
});
