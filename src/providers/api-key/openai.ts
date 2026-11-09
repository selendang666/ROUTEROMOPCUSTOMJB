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
import { dispatchResponses } from "../../proxy/upstream/openai.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import type { DiscoveryInput } from "../../proxy/types/request.js";

/**
 * OpenAI adapter for the Responses API and supported multimodal input.
 */

const OPENAI_SURFACES: readonly Surface[] = ["openai-responses"];

const OPENAI_TEXT_SURFACES: readonly Surface[] = ["openai-responses"];

function openAiTextCapabilities(seed: { readonly reasoning?: boolean; readonly images?: boolean } = {}): ProviderCaps {
  return capabilitiesOf({ surfaces: OPENAI_TEXT_SURFACES, ...seed, explicitCache: true, promptCacheKey: true });
}

const OPENAI_DEFAULT_MODELS: readonly ProviderModel[] = [
  modelOf("gpt-5.6", "GPT-5.6", openAiTextCapabilities({ reasoning: true, images: true })),
  modelOf("gpt-5.6-sol", "GPT-5.6 Sol", openAiTextCapabilities({ reasoning: true, images: true })),
  modelOf("gpt-5.6-terra", "GPT-5.6 Terra", openAiTextCapabilities({ reasoning: true, images: true })),
  modelOf("gpt-5.6-luna", "GPT-5.6 Luna", openAiTextCapabilities({ reasoning: true, images: true })),
  modelOf("gpt-5", "GPT-5", openAiTextCapabilities({ reasoning: true, images: true })),
  modelOf("gpt-5-mini", "GPT-5 Mini", openAiTextCapabilities({ reasoning: true })),
  modelOf("gpt-5-nano", "GPT-5 Nano", openAiTextCapabilities({ reasoning: true })),
  modelOf("gpt-4.1", "GPT-4.1", openAiTextCapabilities({ images: true })),
  modelOf("gpt-4.1-mini", "GPT-4.1 Mini", openAiTextCapabilities({ images: true })),
  modelOf("gpt-4.1-nano", "GPT-4.1 Nano", openAiTextCapabilities()),
  modelOf("gpt-4o", "GPT-4o", openAiTextCapabilities({ images: true })),
  modelOf("gpt-4o-mini", "GPT-4o Mini", openAiTextCapabilities({ images: true })),
  modelOf("o3", "O3", openAiTextCapabilities({ reasoning: true })),
  modelOf("o4-mini", "O4 Mini", openAiTextCapabilities({ reasoning: true })),
];

const OPENAI_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({ surfaces: OPENAI_SURFACES });

export interface OpenAIAdapterConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly credentialKind?: CredentialKind;
  readonly models?: readonly ProviderModel[];
}

export class OpenAIAdapter implements Adapter {
  readonly metadata: ProviderMeta;
  readonly capabilities: ProviderCaps;
  readonly models: ProviderModelCatalog;
  private readonly baseUrl: string;

  constructor(config: OpenAIAdapterConfig = {}) {
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const models = config.models ?? OPENAI_DEFAULT_MODELS;
    this.models = createModelCatalog(models);
    this.capabilities = aggregateCapabilities(models, OPENAI_FALLBACK_CAPABILITIES);
    this.metadata = {
      id: config.id ?? "openai",
      displayName: config.displayName ?? "OpenAI",
      protocol: "openai",
      credentialKind: config.credentialKind ?? "api_key",
    };
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
    const __entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: __entry?.upstreamId ?? modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    this.assertSupported(input);
    const { credential } = input;
    return dispatchResponses(input, this.baseUrl, this.authHeaders(credential, input.request.stream), { explicitCache: this.capabilities.explicitCache });
  }

  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchOpenAICompatibleModels({
      baseUrl: this.baseUrl,
      headers: { authorization: `Bearer ${input.credential}` },
      signal: input.signal,
    });
  }

  mapError(error: unknown): InternalFailure {
    return internalFailureFromUnknown(error);
  }

  private assertSupported(input: ProviderRequest): void {
    const surface = input.target.surface ?? "openai-responses";
    if (input.target.providerId !== this.metadata.id) {
      throw new UpstreamError({
        kind: "capability_unsupported",
        message: `Adapter "${this.metadata.id}" cannot serve provider "${input.target.providerId}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new UpstreamError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support surface "${input.target.surface}"`,
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

  private authHeaders(credential: string, stream: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${credential}`,
    };
    return headers;
  }
}

/**
 * Anthropic adapter: the "anthropic-messages" surface over the Messages
 * upstream format.
 */

