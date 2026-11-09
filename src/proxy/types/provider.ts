/**
 * Provider domain — provider meta, model catalog, capabilities, compatibility, provider output
 * Manual write - contains actual definitions, no re-export from ../types.js to avoid circular
 * This file is the source for provider-related types, types.ts will import and re-export from here
 */

import type { Surface, ProviderProtocol, CredentialKind, ReasoningEffort } from "./surface.js";
import type { AnthropicRequestOptions } from "./content.js";
import type { RouteTarget } from "./routing.js";

export interface ProviderCaps {
  readonly surfaces: readonly Surface[];
  readonly streaming: boolean;
  readonly reasoning: boolean;
  readonly toolCalls: boolean;
  readonly images: boolean;
  readonly pdf: boolean;
  readonly video: boolean;
  readonly explicitCache: boolean;
  readonly search?: boolean;
  readonly forcedToolChoice?: boolean;
  readonly promptCacheKey?: boolean;
  readonly mediaGeneration?: readonly string[];
  readonly compact?: boolean;
}

export type ModelCacheMode = "none" | "explicit" | "implicit" | "native";
type ModelSamplingField = "temperature" | "top_p" | "stop";

export interface ModelReasoningCompatibility {
  readonly efforts?: readonly ReasoningEffort[];
  readonly effortMap?: Readonly<Record<string, string>>;
  readonly budget?: boolean;
  readonly summary?: boolean;
  readonly disable?: boolean;
}

export interface ModelSamplingCompatibility {
  readonly temperature?: boolean;
  readonly topP?: boolean;
  readonly stop?: boolean;
  readonly supported?: readonly ModelSamplingField[];
}

export interface ModelToolCompatibility {
  readonly parallel?: boolean;
  readonly resultIdRequired?: boolean;
  readonly nativeTypes?: readonly string[];
}

export interface ModelCacheCompatibility {
  readonly mode?: ModelCacheMode;
  readonly ttl?: boolean;
  readonly breakpoints?: number;
  readonly minimumPrefixTokens?: number;
}

export interface ModelResponseStateCompatibility {
  readonly previousResponseId?: boolean;
  readonly staleRepair?: boolean;
}

export interface ModelTimeoutProfile {
  readonly firstByteMs?: number;
  readonly idleMs?: number;
}

export interface ModelCompatibility {
  readonly reasoning?: ModelReasoningCompatibility;
  readonly sampling?: ModelSamplingCompatibility;
  readonly tools?: ModelToolCompatibility;
  readonly cache?: ModelCacheCompatibility;
  readonly responseState?: ModelResponseStateCompatibility;
  readonly streamUsage?: boolean;
  readonly timeoutProfile?: ModelTimeoutProfile;
}

export type ModelCapabilityCategory = "vision" | "text" | "reasoning";

export interface ModelContextLimits {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface ModelTokenPricing {
  readonly inputPerMillion: number | null;
  readonly outputPerMillion: number | null;
}

export interface ProviderModel {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCaps;
  readonly compatibility?: ModelCompatibility;
  readonly upstreamId?: string;
  readonly context?: ModelContextLimits;
  readonly categories?: readonly ModelCapabilityCategory[];
  readonly pricing?: ModelTokenPricing;
}

export interface ModelMetadata {
  readonly context: ModelContextLimits;
  readonly categories: readonly ModelCapabilityCategory[];
  readonly pricing: ModelTokenPricing;
  readonly source: "catalog" | "custom";
  readonly updatedAt: string | null;
}

export interface ProviderModelMeta {
  readonly providerId: string;
  readonly modelId: string;
  readonly enabled?: boolean;
  readonly displayName?: string;
  readonly caps: ProviderCaps;
  readonly contextWindowTokens?: number | null;
  readonly protocol?: string;
  readonly credentialKinds?: readonly string[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ProviderModelCatalog {
  readonly list: readonly ProviderModel[];
  readonly get: (modelId: string) => ProviderModel | null;
}

export interface CapabilitySeed {
  readonly surfaces: readonly Surface[];
  readonly streaming?: boolean;
  readonly reasoning?: boolean;
  readonly toolCalls?: boolean;
  readonly images?: boolean;
  readonly pdf?: boolean;
  readonly video?: boolean;
  readonly explicitCache?: boolean;
  readonly promptCacheKey?: boolean;
  readonly search?: boolean;
  readonly compact?: boolean;
}

export interface ModelMetadataSeed {
  readonly upstreamId?: string;
  readonly context?: Partial<{ inputTokens?: number | null; outputTokens?: number | null }> | null;
  readonly categories?: readonly ModelCapabilityCategory[] | null;
  readonly pricing?: Partial<{ inputPerMillion: number | null; outputPerMillion: number | null }> | null;
}

export function createModelCatalog(models: readonly ProviderModel[]): ProviderModelCatalog {
  const byId = new Map<string, ProviderModel>();
  for (const model of models) byId.set(model.id, model);
  return {
    list: Object.freeze([...models]),
    get: (modelId: string): ProviderModel | null => byId.get(modelId) ?? null,
  };
}

export function capabilitiesOf(seed: CapabilitySeed): ProviderCaps {
  return {
    surfaces: [...seed.surfaces],
    streaming: seed.streaming ?? true,
    reasoning: seed.reasoning ?? false,
    toolCalls: seed.toolCalls ?? true,
    images: seed.images ?? false,
    pdf: seed.pdf ?? false,
    video: seed.video ?? false,
    explicitCache: seed.explicitCache ?? false,
    search: seed.search ?? false,
    compact: seed.compact ?? false,
  } as unknown as ProviderCaps;
}

export function categoriesOf(capabilities: ProviderCaps): readonly ModelCapabilityCategory[] {
  const categories: ModelCapabilityCategory[] = [];
  if (capabilities.images) categories.push("vision");
  if (capabilities.surfaces.some((surface) => surface !== "images" as unknown as string)) categories.push("text");
  if (capabilities.reasoning) categories.push("reasoning");
  return categories;
}

export function modelOf(id: string, displayName: string, capabilities: ProviderCaps, metadata: ModelMetadataSeed = {}): ProviderModel {
  return {
    id,
    displayName,
    capabilities,
    ...(metadata.upstreamId !== undefined ? { upstreamId: metadata.upstreamId } : {}),
    context: {
      inputTokens: metadata.context?.inputTokens ?? null,
      outputTokens: metadata.context?.outputTokens ?? null,
    },
    categories: metadata.categories ?? categoriesOf(capabilities),
    pricing: {
      inputPerMillion: metadata.pricing?.inputPerMillion ?? null,
      outputPerMillion: metadata.pricing?.outputPerMillion ?? null,
    },
  } as unknown as ProviderModel;
}

export function aggregateCapabilities(models: readonly ProviderModel[], fallback: ProviderCaps): ProviderCaps {
  if (models.length === 0) return { ...fallback, surfaces: [...fallback.surfaces] };
  const surfaces: Surface[] = [];
  let streaming = false;
  let reasoning = false;
  let toolCalls = false;
  let images = false;
  let pdf = false;
  let video = false;
  let explicitCache = false;
  let search = false;
  let compact = false;
  for (const model of models) {
    const caps = model.capabilities;
    for (const surface of caps.surfaces) {
      if (!surfaces.includes(surface)) surfaces.push(surface);
    }
    streaming ||= caps.streaming;
    reasoning ||= caps.reasoning;
    toolCalls ||= caps.toolCalls;
    images ||= caps.images === true;
    pdf ||= (caps as unknown as { pdf?: boolean }).pdf === true;
    video ||= (caps as unknown as { video?: boolean }).video === true;
    explicitCache ||= caps.explicitCache;
    search ||= caps.search === true;
    compact ||= caps.compact === true;
  }
  return { surfaces, streaming, reasoning, toolCalls, images, pdf, video, explicitCache, search, compact } as unknown as ProviderCaps;
}

export function openAIChatModel(id: string, name: string, reasoning = true, images = false): ProviderModel {
  const caps = capabilitiesOf({ surfaces: ["openai-chat"] as const, reasoning, images });
  return modelOf(id, name, caps);
}

export interface ProviderMeta {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: ProviderProtocol;
  readonly credentialKind: CredentialKind;
  readonly credentialUrl?: string;
  readonly credentialKinds?: readonly CredentialKind[];
  readonly execution?: ProviderExecutionPolicy;
  readonly quirks?: ProviderQuirkPolicy;
}

type ReasoningWireFormat = "openai" | "anthropic-budget" | "anthropic-adaptive" | "gemini-budget" | "gemini-level" | "provider-native";

interface ReasoningCapability {
  readonly enabled: boolean;
  readonly format: ReasoningWireFormat;
  readonly canDisable: boolean;
  readonly minBudget?: number;
  readonly maxBudget?: number;
}

export interface ProviderQuirkPolicy {
  readonly droppedFields?: readonly string[];
  readonly clampedFields?: Readonly<Record<string, { readonly min?: number; readonly max?: number }>>;
  readonly requiredHeaders?: Readonly<Record<string, string>>;
  readonly supportedResponseControls?: readonly string[];
  readonly toolNames?: {
    readonly maxLength: number;
    readonly replacement: string;
    readonly allowedCharacters: "alphanumeric_-";
  };
  readonly roles?: "preserve" | "gemini-alternating";
  readonly reasoning?: {
    readonly minimumOutputTokens?: number;
    readonly maximumOutputTokens?: number;
  };
  readonly cache?: {
    readonly systemTtl?: "1h" | "5m";
    readonly toolsTtl?: "1h" | "5m";
    readonly historyTtl?: "1h" | "5m";
  };
  readonly signatures?: {
    readonly mode: "preserve" | "strip-invalid" | "require";
    readonly placeholder?: string;
  };
  /** Responses tool names required by upstream model-specific anti-abuse gates. */
  readonly responsesToolCloak?: {
    readonly models: readonly string[];
    readonly tools: readonly Readonly<Record<string, unknown>>[];
    readonly forceToolChoiceAuto?: boolean;
  };
}

export interface ProviderEndpoint {
  readonly id: string;
  readonly baseUrl: string;
}

export interface ProviderRetryRule {
  readonly attempts: number;
  readonly delayMs: number;
}

export interface ProviderRetryPolicy {
  readonly status: Readonly<Partial<Record<408 | 409 | 429 | 500 | 502 | 503 | 504, ProviderRetryRule>>>;
  readonly networkAttempts: number;
  readonly maxRetryAfterMs: number;
  readonly retry429AcrossEndpoints?: boolean;
}

export interface ProviderCompactPolicy {
  readonly path: string;
}

export interface ProviderExecutionPolicy {
  readonly endpoints?: readonly ProviderEndpoint[];
  readonly retry?: ProviderRetryPolicy;
  readonly compact?: ProviderCompactPolicy;
  readonly nativePassthrough?: boolean;
}

export type WebSearchPreference = "auto" | "prefer-codex" | "prefer-exa";

export interface ProviderCatalogAdapter {
  readonly metadata: ProviderMeta;
  readonly capabilities: ProviderCaps;
  readonly models: ProviderModelCatalog;
  resolveTarget(modelId: string, surface: Surface): RouteTarget;
}

export interface OpenAIAdapterConfig {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly credentialKind: CredentialKind;
  readonly credentialUrl?: string;
  readonly auth?: "bearer" | "x-api-key" | "none";
  readonly models?: readonly ProviderModel[];
  readonly compatibility?: CompatibilityProfile;
  readonly anthropic?: AnthropicCompatibilityProfile;
}

export type CompatibilityRequestRule =
  | { readonly kind: "rename-field"; readonly from: string; readonly to: string }
  | { readonly kind: "move-field"; readonly from: string; readonly to: readonly string[] }
  | { readonly kind: "set-default"; readonly field: string; readonly value: string | number | boolean }
  | { readonly kind: "omit-field"; readonly field: string };

export interface CompatibilityProfile {
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly streamUsage?: "always" | "never" | "auto";
  readonly structuredOutputs?: {
    readonly supported: boolean;
    readonly strictByDefault?: boolean;
  };
  readonly requestRules?: readonly CompatibilityRequestRule[];
  readonly responseMetadata?: readonly ("request-id" | "system-fingerprint" | "service-tier" | "model")[];
}

export type AnthropicBetaName =
  | "prompt-caching-2024-07-31"
  | "extended-cache-ttl-2025-04-11"
  | "interleaved-thinking-2025-05-14"
  | "effort-2025-11-24"
  | "user-profiles-2024-10-30"
  | "structured-outputs-2025-11-13";

export interface AnthropicCompatibilityProfile {
  readonly version?: "2023-06-01";
  readonly betas?: readonly AnthropicBetaName[];
  readonly allowUserProfile?: boolean;
  readonly options?: Pick<AnthropicRequestOptions, "speed" | "inferenceGeo">;
}

// AnthropicRequestOptions and RouteTarget are needed for provider domain but keep at top to avoid circular
