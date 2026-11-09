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
const GEMINI_SURFACES: readonly Surface[] = ["openai-chat", "openai-responses", "anthropic-messages", "images"];

const GEMINI_TEXT_SURFACES: readonly Surface[] = ["openai-chat", "openai-responses", "anthropic-messages"];

const GEMINI_DEFAULT_MODELS: readonly ProviderModel[] = [
  modelOf("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", capabilitiesOf({ surfaces: GEMINI_TEXT_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite Preview", capabilitiesOf({ surfaces: GEMINI_TEXT_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-3-flash-preview", "Gemini 3 Flash Preview", capabilitiesOf({ surfaces: GEMINI_TEXT_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-2.5-pro", "Gemini 2.5 Pro", capabilitiesOf({ surfaces: GEMINI_TEXT_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-2.5-flash", "Gemini 2.5 Flash", capabilitiesOf({ surfaces: GEMINI_TEXT_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-2.0-flash", "Gemini 2.0 Flash", capabilitiesOf({ surfaces: GEMINI_TEXT_SURFACES, images: true })),
];

const GEMINI_FALLBACK_CAPABILITIES = capabilitiesOf({ surfaces: GEMINI_SURFACES, reasoning: true, images: true });

export interface GeminiAdapterConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly credentialKind?: CredentialKind;
  readonly models?: readonly ProviderModel[];
}

export class GeminiAdapter implements Adapter {
  readonly metadata: ProviderMeta;
  readonly capabilities: ProviderCaps;
  readonly models: ProviderModelCatalog;
  private readonly baseUrl: string;

  constructor(config: GeminiAdapterConfig = {}) {
    this.baseUrl = (config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const models = config.models ?? GEMINI_DEFAULT_MODELS;
    this.models = createModelCatalog(models);
    this.capabilities = aggregateCapabilities(models, GEMINI_FALLBACK_CAPABILITIES);
    this.metadata = {
      id: config.id ?? "gemini",
      displayName: config.displayName ?? "Google Gemini",
      protocol: "gemini",
      credentialKind: config.credentialKind ?? "api_key",
    };
  }

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    const __entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: __entry?.upstreamId ?? modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    this.assertSupported(input);
    return dispatchGemini(input, this.baseUrl, input.credential);
  }

  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchOpenAICompatibleModels({
      baseUrl: this.baseUrl,
      headers: { "x-goog-api-key": input.credential },
      signal: input.signal,
    });
  }

  mapError(error: unknown): InternalFailure {
    return internalFailureFromUnknown(error);
  }

  private assertSupported(input: ProviderRequest): void {
    if (input.target.providerId !== this.metadata.id || !this.capabilities.surfaces.includes(input.target.surface)) throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" cannot serve this target`, statusCode: 400, routeScope: null });
    if (input.request.stream && !this.capabilities.streaming) throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support streaming`, statusCode: 400, routeScope: null });
  }
}

