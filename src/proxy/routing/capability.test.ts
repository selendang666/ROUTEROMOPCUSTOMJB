import { describe, expect, test } from "bun:test";
import { deriveRequiredCapabilities, hasWebSearchCapability, isWebSearchTool } from "./capability.js";
import type { NormalizedTool } from "../types/content.js";
import type { ProxyRequest } from "../types/request.js";

function makeRequest(): ProxyRequest {
  return {
    model: "gpt-4.1",
    messages: [
      { role: "user", content: [{ type: "image", image: { kind: "url", value: "https://example.com/image.png", mediaType: "image/png" } }] },
    ],
    tools: [{ kind: "hosted", hostedType: "web_search" } as unknown as NormalizedTool],
    stream: false,
    responseFormat: "text",
    reasoning: "enabled",
    maxOutputTokens: null,
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits: { maxBodyBytes: 1024, connectTimeoutMs: 1000, firstByteTimeoutMs: 1000, idleTimeoutMs: 1000, totalTimeoutMs: 1000 },
  } as unknown as ProxyRequest;
}

describe("routing capability helpers", () => {
  test("identifies hosted web-search tools only", () => {
    expect(isWebSearchTool({ kind: "hosted", hostedType: "web_search" } as unknown as NormalizedTool)).toBe(true);
    expect(isWebSearchTool({ kind: "function", name: "web_search", description: null, inputSchema: {} } as unknown as NormalizedTool)).toBe(false);
    expect(isWebSearchTool({ kind: "native", nativeType: "web_search" } as unknown as NormalizedTool)).toBe(false);
  });

  test("derives required capabilities from tools, reasoning, and images", () => {
    const caps = deriveRequiredCapabilities(makeRequest());
    expect(caps).toMatchObject({ tools: true, hostedSearch: true, reasoning: true, image: true, stream: false, sourceSurface: "openai-chat" });
  });

  test("recognizes explicit hosted-search capability flags", () => {
    expect(hasWebSearchCapability({ search: true })).toBe(true);
    expect(hasWebSearchCapability({ websearch: true })).toBe(true);
    expect(hasWebSearchCapability({ surfaces: ["web-search"] })).toBe(true);
    expect(hasWebSearchCapability({ surfaces: ["openai-chat"] })).toBe(false);
    expect(hasWebSearchCapability(null)).toBe(false);
  });
});
