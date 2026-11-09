import { describe, expect, test } from "bun:test";
import {
  buildCachePlan,
  findCacheBreakpoint,
  looksStableText,
  markCacheSections,
  resolvePromptCacheKey,
  shouldBuildCachePlan,
  supportsOpenAIPromptBreakpoints,
} from "./cache.js";
import type { CachePlan } from "./cache.js";
import type { ProxyRequest } from "../types/request.js";

function makeRequest(lastUserText = "2024-08-15T12:30:00Z", systemText = "You are a careful assistant." ): ProxyRequest {
  return {
    model: "gpt-4.1",
    messages: [
      { role: "system", content: [{ type: "text", text: systemText }] },
      { role: "user", content: [{ type: "text", text: "Initial stable context." }] },
        { role: "assistant", content: [{ type: "text", text: "Earlier answer.", cacheControl: "ephemeral" }] },
      { role: "user", content: [{ type: "text", text: lastUserText }] },
    ],
    tools: [
      {
        kind: "function",
        name: "lookup_profile",
        description: "Find a profile by name.",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
    ],
    stream: false,
    responseFormat: "text",
    reasoning: "enabled",
    maxOutputTokens: null,
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits: { maxBodyBytes: 1_048_576, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, totalTimeoutMs: 1_000 },
    cacheKey: "fallback-cache-key",
  } as unknown as ProxyRequest;
}

describe("cache planning", () => {
  test("gates plan construction on message count and tools", () => {
    const tiny = { ...makeRequest(), messages: makeRequest().messages.slice(0, 3), tools: [] } as ProxyRequest;
    expect(shouldBuildCachePlan(tiny)).toBe(false);
    expect(shouldBuildCachePlan(makeRequest())).toBe(true);
    expect(shouldBuildCachePlan({ ...tiny, tools: makeRequest().tools } as ProxyRequest)).toBe(true);
  });

  test("classifies cache sections and stable text", () => {
    const sections = markCacheSections(makeRequest());
    expect(looksStableText("fixed prefix" )).toBe(true);
    expect(looksStableText("2024-08-15T12:30:00Z")).toBe(false);
    expect(sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "system", stable: true }),
        expect.objectContaining({ kind: "static_context", stable: true }),
        expect.objectContaining({ kind: "stable_history", stable: true }),
        expect.objectContaining({ kind: "stable_history", stable: false }),
        expect.objectContaining({ kind: "tools", stable: true, messageIndex: null, blockIndex: null }),
      ]),
    );
  });

  test("builds stable fingerprints that ignore later dynamic text", () => {
    const baseline = buildCachePlan(makeRequest());
    const changedTail = buildCachePlan(makeRequest("2024-08-15T13:45:00Z"));
    const changedPrefix = buildCachePlan(makeRequest("2024-08-15T12:30:00Z", "You are a different assistant."));
    expect(baseline.hasStablePrefix).toBe(true);
    expect(baseline.toolsStable).toBe(true);
    expect(baseline.prefixFingerprint).toBe(changedTail.prefixFingerprint);
    expect(baseline.prefixFingerprint).not.toBe(changedPrefix.prefixFingerprint);
  });

  test("resolves prompt cache keys from stable prefix and identity", () => {
    const plan = buildCachePlan(makeRequest());
    const identity = { sessionId: "session-123", conversationId: "conversation-456", metadataUserId: "user-789" };
    expect(resolvePromptCacheKey(makeRequest(), plan, identity)).toBe(resolvePromptCacheKey(makeRequest(), plan, identity));
    expect(resolvePromptCacheKey(makeRequest(), plan, { ...identity, sessionId: "session-124" })).not.toBe(
      resolvePromptCacheKey(makeRequest(), plan, identity),
    );
    const fallbackPlan = { sections: [], toolsStable: false, hasStablePrefix: false, prefixEndMessageIndex: null, prefixEndBlockIndex: null, prefixFingerprint: null } as CachePlan;
    expect(resolvePromptCacheKey(makeRequest(), fallbackPlan)).toBe("fallback-cache-key");
  });

  test("finds the last stable input block and supports GPT-5.6+ breakpoints", () => {
    const position = findCacheBreakpoint(makeRequest());
    expect(position).toEqual({ messageIndex: 1, blockIndex: 0 });
    expect(supportsOpenAIPromptBreakpoints("gpt-5.6")).toBe(true);
    expect(supportsOpenAIPromptBreakpoints("gpt-5.5")).toBe(false);
  });
});
