// transport/errors — unified upstream failure handling with trace fidelity
import { ProtocolCodecError } from "../errors.js";
import { isRecord } from "../validation.js";
import { boundedRetryAt, deriveErrorSource, parseRateLimitReason, sanitizeMessage } from "../types/error-types.js";
import type { ApplicationErrorKind, InternalFailure } from "../types/error-types.js";
import type { UpstreamFailureTrace, UpstreamTransport } from "../types/error-types.js";
import { createInternalFailure, internalFailureFromTrace } from "../errors.js";
import { isUsageLimitOutcome } from "../../runtime/rate-limit.js";

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export interface UpstreamErrorOptions {
  readonly kind: ApplicationErrorKind;
  readonly message: string;
  readonly statusCode?: number | null;
  readonly retryable?: boolean;
  readonly routeScope?: "account" | "proxy" | "provider" | null;
  readonly retryAt?: string | null;
}

export class UpstreamError extends Error {
  readonly kind: ApplicationErrorKind;
  readonly statusCode: number | null;
  readonly retryable: boolean;
  readonly routeScope: "account" | "proxy" | "provider" | null;
  readonly retryAt: string | null;

  constructor(options: UpstreamErrorOptions) {
    super(options.message);
    this.name = "UpstreamError";
    this.kind = options.kind;
    this.statusCode = options.statusCode ?? null;
    this.retryable = options.retryable ?? false;
    this.routeScope = options.routeScope ?? "provider";
    this.retryAt = options.retryAt ?? null;
  }

  toInternalFailure(trace?: UpstreamFailureTrace): InternalFailure {
    if (trace) return internalFailureFromTrace(trace, { kind: this.kind, retryable: this.retryable, routeScope: this.routeScope === "provider" ? null : this.routeScope, retryAt: this.retryAt ?? undefined });
    return createInternalFailure({ kind: this.kind, safeMessage: this.message, statusCode: this.statusCode, retryable: this.retryable, routeScope: this.routeScope === "provider" ? null : this.routeScope, retryAt: this.retryAt });
  }
}

const MAX_RETRY_AFTER_DELAY_MS = 30_000;
const MAX_ERROR_BODY_BYTES = 16_384;
const MAX_RETRY_AFTER_SECONDS = MAX_RETRY_AFTER_DELAY_MS / 1_000;

export function parseRetryAfterSeconds(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^-\d/.test(trimmed)) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return Math.min(parsed, MAX_RETRY_AFTER_SECONDS);
  } else {
    const at = Date.parse(trimmed);
    if (Number.isFinite(at)) return Math.min(Math.max(0, (at - nowMs) / 1_000), MAX_RETRY_AFTER_SECONDS);
  }
  return null;
}

// Local bounded body reader to avoid circular import with transport/fetch
async function readBoundedErrorText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (body === null) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: string[] = [];
  const utf8 = new TextDecoder();
  let bytesRead = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        chunks.push(utf8.decode());
        break;
      }
      if (!value || value.byteLength === 0) continue;
      const nextBytes = bytesRead + value.byteLength;
      if (nextBytes > maxBytes) {
        const permitted = maxBytes - bytesRead;
        if (permitted > 0) chunks.push(utf8.decode(value.subarray(0, permitted), { stream: true }));
        truncated = true;
        // drain and cancel
        break;
      }
      bytesRead = nextBytes;
      chunks.push(utf8.decode(value, { stream: true }));
    }
    return { text: chunks.join(""), truncated };
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

function extractRetryAfterMs(headers: Headers, bodyText: string): number | null {
  const headerMs = parseRetryAfterSeconds(headers.get("retry-after"), Date.now());
  if (headerMs !== null) return Math.floor(headerMs * 1000);
  // FreeUsageLimit: retry-after-ms in body
  const msMatch = /(?:retry[_-]after[_-]ms|retryafterms)\s*[:=]\s*(\d+)/i.exec(bodyText);
  const ms = msMatch ? Number(msMatch[1]) : null;
  if (ms !== null && Number.isFinite(ms) && ms > 0) return Math.min(ms, 24 * 60 * 60 * 1000);
  return null;
}

function extractUpstreamFields(bodyText: string): { message: string | null; providerCode: string | null; providerType: string | null; hasStructuredError: boolean; rawMessage: string | null } {
  let message: string | null = null;
  let providerCode: string | null = null;
  let providerType: string | null = null;
  let hasStructuredError = false;
  let rawMessage: string | null = null;
  if (bodyText.length === 0) return { message, providerCode, providerType, hasStructuredError, rawMessage };
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed)) {
      if (isRecord(parsed.error)) {
        hasStructuredError = true;
        if (typeof parsed.error.message === "string") { message = parsed.error.message; rawMessage = parsed.error.message; }
        else if (typeof parsed.error.msg === "string") { message = parsed.error.msg; rawMessage = parsed.error.msg; }
        // precedence: error.code, then error.type, then top-level code
        if (typeof parsed.error.code === "string") { providerCode = parsed.error.code; providerType = typeof parsed.error.type === "string" ? parsed.error.type : null; }
        else if (typeof parsed.error.type === "string") { providerType = parsed.error.type; providerCode = null; }
        else if (typeof (parsed as Record<string, unknown>).code === "string") { providerCode = (parsed as Record<string, unknown>).code as string; }
        // Also capture message from error field if not already
        if (rawMessage === null && typeof parsed.error.message === "string") rawMessage = parsed.error.message;
        if (rawMessage === null && typeof (parsed.error as Record<string, unknown>).detail === "string") { message = (parsed.error as Record<string, unknown>).detail as string; rawMessage = message; }
      } else if (typeof parsed.message === "string") {
        hasStructuredError = true; message = parsed.message; rawMessage = parsed.message;
      } else if (typeof parsed.detail === "string") {
        hasStructuredError = true; message = parsed.detail; rawMessage = parsed.detail;
      } else if (typeof parsed.error === "string") {
        // flat error string: message only, no code/type
        hasStructuredError = true; message = parsed.error; rawMessage = parsed.error;
      } else {
        // check top-level code as fallback
        if (typeof (parsed as Record<string, unknown>).code === "string") providerCode = (parsed as Record<string, unknown>).code as string;
      }
    }
  } catch {
    // Not JSON: treat bodyText as message, truncated to 500
    message = bodyText.slice(0, 500);
    rawMessage = message;
  }
  if (message !== null && rawMessage === null) rawMessage = message;
  return { message, providerCode, providerType, hasStructuredError, rawMessage };
}

function mapStatusToKind(statusCode: number, message: string, _providerCode: string | null): { kind: ApplicationErrorKind; retryable: boolean; routeScope: "account" | "proxy" | null } {
  switch (statusCode) {
    case 400: return { kind: "invalid_request", retryable: false, routeScope: null };
    case 401: return { kind: "authentication_failed", retryable: false, routeScope: "account" };
    case 402: return { kind: "quota_exceeded", retryable: true, routeScope: "account" };
    case 403: return { kind: "authorization_denied", retryable: false, routeScope: "account" };
    case 404: return { kind: "model_not_found", retryable: false, routeScope: null };
    case 407: return { kind: "network_unavailable", retryable: true, routeScope: "proxy" };
    case 408: return { kind: "provider_unavailable", retryable: true, routeScope: null };
    case 409: return { kind: "concurrency_exceeded", retryable: true, routeScope: null };
    case 413:
    case 422: return { kind: "invalid_request", retryable: false, routeScope: null };
    case 429: {
      const reason = parseRateLimitReason(message);
      const quotaHint = reason === "QUOTA_EXHAUSTED" || isUsageLimitOutcome(statusCode, message);
      return { kind: quotaHint ? "quota_exceeded" : "provider_rate_limited", retryable: true, routeScope: "account" };
    }
    default:
      if (statusCode >= 500) return { kind: "provider_unavailable", retryable: true, routeScope: null };
      return { kind: "provider_protocol_error", retryable: false, routeScope: null };
  }
}

/**
 * Captures bounded raw diagnostics via encrypted payload capture without
 * leaking rawMessage into normal telemetry. The raw body is truncated to
 * 16 KiB and encrypted through the capture path.
 */
export function captureUpstreamFailure(trace: UpstreamFailureTrace, capture?: { request?(v: unknown): void; response?(v: unknown): void; observeResponse?(r: Response): Response }): void {
  if (capture === undefined || trace.rawMessage === null) return;
  try {
    const bounded = trace.rawMessage.slice(0, MAX_ERROR_BODY_BYTES);
    capture.response?.({ providerId: trace.providerId, transport: trace.transport, statusCode: trace.statusCode, providerCode: trace.providerCode, providerType: trace.providerType, requestId: trace.requestId, body: bounded, bodyTruncated: trace.bodyTruncated });
  } catch {}
}

export async function parseUpstreamFailure(response: Response, providerId: string = "unknown", transport: UpstreamTransport = "http", capture?: unknown): Promise<never> {
  const statusCode = response.status;
  const headers = response.headers;
  const { text: bodyText, truncated: bodyTruncated } = await readBoundedErrorText(response.body, MAX_ERROR_BODY_BYTES);
  const retryAfterMs = extractRetryAfterMs(headers, bodyText);
  const requestId = headers.get("x-request-id") ?? headers.get("request-id") ?? headers.get("x-requestid") ?? null;
  const { message, providerCode, providerType, hasStructuredError, rawMessage } = extractUpstreamFields(bodyText);

  const lowerBody = `${bodyText} ${message ?? ""} ${providerType ?? ""} ${providerCode ?? ""}`.toLowerCase();
  const isProxied = headers.get("x-ohmyomop-router-proxied") === "1";
  const isCloudflareBlock = lowerBody.includes("attention required") && lowerBody.includes("cloudflare") && lowerBody.includes("you have been blocked");

  // Proxy-scoped unstructured 400 / Cloudflare block
  if (isProxied && !hasStructuredError && (statusCode === 400 || isCloudflareBlock)) {
    const trace: UpstreamFailureTrace = {
      providerId,
      transport,
      statusCode,
      providerCode: null,
      providerType: null,
      requestId,
      retryAfterMs: null,
      rawMessage: rawMessage ?? bodyText.slice(0, 500),
      bodyTruncated,
    };
    captureUpstreamFailure(trace, capture as never);
    throw internalFailureFromTrace(trace, { kind: "network_unavailable", retryable: true, routeScope: "proxy" });
  }

  // FreeUsageLimit: preserve long retry as proxy-scoped rate limit
  if (lowerBody.includes("freeusagelimite")) {
    const trace: UpstreamFailureTrace = {
      providerId,
      transport,
      statusCode,
      providerCode: providerCode ?? "FREE_USAGE_LIMIT",
      providerType: providerType ?? "FREE_USAGE_LIMIT",
      requestId,
      retryAfterMs: retryAfterMs ?? 60_000,
      rawMessage: rawMessage ?? bodyText.slice(0, 500),
      bodyTruncated,
    };
    captureUpstreamFailure(trace, capture as never);
    const retryAt = retryAfterMs !== null ? new Date(Date.now() + Math.min(retryAfterMs, 24 * 60 * 60 * 1000)).toISOString() : new Date(Date.now() + 60_000).toISOString();
    throw internalFailureFromTrace(trace, { kind: "provider_rate_limited", retryable: true, routeScope: "proxy", retryAt });
  }

  const effectiveMessage = message ?? `Upstream provider returned HTTP ${statusCode}`;
  const mapped = mapStatusToKind(statusCode, effectiveMessage, providerCode);
  // For 429, preserve retryAfterMs via trace; classification uses message first
  const trace: UpstreamFailureTrace = {
    providerId,
    transport,
    statusCode,
    providerCode,
    providerType,
    requestId,
    retryAfterMs,
    rawMessage,
    bodyTruncated,
  };
  captureUpstreamFailure(trace, capture as never);
  throw internalFailureFromTrace(trace, { kind: mapped.kind, retryable: mapped.retryable, routeScope: mapped.routeScope });
}

export function isRetryableError(err: InternalFailure | InternalFailure): boolean {
  if (!("retryable" in err) || !err.retryable) return false;
  if (err.kind === "authentication_failed" || err.kind === "model_not_found") return false;
  return true;
}
