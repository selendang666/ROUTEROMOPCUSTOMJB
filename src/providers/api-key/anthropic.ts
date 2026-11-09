import { internalFailureFromUnknown } from "../../proxy/errors.js";
import { buildResponsesPayload } from "../../proxy/translate/request.js";
import { mapResponsesUsage } from "../../proxy/translate/response.js";
import { resolveModelCapabilities, resolveModelWireSurface } from "../../proxy/translate/policy.js";
import { aggregateCapabilities, capabilitiesOf, createModelCatalog, modelOf } from "../../proxy/types/provider.js";
import type { Adapter, ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import type { CredentialKind, Surface } from "../../proxy/types/surface.js";
import type { InternalFailure } from "../../proxy/types/error-types.js";
import type { ProviderCaps, ProviderMeta, ProviderModel, ProviderModelCatalog } from "../../proxy/types/provider.js";
import type { RouteTarget } from "../../proxy/types/routing.js";
import { transformOpenAIResponsesStream } from "../../proxy/upstream/openai.js";
import { lineLimit, mapSseStream, parseSseData, parseSseEvents } from "../../proxy/transport/sse.js";
import { AbortCoordinator } from "../../proxy/transport/abort.js";
import { UpstreamError, parseUpstreamFailure } from "../../proxy/transport/errors.js";
import { executeFetch } from "../../proxy/transport/fetch.js";
import { applyAnthropicCompatibilityHeaders } from "../../proxy/upstream/compatibility.js";
import { dispatchAnthropic } from "../../proxy/upstream/anthropic.js";
import { dispatchGemini } from "../../proxy/upstream/gemini.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import type { DiscoveryInput } from "../../proxy/types/request.js";
const ANTHROPIC_SURFACES: readonly Surface[] = ["anthropic-messages"];

const ANTHROPIC_DEFAULT_MODELS: readonly ProviderModel[] = [
  modelOf("claude-opus-4-1", "Claude Opus 4.1", capabilitiesOf({ surfaces: ANTHROPIC_SURFACES, reasoning: true, images: true, search: true, explicitCache: true })),
  modelOf("claude-sonnet-4-5", "Claude Sonnet 4.5", capabilitiesOf({ surfaces: ANTHROPIC_SURFACES, reasoning: true, images: true, search: true, explicitCache: true })),
  modelOf("claude-haiku-4-5", "Claude Haiku 4.5", capabilitiesOf({ surfaces: ANTHROPIC_SURFACES, images: true, search: true, explicitCache: true })),
  modelOf("claude-3-7-sonnet", "Claude 3.7 Sonnet", capabilitiesOf({ surfaces: ANTHROPIC_SURFACES, reasoning: true, images: true, search: true, explicitCache: true })),
  modelOf("claude-3-5-haiku-latest", "Claude 3.5 Haiku", capabilitiesOf({ surfaces: ANTHROPIC_SURFACES, images: true, search: true, explicitCache: true })),
];

const ANTHROPIC_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({
  surfaces: ANTHROPIC_SURFACES,
  reasoning: true,
  images: true,
  search: true,
  explicitCache: true,
});

export interface AnthropicAdapterConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly credentialKind?: CredentialKind;
  readonly auth?: "x-api-key" | "bearer";
  readonly models?: readonly ProviderModel[];
  readonly anthropic?: import("../../proxy/types/provider.js").AnthropicCompatibilityProfile;
}

export class AnthropicAdapter implements Adapter {
  readonly metadata: ProviderMeta;
  readonly capabilities: ProviderCaps;
  readonly models: ProviderModelCatalog;
  private readonly baseUrl: string;
  private readonly auth: "x-api-key" | "bearer";
  private readonly anthropic: import("../../proxy/types/provider.js").AnthropicCompatibilityProfile | undefined;

  constructor(config: AnthropicAdapterConfig = {}) {
    this.baseUrl = (config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    const models = config.models ?? ANTHROPIC_DEFAULT_MODELS;
    this.models = createModelCatalog(models);
    this.capabilities = aggregateCapabilities(models, ANTHROPIC_FALLBACK_CAPABILITIES);
    this.metadata = {
      id: config.id ?? "anthropic",
      displayName: config.displayName ?? "Anthropic",
      protocol: "anthropic",
      credentialKind: config.credentialKind ?? "api_key",
    };
    this.auth = config.auth ?? "x-api-key";
    this.anthropic = config.anthropic;
  }

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new UpstreamError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support surface "${surface}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    const entry = this.models.get(modelId);
    return { providerId: this.metadata.id, modelId, surface, upstreamModelId: entry?.upstreamId ?? modelId };
  }
  async call(input: ProviderRequest): Promise<ProviderOutput> {
    this.assertSupported(input);
    const { request, credential } = input;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
    };
    applyAnthropicCompatibilityHeaders(headers, input, { anthropic: this.anthropic }, this.capabilities.explicitCache);
    if (this.auth === "bearer") headers.authorization = `Bearer ${credential}`;
    else headers["x-api-key"] = credential;
    const entry = this.models.get(input.target.modelId);
    const upstreamModelId = entry?.upstreamId ?? input.target.modelId;
    const wireInput = {
      ...input,
      target: { ...input.target, upstreamModelId, surface: "anthropic-messages" as const },
    } as unknown as Parameters<typeof dispatchAnthropic>[0];
    return dispatchAnthropic(wireInput, this.baseUrl, headers, this.capabilities);
  }

  async discoverModels(input: DiscoveryInput): Promise<readonly import("../../proxy/types/provider.js").ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    const headers: Record<string, string> =
      this.auth === "bearer"
        ? { authorization: `Bearer ${input.credential}` }
        : { "x-api-key": input.credential, "anthropic-version": "2023-06-01" };
    return fetchOpenAICompatibleModels({ baseUrl: this.baseUrl, headers, signal: input.signal });
  }

  mapError(error: unknown): InternalFailure {
    return internalFailureFromUnknown(error);
  }

  private assertSupported(input: ProviderRequest): void {
    if (input.target.providerId !== this.metadata.id) {
      throw new UpstreamError({
        kind: "capability_unsupported",
        message: `Adapter "${this.metadata.id}" cannot serve provider "${input.target.providerId}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (input.request.stream && !this.capabilities.streaming) {
      throw new UpstreamError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support streaming`,
        statusCode: 400,
        routeScope: null,
      });
    }
  }
}

/** Direct Gemini Generative Language API adapter. */
