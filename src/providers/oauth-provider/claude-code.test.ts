import { expect, test } from "bun:test";
import { AnthropicOAuthAdapter } from "./claude-code.js";
import type { ProviderRequest, ProxyRequest } from "../../proxy/types/request.js";

const limits = {
  maxBodyBytes: 1_000_000,
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
};

function request(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    model: "claude-opus-4-6-thinking",
    messages: [{ role: "user", content: [{ type: "text", text: "hello", cacheControl: { type: "ephemeral", ttl: "1h" } }] }],
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "enabled",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "anthropic-messages",
    signal: new AbortController().signal,
    limits,
    ...overrides,
  };
}

test("Claude Code emits conditional thinking and extended-cache betas only when needed", async () => {
  const originalFetch = globalThis.fetch;
  let betaHeader = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    betaHeader = new Headers(init?.headers).get("anthropic-beta") ?? "";
    return Response.json({ id: "msg_1", content: [], usage: {} });
  }) as typeof fetch;
  try {
    const adapter = new AnthropicOAuthAdapter();
    const target = adapter.resolveTarget("claude-opus-4-6-thinking", "anthropic-messages") as ProviderRequest["target"];
    await adapter.call({
      target,
      request: request(),
      credential: "oauth-token",
      network: { proxyId: null, url: null, release: async () => {} },
      signal: new AbortController().signal,
      headers: new Headers({ "anthropic-beta": "untrusted-beta" }),
    });
    expect(betaHeader).toContain("interleaved-thinking-2025-05-14");
    expect(betaHeader).toContain("extended-cache-ttl-2025-04-11");
    expect(betaHeader).not.toContain("untrusted-beta");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
