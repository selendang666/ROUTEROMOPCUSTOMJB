import { describe, expect, test } from "bun:test";
import { buildMessagesPayload, normalizeMessagesRequest } from "../normalize/anthropic.js";
import { normalizeChatRequest } from "../normalize/openai.js";
import { buildChatPayload } from "./request.js";
import type { ProviderRequest, ProxyRequest } from "./request.js";
import { createOpenAIAdapter } from "../upstream/adapter.js";

const limits = {
  maxBodyBytes: 1_000_000,
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
};

function request(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    stream: false,
    responseFormat: { kind: "text" },
    reasoning: "default",
    maxOutputTokens: 128,
    images: [],
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits,
    ...overrides,
  };
}

describe("OpenAI-compatible native hardening", () => {
  test("forwards strict tools and canonical sampling controls", () => {
    const normalized = normalizeChatRequest({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      frequency_penalty: 1.2,
      presence_penalty: -0.5,
      seed: 42,
      user: "opaque-user",
      verbosity: "high",
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" }, strict: true } }],
    }, { signal: new AbortController().signal, limits });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const payload = buildChatPayload(normalized.request);
    expect(payload.frequency_penalty).toBe(1.2);
    expect(payload.presence_penalty).toBe(-0.5);
    expect(payload.seed).toBe(42);
    expect(payload.user).toBe("opaque-user");
    expect(payload.verbosity).toBe("high");
    expect((payload.tools as Array<{ function: { strict?: boolean } }>)[0]?.function.strict).toBe(true);
  });

  test("uses an opt-out stream usage profile and safely applies query/header/rules", async () => {
    const originalFetch = globalThis.fetch;
    let receivedUrl = "";
    let receivedHeaders: Headers | undefined;
    let receivedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      receivedUrl = String(input);
      receivedHeaders = new Headers(init?.headers);
      receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "chatcmpl_1",
        model: "effective-model",
        system_fingerprint: "fp_123",
        service_tier: "priority",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_123" } });
    }) as typeof fetch;
    try {
      const adapter = createOpenAIAdapter({
        id: "compat-test",
        displayName: "Compatibility Test",
        baseUrl: "https://compat.test/v1",
        credentialKind: "api_key",
        compatibility: {
          query: { "api-version": "2026-01-01" },
          headers: { "x-provider-mode": "strict" },
          streamUsage: "never",
          requestRules: [{ kind: "rename-field", from: "max_tokens", to: "max_completion_tokens" }],
          responseMetadata: ["request-id", "system-fingerprint", "service-tier", "model"],
        },
      });
      const result = await adapter.call({
        target: adapter.resolveTarget("test-model", "openai-chat") as ProviderRequest["target"],
        request: request({ stream: true }),
        credential: "secret",
        network: { proxyId: null, url: null, release: async () => {} },
        signal: new AbortController().signal,
      });
      expect(receivedUrl).toBe("https://compat.test/v1/chat/completions?api-version=2026-01-01");
      expect(receivedHeaders?.get("x-provider-mode")).toBe("strict");
      expect(receivedHeaders?.get("authorization")).toBe("Bearer secret");
      expect(receivedBody?.stream_options).toBeUndefined();
      expect(receivedBody?.max_tokens).toBeUndefined();
      expect(receivedBody?.max_completion_tokens).toBe(128);
      expect(result.metadata).toEqual({ requestId: "req_123" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps stream usage conservative for auto profiles", () => {
    const payload = buildChatPayload(request({ stream: true }), { streamUsage: "auto" });
    expect(payload.stream_options).toBeUndefined();
  });

  test("rejects JSON schema for profiles without structured output support", () => {
    expect(() => buildChatPayload(
      request({
        responseFormat: { kind: "json_schema", schema: { name: "answer", schema: { type: "object" } } },
      }),
      { structuredOutputs: { supported: false } },
    )).toThrow("does not support JSON schema");
  });
});

describe("Anthropic native hardening", () => {
  test("preserves metadata, cache TTL, file references, citations, and native options", () => {
    const normalized = normalizeMessagesRequest({
      model: "claude-test",
      max_tokens: 128,
      metadata: { user_id: "opaque-user" },
      speed: "fast",
      inference_geo: "global",
      task_budget: { total: 2048 },
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "cite this", cache_control: { type: "ephemeral", ttl: "1h" }, citations: [{ type: "char_location", cited_text: "cite" }] },
          { type: "image", source: { type: "file", file_id: "file_image" } },
          { type: "document", source: { type: "file", file_id: "file_pdf" }, title: "Reference", context: "important" },
          { type: "document", source: { type: "content", content: [{ type: "text", text: "nested document" }] } },
        ],
      }],
    }, { signal: new AbortController().signal, limits });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const payload = buildMessagesPayload(normalized.request, {
      surfaces: ["anthropic-messages"], streaming: true, reasoning: true, toolCalls: true,
      images: true, pdf: true, video: false, explicitCache: true,
    });
    expect(payload.metadata).toEqual({ user_id: "opaque-user" });
    expect(payload.speed).toBe("fast");
    expect(payload.inference_geo).toBe("global");
    expect(payload.task_budget).toEqual({ type: "tokens", total: 2048 });
    expect(payload.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    const blocks = ((payload.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]?.content) ?? [];
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(blocks[0]?.citations).toEqual([{ type: "char_location", cited_text: "cite" }]);
    expect(blocks[1]?.source).toEqual({ type: "file", file_id: "file_image" });
    expect(blocks[2]?.source).toEqual({ type: "file", file_id: "file_pdf" });
    expect(blocks[2]?.title).toBe("Reference");
    expect(blocks[2]?.context).toBe("important");
    expect(blocks[3]?.source).toEqual({ type: "content", content: [{ type: "text", text: "nested document" }] });
  });
});
