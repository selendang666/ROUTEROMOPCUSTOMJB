import { describe, expect, test } from "bun:test";
import { normalizeMessagesRequest } from "./normalize/anthropic.js";
import { translateGeminiResponse } from "./upstream/gemini.js";

function limits() {
  return {
    maxBodyBytes: 10_000_000,
    connectTimeoutMs: 30000,
    firstByteTimeoutMs: 60000,
    idleTimeoutMs: 60000,
    totalTimeoutMs: 600000,
  } as any;
}

describe("Anthropic output_config hardening", () => {
  test("rejects malformed output_config (non-object)", () => {
    const result = normalizeMessagesRequest(
      {
        model: "claude-3",
        max_tokens: 100,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        output_config: "bad",
      },
      { signal: new AbortController().signal, limits: limits(), includeWirePayload: true } as any,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toContain("output_config");
  });

  test("rejects unsupported effort value", () => {
    const result = normalizeMessagesRequest(
      {
        model: "claude-3",
        max_tokens: 100,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        output_config: { effort: "banana" },
      },
      { signal: new AbortController().signal, limits: limits(), includeWirePayload: true } as any,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toContain("output_config.effort");
  });

  test("rejects non-string effort", () => {
    const result = normalizeMessagesRequest(
      {
        model: "claude-3",
        max_tokens: 100,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        output_config: { effort: 123 },
      },
      { signal: new AbortController().signal, limits: limits(), includeWirePayload: true } as any,
    );
    expect(result.ok).toBe(false);
  });

  test("accepts valid effort", () => {
    const result = normalizeMessagesRequest(
      {
        model: "claude-3",
        max_tokens: 100,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        output_config: { effort: "high" },
      },
      { signal: new AbortController().signal, limits: limits(), includeWirePayload: true } as any,
    );
    expect(result.ok).toBe(true);
  });
});

describe("Gemini unsupported surface hardening", () => {
  test("rejects images surface instead of falling through to chat", () => {
    const body = { candidates: [{ content: { parts: [{ text: "hi" }] } }] };
    expect(() => translateGeminiResponse(body, "images" as any, "gemini-2.0")).toThrow();
    try {
      translateGeminiResponse(body, "images" as any, "gemini-2.0");
    } catch (e: any) {
      expect(e.kind ?? e.message).toMatch(/capability_unsupported|Gemini does not support/);
    }
  });

  test("still supports text surfaces", () => {
    const body = { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } };
    const chat = translateGeminiResponse(body, "openai-chat", "m");
    expect((chat as any).object).toBe("chat.completion");
    const responses = translateGeminiResponse(body, "openai-responses", "m");
    expect((responses as any).object).toBe("response");
    const anthro = translateGeminiResponse(body, "anthropic-messages", "m");
    expect((anthro as any).type).toBe("message");
  });
});
