/**
 * Error domain — rate limit, cooldown, provider failure, sanitization
 */

import type { Surface, ProviderProtocol, CredentialKind, RouteScope, RouteStatus, CooldownKind, ProviderFailureCode, ErrorSource, ReasoningEffort, ReasoningSummary, ReasoningMode, ReasoningContext } from "./surface.js";
import type { ProviderCaps, ProviderModel } from "./provider.js";
import type { RouteTarget, RoutingSnapshot } from "./routing.js";
import type { ProxyRequest, ProviderRequest, ProviderOutput } from "./request.js";
import type { StreamEvent, StopReason } from "./stream.js";
import type { ProviderUsage } from "./telemetry.js";

export type RateLimitReason =
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMIT_EXCEEDED"
  | "MODEL_CAPACITY_EXHAUSTED"
  | "SERVER_ERROR"
  | "UNKNOWN";

const ACCOUNT_RATE_LIMIT_PATTERN =
  /\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;
const INSUFFICIENT_BALANCE_PATTERN = /insufficient.?balance/i;
const SPEND_LIMIT_PATTERN = /spend.?limit/i;
const OPENROUTER_DAILY_FREE_LIMIT_PATTERN = /\bfree[-_ ]models[-_ ]per[-_ ]day\b/i;

/** Classifies an upstream rate-limit message for account cooldown policy. */
export function parseRateLimitReason(errorMessage: string): RateLimitReason {
  const lower = errorMessage.toLowerCase();
  if (
    lower.includes("freeusagelimite") ||
    lower.includes("free_usage") ||
    lower.includes("freeusagelimiteerror") ||
    lower.includes("quota will reset") ||
    lower.includes("exhausted your capacity")
  )
    return "QUOTA_EXHAUSTED";
  if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("529") || lower.includes("503") || lower.includes("resource exhausted")) {
    return "MODEL_CAPACITY_EXHAUSTED";
  }
  if (ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage) || SPEND_LIMIT_PATTERN.test(errorMessage) || OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(errorMessage)) {
    return "QUOTA_EXHAUSTED";
  }
  if (lower.includes("per minute") || lower.includes("rate limit") || lower.includes("too many requests")) return "RATE_LIMIT_EXCEEDED";
  if (
    lower.includes("exhausted") ||
    lower.includes("quota") ||
    lower.includes("usage limit") ||
    lower.includes("usage_limit") ||
    lower.includes("run out of credits") ||
    lower.includes("out of credits") ||
    lower.includes("spending-limit") ||
    lower.includes("spending limit") ||
    INSUFFICIENT_BALANCE_PATTERN.test(errorMessage)
  ) {
    return "QUOTA_EXHAUSTED";
  }
  if (lower.includes("500") || lower.includes("internal error") || lower.includes("internal server error")) return "SERVER_ERROR";
  return "UNKNOWN";
}

/** Returns the account cooldown delay for one classified rate-limit outcome. */
export function calculateRateLimitBackoffMs(reason: RateLimitReason): number {
  if (reason === "QUOTA_EXHAUSTED") return 5 * 60_000;
  if (reason === "RATE_LIMIT_EXCEEDED") return 30_000;
  if (reason === "MODEL_CAPACITY_EXHAUSTED") return 45_000 + Math.random() * 30_000;
  return 0;
}

export type ApplicationErrorKind =
  | "invalid_request"
  | "authentication_failed"
  | "authorization_denied"
  | "quota_exceeded"
  | "concurrency_exceeded"
  | "model_not_found"
  | "context_overflow"
  | "capability_unsupported"
  | "credential_unavailable"
  | "network_unavailable"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_protocol_error"
  | "stream_timeout"
  | "stream_truncated"
  | "client_aborted"
  | "internal_error";

export type UpstreamTransport = "http" | "sse" | "ndjson" | "protobuf" | "network";

export interface UpstreamFailureTrace {
  readonly providerId: string;
  readonly transport: UpstreamTransport;
  readonly statusCode: number | null;
  readonly providerCode: string | null;
  readonly providerType: string | null;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly rawMessage: string | null;
  readonly bodyTruncated: boolean;
}

export interface UpstreamFailureSummary {
  readonly providerId: string;
  readonly transport: UpstreamTransport;
  readonly statusCode: number | null;
  readonly providerCode: string | null;
  readonly providerType: string | null;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly bodyTruncated: boolean;
}

export interface InternalFailure {
  readonly kind: ApplicationErrorKind;
  readonly statusCode: number | null;
  readonly retryable: boolean;
  readonly routeScope: RouteScope | null;
  readonly source: ErrorSource;
  readonly safeMessage: string;
  readonly failureCode: ProviderFailureCode | null;
  readonly retryAt: string | null;
  readonly upstream: UpstreamFailureSummary | null;
}

export interface PublicFailure {
  readonly type: "error";
  readonly code: import("../../api/errors.js").ProxyErrorCode;
  readonly message: string;
  readonly request_id: string;
}

export interface PublicErrorBody {
  readonly error: { readonly message: string; readonly type: string; readonly code: string | null };
  readonly request_id: string;
}

interface CooldownPolicy {
  readonly defaultMs: number;
  readonly baseMs: number;
  readonly capMs: number;
}

export const ACCOUNT_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
export const ACCOUNT_QUOTA_COOLDOWN_MS = 5 * 60_000;
export const ACCOUNT_AUTH_BACKOFF_BASE_MS = 2_000;
export const ACCOUNT_AUTH_BACKOFF_CAP_MS = 5 * 60_000;
export const PROXY_RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
export const PROXY_AUTH_BACKOFF_BASE_MS = 2_000;
export const PROXY_AUTH_BACKOFF_CAP_MS = 5 * 60_000;
export const RATE_LIMIT_GRADUATED_BASE_MS = 30_000;
export const RATE_LIMIT_GRADUATED_THRESHOLD = 3;

const ACCOUNT_RATE_LIMIT_POLICY: CooldownPolicy = {
  defaultMs: ACCOUNT_RATE_LIMIT_COOLDOWN_MS,
  baseMs: ACCOUNT_AUTH_BACKOFF_BASE_MS,
  capMs: ACCOUNT_RATE_LIMIT_COOLDOWN_MS,
};

const ACCOUNT_QUOTA_POLICY: CooldownPolicy = {
  defaultMs: ACCOUNT_QUOTA_COOLDOWN_MS,
  baseMs: ACCOUNT_AUTH_BACKOFF_BASE_MS,
  capMs: ACCOUNT_QUOTA_COOLDOWN_MS,
};

const ACCOUNT_BACKOFF_POLICY: CooldownPolicy = {
  defaultMs: 0,
  baseMs: ACCOUNT_AUTH_BACKOFF_BASE_MS,
  capMs: ACCOUNT_AUTH_BACKOFF_CAP_MS,
};

const PROXY_RATE_LIMIT_POLICY: CooldownPolicy = {
  defaultMs: PROXY_RATE_LIMIT_COOLDOWN_MS,
  baseMs: PROXY_AUTH_BACKOFF_BASE_MS,
  capMs: PROXY_RATE_LIMIT_COOLDOWN_MS,
};

const PROXY_BACKOFF_POLICY: CooldownPolicy = {
  defaultMs: 0,
  baseMs: PROXY_AUTH_BACKOFF_BASE_MS,
  capMs: PROXY_AUTH_BACKOFF_CAP_MS,
};

const RATE_LIMITED_KINDS: Record<string, true> = { provider_rate_limited: true };
const QUOTA_EXHAUSTED_KINDS: Record<string, true> = { quota_exceeded: true };
const TRANSIENT_ERROR_KINDS: Record<string, true> = {
  provider_unavailable: true,
  provider_protocol_error: true,
  stream_timeout: true,
  stream_truncated: true,
  network_unavailable: true,
  internal_error: true,
};

export function isTransientErrorKind(kind: ApplicationErrorKind): boolean {
  return TRANSIENT_ERROR_KINDS[kind] === true;
}

export function accountCooldownPolicyFor(kind: ApplicationErrorKind): CooldownPolicy {
  if (RATE_LIMITED_KINDS[kind] === true) return ACCOUNT_RATE_LIMIT_POLICY;
  if (QUOTA_EXHAUSTED_KINDS[kind] === true) return ACCOUNT_QUOTA_POLICY;
  return ACCOUNT_BACKOFF_POLICY;
}

export function proxyCooldownPolicyFor(kind: ApplicationErrorKind): CooldownPolicy {
  if (RATE_LIMITED_KINDS[kind] === true) return PROXY_RATE_LIMIT_POLICY;
  if (QUOTA_EXHAUSTED_KINDS[kind] === true) return PROXY_RATE_LIMIT_POLICY;
  return PROXY_BACKOFF_POLICY;
}

export function exponentialBackoffMs(baseMs: number, attempt: number, capMs: number): number {
  if (attempt <= 1) return Math.min(capMs, baseMs);
  const factor = 2 ** (attempt - 1);
  const raw = Math.min(capMs, Number.isFinite(factor) ? baseMs * factor : capMs);
  const jitter = raw * 0.25 * (Math.random() * 2 - 1);
  return Math.max(baseMs, Math.min(capMs, Math.round(raw + jitter)));
}

export function boundedRetryDelayMs(retryAt: string | null, nowMs: number, capMs: number): number | null {
  if (retryAt === null) return null;
  const at = Date.parse(retryAt);
  if (!Number.isFinite(at)) return null;
  const delay = at - nowMs;
  if (delay < 0 || delay > capMs) return null;
  return delay;
}

export function cooldownDelayMs(error: InternalFailure, policy: CooldownPolicy, failureCount: number, nowMs: number): number {
  if (!error.retryable) return 0;
  if (isTransientErrorKind(error.kind)) return 0;
  const retryAfter = boundedRetryDelayMs(error.retryAt, nowMs, policy.capMs);
  if (retryAfter !== null) return retryAfter;
  if (policy.defaultMs > 0) {
    const reason = parseRateLimitReason(error.safeMessage ?? (error as unknown as { message?: string }).message ?? "");
    if (reason === "QUOTA_EXHAUSTED") return Math.min(calculateRateLimitBackoffMs(reason), policy.defaultMs);
    if (reason === "MODEL_CAPACITY_EXHAUSTED") return Math.min(calculateRateLimitBackoffMs(reason), policy.defaultMs);
    if (reason === "RATE_LIMIT_EXCEEDED") return Math.min(calculateRateLimitBackoffMs(reason), policy.defaultMs);
    if (failureCount >= RATE_LIMIT_GRADUATED_THRESHOLD) return policy.defaultMs;
    return Math.min(policy.defaultMs, exponentialBackoffMs(RATE_LIMIT_GRADUATED_BASE_MS, failureCount, policy.defaultMs));
  }
  return exponentialBackoffMs(policy.baseMs, failureCount, policy.capMs);
}

interface HealthRecordView {
  readonly status: RouteStatus;
  readonly statusCode: number | null;
  readonly failureKind: ApplicationErrorKind | null;
  readonly safeMessage: string | null;
  readonly occurredAt: string | null;
  readonly retryAt: string | null;
  readonly disabledUntilMs: number | null;
}

export function isRecordUsable(record: HealthRecordView, nowMs: number): boolean {
  if (record.status === "healthy") return true;
  if (record.status === "disabled") return false;
  if (record.status === "error") return true;
  if (record.status === "cooling_down") return record.disabledUntilMs === null || nowMs >= record.disabledUntilMs;
  return true;
}

export function deriveRouteHealth(record: HealthRecordView, scope: RouteScope, nowMs: number): { scope: RouteScope; status: RouteStatus; statusCode: number | null; failureKind: ApplicationErrorKind | null; safeMessage: string | null; occurredAt: string | null; retryAt: string | null } {
  const cooling = record.disabledUntilMs !== null && nowMs < record.disabledUntilMs;
  let status: RouteStatus;
  if (cooling) status = "cooling_down";
  else if (record.status === "disabled") status = "disabled";
  else if (record.status === "error") status = "error";
  else status = "healthy";
  const active = cooling || status !== "healthy";
  return {
    scope,
    status,
    statusCode: active ? record.statusCode : null,
    failureKind: active ? record.failureKind : null,
    safeMessage: active ? record.safeMessage : null,
    occurredAt: active ? record.occurredAt : null,
    retryAt: cooling ? record.retryAt : null,
  };
}

export interface CleanupHandle {
  readonly release: () => Promise<void>;
}

export interface CleanupStack {
  add(handle: CleanupHandle): void;
  run(): Promise<void>;
}

const MAX_ERROR_MESSAGE_LENGTH = 240;

function errorMessageOf(value: unknown, depth = 0): string | null {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (depth >= 2 || typeof value !== "object" || value === null) return null;
  const record = value as { readonly message?: unknown; readonly detail?: unknown; readonly error?: unknown };
  for (const candidate of [record.message, record.detail, record.error]) {
    const message = errorMessageOf(candidate, depth + 1);
    if (message !== null && message.trim().length > 0) return message;
  }
  return null;
}

export function sanitizeMessage(value: unknown): string {
  const source = errorMessageOf(value) ?? "Provider request failed (no error detail available)";
  const redacted = source
    .replace(/\bauthorization\s*:\s*bearer\s+[^\s"']+/gi, "Authorization: Bearer [redacted]")
    .replace(/Bearer\s+[^\n"']*/gi, "Bearer [redacted]")
    .replace(/(?:api[-_ ]?key|token|secret|password)\s*[:=]\s*(?:Bearer\s+)?[^\n"']*/gi, "credential=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > 0 ? redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH) : "Provider request failed (empty error message)";
}

export function boundedRetryAt(value: unknown, nowMs: number, maxDelayMs: number): string | null {
  const seconds = typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
  if (seconds === null || seconds < 0 || seconds > maxDelayMs / 1_000) return null;
  return new Date(nowMs + seconds * 1_000).toISOString();
}

export interface ProviderErrorOptions {
  readonly retryable?: boolean;
  readonly routeScope?: RouteScope | null;
  readonly statusCode?: number | null;
  readonly retryAt?: string | null;
  readonly failureCode?: ProviderFailureCode;
  readonly source?: ErrorSource;
}

export function createProviderError(kind: ApplicationErrorKind, message: string, options: ProviderErrorOptions = {}): InternalFailure {
  const sanitized = sanitizeMessage(message);
  return {
    kind,
    safeMessage: sanitized,
    retryable: options.retryable ?? false,
    routeScope: options.routeScope ?? null,
    statusCode: options.statusCode ?? null,
    retryAt: options.retryAt ?? null,
    source: options.source ?? (kind === "client_aborted" || kind === "invalid_request" ? "client" : kind === "internal_error" || kind === "credential_unavailable" || kind === "capability_unsupported" || kind === "model_not_found" ? "internal" : "upstream"),
    failureCode: options.failureCode ?? null,
    upstream: null,
  };
}

export function createCleanupStack(): CleanupStack {
  const handles: CleanupHandle[] = [];
  let finished = false;
  return {
    add(handle: CleanupHandle): void {
      if (finished) {
        void handle.release().catch((error: unknown) => {
          console.warn(`[Cleanup] release failed: ${sanitizeMessage(error)}`);
        });
        return;
      }
      handles.push(handle);
    },
    async run(): Promise<void> {
      if (finished) return;
      finished = true;
      while (handles.length > 0) {
        const handle = handles.pop();
        if (handle) await handle.release();
      }
    },
  };
}

export function deriveErrorSource(kind: ApplicationErrorKind, _routeScope: "account" | "proxy" | "provider" | null): ErrorSource {
  if (kind === "client_aborted" || kind === "invalid_request") return "client";
  if (kind === "internal_error" || kind === "credential_unavailable" || kind === "capability_unsupported" || kind === "model_not_found") return "internal";
  if (kind === "network_unavailable") return "upstream";
  return "upstream";
}

type ProviderFailurePhase = "pre_response" | "idle" | "total" | "caller_abort";

export interface ProviderFailureClassificationInput {
  readonly statusCode?: number | null;
  readonly structuredCode?: unknown;
  readonly message?: unknown;
  readonly phase?: ProviderFailurePhase | null;
  readonly bodyState?: "present" | "empty" | "truncated";
  readonly callerAborted?: boolean;
  readonly kind?: ApplicationErrorKind;
  readonly failureCode?: ProviderFailureCode;
}

export function classifyProviderFailure(input: ProviderFailureClassificationInput): ProviderFailureCode {
  if (input.failureCode) return input.failureCode as ProviderFailureCode;
  const message = typeof input.message === "string" ? input.message.toLowerCase() : "";
  if (input.callerAborted === true || input.kind === "client_aborted") return "caller_aborted";
  if (input.phase === "pre_response") return "stream_pre_response_timeout";
  if (input.phase === "idle") return "stream_idle_timeout";
  if (input.phase === "total" || input.kind === "stream_timeout") return "stream_total_timeout";
  if (input.statusCode === 401 || input.kind === "authentication_failed") return "auth_invalidated";
  if (
    input.statusCode === 429
    || input.kind === "provider_rate_limited"
    || input.kind === "quota_exceeded"
    || message.includes("rate limit")
    || message.includes("freeusagelimit")
    || message.includes("usage limit")
  ) {
    return message.includes("quota") || message.includes("usage limit") || message.includes("freeusage")
      ? "usage_limit"
      : "rate_limit_transient";
  }
  if (message.includes("context length") || message.includes("too many tokens") || message.includes("context window")) return "context_overflow";
  if (input.kind === "provider_unavailable" || input.kind === "network_unavailable") return "provider_finish_error";
  if (input.kind === "stream_truncated" || input.bodyState === "empty") return "empty_provider_body";
  return "unknown_provider_failure";
}

export function normalizeInternalFailure(error: InternalFailure, context: ProviderFailureNormalizationContext = {}): InternalFailure {
  const failureCode = classifyProviderFailure({
    ...context,
    statusCode: (context as unknown as { statusCode?: number | null }).statusCode ?? error.statusCode,
    kind: error.kind,
    failureCode: error.failureCode,
    message: (context as unknown as { message?: string }).message ?? error.safeMessage,
  } as ProviderFailureClassificationInput);
  const statusCode = context.statusCode ?? error.statusCode;
  if (error.kind === "network_unavailable") {
    return {
      ...error,
      safeMessage: `Oh My Omop - Router proxy error${statusCode === null || statusCode === undefined ? "" : ` (HTTP ${statusCode})`}`,
      failureCode,
    };
  }
  if (error.upstream !== null) {
    return { ...error, failureCode };
  }
  const sanitized = failureCode === "auth_invalidated"
    ? "Provider authentication was rejected"
    : failureCode === "usage_limit"
      ? "Provider usage limit reached"
      : `Provider request failed with ${failureCode}`;
  return { ...error, safeMessage: sanitized, failureCode };
}

export type ProviderFailureNormalizationContext = Omit<ProviderFailureClassificationInput, "kind" | "failureCode">;
