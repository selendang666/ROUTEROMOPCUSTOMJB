import { describe, expect, test } from "bun:test";
import type { ProxyRequestLogEvent } from "../proxy/request/prepare.js";
import { buildContext, levelFor, renderTraceLine } from "./request-log-format.js";

function baseEvent(overrides: Partial<ProxyRequestLogEvent> = {}): ProxyRequestLogEvent {
  return {
    event: "complete",
    requestId: "req-12345678-abcd",
    endpoint: "/v1/chat/completions" as ProxyRequestLogEvent["endpoint"],
    providerId: "anthropic",
    model: "claude-3",
    status: 200,
    errorKind: null,
    durationMs: 123,
    inputTokens: 10,
    cachedTokens: null,
    cacheWriteTokens: null,
    outputTokens: 5,
    messageCount: 2,
    toolCount: 0,
    clientName: "claude-code",
    clientSource: "cli",
    clientIp: "1.2.3.4",
    accountId: "acc-1",
    proxyId: null,
    reasoningTokens: null,
    ...overrides,
  };
}

describe("levelFor", () => {
  test("maps each lifecycle event to its console log level", () => {
    expect(levelFor("failed")).toBe("error");
    expect(levelFor("aborted")).toBe("warn");
    expect(levelFor("switch")).toBe("warn");
    expect(levelFor("complete")).toBe("info");
    expect(levelFor("incoming")).toBe("debug");
  });
});

describe("renderTraceLine", () => {
  test("complete events never contain the client IP", () => {
    const line = renderTraceLine(baseEvent({ event: "complete", clientIp: "9.9.9.9" }));
    expect(line).not.toContain("ip=");
    expect(line).not.toContain("9.9.9.9");
  });

  test("switch events render the from/to/reason arrow token", () => {
    const line = renderTraceLine(
      baseEvent({
        event: "switch",
        switch: {
          scope: "provider",
          fromCandidateId: "a",
          toCandidateId: "b",
          fromAccountId: "acc-1",
          toAccountId: null,
          reason: "provider_rate_limited",
        },
      }),
    );
    expect(line).toContain("switch=a\u2192b(provider_rate_limited)");
  });

  test("reasoning and cache-write tokens render as think= and cachew=", () => {
    const line = renderTraceLine(baseEvent({ reasoningTokens: 42, cacheWriteTokens: 7 }));
    expect(line).toContain("think=42");
    expect(line).toContain("cachew=7");
  });

  test("aborted events force status=499 and err=client_aborted regardless of the underlying failure", () => {
    const line = renderTraceLine(baseEvent({ event: "aborted", status: 0, errorKind: "client_aborted" }));
    expect(line).toContain("status=499");
    expect(line).toContain("err=client_aborted");
  });

  test("skips nullish fields instead of rendering empty tokens", () => {
    const line = renderTraceLine(baseEvent({ accountId: null, proxyId: null, inputTokens: null, outputTokens: null }));
    expect(line).not.toContain("acc=");
    expect(line).not.toContain("proxy=");
  });
});

describe("buildContext", () => {
  test("populates clientIp verbatim from the input event — never masks", () => {
    const context = buildContext(baseEvent({ clientIp: "203.0.113.7" }));
    expect(context.clientIp).toBe("203.0.113.7");
  });

  test("carries every field of the event through unchanged", () => {
    const event = baseEvent({ accountId: "acc-42", proxyId: "proxy-7", reasoningTokens: 11 });
    const context = buildContext(event);
    expect(context.accountId).toBe("acc-42");
    expect(context.proxyId).toBe("proxy-7");
    expect(context.reasoningTokens).toBe(11);
    expect(context.event).toBe("complete");
  });
});
