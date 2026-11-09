import type { ProxyErrorCode } from "../api/errors.js";
import {
  boundedRetryAt as boundedRetryAtSeconds,
  classifyProviderFailure as classifyLegacyProviderFailure,
  sanitizeMessage,
} from "./types/error-types.js";
import type {
  ApplicationErrorKind,
  InternalFailure,
  PublicFailure,
  UpstreamFailureSummary,
  UpstreamFailureTrace,
} from "./types/error-types.js";
import type { ErrorSource, ProviderFailureCode, RouteScope } from "./types/surface.js";

const MAX_RETRY_AFTER_MS = 30_000;
const PROVIDER_FAILURE_CODES: ReadonlySet<string> = new Set([
  "auth_invalidated",
  "usage_limit",
  "rate_limit_transient",
  "context_overflow",
  "stale_response_state",
  "empty_provider_body",
  "provider_finish_error",
  "content_blocked",
  "tool_schema_rejected",
  "optional_parameter_rejected",
  "stream_pre_response_timeout",
  "stream_idle_timeout",
  "stream_total_timeout",
  "caller_aborted",
  "unknown_provider_failure",
]);

const PUBLIC_FAILURE_MESSAGES: Readonly<Record<ApplicationErrorKind, string>> = {
  invalid_request: "Invalid request.",
  authentication_failed: "Authentication failed.",
  authorization_denied: "Authorization denied.",
  quota_exceeded: "Provider quota exceeded.",
  concurrency_exceeded: "Request concurrency limit reached.",
  model_not_found: "Model not found.",
  context_overflow: "Context length exceeded.",
  capability_unsupported: "Requested capability is not supported.",
  credential_unavailable: "Authentication failed.",
  network_unavailable: "Upstream network is unavailable.",
  provider_rate_limited: "Provider rate limit exceeded.",
  provider_unavailable: "Provider is unavailable.",
  provider_protocol_error: "Provider returned an invalid response.",
  stream_timeout: "Request timed out.",
  stream_truncated: "Provider returned an incomplete response.",
  client_aborted: "Request cancelled.",
  internal_error: "Internal server error.",
};

const PUBLIC_FAILURE_CODES: Readonly<Record<ApplicationErrorKind, ProxyErrorCode>> = {
  invalid_request: "invalid_request",
  authentication_failed: "authentication_failed",
  authorization_denied: "authorization_denied",
  quota_exceeded: "quota_exceeded",
  concurrency_exceeded: "concurrency_limit",
  model_not_found: "model_not_found",
  context_overflow: "context_overflow",
  capability_unsupported: "capability_unsupported",
  credential_unavailable: "authentication_failed",
  network_unavailable: "network_unavailable",
  provider_rate_limited: "rate_limit_error",
  provider_unavailable: "provider_unavailable",
  provider_protocol_error: "provider_protocol_error",
  stream_timeout: "request_timeout",
  stream_truncated: "provider_protocol_error",
  client_aborted: "request_cancelled",
  internal_error: "internal_error",
};

/** Resolves the owner of a normalized application failure. */
export function deriveErrorSource(kind: ApplicationErrorKind, _routeScope: RouteScope | "provider" | null): ErrorSource {
  if (kind === "client_aborted" || kind === "invalid_request") return "client";
  if (
    kind === "internal_error"
    || kind === "credential_unavailable"
    || kind === "capability_unsupported"
    || kind === "model_not_found"
  ) {
    return "internal";
  }
  return "upstream";
}

/** Converts a transient trace into a raw-message-free summary. */
export function upstreamFailureSummary(trace: UpstreamFailureTrace): UpstreamFailureSummary {
  return {
    providerId: trace.providerId,
    transport: trace.transport,
    statusCode: trace.statusCode,
    providerCode: trace.providerCode,
    providerType: trace.providerType,
    requestId: trace.requestId,
    retryAfterMs: trace.retryAfterMs,
    bodyTruncated: trace.bodyTruncated,
  };
}

/** Creates a stable failure that can cross router, telemetry, and response boundaries. */
export function createInternalFailure(options: {
  readonly kind: ApplicationErrorKind;
  readonly safeMessage?: string;
  readonly statusCode?: number | null;
  readonly retryable?: boolean;
  readonly routeScope?: RouteScope | null;
  readonly source?: ErrorSource;
  readonly retryAt?: string | null;
  readonly failureCode?: ProviderFailureCode | null;
  readonly upstream?: UpstreamFailureSummary | null;
}): InternalFailure {
  const routeScope = options.routeScope ?? null;
  return {
    kind: options.kind,
    statusCode: options.statusCode ?? null,
    retryable: options.retryable ?? false,
    routeScope,
    source: options.source ?? deriveErrorSource(options.kind, routeScope),
    retryAt: options.retryAt ?? null,
    safeMessage: sanitizeMessage(options.safeMessage ?? PUBLIC_FAILURE_MESSAGES[options.kind]),
    failureCode: options.failureCode ?? null,
    upstream: options.upstream ?? null,
  };
}

/** Maps an upstream trace while preserving the upstream message/code in bounded form. */
export function internalFailureFromTrace(
  trace: UpstreamFailureTrace,
  options: {
    readonly kind: ApplicationErrorKind;
    readonly retryable?: boolean;
    readonly routeScope?: RouteScope | null;
    readonly retryAt?: string | null;
    readonly failureCode?: ProviderFailureCode | null;
  },
): InternalFailure {
  const retryAt = options.retryAt
    ?? (trace.retryAfterMs === null ? null : boundedRetryAt(trace.retryAfterMs / 1_000, Date.now(), MAX_RETRY_AFTER_MS));
  const failureCode = options.failureCode ?? classifyProviderFailure({
    statusCode: trace.statusCode,
    structuredCode: trace.providerCode ?? trace.providerType,
    message: trace.rawMessage,
    kind: options.kind,
  });
  return createInternalFailure({
    kind: options.kind,
    statusCode: trace.statusCode,
    retryable: options.retryable,
    routeScope: options.routeScope,
    retryAt,
    // The upstream message is untrusted provider text and must not reach the
    // client. The bounded `upstream` summary carries the code/type/requestId.
    failureCode,
    upstream: upstreamFailureSummary(trace),
  });
}

/** Normalizes an arbitrary thrown value without exposing untrusted text publicly. */
export function internalFailureFromUnknown(error: unknown): InternalFailure {
  if (isInternalFailure(error)) return error;
  const legacy = legacyFailure(error);
  if (legacy !== null) return legacy;
  if (error instanceof ProtocolCodecError) {
    return createInternalFailure({
      kind: error.kind,
      statusCode: error.statusCode,
      retryable: error.retryable,
      routeScope: internalRouteScope(error.routeScope),
      retryAt: error.retryAt,
      safeMessage: error.message,
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return createInternalFailure({ kind: "client_aborted", safeMessage: "Request aborted" });
  }
  if (error instanceof TypeError) {
    return createInternalFailure({
      kind: "network_unavailable",
      safeMessage: error.message,
      retryable: true,
      routeScope: "proxy",
    });
  }
  return createInternalFailure({ kind: "internal_error" });
}

function legacyFailure(error: unknown): InternalFailure | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as Record<string, unknown>;
  if (
    !isApplicationErrorKind(candidate.kind)
    || typeof candidate.retryable !== "boolean"
    || (candidate.statusCode !== null && typeof candidate.statusCode !== "number")
  ) {
    return null;
  }
  const routeScope = candidate.routeScope === "account" || candidate.routeScope === "proxy"
    ? candidate.routeScope
    : null;
  const source = candidate.source === "client" || candidate.source === "internal" || candidate.source === "upstream"
    ? candidate.source
    : deriveErrorSource(candidate.kind, routeScope);
  return createInternalFailure({
    kind: candidate.kind,
    statusCode: candidate.statusCode,
    retryable: candidate.retryable,
    routeScope,
    source,
    retryAt: typeof candidate.retryAt === "string" ? candidate.retryAt : null,
    failureCode: isProviderFailureCode(candidate.failureCode) ? candidate.failureCode : null,
    safeMessage: typeof candidate.safeMessage === "string" ? candidate.safeMessage : undefined,
  });
}

function isProviderFailureCode(value: unknown): value is ProviderFailureCode {
  return typeof value === "string" && PROVIDER_FAILURE_CODES.has(value);
}

function isApplicationErrorKind(value: unknown): value is ApplicationErrorKind {
  return typeof value === "string" && value in PUBLIC_FAILURE_CODES;
}

function internalRouteScope(routeScope: RouteScope | "provider" | null): RouteScope | null {
  return routeScope === "provider" ? null : routeScope;
}

/** Narrows an unknown value to the stable internal failure DTO. */
export function isInternalFailure(value: unknown): value is InternalFailure {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.kind === "string"
    && typeof candidate.retryable === "boolean"
    && typeof candidate.safeMessage === "string"
    && (candidate.statusCode === null || typeof candidate.statusCode === "number")
    && (candidate.routeScope === null || candidate.routeScope === "account" || candidate.routeScope === "proxy")
    && (candidate.source === "client" || candidate.source === "internal" || candidate.source === "upstream")
    && (candidate.retryAt === null || typeof candidate.retryAt === "string")
    && (candidate.failureCode === null || typeof candidate.failureCode === "string")
    && (candidate.upstream === null || typeof candidate.upstream === "object");
}

/** Classifies provider failures without manufacturing provider-native codes. */
export function classifyProviderFailure(input: Parameters<typeof classifyLegacyProviderFailure>[0]): ProviderFailureCode {
  return classifyLegacyProviderFailure(input);
}

/** Parses a bounded retry timestamp from either seconds or a retry date. */
export function boundedRetryAt(value: unknown, nowMs: number, maxDelayMs: number): string | null {
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const retryAtMs = Date.parse(value);
    if (!Number.isFinite(retryAtMs) || retryAtMs < nowMs || retryAtMs - nowMs > maxDelayMs) return null;
    return new Date(retryAtMs).toISOString();
  }
  return boundedRetryAtSeconds(value, nowMs, maxDelayMs);
}

/**
 * Typed, sanitized failure returned by protocol validation and normalization.
 *
 * Structurally compatible with the application `InternalFailure` (same required
 * members, narrower literals for `retryable`/`routeScope`), so it composes
 * directly into typed pipeline failures without a second mapping. Validation
 * failures are never retryable and never rotate accounts or proxies.
 */
export interface ProtocolError {
  readonly kind: ApplicationErrorKind;
  readonly statusCode: number;
  readonly safeMessage: string;
  readonly retryable: false;
  readonly routeScope: null;
  readonly retryAt: null;
  /** Dot-separated path of the offending field, e.g. "messages[2].content". */
  readonly field: string;
}

export function applicationError(
  kind: ApplicationErrorKind,
  statusCode: number,
  field: string,
  message: string,
): ProtocolError {
  return {
    kind,
    statusCode,
    safeMessage: sanitizeMessage(message),
    retryable: false,
    routeScope: null,
    retryAt: null,
    field,
  };
}

/** Default invalid-request failure (HTTP 400, never retryable). */
export function protocolError(field: string, message: string): ProtocolError {
  return applicationError("invalid_request", 400, field, message);
}

export function isProtocolError(value: unknown): value is ProtocolError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { field?: unknown; retryable?: unknown; safeMessage?: unknown };
  return candidate.field !== undefined && candidate.retryable === false && candidate.safeMessage !== undefined;
}

/** Entry check so an already-aborted request never reaches deep normalization. */
export function abortedError(signal: AbortSignal): ProtocolError | null {
  if (!signal.aborted) return null;
  return applicationError("client_aborted", 499, "request", "request was aborted before normalization completed");
}

/** Typed failure raised while encoding or decoding a protocol payload. */
export class ProtocolCodecError extends Error {
  readonly kind: ApplicationErrorKind;
  readonly statusCode: number | null;
  readonly retryable: boolean;
  readonly routeScope: "account" | "proxy" | "provider" | null;
  readonly retryAt: string | null;

  constructor(options: {
    readonly kind: ApplicationErrorKind;
    readonly message: string;
    readonly statusCode?: number | null;
    readonly retryable?: boolean;
    readonly routeScope?: "account" | "proxy" | "provider" | null;
    readonly retryAt?: string | null;
  }) {
    super(options.message);
    this.name = "ProtocolCodecError";
    this.kind = options.kind;
    this.statusCode = options.statusCode ?? null;
    this.retryable = options.retryable ?? false;
    this.routeScope = options.routeScope ?? "provider";
    this.retryAt = options.retryAt ?? null;
  }

}
