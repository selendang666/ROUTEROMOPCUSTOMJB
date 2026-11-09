import type { AccountCandidate, AffinityKey, ProxyRoutePlan as NewProxyRoutePlan, RouteCandidate, RouteSwitch, RoutingSnapshot } from "../types/routing.js";
import type { Adapter, ClientIdentity, ProxyRequest as NewProxyRequest, ProviderOutput, RunProxyRequestInput } from "../types/request.js";
import type { RequestLimits } from "../types/content.js";
import { MAX_FILTER_PATTERN_LENGTH } from "../limits.js";
import type { ApplicationErrorKind, InternalFailure } from "../types/error-types.js";
import type { ProviderUsage, TelemetryEvent, TelemetryPort, TelemetryWriter, TranslationDiagnostic } from "../types/telemetry.js";
import type { Surface } from "../types/surface.js";
import type { ApiKeyPublic } from "../../persistence/types.js";
import { PII_DENY_RULES, isPotentiallyCatastrophic, resolveFlags } from "../../compression/filter-policy.js";
import type { FilterRuleConfig } from "../../compression/filter-policy.js";
import { genericTruncate } from "../../compression/token-saver.js";
import type { TokenSaverConfig } from "../../compression/token-saver.js";
import type { AccountEligibilityPorts, CredentialSelector } from "../routing/account.js";
import type { NetworkSelector } from "../transport/network.js";
import type { ApiKeyAdmission } from "../../runtime/key.js";
import type { FormatDetectionResult } from "../translate/cross-surface.js";
import { createAccountManager } from "../routing/account.js";
import { isRouteAllowed } from "../../api/guard.js";
import { deriveErrorSource, normalizeInternalFailure, sanitizeMessage } from "../types/error-types.js";
import { findCacheBreakpoint, applyCachePlan, buildCachePlan } from "../translate/cache.js";
import { estimateRequestTokens } from "../../runtime/key.js";
import { isProtocolError, ProtocolCodecError } from "../errors.js";
import { detectClientFormat, diagnosticsForDetection, normalizationEndpoint, normalizeRequest, parseRequestBody } from "../translate/cross-surface.js";
/**
 * Prepare — one parse, one compression, immutable snapshot.
 * Owns the request options / persistence ports / proxy-request types
 * that downstream slices (attempt, executor) consume.
 */



import { repairToolCallRequest, sanitizeMalformedToolCalls, stringifyToolArguments } from "../events/repair.js";
import type { HeaderSnapshot } from "../protocol-request.js";
import { resolveModelWireSurface } from "../translate/policy.js";
import { applyFilterRules } from "../../compression/filter-policy.js";
import { applyTokenSaver } from "../../compression/token-saver.js";
import { COMPRESSION_EMERGENCY_MESSAGE_THRESHOLD } from "../../compression/ponytail.js";
import { applyGlobalPersona } from "../../persona/persona.js";
import type { GlobalPersonaSnapshot } from "../../persona/snapshot.js";
import { internalFailureFromUnknown, isInternalFailure } from "../errors.js";
import { headerSnapshotFromHeaders as snapshotFromHeaders, scanTrim } from "../normalize/detection.js";

// ---------------------------------------------------------------------------
// Fused compression helpers — single messages.map with structural sharing
// ---------------------------------------------------------------------------
const QUALITY_LIMITS_FUSED = {
  lite: { maxChars: 8_000, keepLastTurns: 3 },
  balanced: { maxChars: 4_000, keepLastTurns: 2 },
  extreme: { maxChars: 2_000, keepLastTurns: 1 },
} as const;
type CompiledFilterRuleFused =
  | { readonly regex: RegExp; readonly replacement: string; readonly isRegex: true }
  | { readonly pattern: string; readonly replacement: string; readonly isRegex: false };
const fusedFilterCache = new WeakMap<FilterRuleConfig, readonly CompiledFilterRuleFused[]>();
function compileFilterRulesFused(config: FilterRuleConfig): readonly CompiledFilterRuleFused[] {
  const cached = fusedFilterCache.get(config);
  if (cached !== undefined) return cached;
  const sourceRules = (config as unknown as { piiDenyList?: boolean; rules: readonly { pattern: string; replacement: string; isRegex: boolean; flags?: string }[] }).piiDenyList === true
    ? [...config.rules as unknown as readonly { pattern: string; replacement: string; isRegex: boolean; flags?: string }[], ...PII_DENY_RULES]
    : (config.rules as unknown as readonly { pattern: string; replacement: string; isRegex: boolean; flags?: string }[]);
  const compiled = (sourceRules as readonly { pattern: string; replacement: string; isRegex: boolean; flags?: string }[]).map((rule) => {
    if (rule.isRegex) {
      if (rule.pattern.length === 0 || rule.pattern.length > MAX_FILTER_PATTERN_LENGTH) return null;
      if (isPotentiallyCatastrophic(rule.pattern)) return null;
      try {
        return { regex: new RegExp(rule.pattern, resolveFlags(rule.flags)), replacement: rule.replacement, isRegex: true as const };
      } catch {
        return null;
      }
    }
    return { pattern: rule.pattern, replacement: rule.replacement, isRegex: false as const };
  }).filter((e): e is NonNullable<typeof e> => e !== null);
  fusedFilterCache.set(config, compiled);
  return compiled;
}
const MAX_TOOL_CALL_ID_LENGTH = 64;
function sanitizeToolCallIdFused(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+/, "").slice(0, MAX_TOOL_CALL_ID_LENGTH);
  return normalized === "" ? "call_generated" : normalized;
}
function allocateTargetIdFused(sourceId: string, usedIds: Set<string>): string {
  const base = sanitizeToolCallIdFused(sourceId);
  let target = base;
  let suffix = 2;
  while (usedIds.has(target)) target = `${base.slice(0, MAX_TOOL_CALL_ID_LENGTH - String(suffix).length - 1)}_${suffix++}`;
  usedIds.add(target);
  return target;
}
function mergeAdjacentMessagesFused(messages: readonly import("../types/content.js").NormalizedMessage[]): import("../types/content.js").NormalizedMessage[] {
  const merged: import("../types/content.js").NormalizedMessage[] = [];
  for (const message of messages) {
    const prev = merged.at(-1);
    if (prev === undefined || prev.role !== message.role) {
      merged.push(message);
      continue;
    }
    merged[merged.length - 1] = { ...prev, content: [...prev.content, ...message.content] };
  }
  return merged;
}
function applyFusedCompression(
  request: NewProxyRequest,
  filterConfig: FilterRuleConfig | null,
  tokenSaverConfig: (TokenSaverConfig & { emergency?: boolean }) | null,
): NewProxyRequest {
  const filtered = filterConfig === null
    ? request
    : applyFilterRules(request as unknown as import("../types/request.js").ProxyRequest, filterConfig) as NewProxyRequest;
  const compressed = tokenSaverConfig === null
    ? filtered
    : applyTokenSaver(filtered as unknown as import("../types/request.js").ProxyRequest, tokenSaverConfig) as NewProxyRequest;
  return repairToolCallRequest(compressed as unknown as import("../types/request.js").ProxyRequest).request as NewProxyRequest;
}

// Injected ports — new executor
// ---------------------------------------------------------------------------

export interface RequestPersistencePorts {
  getSnapshot(): Promise<RoutingSnapshot>;
  accountPorts: AccountEligibilityPorts | null;
  telemetry: TelemetryPort;
}

export interface ProviderPort {
  call(candidateId: string, request: NewProxyRequest): Promise<ProviderOutput>;
}

export interface RequestOptions {
  readonly requestId: string;
  readonly requestedModel: string;
  readonly proxyRequest: NewProxyRequest;
  readonly affinityKey?: AffinityKey | null;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
  readonly apiKeyId?: string | null;
  readonly apiKeyPrefix?: string | null;
}

// ---------------------------------------------------------------------------
// Legacy public exports — keep live callers (app/composition, console, routing,
// tests) working without edits. These are real adapters to the new executor
// semantics (single compression, snapshot, commit/release), not empty stubs.
// ---------------------------------------------------------------------------

export interface ProxyRoutePlan {
  readonly affinity: AffinityKey;
  readonly candidates: readonly RouteCandidate[];
  readonly requestedModel?: string;
  readonly unsupportedReason?: string;
  readonly webSearch?: boolean;
  readonly webSearchPassthrough?: boolean;
  readonly maxAttempts?: number;
}

export interface RouteAttemptSelection {
  readonly accountId: string | null;
  readonly proxyId: string | null;
}

export interface ProxyRequestLogEvent {
  readonly event: "incoming" | "complete" | "failed" | "aborted" | "switch";
  readonly requestId: string;
  readonly endpoint: RunProxyRequestInput["endpoint"];
  readonly providerId: string | null;
  readonly model: string | null;
  readonly status: number | null;
  readonly errorKind: ApplicationErrorKind | null;
  readonly durationMs: number;
  readonly inputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly clientName: string;
  readonly clientSource: string;
  readonly clientIp: string | null;
  readonly accountId: string | null;
  readonly proxyId: string | null;
  readonly reasoningTokens: number | null;
  readonly switch?: {
    readonly scope: "account" | "proxy" | "provider";
    readonly fromCandidateId: string;
    readonly toCandidateId: string | null;
    readonly fromAccountId: string | null;
    readonly toAccountId: string | null;
    readonly reason: string;
  };
}

export interface ProxyRequestDependencies {
  readonly requestLimits: RequestLimits;
  readonly providers: { get(providerId: string): Adapter | undefined };
  readonly accounts: CredentialSelector;
  readonly network: NetworkSelector;
  readonly telemetry?: TelemetryWriter;
  readonly resolveRoutes: (request: NewProxyRequest, affinity: AffinityKey, client: ClientIdentity, disableRemoteMapping?: boolean) => Promise<ProxyRoutePlan>;
  readonly accountCandidates: (providerId: string) => Promise<readonly AccountCandidate[]>;
  readonly getProviderRouting?: (providerId: string) => { readonly strategy: "priority" | "round-robin"; readonly stickyLimit: number; readonly useStickyLimit: boolean };
  readonly onRouteFailure?: (candidate: RouteCandidate, error: InternalFailure, selected: RouteAttemptSelection | null) => Promise<void>;
  readonly onRouteSuccess?: (candidate: RouteCandidate, selected: RouteAttemptSelection | null) => Promise<void>;
  readonly onRouteSwitch?: (event: RouteSwitch) => Promise<void>;
  readonly onRequestLog?: (event: ProxyRequestLogEvent) => void;
  readonly admission?: ApiKeyAdmission;
  readonly maxAttempts?: number;
  readonly tokenSaver?: () => TokenSaverConfig;
  readonly filterRules?: () => FilterRuleConfig;
  readonly globalPersona?: () => GlobalPersonaSnapshot | null;
  readonly createPayloadCapture?: (requestId: string) => { save(requestId: string, kind: "client_request" | "provider_request" | "provider_response" | "client_response", artifact: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number }): void } | null;
}

export interface ProxyAuthorization {
  readonly apiKeyId: string | null;
  readonly apiKey?: ApiKeyPublic;
  readonly trustedIdentity: string | null;
  readonly providerAllowlist?: readonly string[] | null;
  readonly modelAllowlist?: readonly string[] | null;
  readonly modelDenylist?: readonly string[] | null;
}

export interface AuthorizedProxyRequestInput {
  readonly request: RunProxyRequestInput;
  readonly authorization: ProxyAuthorization;
}

function admissionInputTokens(usage: ProviderUsage, fallback: number): number {
  const input = (usage as unknown as { inputTokens?: number | null }).inputTokens ?? usage.promptTokens ?? null;
  if (input === null || input === undefined) return fallback;
  const cacheRead = (usage as unknown as { cacheReadTokens?: number | null; cachedTokens?: number | null }).cacheReadTokens ?? usage.cachedTokens ?? 0;
  const cacheWrite = (usage as unknown as { cacheWriteTokens?: number | null }).cacheWriteTokens ?? 0;
  return Math.max(0, Math.floor(input) + Math.floor(cacheRead) + Math.floor(cacheWrite));
}

function selectWireSurface(adapter: Adapter, candidate: RouteCandidate, request: NewProxyRequest): Surface | null {
  const model = adapter.models.get(candidate.modelId);
  return resolveModelWireSurface(adapter.metadata as unknown as Parameters<typeof resolveModelWireSurface>[0], adapter.capabilities, model?.capabilities ?? null, request.sourceSurface);
}

function normalizeProviderError(error: unknown): InternalFailure {
  if (isInternalFailure(error)) return normalizeInternalFailure(error);
  if (error instanceof ProtocolCodecError) return normalizeInternalFailure(internalFailureFromUnknown(error));
  const sanitized = sanitizeMessage(error instanceof Error ? error.message : String(error));
  return normalizeInternalFailure({
    statusCode: null,
    kind: "internal_error",
    retryable: false,
    routeScope: null,
    source: deriveErrorSource("internal_error", null),
    safeMessage: sanitized,
    message: error instanceof Error ? error.message : String(error),
    retryAt: null,
  } as unknown as InternalFailure) as InternalFailure;
}

interface TelemetryStartHandle {
  recordFirstByte?(): void;
  recordFirstToken?(): void;
  finish(input: unknown): Promise<void>;
}

function telemetryStart(
  input: RunProxyRequestInput,
  requestId: string,
  client: ClientIdentity,
  authorization: ProxyAuthorization,
  telemetry: TelemetryWriter | undefined,
): TelemetryStartHandle {
  if (!telemetry) {
    return { recordFirstByte: () => {}, recordFirstToken: () => {}, finish: async () => {}, } as unknown as TelemetryStartHandle;
  }
  const snap: HeaderSnapshot = snapshotFromHeaders(input.headers);
  return telemetry.start({
    requestId,
    endpoint: input.endpoint,
    surface: input.surface,
    client: { name: (() => { const raw = snap.clientName; const trimmed = raw !== null ? scanTrim(raw) : ""; return trimmed.length > 0 ? trimmed : client.name; })(), source: snap.clientName ? "explicit_header" : client.source },
    apiKeyId: authorization.apiKeyId,
    apiKeyPrefix: authorization.apiKey?.keyPrefix ?? null,
    trustedIdentity: authorization.trustedIdentity,
    clientIp: input.clientIp ?? null,
    userAgent: snap.userAgent,
    fingerprint: snap.fingerprint,
    safeHeaders: {
      accept: snap.accept ?? "",
      "content-type": snap.contentType ?? "",
      "x-client-name": snap.clientName ?? "",
      "x-request-id": snap.requestId ?? "",
      "x-forwarded-proto": snap.forwardedProto ?? "",
    },
  } as unknown as Parameters<TelemetryWriter["start"]>[0]) as unknown as TelemetryStartHandle;
}

// ---------------------------------------------------------------------------
// Inlined prepare — one parse, one compression, immutable snapshot
// ---------------------------------------------------------------------------

export interface PreparedProxyRequest {
  readonly request: NewProxyRequest;
  readonly admissionEstimate: number;
  readonly formatDetection: FormatDetectionResult;
  readonly translationDiagnostics: readonly TranslationDiagnostic[];
}

export async function prepareProxyRequest(input: AuthorizedProxyRequestInput, dependencies: ProxyRequestDependencies): Promise<PreparedProxyRequest> {
  const rawBody = input.request.body;
  const requestLimits = dependencies.requestLimits;
  let parsed: unknown;
  if (typeof rawBody === "string") {
    const result = parseRequestBody(rawBody, requestLimits);
    if (isProtocolError(result)) throw result;
    parsed = result;
  } else {
    parsed = rawBody;
  }
  const snap = snapshotFromHeaders(input.request.headers);
  const formatDetection = detectClientFormat(input.request.endpoint, input.request.surface, snap, parsed);
  const normalizedEndpoint = normalizationEndpoint(input.request.endpoint, formatDetection);
  const translationDiagnostics = diagnosticsForDetection(input.request.endpoint, input.request.surface, formatDetection, normalizedEndpoint);
  const normalized = normalizeRequest(normalizedEndpoint, parsed, { signal: input.request.signal, limits: requestLimits });
  if (!normalized.ok) throw normalized.error;
  // Fused compression: single messages.map with structural sharing (G-FILTER-08 order preserved)
  const filterRulesConfig = dependencies.filterRules?.() ?? null;
  const tokenSaverRaw = dependencies.tokenSaver?.() ?? null;
  const tokenSaverConfig = tokenSaverRaw ? { ...tokenSaverRaw, emergency: normalized.request.messages.length > COMPRESSION_EMERGENCY_MESSAGE_THRESHOLD } : null;
  const preparedRequest = applyFusedCompression(
    normalized.request as unknown as NewProxyRequest,
    filterRulesConfig,
    tokenSaverConfig,
  );
  // Global locked persona: prepend-first system message, before the cache
  // plan so it joins the stable prefix instead of leaking across cache keys.
  const personaSnapshot = dependencies.globalPersona?.() ?? null;
  const personifiedRequest = personaSnapshot !== null && personaSnapshot.enabled
    ? applyGlobalPersona(preparedRequest as unknown as import("../types/request.js").ProxyRequest, personaSnapshot)
    : preparedRequest;
  const admissionBody = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const hasApiKey = input.authorization.apiKey !== undefined && input.authorization.apiKey !== null;
  const admissionEstimate = dependencies.admission !== undefined && hasApiKey ? estimateRequestTokens(admissionBody) : 0;
  const apiKeyId = input.authorization.apiKeyId;
  const trustedIdentity = input.authorization.trustedIdentity;
  const affinityKey = apiKeyId !== null && apiKeyId !== undefined
    ? `api_key:${apiKeyId}`
    : `trusted_identity:${trustedIdentity ?? "anonymous"}`;
  return {
    request: applyCachePlan(personifiedRequest as unknown as import("../types/request.js").ProxyRequest, buildCachePlan(personifiedRequest as unknown as import("../types/request.js").ProxyRequest), affinityKey) as unknown as NewProxyRequest,
    admissionEstimate,
    formatDetection,
    translationDiagnostics,
  };
}

// Re-export the new proxy route plan type alias for downstream slices
export type { NewProxyRoutePlan };

// Symbols below are exported for cross-slice use (executor.ts consumes them
// from prepare.ts — single source of truth per phase2 plan).
export { createAccountManager };
export { admissionInputTokens, selectWireSurface, telemetryStart, normalizeProviderError };

// Re-export types so other slices can `import type` from this module.
export type { TelemetryStartHandle, TelemetryEvent };
