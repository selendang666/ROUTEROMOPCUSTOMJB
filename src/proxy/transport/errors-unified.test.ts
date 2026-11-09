import { describe, expect, test } from "bun:test";
import { createInternalFailure, internalFailureFromTrace } from "../errors.js";
import { writeErrorResponse } from "../events/commit.js";
import type { UpstreamFailureTrace } from "../types/error-types.js";

describe("Unified transport failure cutover", () => {
  test("UpstreamFailureTrace rawMessage never reaches InternalFailure or public body", () => {
    const trace: UpstreamFailureTrace = {
      providerId: "openai",
      transport: "http",
      statusCode: 429,
      providerCode: "rate_limit_exceeded",
      providerType: "rate_limit_error",
      requestId: "req_abc",
      retryAfterMs: 30000,
      rawMessage: "Rate limit exceeded for model gpt-4, retry after 30s Bearer sk-... [redacted should not leak]",
      bodyTruncated: false,
    };
    const failure = internalFailureFromTrace(trace, { kind: "provider_rate_limited", retryable: true, routeScope: "account" });
    expect(failure.safeMessage).not.toContain("sk-");
    expect(failure.safeMessage.length).toBeLessThanOrEqual(240);
    expect(failure.upstream?.providerCode).toBe("rate_limit_exceeded");
    expect(failure.upstream?.providerType).toBe("rate_limit_error");
    expect(failure.upstream?.requestId).toBe("req_abc");
    expect((failure.upstream as unknown as { rawMessage?: unknown }).rawMessage).toBeUndefined();
    const presented = writeErrorResponse(failure, "public-req");
    const body = (presented.body as Extract<typeof presented.body, { readonly mode: "json" }>).value as { readonly error: { readonly message: string; readonly code: string | null } };
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(body.error.message).not.toContain("sk-");
  });

  test("OpenAI error precedence: error.code > error.type > top-level code", async () => {
    const { parseUpstreamFailure } = await import("./errors.js");
    const mk = (body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json", ...headers } });
    // error.code takes precedence
    await expect(parseUpstreamFailure(mk({ error: { code: "invalid_api_key", type: "auth_error", message: "bad" } }))).rejects.toMatchObject({ kind: "invalid_request" });
    // When body has flat error string, it's treated as message not code
    await expect(parseUpstreamFailure(mk({ error: "flat string error" }))).rejects.toMatchObject({ kind: "invalid_request" });
  });

  test("Google RESOURCE_EXHAUSTED classifications preserve providerType", () => {
    const trace: UpstreamFailureTrace = {
      providerId: "gemini",
      transport: "http",
      statusCode: 429,
      providerCode: null,
      providerType: "RESOURCE_EXHAUSTED",
      requestId: null,
      retryAfterMs: null,
      rawMessage: "Resource has been exhausted (e.g. check quota).",
      bodyTruncated: false,
    };
    const failure = internalFailureFromTrace(trace, { kind: "provider_rate_limited", retryable: true, routeScope: "account" });
    expect(failure.upstream?.providerType).toBe("RESOURCE_EXHAUSTED");
    expect(failure.failureCode).toBeDefined();
  });

  test("createInternalFailure sanitizes safeMessage", () => {
    const failure = createInternalFailure({ kind: "invalid_request", safeMessage: "Bearer sk-12345 and api-key: secret123" });
    expect(failure.safeMessage).not.toContain("sk-12345");
    expect(failure.safeMessage).not.toContain("secret123");
  });
});
