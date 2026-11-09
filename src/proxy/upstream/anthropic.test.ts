import { describe, expect, test } from "bun:test";
import { dispatchAnthropic, transformAnthropicMessagesStream } from "./anthropic.js";
import { UpstreamError } from "../transport/errors.js";
import type { ProviderCaps } from "../types/provider.js";
import type { ProviderRequest } from "../types/request.js";

function makeRequest(stream: boolean): ProviderRequest {
  return {
    target: { upstreamModelId: "claude-3-5-sonnet-20241022" },
    request: {
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      tools: [],
      stream,
      responseFormat: "text",
      reasoning: "disabled",
      maxOutputTokens: null,
      sourceSurface: "anthropic-messages",
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 1_048_576, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, totalTimeoutMs: 1_000 },
    },
    headers: {},
    network: { url: null },
    signal: new AbortController().signal,
    capture: undefined,
  } as unknown as ProviderRequest;
}

describe("Anthropic upstream adapter", () => {
  test("maps SSE events into stream lifecycle events", () => {
    const map = transformAnthropicMessagesStream("claude", (name) => `tool:${name}`);
    expect(
      map({
        event: "message_start",
        data: JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } }),
      }),
    ).toEqual({ type: "message_start", id: "msg_1" });
    expect(
      map({
        event: "content_block_start",
        data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_1", name: "search" } }),
      }),
    ).toEqual({ type: "tool_call_start", callId: "tool_1", name: "tool:search" });
    expect(
      map({
        event: "content_block_delta",
        data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":"cats"}' } }),
      }),
    ).toEqual({ type: "tool_call_delta", callId: "tool_1", delta: '{"q":"cats"}' });
    expect(map({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) })).toEqual({ type: "tool_call_end", callId: "tool_1" });
    expect(
      map({
        event: "message_delta",
        data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 3 } }),
      }),
    ).toEqual({
      type: "usage",
      usage: {
        promptTokens: 10,
        completionTokens: 3,
        cachedTokens: 2,
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 13,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        source: "provider",
      },
    });
    expect(map({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) })).toEqual({ type: "message_stop", reason: "length" });
  });

  test("throws mapped upstream errors from Anthropic error events", () => {
    const map = transformAnthropicMessagesStream("claude");
    let failure: unknown;
    try {
      map({
        event: "error",
        data: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      kind: "provider_rate_limited",
      upstream: { providerId: "claude", providerCode: "rate_limit_error" },
    });
  });

  test("dispatches non-stream responses through JSON parsing", async () => {
    const request = makeRequest(false);
    const originalFetch = globalThis.fetch;
    const mockFetch = Object.assign(
      async () =>
        new Response(JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "hello" }], usage: { input_tokens: 7, output_tokens: 3 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      { preconnect: originalFetch.preconnect },
    );
    globalThis.fetch = mockFetch as typeof fetch;

    try {
      const result = await dispatchAnthropic(request, "https://api.anthropic.com", {}, {} as unknown as ProviderCaps, undefined);
      expect(result).toEqual({
        mode: "non_stream",
        body: { id: "msg_1", content: [{ type: "text", text: "hello" }], usage: { input_tokens: 7, output_tokens: 3 } },
        usage: {
          promptTokens: 7,
          completionTokens: 3,
          cachedTokens: 0,
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          source: "provider",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
