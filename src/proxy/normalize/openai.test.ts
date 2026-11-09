import { describe, expect, test } from "bun:test";
import { normalizeChatRequest, normalizeResponsesRequest, parseReasoningConfig } from "./openai.js";
import type { NormalizeInput } from "../protocol-request.js";

const limits = {
  maxBodyBytes: 1_000_000,
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
};

function input(overrides: Partial<NormalizeInput> = {}): NormalizeInput {
  return {
    signal: new AbortController().signal,
    limits,
    operation: "invoke",
    ...overrides,
  };
}

describe("normalizeChatRequest", () => {
  test("normalizes minimal valid chat request", () => {
    const result = normalizeChatRequest(
      { model: "gpt-4", messages: [{ role: "user", content: "hello" }] },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.model).toBe("gpt-4");
    expect(result.request.sourceSurface).toBe("openai-chat");
    expect(result.request.messages).toHaveLength(1);
    expect(result.request.messages[0]?.role).toBe("user");
    expect(result.request.stream).toBe(false);
  });

  test("normalizes tools with function wrapper", () => {
    const result = normalizeChatRequest(
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "get weather", parameters: { type: "object", properties: {} } },
          },
        ],
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.tools).toHaveLength(1);
    expect(result.request.tools[0]?.kind).toBe("function");
    if (result.request.tools[0]?.kind === "function") {
      expect(result.request.tools[0].name).toBe("get_weather");
    }
  });

  test("rejects empty tool name", () => {
    const result = normalizeChatRequest(
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "  ", parameters: {} } }],
      },
      input(),
    );
    expect(result.ok).toBe(false);
  });

  test("normalizes reasoning effort via reasoning object", () => {
    const result = normalizeChatRequest(
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "hi" }],
        reasoning: { enabled: true, effort: "high" },
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.reasoning).toBe("enabled");
    expect(result.request.reasoningConfig?.effort).toBe("high");
  });

  test("normalizes reasoning_effort top-level alias", () => {
    const result = normalizeChatRequest(
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "low",
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.reasoning).toBe("enabled");
    expect(result.request.reasoningConfig?.effort).toBe("low");
  });

  test("rejects reasoning with unsupported mode on chat surface", () => {
    const result = normalizeChatRequest(
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "hi" }],
        reasoning: { mode: "standard" },
      },
      input(),
    );
    expect(result.ok).toBe(false);
  });

  test("normalizes sampling controls", () => {
    const result = normalizeChatRequest(
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.7,
        top_p: 0.9,
        seed: 42,
        stop: ["STOP"],
        parallel_tool_calls: false,
        tool_choice: "auto",
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.temperature).toBe(0.7);
    expect(result.request.topP).toBe(0.9);
    expect(result.request.seed).toBe(42);
    expect(result.request.stop).toEqual(["STOP"]);
    expect(result.request.parallelToolCalls).toBe(false);
    expect(result.request.toolChoice).toEqual({ kind: "auto" });
  });

  test("rejects out-of-range temperature", () => {
    const result = normalizeChatRequest(
      { model: "gpt-4", messages: [{ role: "user", content: "hi" }], temperature: 99 },
      input(),
    );
    expect(result.ok).toBe(false);
  });

  test("normalizes tool_choice function", () => {
    const result = normalizeChatRequest(
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: { type: "function", function: { name: "get_weather" } },
        tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.toolChoice).toEqual({ kind: "function", name: "get_weather" });
  });

  test("accepts stop as string and normalizes to array", () => {
    const result = normalizeChatRequest(
      { model: "gpt-4", messages: [{ role: "user", content: "hi" }], stop: "STOP" },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.stop).toEqual(["STOP"]);
  });

  test("rejects empty messages model", () => {
    const result = normalizeChatRequest({ model: "", messages: [{ role: "user", content: "hi" }] }, input());
    expect(result.ok).toBe(false);
  });

  test("handles empty messages array", () => {
    const result = normalizeChatRequest({ model: "gpt-4", messages: [] }, input());
    // empty array is allowed – normalization yields no messages
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.messages).toHaveLength(0);
  });

  test("rejects oversized text content", () => {
    const huge = "a".repeat(600_000);
    const result = normalizeChatRequest({ model: "gpt-4", messages: [{ role: "user", content: huge }] }, input());
    expect(result.ok).toBe(false);
  });

  test("normalizes assistant tool_calls and reasoning_content", () => {
    const result = normalizeChatRequest(
      {
        model: "gpt-4",
        messages: [
          {
            role: "assistant",
            content: "thought",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "fn", arguments: '{"x":1}' } }],
            reasoning_content: "internal reasoning",
          },
        ],
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const msg = result.request.messages[0];
    expect(msg?.content.some((b) => b.type === "tool_use")).toBe(true);
    expect(msg?.content.some((b) => b.type === "reasoning")).toBe(true);
    expect(result.request.reasoning).toBe("enabled");
  });
  test("preserves Gemini thought signatures from OpenAI tool calls", () => {
    const result = normalizeChatRequest(
      {
        model: "gemini-3.7-flash",
        messages: [
          {
            role: "assistant",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "todo", arguments: "{}" },
              extra_content: { google: { thought_signature: "sig-1" } },
            }],
          },
        ],
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.messages[0]?.content[0]).toMatchObject({ type: "tool_use", reasoningSignature: "sig-1" });
  });


  test("aborted signal short-circuits", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = normalizeChatRequest({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }, input({ signal: ctrl.signal }));
    expect(result.ok).toBe(false);
  });

  test("includeWirePayload preserves root", () => {
    const result = normalizeChatRequest({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }, input({ includeWirePayload: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.wirePayload).toBeDefined();
  });
});

describe("normalizeResponsesRequest", () => {
  test("normalizes minimal responses request with string input", () => {
    const result = normalizeResponsesRequest({ model: "gpt-4", input: "hello" }, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.sourceSurface).toBe("openai-responses");
    expect(result.request.messages.length).toBeGreaterThan(0);
  });

  test("normalizes instructions into system message", () => {
    const result = normalizeResponsesRequest({ model: "gpt-4", input: "hi", instructions: "be helpful" }, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.messages[0]?.role).toBe("system");
  });

  test("normalizes function_call items into assistant tool_use", () => {
    const result = normalizeResponsesRequest(
      {
        model: "gpt-4",
        input: [{ type: "function_call", call_id: "call_1", name: "fn", arguments: '{"a":1}' }],
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hasToolUse = result.request.messages.some((m) => m.content.some((b) => b.type === "tool_use"));
    expect(hasToolUse).toBe(true);
  });

  test("normalizes function_call_output into tool result", () => {
    const result = normalizeResponsesRequest(
      {
        model: "gpt-4",
        input: [{ type: "function_call_output", call_id: "call_1", output: "result" }],
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hasToolResult = result.request.messages.some((m) => m.content.some((b) => b.type === "tool_result"));
    expect(hasToolResult).toBe(true);
  });

  test("rejects unsupported input item type", () => {
    const result = normalizeResponsesRequest({ model: "gpt-4", input: [{ type: "unknown_foo" }] }, input());
    expect(result.ok).toBe(false);
  });

  test("normalizes reasoning config", () => {
    const result = normalizeResponsesRequest({ model: "gpt-4", input: "hi", reasoning: { effort: "high", summary: "concise" } }, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.reasoningConfig?.effort).toBe("high");
  });

  test("normalizes include array", () => {
    const result = normalizeResponsesRequest({ model: "gpt-4", input: "hi", include: ["reasoning.encrypted_content"] }, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.include).toContain("reasoning.encrypted_content");
  });

  test("rejects empty model", () => {
    const result = normalizeResponsesRequest({ model: "", input: "hi" }, input());
    expect(result.ok).toBe(false);
  });

  test("handles oversized instructions", () => {
    const huge = "a".repeat(600_000);
    const result = normalizeResponsesRequest({ model: "gpt-4", input: "hi", instructions: huge }, input());
    expect(result.ok).toBe(false);
  });
});

describe("parseReasoningConfig", () => {
  test("parses effort and summary", () => {
    const res = parseReasoningConfig({ effort: "high", summary: "detailed" }, "reasoning", undefined);
    expect(res).not.toBeNull();
    if (res !== null && typeof res === "object" && "flag" in res) {
      expect((res as { flag: string }).flag).toBe("enabled");
      expect((res as { config?: { effort?: string } }).config?.effort).toBe("high");
    }
  });

  test("rejects unsupported summary", () => {
    const res = parseReasoningConfig({ summary: "verbose" }, "reasoning", undefined);
    expect(res).toHaveProperty("kind");
  });

  test("disabled flag when enabled is false", () => {
    const res = parseReasoningConfig({ enabled: false }, "reasoning", false);
    if (res !== null && typeof res === "object" && "flag" in res) {
      expect((res as { flag: string }).flag).toBe("disabled");
    }
  });
});
