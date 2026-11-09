import type { CapabilitySeed, ModelCapabilityCategory, ModelMetadataSeed, ProviderModelCatalog } from "../types/provider.js";
import type { FieldDisposition } from "../protocol-request.js";

import { isRecord } from "../validation.js";
import type { ClientFormat, ClientProfile } from "./cross-surface.js";
import { classifyProviderFailure } from "../types/error-types.js";
import type { ModelCacheMode, ModelCompatibility, ModelSamplingCompatibility, ModelToolCompatibility, ProviderCaps, ProviderModel, ProviderQuirkPolicy } from "../types/provider.js";
import type { InternalFailure } from "../types/error-types.js";
import type { ProviderFailureCode, ReasoningEffort, Surface } from "../types/surface.js";
import type { ProviderRequest, ProxyRequest } from "../types/request.js";
import type { TranslationDiagnostic } from "../types/telemetry.js";

export type CanonicalEffort = ReasoningEffort;

export type SupportLevel = "supported" | "unsupported" | "unknown";

export interface ReasoningCapabilities {
  readonly supported: boolean;
  readonly efforts: readonly CanonicalEffort[];
  readonly effortMap?: Readonly<Record<string, string>>;
  readonly maxTokens: SupportLevel;
  readonly budget?: boolean;
  readonly summary: boolean;
  readonly disable?: boolean;
  readonly modes: readonly string[];
}

export interface SamplingCapabilities {
  readonly temperature: boolean;
  readonly topP: boolean;
  readonly stop: boolean;
}

export interface CacheCapabilities {
  readonly mode?: ModelCacheMode;
  readonly read: boolean;
  readonly write: boolean;
  readonly key: boolean;
  readonly breakpoints: boolean;
  readonly breakpointLimit?: number;
  readonly minimumPrefixTokens?: number;
  readonly ttl: readonly string[];
  readonly options: readonly string[];
}

export interface ToolCapabilities {
  readonly function: boolean;
  readonly native: readonly string[];
  readonly nativeTypes?: readonly string[];
  readonly parallel: boolean;
  readonly resultIdRequired?: boolean;
  /** When false, a forced tool choice is downgraded to `auto` before the wire. */
  readonly forcedChoice?: boolean;
}

export interface ResponseCapabilities {
  readonly jsonObject: boolean;
  readonly jsonSchema: boolean;
}

export interface ResponseStateCapabilities {
  readonly previousResponseId: boolean;
  readonly staleRepair: boolean;
}

export interface TimeoutProfileCapabilities {
  readonly firstByteMs?: number;
  readonly idleMs?: number;
}

export interface MediaCapabilities {
  readonly images: boolean;
  readonly pdf: boolean;
  readonly video: boolean;
}

export interface ModelCapabilities {
  readonly surfaces: readonly Surface[];
  readonly streaming: boolean;
  readonly reasoning: ReasoningCapabilities;
  readonly sampling?: SamplingCapabilities;
  readonly cache: CacheCapabilities;
  readonly tools: ToolCapabilities;
  readonly response: ResponseCapabilities;
  readonly responseState?: ResponseStateCapabilities;
  readonly streamUsage?: boolean;
  readonly timeoutProfile?: TimeoutProfileCapabilities;
  readonly media: MediaCapabilities;
}

const ALL_EFFORTS: readonly CanonicalEffort[] = ["xhigh", "high", "medium", "low", "minimal", "none"];

const DEFAULT_CACHE_TTL: readonly string[] = ["30m", "5m", "1h"];

/** Resolves model capabilities without treating provider aggregate OR flags as model guarantees. */
export function resolveModelCapabilities(provider: ProviderCaps, model: ProviderModel | null, targetSurface: Surface): ModelCapabilities {
  if (model !== null) return fromCaps(model.capabilities, targetSurface, model.compatibility);
  return conservativeUnknown(provider, targetSurface);
}

/** Selects the provider-native wire surface for one routed model. */
export function resolveModelWireSurface(
  metadata: { readonly protocol?: string },
  providerCaps: ProviderCaps,
  modelCaps: ProviderCaps | null,
  clientSurface: Surface,
): Surface | null {
  const caps = modelCaps ?? providerCaps;
  const surfaces: readonly Surface[] = Array.isArray((caps as { readonly surfaces?: readonly Surface[] }).surfaces)
    ? ((caps as { readonly surfaces?: readonly Surface[] }).surfaces ?? [])
    : [];
  if (surfaces.length === 0) return clientSurface;
  if (clientSurface === "web-search" || clientSurface === "images") return surfaces.includes(clientSurface) ? clientSurface : null;
  if (surfaces.includes(clientSurface)) return clientSurface;
  const protocol = metadata.protocol;
  if (protocol === "anthropic") return surfaces.includes("anthropic-messages") ? "anthropic-messages" : null;
  if (protocol === "exa") return surfaces.includes("web-search") ? "web-search" : null;
  const openAIFallback: readonly Surface[] = ["openai-chat", "openai-responses"];
  for (const candidate of openAIFallback) if (surfaces.includes(candidate)) return candidate;
  return null;
}

/** Projects provider capabilities and optional model-local metadata into a feature matrix. */
export function fromCaps(caps: ProviderCaps, targetSurface: Surface, compatibility?: ModelCompatibility): ModelCapabilities {
  return {
    surfaces: caps.surfaces.includes(targetSurface) ? [...caps.surfaces] : [],
    streaming: caps.streaming,
    reasoning: resolveReasoning(caps, targetSurface, compatibility?.reasoning),
    sampling: resolveSampling(caps, compatibility?.sampling),
    cache: resolveCache(caps, compatibility?.cache),
    tools: resolveTools(caps, compatibility?.tools),
    response: {
      jsonObject: caps.surfaces.includes("openai-chat") || caps.surfaces.includes("openai-responses"),
      jsonSchema: caps.surfaces.includes("openai-responses"),
    },
    responseState: {
      previousResponseId: compatibility?.responseState?.previousResponseId === true,
      staleRepair: compatibility?.responseState?.staleRepair === true,
    },
    streamUsage: compatibility?.streamUsage === true,
    timeoutProfile: normalizeTimeoutProfile(compatibility?.timeoutProfile),
    media: {
      images: caps.images === true,
      pdf: caps.pdf === true,
      video: caps.video === true,
    },
  };
}

function resolveReasoning(
  caps: ProviderCaps,
  targetSurface: Surface,
  descriptor: ModelCompatibility["reasoning"],
): ReasoningCapabilities {
  const supported = caps.reasoning;
  const effortMap = descriptor === undefined ? undefined : normalizeEffortMap(descriptor.effortMap);
  let efforts: readonly CanonicalEffort[] = [];
  let maxTokens: SupportLevel = "unsupported";
  let summary = false;
  let disable = false;
  let modes: readonly string[] = [];
  if (!supported) {
    maxTokens = "unsupported";
  } else if (descriptor === undefined) {
    efforts = [...ALL_EFFORTS] as readonly ReasoningEffort[];
    maxTokens = targetSurface === "openai-responses" ? "supported" : "unknown";
    summary = targetSurface === "openai-responses" || targetSurface === "openai-chat";
    modes = ["standard", "pro"];
  } else {
    if (descriptor.efforts !== undefined) efforts = normalizeEfforts(descriptor.efforts);
    else efforts = Object.keys(effortMap ?? {}).filter(isCanonicalEffort);
    if (descriptor.budget === true) maxTokens = "supported";
    else if (descriptor.budget === false) maxTokens = "unsupported";
    else maxTokens = "unknown";
    summary = descriptor.summary === true;
    disable = descriptor.disable === true;
  }
  return {
    supported,
    efforts,
    ...(effortMap === undefined ? {} : { effortMap }),
    maxTokens,
    budget: maxTokens === "supported",
    summary,
    disable,
    modes,
  };
}

function resolveSampling(caps: ProviderCaps, descriptor: ModelSamplingCompatibility | undefined): SamplingCapabilities {
  if (descriptor !== undefined) {
    return {
      temperature: samplingFlag(descriptor.temperature, "temperature", descriptor.supported),
      topP: samplingFlag(descriptor.topP, "top_p", descriptor.supported),
      stop: samplingFlag(descriptor.stop, "stop", descriptor.supported),
    };
  }
  return {
    temperature: true,
    topP: false,
    stop: false,
  };
}

function resolveCache(caps: ProviderCaps, descriptor: ModelCompatibility["cache"]): CacheCapabilities {
  if (descriptor === undefined) {
    const mode: ModelCacheMode = caps.explicitCache ? "explicit" : "none";
    return {
      mode,
      read: caps.explicitCache,
      write: caps.explicitCache,
      key: caps.explicitCache,
      breakpoints: caps.explicitCache,
      ttl: caps.explicitCache ? DEFAULT_CACHE_TTL : [],
      options: caps.explicitCache ? ["mode", "ttl"] : [],
    };
  }
  const mode = descriptor.mode ?? "none";
  const breakpointLimit = positiveNumber(descriptor.breakpoints, true);
  const minimumPrefixTokens = positiveNumber(descriptor.minimumPrefixTokens, true);
  const breakpoints = breakpointLimit !== undefined;
  const ttl = descriptor.ttl === true ? DEFAULT_CACHE_TTL : [];
  const options = [
    ...(descriptor.mode !== undefined && mode !== "none" ? ["mode"] : []),
    ...(descriptor.ttl === true ? ["ttl"] : []),
    ...(breakpoints ? ["breakpoints"] : []),
    ...(minimumPrefixTokens === undefined ? [] : ["minimum_prefix_tokens"]),
  ];
  return {
    mode,
    read: mode !== "none",
    write: mode !== "none",
    key: mode === "explicit",
    breakpoints,
    ...(breakpointLimit === undefined ? {} : { breakpointLimit }),
    ...(minimumPrefixTokens === undefined ? {} : { minimumPrefixTokens }),
    ttl,
    options,
  };
}

function resolveTools(caps: ProviderCaps, descriptor: ModelToolCompatibility | undefined): ToolCapabilities {
  const nativeTypes = descriptor === undefined ? [] : normalizeNativeTypes(descriptor.nativeTypes);
  return {
    function: caps.toolCalls,
    native: nativeTypes,
    nativeTypes,
    parallel: descriptor?.parallel === true,
    resultIdRequired: descriptor?.resultIdRequired === true,
    ...(caps.forcedToolChoice === undefined ? {} : { forcedChoice: caps.forcedToolChoice }),
  };
}

function conservativeUnknown(provider: ProviderCaps, targetSurface: Surface): ModelCapabilities {
  return {
    surfaces: provider.surfaces.includes(targetSurface) ? [targetSurface] : [],
    streaming: provider.streaming,
    reasoning: { supported: false, efforts: [], maxTokens: "unknown", budget: false, summary: false, disable: false, modes: [] },
    sampling: { temperature: false, topP: false, stop: false },
    cache: { mode: "none", read: false, write: false, key: false, breakpoints: false, ttl: [], options: [] },
    tools: { function: false, native: [], nativeTypes: [], parallel: false, resultIdRequired: false },
    response: { jsonObject: false, jsonSchema: false },
    responseState: { previousResponseId: false, staleRepair: false },
    streamUsage: false,
    timeoutProfile: {},
    media: { images: false, pdf: false, video: false },
  };
}

function normalizeEfforts(values: readonly CanonicalEffort[]): readonly CanonicalEffort[] {
  return values.filter((value, index): value is CanonicalEffort => isCanonicalEffort(value) && values.indexOf(value) === index);
}

function normalizeEffortMap(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(value).filter(([key, mapped]) => isCanonicalEffort(key) && mapped.trim().length > 0);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function normalizeNativeTypes(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return value.filter((item, index): item is string => item.trim().length > 0 && value.indexOf(item) === index);
}

function samplingFlag(value: boolean | undefined, field: "temperature" | "top_p" | "stop", supported: readonly string[] | undefined): boolean {
  if (value !== undefined) return value;
  return supported?.includes(field) ?? false;
}

function normalizeTimeoutProfile(profile: ModelCompatibility["timeoutProfile"]): TimeoutProfileCapabilities {
  if (profile === undefined) return {};
  const firstByteMs = positiveNumber(profile.firstByteMs);
  const idleMs = positiveNumber(profile.idleMs);
  return {
    ...(firstByteMs === undefined ? {} : { firstByteMs }),
    ...(idleMs === undefined ? {} : { idleMs }),
  };
}

function positiveNumber(value: number | undefined, allowZero = false): number | undefined {
  if (value === undefined || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) return undefined;
  return value;
}

function isCanonicalEffort(value: string): value is CanonicalEffort {
  return ALL_EFFORTS.includes(value as CanonicalEffort);
}

export { aggregateCapabilities, capabilitiesOf, categoriesOf, createModelCatalog, modelOf } from "../types/provider.js";

export interface TranslationPolicy {
  readonly preserveExtensions: boolean;
  readonly retryOptionalCompatibility: boolean;
  readonly emitDiagnostics: boolean;
}

export interface TranslationDiagnosticSink {
  record(diagnostic: TranslationDiagnostic): void;
}

export interface TranslationContext {
  readonly source: {
    readonly client: ClientProfile;
    readonly format: ClientFormat;
    readonly surface: Surface;
  };
  readonly target: {
    readonly providerId: string;
    readonly modelId: string;
    readonly upstreamModelId: string;
    readonly surface: Surface;
    readonly capabilities: ModelCapabilities;
  };
  readonly policy: TranslationPolicy;
  readonly diagnostics: TranslationDiagnosticSink;
}

export interface FeatureTranslation<T> {
  readonly value: T;
  readonly dispositions: readonly FieldDisposition[];
  readonly diagnostics: readonly TranslationDiagnostic[];
}

export interface CompatibilityRejection {
  readonly category: "unsupported-field" | "unsupported-cache" | "unsupported-reasoning" | "unsupported-tool" | "unsupported-response";
  readonly fieldPath: string;
  readonly optional: boolean;
  readonly retryable: boolean;
}

export interface CompatibilityRule {
  match(error: InternalFailure): CompatibilityRejection | null;
  remove(payload: Record<string, unknown>, rejection: CompatibilityRejection): void;
}

export function createTranslationContext(input: Omit<TranslationContext, "policy"> & { readonly policy?: Partial<TranslationPolicy> }): TranslationContext {
  return {
    ...input,
    policy: {
      preserveExtensions: input.policy?.preserveExtensions ?? true,
      retryOptionalCompatibility: input.policy?.retryOptionalCompatibility ?? true,
      emitDiagnostics: input.policy?.emitDiagnostics ?? true,
    },
  };
}

export interface DirectAdapterException {
  readonly providerId: string;
  readonly surfaces: readonly Surface[];
  readonly reason: string;
  readonly sharedPolicyBoundary: "protocol-translation" | "auth-exchange" | "binary-transport" | "search-api" | "media-api";
}

/**
 * Explicitly documents adapters that cannot use the JSON surface translation
 * because their wire protocol is not an LLM JSON translation surface.
 */
export const DIRECT_ADAPTER_EXCEPTIONS: readonly DirectAdapterException[] = [
  { providerId: "antigravity", surfaces: ["openai-chat", "openai-responses"], reason: "Google internal generateContent lifecycle", sharedPolicyBoundary: "media-api" },
  { providerId: "commandcode", surfaces: ["openai-chat"], reason: "Gateway-specific request envelope and stream framing", sharedPolicyBoundary: "protocol-translation" },
  { providerId: "cline", surfaces: ["openai-chat"], reason: "Cline-specific OAuth and stream normalization", sharedPolicyBoundary: "protocol-translation" },
  { providerId: "cloudflare", surfaces: ["openai-chat"], reason: "Workers AI response envelope", sharedPolicyBoundary: "protocol-translation" },
  { providerId: "cursor", surfaces: ["openai-responses"], reason: "Cursor protobuf/binary session transport", sharedPolicyBoundary: "binary-transport" },
  { providerId: "kiro", surfaces: ["openai-chat"], reason: "OAuth exchange and gateway-specific stream framing", sharedPolicyBoundary: "auth-exchange" },
  { providerId: "qoder", surfaces: ["openai-chat"], reason: "PAT exchange and gateway-specific stream framing", sharedPolicyBoundary: "auth-exchange" },
];

/** Normalizes client-specific effort names into the canonical reasoning contract. */
export function normalizeClientEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return "medium";
  const normalized = value.trim().toLowerCase().replace(/[-_\s]/g, "");
  if (normalized === "") return undefined;
  if (normalized === "none" || normalized === "off" || normalized === "disabled") return "none";
  if (normalized === "minimal") return "minimal";
  if (normalized === "low") return "low";
  if (normalized === "medium" || normalized === "default" || normalized === "auto") return "medium";
  if (normalized === "high") return "high";
  if (normalized === "xhigh" || normalized === "max" || normalized === "maximum" || normalized === "ultra" || normalized === "ultrahigh" || normalized === "ultracode") return "xhigh";
  return "medium";
}

/** Projects canonical effort into a target protocol vocabulary. */
export function projectEffort(value: unknown, targetSurface: Surface, supported: readonly ReasoningEffort[] = []): ReasoningEffort | undefined {
  const effort = normalizeClientEffort(value);
  if (effort === undefined || effort === "none") return effort;
  if (targetSurface === "anthropic-messages") {
    if (effort === "minimal" || effort === "low") return "low";
    if (effort === "xhigh" || effort === "high") return "high";
    return "medium";
  }
  if (supported.length === 0 || supported.includes(effort)) return effort;
  if (effort === "xhigh" && supported.includes("high")) return "high";
  if (effort === "minimal" && supported.includes("low")) return "low";
  if (supported.includes("medium")) return "medium";
  return supported[0];
}

const ALLOWED_EXTENSIONS: Readonly<Partial<Record<Surface, readonly string[]>>> = {
  "openai-chat": ["store", "user", "service_tier", "safety_identifier"],
  "openai-responses": ["store", "background", "truncation", "service_tier", "safety_identifier", "additional_tools"],
  "anthropic-messages": ["service_tier", "context_management"],
  "web-search": [],
  images: [],
};

/** Preserves bounded canonical fields and explicitly registered same-surface extensions. */
export function preserveWireExtensions(payload: Record<string, unknown>, request: ProxyRequest, targetSurface: Surface, canonicalFields: readonly string[]): void {
  if (request.sourceSurface !== targetSurface || request.wirePayload === undefined) return;
  for (const field of canonicalFields) {
    const value = request.wirePayload[field];
    if (value !== undefined && isSafeExtension(value)) payload[field] = value;
  }
  for (const field of ALLOWED_EXTENSIONS[targetSurface] ?? []) {
    if (canonicalFields.includes(field)) continue;
    const value = request.wirePayload[field];
    if (value !== undefined && isSafeExtension(value)) payload[field] = value;
  }
}

function isSafeExtension(value: unknown): boolean {
  if (typeof value === "string") return value.length <= 8_192;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length <= 128 && value.every(isSafeExtension);
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 128 && entries.every(([key, child]) => key.length <= 128 && isSafeExtension(child));
}

/** Reasons returned by the bounded provider-local retry policy. */
export type ProviderRetryReason =
  | ProviderFailureCode
  | "retry_exhausted"
  | "semantic_output"
  | "post_semantic_failure";

/** Attempt phase used by the provider-local retry policy. */
export type ProviderRetryPhase = "pre_response" | "pre_content" | "streaming" | "post_semantic" | "post_content" | "terminal";

/** Output state used by the provider-local retry policy. */
export type ProviderRetryOutputState = "none" | "lifecycle" | "semantic" | "terminal";

/**
 * Bounded, side-effect-free state supplied to {@link decideProviderRetry}.
 *
 * `retryCount` is the number of provider-local retries already consumed. The
 * optional aliases keep the helper easy to use with existing stream lifecycle
 * state while retaining a conservative default of no output.
 */
export interface ProviderRetryState {
  readonly phase: ProviderRetryPhase;
  readonly output?: ProviderRetryOutputState;
  readonly outputState?: ProviderRetryOutputState;
  readonly semanticOutput?: boolean;
  readonly terminalSeen?: boolean;
  readonly retryCount?: number;
  readonly retries?: number;
}

/** Result of a provider-local retry policy evaluation. */
export interface ProviderRetryDecision {
  readonly retryable: boolean;
  readonly reason: ProviderRetryReason;
}

const PROVIDER_LOCAL_RETRY_CODES: readonly ProviderFailureCode[] = [
  "stale_response_state",
  "empty_provider_body",
  "provider_finish_error",
  "optional_parameter_rejected",
];

/**
 * Decides whether a provider failure can be retried locally without replaying
 * semantic output. The policy permits at most one retry and never inspects or
 * returns an upstream body.
 */
export function decideProviderRetry(error: InternalFailure, state: ProviderRetryState): ProviderRetryDecision {
  const output = state.outputState ?? state.output;
  const semanticOutput = state.semanticOutput === true || output === "semantic";
  const terminalSeen = state.terminalSeen === true || output === "terminal";
  const retryCount = state.retryCount ?? state.retries ?? 0;
  const code = providerFailureCode(error);

  if (semanticOutput || terminalSeen) {
    return { retryable: false, reason: terminalSeen ? "post_semantic_failure" : "semantic_output" };
  }
  if (!Number.isFinite(retryCount) || retryCount < 0 || retryCount >= 1) {
    return { retryable: false, reason: "retry_exhausted" };
  }
  if (state.phase !== "pre_response" && state.phase !== "pre_content") {
    return { retryable: false, reason: "post_semantic_failure" };
  }
  if ((PROVIDER_LOCAL_RETRY_CODES as readonly ProviderFailureCode[]).includes(code)) {
    return { retryable: true, reason: code };
  }
  return { retryable: false, reason: code };
}

function providerFailureCode(error: InternalFailure): ProviderFailureCode {
  if (error.failureCode !== null) return error.failureCode;
  return classifyProviderFailure({
    statusCode: error.statusCode,
    message: error.safeMessage,
    kind: error.kind,
  });
}

/** Classifies explicit optional-parameter rejections for a bounded fallback. */
export function classifyCompatibilityRejection(error: InternalFailure): CompatibilityRejection | null {
  const stableCode = error.failureCode;
  if (stableCode !== null && stableCode !== "optional_parameter_rejected") return null;
  if (stableCode === null && error.statusCode !== 400) return null;
  const message = error.safeMessage.toLowerCase();
  const fieldPath = extractRejectedField(message);
  if (fieldPath === null) return null;
  const category = compatibilityCategory(fieldPath, message);
  const optional = isOptionalProjectionPath(fieldPath);
  return { category, fieldPath, optional, retryable: optional };
}

/** Records a secret-free compatibility retry decision for request metadata. */
export function recordCompatibilityFallback(request: ProviderRequest, rejection: CompatibilityRejection): void {
  const fieldPath = isOptionalProjectionPath(rejection.fieldPath) ? normalizeFieldPath(rejection.fieldPath) : "optional provider projection";
  request.recordDiagnostic?.({
    stage: "policy",
    sourceFormat: request.request.sourceSurface,
    targetSurface: request.target.surface,
    fieldCategory: rejection.category,
    action: "fallback",
    reason: `retried without ${fieldPath}`,
  });
}

/** Removes one allowlisted optional projection while preserving semantic content. */
export function removeCompatibilityProjection(payload: Record<string, unknown>, rejection: CompatibilityRejection): boolean {
  if (!rejection.optional || !rejection.retryable) return false;
  const path = normalizeFieldPath(rejection.fieldPath);
  if (!isOptionalProjectionPath(path)) return false;
  if (path === "prompt_cache_options") {
    delete payload.prompt_cache_options;
    removeNestedField(payload.input, "prompt_cache_breakpoint");
    removeNestedField(payload.messages, "prompt_cache_breakpoint");
    return true;
  }
  if (path.startsWith("prompt_cache_options.")) {
    return removeNestedField(payload.prompt_cache_options, path.slice("prompt_cache_options.".length));
  }
  if (path === "prompt_cache_breakpoint") {
    return removeNestedField(payload.input, "prompt_cache_breakpoint") || removeNestedField(payload.messages, "prompt_cache_breakpoint");
  }
  if (path === "reasoning") return deletePayloadField(payload, "reasoning");
  if (path.startsWith("reasoning.")) return removeNestedField(payload.reasoning, path.slice("reasoning.".length));
  if (path === "reasoning_effort" || path === "thinking") return deletePayloadField(payload, path);
  if (path === "output_config") return deletePayloadField(payload, path);
  if (path.startsWith("output_config.")) return removeNestedField(payload.output_config, path.slice("output_config.".length));
  if (path === "response_format" || path === "parallel_tool_calls" || path === "tool_choice" || path === "stream_options") {
    return deletePayloadField(payload, path);
  }
  return false;
}

function compatibilityCategory(fieldPath: string, message: string): CompatibilityRejection["category"] {
  if (/cache|prompt_cache/.test(fieldPath) || /cache/.test(message)) return "unsupported-cache";
  if (/reasoning|effort|thinking/.test(fieldPath) || /reasoning|effort|thinking/.test(message)) return "unsupported-reasoning";
  if (/tool/.test(fieldPath) || /tool/.test(message)) return "unsupported-tool";
  if (/response|format|json/.test(fieldPath) || /response|format|json/.test(message)) return "unsupported-response";
  return "unsupported-field";
}

function isOptionalProjectionPath(value: string): boolean {
  const path = normalizeFieldPath(value);
  if (path === "prompt_cache_options" || path === "prompt_cache_breakpoint") return true;
  if (path.startsWith("prompt_cache_options.")) return true;
  if (path === "reasoning" || path === "reasoning_effort" || path === "thinking") return true;
  if (/^reasoning\.(?:effort|max_tokens|summary|exclude|enabled|mode)$/.test(path)) return true;
  if (path === "output_config" || /^output_config\.effort$/.test(path)) return true;
  return path === "response_format" || path === "parallel_tool_calls" || path === "tool_choice" || path === "stream_options";
}

function normalizeFieldPath(value: string): string {
  return value.trim().toLowerCase().replace(/^["'`]|["'`]$/g, "");
}

function extractRejectedField(message: string): string | null {
  const match = message.match(/(?:unsupported parameter|parameter unsupported|unknown parameter|invalid parameter|unsupported field|unknown field)[:\s]+["'`]?([a-z][a-z0-9_.-]*)/i);
  if (match?.[1] !== undefined) return normalizeFieldPath(match[1]);
  const known = ["prompt_cache_options", "prompt_cache_breakpoint", "reasoning.max_tokens", "reasoning.effort", "output_config.effort", "response_format", "parallel_tool_calls", "tool_choice", "stream_options"];
  return known.find((field) => message.includes(field)) ?? null;
}

function removeNestedField(value: unknown, field: string): boolean {
  let removed = false;
  if (Array.isArray(value)) {
    for (const item of value) removed ||= removeNestedField(item, field);
    return removed;
  }
  if (!isRecord(value)) return false;
  if (Object.prototype.hasOwnProperty.call(value, field)) {
    delete value[field];
    removed = true;
  }
  for (const child of Object.values(value)) removed ||= removeNestedField(child, field);
  return removed;
}

function deletePayloadField(payload: Record<string, unknown>, field: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) return false;
  delete payload[field];
  return true;
}

;

export interface NativePassthroughContext {
  readonly client: ClientProfile;
  readonly source: Surface;
  readonly target: Surface;
  readonly providerAllowsNative: boolean;
}

/** Allows native passthrough only for explicit same-protocol, capability-approved clients. */
export function isNativePassthroughEligible(context: NativePassthroughContext): boolean {
  return context.providerAllowsNative
    && context.client.passthrough !== "never"
    && context.source === context.target
    && (context.source === "anthropic-messages" || context.source === "openai-chat" || context.source === "openai-responses")
    && context.client.format === context.source;
}

export type TranslationCapability = "reasoning" | "toolCalls" | "images" | "pdf" | "video" | "explicitCache" | "search";

/** Checks a provider capability before preserving a protocol-native semantic item. */
export function supportsTranslationCapability(capabilities: ProviderCaps, capability: TranslationCapability): boolean {
  switch (capability) {
    case "reasoning":
      return capabilities.reasoning === true;
    case "toolCalls":
      return capabilities.toolCalls === true;
    case "images":
      return capabilities.images === true;
    case "pdf":
      return capabilities.pdf === true;
    case "video":
      return capabilities.video === true;
    case "explicitCache":
      return capabilities.explicitCache === true;
    case "search":
      return capabilities.search === true;
    default:
      return false;
  }
}

/** Returns whether a target surface can carry a native block without visible-text loss. */
export function supportsNativeBlockSurface(surface: Surface, nativeType: string | undefined): boolean {
  if (nativeType === undefined) return false;
  if (surface === "anthropic-messages") return nativeType.startsWith("server_") || nativeType.endsWith("_tool_result") || nativeType === "compaction";
  if (surface === "openai-responses") return nativeType === "compaction" || nativeType === "reasoning";
  return false;
}

/** Returns whether the target protocol can preserve encrypted reasoning metadata. */
export function supportsEncryptedReasoning(surface: Surface): boolean {
  return surface === "openai-responses";
}

;

/** Global decision for source-wire preservation versus protocol adaptation. */
export type TranslationAction = "preserve" | "adapt";

export function translationAction(sourceSurface: Surface, targetSurface: Surface): TranslationAction {
  return sourceSurface === targetSurface ? "preserve" : "adapt";
}

/**
 * Preserves only bounded, explicitly registered source-wire extensions while
 * restoring canonical fields that were deliberately normalized.
 */
export function preserveWirePayload(
  payload: Record<string, unknown>,
  request: ProxyRequest,
  targetSurface: Surface,
  canonicalFields: readonly string[],
): void {
  if (translationAction(request.sourceSurface, targetSurface) !== "preserve") return;
  preserveWireExtensions(payload, request, targetSurface, canonicalFields);
}

;


