import { describe, expect, test } from "bun:test";
import {
  abortedError,
  applicationError,
  boundedRetryAt,
  createInternalFailure,
  internalFailureFromUnknown,
  isInternalFailure,
  isProtocolError,
  protocolError,
  ProtocolCodecError,
} from "./errors.js";
import { sanitizeMessage } from "./types/error-types.js";

describe("createInternalFailure", () => {
  test("defaults statusCode, retryable, source, safeMessage", () => {
    const failure = createInternalFailure({ kind: "internal_error" });
    expect(failure.kind).toBe("internal_error");
    expect(failure.statusCode).toBeNull();
    expect(failure.retryable).toBe(false);
    expect(failure.source).toBe("internal");
    expect(failure.safeMessage).toBe("Internal server error.");
    expect(failure.retryAt).toBeNull();
    expect(failure.failureCode).toBeNull();
    expect(failure.upstream).toBeNull();
  });

  test("preserves explicit statusCode and retryable", () => {
    const failure = createInternalFailure({ kind: "provider_unavailable", statusCode: 502, retryable: true });
    expect(failure.statusCode).toBe(502);
    expect(failure.retryable).toBe(true);
    expect(failure.source).toBe("upstream");
  });

  test("deriveErrorSource: client kinds", () => {
    expect(createInternalFailure({ kind: "invalid_request" }).source).toBe("client");
    expect(createInternalFailure({ kind: "client_aborted" }).source).toBe("client");
  });

  test("deriveErrorSource: internal kinds", () => {
    expect(createInternalFailure({ kind: "credential_unavailable" }).source).toBe("internal");
    expect(createInternalFailure({ kind: "model_not_found" }).source).toBe("internal");
  });

  test("sanitizes safeMessage and truncates over 240 chars", () => {
    const long = "x".repeat(500);
    const failure = createInternalFailure({ kind: "internal_error", safeMessage: long });
    expect(failure.safeMessage.length).toBeLessThanOrEqual(240);
  });
});

describe("sanitizeMessage", () => {
  test("redacts Bearer token", () => {
    const out = sanitizeMessage("Authorization: Bearer sk-abcdef12345");
    expect(out).not.toContain("sk-abcdef");
    expect(out).toContain("[redacted]");
  });

  test("redacts api-key pattern", () => {
    const out = sanitizeMessage("api_key: Bearer sk-test123");
    expect(out).toContain("credential=[redacted]");
  });

  test("collapses whitespace and returns fallback for empty", () => {
    expect(sanitizeMessage("   ")).toBe("Provider request failed (empty error message)");
    expect(sanitizeMessage(null)).toBe("Provider request failed (no error detail available)");
  });

  test("extracts nested message fields", () => {
    const out = sanitizeMessage({ detail: { message: "upstream boom" } });
    expect(out).toBe("upstream boom");
  });

  test("truncates at 240 chars", () => {
    const out = sanitizeMessage("a".repeat(500));
    expect(out.length).toBe(240);
  });
});

describe("ProtocolCodecError", () => {
  test("constructor sets fields and extends Error", () => {
    const err = new ProtocolCodecError({ kind: "provider_protocol_error", message: "bad json", statusCode: 502, retryable: true });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProtocolCodecError");
    expect(err.kind).toBe("provider_protocol_error");
    expect(err.message).toBe("bad json");
    expect(err.statusCode).toBe(502);
    expect(err.retryable).toBe(true);
    expect(err.routeScope).toBe("provider");
  });

  test("defaults retryable false and provider scope", () => {
    const err = new ProtocolCodecError({ kind: "invalid_request", message: "oops" });
    expect(err.retryable).toBe(false);
    expect(err.routeScope).toBe("provider");
    expect(err.retryAt).toBeNull();
  });
});

describe("internalFailureFromUnknown", () => {
  test("passthrough InternalFailure", () => {
    const original = createInternalFailure({ kind: "provider_rate_limited", retryable: true });
    expect(internalFailureFromUnknown(original)).toEqual(original);
  });

  test("maps ProtocolCodecError to InternalFailure", () => {
    const codec = new ProtocolCodecError({ kind: "context_overflow", message: "too long", statusCode: 400 });
    const failure = internalFailureFromUnknown(codec);
    expect(failure.kind).toBe("context_overflow");
    expect(failure.statusCode).toBe(400);
    expect(isInternalFailure(failure)).toBe(true);
  });

  test("maps AbortError to client_aborted", () => {
    const abort = new DOMException("aborted", "AbortError");
    Object.defineProperty(abort, "name", { value: "AbortError" });
    const failure = internalFailureFromUnknown(abort);
    expect(failure.kind).toBe("client_aborted");
    expect(failure.safeMessage).toContain("aborted");
  });

  test("maps TypeError to network_unavailable retryable", () => {
    const failure = internalFailureFromUnknown(new TypeError("fetch failed"));
    expect(failure.kind).toBe("network_unavailable");
    expect(failure.retryable).toBe(true);
    expect(failure.routeScope).toBe("proxy");
  });

  test("maps unknown value to internal_error", () => {
    const failure = internalFailureFromUnknown("string oops");
    expect(failure.kind).toBe("internal_error");
  });

  test("maps null/undefined to internal_error", () => {
    expect(internalFailureFromUnknown(null).kind).toBe("internal_error");
    expect(internalFailureFromUnknown(undefined).kind).toBe("internal_error");
  });

  test("legacy object with kind is normalized", () => {
    const legacy = { kind: "provider_unavailable", retryable: false, statusCode: 502, safeMessage: "legacy", routeScope: "proxy", source: "upstream", retryAt: null, failureCode: null };
    const failure = internalFailureFromUnknown(legacy);
    expect(failure.kind).toBe("provider_unavailable");
    expect(failure.safeMessage).toBe("legacy");
  });
});

describe("protocol helpers", () => {
  test("protocolError creates invalid_request 400", () => {
    const err = protocolError("model", "bad");
    expect(err.kind).toBe("invalid_request");
    expect(err.statusCode).toBe(400);
    expect(err.field).toBe("model");
    expect(err.retryable).toBe(false);
  });

  test("applicationError sanitizes message", () => {
    const err = applicationError("quota_exceeded", 402, "usage", "Bearer sk-secret");
    expect(err.safeMessage).not.toContain("sk-secret");
  });

  test("isProtocolError / isInternalFailure guards", () => {
    expect(isProtocolError(protocolError("a", "b"))).toBe(true);
    expect(isProtocolError({})).toBe(false);
    expect(isInternalFailure(createInternalFailure({ kind: "internal_error" }))).toBe(true);
    expect(isInternalFailure(null)).toBe(false);
  });

  test("abortedError returns null when not aborted", () => {
    const c = new AbortController();
    expect(abortedError(c.signal)).toBeNull();
  });

  test("abortedError returns client_aborted when aborted", () => {
    const c = new AbortController();
    c.abort();
    const err = abortedError(c.signal);
    expect(err?.kind).toBe("client_aborted");
    expect(err?.statusCode).toBe(499);
  });

  test("boundedRetryAt parses seconds and date", () => {
    const now = Date.now();
    const iso = boundedRetryAt("1", now, 30_000);
    expect(iso).not.toBeNull();
    expect(new Date(iso!).getTime()).toBeGreaterThan(now);
    // out of bounds
    expect(boundedRetryAt("9999", now, 30_000)).toBeNull();
    // date string
    const future = new Date(now + 5_000).toISOString();
    expect(boundedRetryAt(future, now, 30_000)).toBe(future);
    // invalid
    expect(boundedRetryAt("not-a-date", now, 30_000)).toBeNull();
  });
});
