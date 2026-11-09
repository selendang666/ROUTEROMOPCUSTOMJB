import { describe, expect, test } from "bun:test";
import { decideNativePassthrough, isNativePassthroughEligible, preserveWirePayload } from "./passthrough.js";
import type { ProxyRequest } from "../types/request.js";

function makeRequest(): ProxyRequest {
  return {
    model: "target-model",
    messages: [],
    tools: [],
    stream: true,
    responseFormat: "text",
    reasoning: "disabled",
    maxOutputTokens: null,
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits: { maxBodyBytes: 1_048_576, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, totalTimeoutMs: 1_000 },
    cacheKey: "cache-1",
    nativeMetadata: { quirks: { requiredHeaders: { "x-required": "1" }, droppedFields: ["remove_me"] } },
  } as unknown as ProxyRequest;
}

describe("native passthrough", () => {
  test("checks passthrough eligibility only on provider and surface gates", () => {
    expect(isNativePassthroughEligible({ client: { passthrough: "auto", format: "openai-chat" }, providerAllowsNative: true, source: "openai-chat", target: "openai-chat" })).toBe(true);
    expect(isNativePassthroughEligible({ client: { passthrough: "never", format: "openai-chat" }, providerAllowsNative: true, source: "openai-chat", target: "openai-chat" })).toBe(false);
    expect(isNativePassthroughEligible({ client: { passthrough: "auto", format: "openai-chat" }, providerAllowsNative: true, source: "openai-chat", target: "anthropic-messages" })).toBe(false);
    expect(isNativePassthroughEligible({ client: { passthrough: "auto", format: "openai-chat" }, providerAllowsNative: false, source: "openai-chat", target: "openai-chat" })).toBe(false);
  });

  test("chooses canonical transport whenever a guard fails", () => {
    const base = {
      client: { passthrough: "auto", format: "openai-chat" },
      request: makeRequest(),
      target: { surface: "openai-chat" as const },
      providerPolicy: { nativePassthrough: true },
      semanticChanged: false,
      globallyDisabled: false,
    };
    expect(decideNativePassthrough({ ...base, globallyDisabled: true }).decision).toBe("canonical");
    expect(decideNativePassthrough({ ...base, semanticChanged: true }).decision).toBe("canonical");
    expect(decideNativePassthrough({ ...base, providerPolicy: { nativePassthrough: false } }).decision).toBe("canonical");
    expect(decideNativePassthrough({ ...base, client: { passthrough: "never", format: "openai-chat" } }).decision).toBe("canonical");
    expect(decideNativePassthrough(base).decision).toBe("native");
  });

  test("preserves only canonical wire fields and strips sensitive headers", () => {
    const request = makeRequest();
    const result = preserveWirePayload(
      {
        model: "client-model",
        stream: false,
        prompt_cache_key: "client-cache",
        headers: {
          Authorization: "Bearer secret",
          Host: "api.example.com",
          "X-Forwarded-For": "203.0.113.5",
          Cookie: "session=secret",
          "X-Keep": "yes",
        },
        keep: "ok",
        remove_me: true,
      },
      request,
      "openai-chat",
      ["keep"],
    );

    expect(result).toMatchObject({ model: "target-model", stream: true, prompt_cache_key: "cache-1", keep: "ok" });
    expect(result).not.toHaveProperty("remove_me");
    expect(result).toHaveProperty("headers");
    expect(result.headers).toEqual({ "x-keep": "yes", "x-required": "1" });
  });
});
