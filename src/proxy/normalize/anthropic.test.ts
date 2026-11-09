import { describe, expect, test } from "bun:test";
import { buildMessagesPayload, normalizeMessagesRequest, translateAnthropicResponse } from "./anthropic.js";
import type { NormalizeInput } from "../protocol-request.js";
import type { ProxyRequest } from "../types/request.js";
import type { ProviderCaps } from "../types/provider.js";
import { providerQuirkPolicy } from "../policy/profiles.js";

const limits = {
  maxBodyBytes: 1_000_000,
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
};

function input(overrides: Partial<NormalizeInput> = {}): NormalizeInput {
  return { signal: new AbortController().signal, limits, operation: "invoke", ...overrides };
}

function capabilities(overrides: Partial<ProviderCaps> = {}): ProviderCaps {
  return {
    reasoning: true,
    toolCalls: true,
    images: true,
    explicitCache: false,
    streaming: true,
    jsonMode: true,
    ...overrides,
  } as unknown as ProviderCaps;
}

function proxyRequest(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    model: "claude-3-5-sonnet",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    stream: false,
    responseFormat: { kind: "text" },
    reasoning: "default",
    maxOutputTokens: 128,
    images: [],
    sourceSurface: "anthropic-messages",
    signal: new AbortController().signal,
    limits,
    ...overrides,
  };
}

describe("normalizeMessagesRequest", () => {
  test("normalizes minimal valid request", () => {
    const result = normalizeMessagesRequest(
      { model: "claude-3-5-sonnet", max_tokens: 128, messages: [{ role: "user", content: "hello" }] },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.model).toBe("claude-3-5-sonnet");
    expect(result.request.sourceSurface).toBe("anthropic-messages");
    expect(result.request.maxOutputTokens).toBe(128);
  });

  test("rejects missing max_tokens", () => {
    const result = normalizeMessagesRequest({ model: "claude-3-5-sonnet", messages: [{ role: "user", content: "hi" }] }, input());
    expect(result.ok).toBe(false);
  });

  test("normalizes system string into system message", () => {
    const result = normalizeMessagesRequest(
      { model: "claude-3-5-sonnet", max_tokens: 64, messages: [{ role: "user", content: "hi" }], system: "you are helpful" },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.messages.some((m) => m.role === "system")).toBe(true);
  });

  test("normalizes system array blocks", () => {
    const result = normalizeMessagesRequest(
      {
        model: "claude-3-5-sonnet",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        system: [{ type: "text", text: "sys" }],
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.messages[0]?.role).toBe("system");
  });

  test("normalizes text and image blocks", () => {
    const result = normalizeMessagesRequest(
      {
        model: "claude-3-5-sonnet",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
            ],
          },
        ],
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const user = result.request.messages.find((m) => m.role === "user");
    expect(user?.content.some((b) => b.type === "text")).toBe(true);
    expect(user?.content.some((b) => b.type === "image")).toBe(true);
  });

  test("normalizes tool_use blocks", () => {
    const result = normalizeMessagesRequest(
      {
        model: "claude-3-5-sonnet",
        max_tokens: 64,
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }],
          },
        ],
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const assistant = result.request.messages.find((m) => m.role === "assistant");
    expect(assistant?.content.some((b) => b.type === "tool_use")).toBe(true);
  });

  test("normalizes thinking blocks and sets reasoning enabled", () => {
    const result = normalizeMessagesRequest(
      {
        model: "claude-3-5-sonnet",
        max_tokens: 64,
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "hmm", signature: "sig123" }],
          },
        ],
        thinking: { type: "enabled", budget_tokens: 1024 },
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.reasoning).toBe("enabled");
    const assistant = result.request.messages.find((m) => m.role === "assistant");
    expect(assistant?.content.some((b) => b.type === "reasoning")).toBe(true);
  });

  test("rejects unsupported role", () => {
    const result = normalizeMessagesRequest(
      { model: "claude-3-5-sonnet", max_tokens: 64, messages: [{ role: "tool", content: "hi" }] },
      input(),
    );
    expect(result.ok).toBe(false);
  });

  test("normalizes tools with input_schema", () => {
    const result = normalizeMessagesRequest(
      {
        model: "claude-3-5-sonnet",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "search", description: "search", input_schema: { type: "object" } }],
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.tools).toHaveLength(1);
  });

  test("requires tool input_schema", () => {
    const result = normalizeMessagesRequest(
      {
        model: "claude-3-5-sonnet",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "search" }],
      },
      input(),
    );
    expect(result.ok).toBe(false);
  });

  test("normalizes document blocks", () => {
    const result = normalizeMessagesRequest(
      {
        model: "claude-3-5-sonnet",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "pdfdata" } }],
          },
        ],
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const user = result.request.messages.find((m) => m.role === "user");
    expect(user?.content.some((b) => b.type === "pdf")).toBe(true);
  });

  test("aborted signal short-circuits", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = normalizeMessagesRequest(
      { model: "claude-3-5-sonnet", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
      input({ signal: ctrl.signal }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("buildMessagesPayload", () => {
  test("builds minimal wire format", () => {
    const req = proxyRequest();
    const payload = buildMessagesPayload(req, capabilities());
    expect(payload.model).toBe("claude-3-5-sonnet");
    expect(payload.stream).toBe(false);
    expect(Array.isArray(payload.messages)).toBe(true);
  });

  test("maps system messages to system field", () => {
    const req = proxyRequest({
      messages: [
        { role: "system", content: [{ type: "text", text: "be helpful" }] },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    });
    const payload = buildMessagesPayload(req, capabilities());
    expect(payload.system).toBeDefined();
    const msgs = payload.messages as unknown[];
    expect(msgs.every((m) => (m as { role: string }).role !== "system")).toBe(true);
  });

  test("maps tool_use to anthropic tool_use blocks", () => {
    const req = proxyRequest({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", toolCallId: "toolu_1", toolName: "fn", toolArguments: '{"x":1}' }],
        },
      ],
    });
    const payload = buildMessagesPayload(req, capabilities());
    const msgs = payload.messages as Array<{ content: Array<{ type: string }> }>;
    expect(msgs[0]?.content[0]?.type).toBe("tool_use");
  });

  test("throws when responseFormat is not text", () => {
    const req = proxyRequest({ responseFormat: { kind: "json_object" } });
    expect(() => buildMessagesPayload(req, capabilities())).toThrow();
  });

  test("includes thinking when reasoning enabled and supported", () => {
    const req = proxyRequest({ reasoning: "enabled", reasoningConfig: { maxTokens: 512 } });
    const caps = capabilities({ reasoning: true });
    const payload = buildMessagesPayload(req, caps, { modelCapabilities: { reasoning: { supported: true, efforts: [], maxTokens: "supported", summary: true, modes: [] } } as unknown as never });
    expect((payload as Record<string, unknown>).thinking).toBeDefined();
  });

  test("preserves reasoning summary on anthropic normalize", () => {
    const result = normalizeMessagesRequest(
      {
        model: "claude-3-5-sonnet",
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        reasoning: { summary: "detailed" },
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.reasoningConfig?.summary).toBe("detailed");
  });

  test("emits tools array", () => {
    const req = proxyRequest({
      tools: [{ kind: "function", name: "fn", description: "desc", inputSchema: { type: "object" } }],
    });
    const payload = buildMessagesPayload(req, capabilities());
    expect(Array.isArray(payload.tools)).toBe(true);
  });

  test("strips invalid reasoning signatures under Claude quirk policy", () => {
    const req = proxyRequest({
      messages: [
        {
          role: "assistant",
          content: [{ type: "reasoning", reasoningText: "step 1", reasoningSignature: "bad\x01sig" }],
        },
      ],
      reasoning: "enabled",
      reasoningConfig: { maxTokens: 128 },
    });
    const payload = buildMessagesPayload(req, capabilities({ reasoning: true }), {
      quirks: providerQuirkPolicy("claude"),
    });
    const assistant = (payload.messages as Array<{ content: Array<Record<string, unknown>> }>)[0];
    expect(assistant.content[0]).toMatchObject({ type: "thinking", thinking: "step 1" });
    expect(assistant.content[0]).not.toHaveProperty("signature");
  });
});

describe("translateAnthropicResponse", () => {
  test("translates text content to text_delta", () => {
    const doc = translateAnthropicResponse(
      { id: "msg_1", content: [{ type: "text", text: "hello world" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } },
      "claude-3-5-sonnet",
    );
    expect(doc.sourceSurface).toBe("anthropic-messages");
    expect(doc.events.some((e) => e.type === "text_delta" && e.text === "hello world")).toBe(true);
  });

  test("maps stop reasons", () => {
    const cases: Array<[string, string]> = [
      ["max_tokens", "length"],
      ["tool_use", "tool_call"],
      ["end_turn", "completed"],
    ];
    for (const [input, expected] of cases) {
      const doc = translateAnthropicResponse({ id: "msg_1", content: [], stop_reason: input }, "claude-3-5-sonnet");
      const stop = doc.events.find((e) => e.type === "message_stop");
      expect((stop as { reason?: string } | undefined)?.reason).toBe(expected);
    }
  });

  test("translates tool_use blocks", () => {
    const doc = translateAnthropicResponse(
      { id: "msg_1", content: [{ type: "tool_use", id: "toolu_1", name: "fn", input: { x: 1 } }], stop_reason: "tool_use" },
      "claude-3-5-sonnet",
    );
    expect(doc.events.some((e) => e.type === "tool_call_start")).toBe(true);
    expect(doc.events.some((e) => e.type === "tool_call_delta")).toBe(true);
    expect(doc.events.some((e) => e.type === "tool_call_end")).toBe(true);
  });

  test("translates thinking blocks to thinking_delta", () => {
    const doc = translateAnthropicResponse(
      { id: "msg_1", content: [{ type: "thinking", thinking: "reasoning here" }], stop_reason: "end_turn" },
      "claude-3-5-sonnet",
    );
    expect(doc.events.some((e) => e.type === "thinking_delta")).toBe(true);
  });

  test("throws on non-array content", () => {
    expect(() => translateAnthropicResponse({ id: "msg_1", content: "not-array" } as unknown as Record<string, unknown>, "claude-3-5-sonnet")).toThrow();
  });

  test("produces usage event when usage present", () => {
    const doc = translateAnthropicResponse(
      { id: "msg_1", content: [], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 10 } },
      "claude-3-5-sonnet",
    );
    expect(doc.events.some((e) => e.type === "usage")).toBe(true);
  });
});
