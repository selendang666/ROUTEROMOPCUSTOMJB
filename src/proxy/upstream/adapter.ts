import { internalFailureFromUnknown } from "../errors.js";
// OpenAI-compatible adapter — extracted from translate.ts verbatim
import { aggregateCapabilities, capabilitiesOf, createModelCatalog, resolveModelCapabilities } from "../translate/policy.js";
import type { Adapter, ProviderOutput, ProviderRequest } from "../types/request.js";
import type { ApplicationErrorKind, InternalFailure } from "../types/error-types.js";
import type { CompatibilityProfile, CompatibilityRequestRule, OpenAIAdapterConfig, ProviderCaps, ProviderCatalogAdapter, ProviderMeta } from "../types/provider.js";
import type { ProviderUsage } from "../types/telemetry.js";
import type { RouteTarget } from "../types/routing.js";
import type { SseEvent, StopReason, StreamEvent, StreamMapper } from "../types/stream.js";
import type { Surface } from "../types/surface.js";
import { UpstreamError } from "../transport/errors.js";
import { dispatchAnthropic } from "./anthropic.js";
import { applyAnthropicCompatibilityHeaders, applyCompatibilityHeaders } from "./compatibility.js";
import { dispatchChatCompletions, dispatchResponses, transformOpenAIChatStream, transformOpenAIResponsesStream, OPENAI_FALLBACK_CAPS } from "./openai.js";

/** Builds the eager catalog half of an OpenAI-compatible adapter. */
export function describeOpenAIAdapter(config: OpenAIAdapterConfig): ProviderCatalogAdapter {
  const models = config.models ?? [];
  const modelCatalog = createModelCatalog(models);
  const capabilities = aggregateCapabilities(models, OPENAI_FALLBACK_CAPS);
  const metadata: ProviderMeta = {
    id: config.id,
    displayName: config.displayName,
    protocol: "openai",
    credentialKind: config.credentialKind,
    ...(config.credentialUrl ? { credentialUrl: config.credentialUrl } : {}),
  };
  return {
    metadata,
    capabilities,
    models: modelCatalog,
    resolveTarget(modelId: string, surface: Surface): RouteTarget {
      if (!capabilities.surfaces.includes(surface)) {
        throw new UpstreamError({
          kind: "capability_unsupported",
          message: `Provider "${metadata.id}" does not support surface "${surface}"`,
          statusCode: 400,
          routeScope: null,
        });
      }
      const entry = modelCatalog.get(modelId);
      if (entry !== null && !entry.capabilities.surfaces.includes(surface)) {
        throw new UpstreamError({
          kind: "capability_unsupported",
          message: `Model "${modelId}" on provider "${metadata.id}" does not support surface "${surface}"`,
          statusCode: 400,
          routeScope: "provider",
        });
      }
      const upstreamModelId = entry?.upstreamId ?? modelId;
      return { providerId: metadata.id, modelId, upstreamModelId, surface };
    },
  };
}

/**
 * Creates a standalone OpenAI-compatible adapter with Chat Completions,
 * Responses, and Anthropic Messages upstream support when a catalog declares it.
 */
export function createOpenAIAdapter(config: OpenAIAdapterConfig): Adapter {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const catalog = describeOpenAIAdapter(config);
  const auth = config.auth ?? "bearer";

  function assertSupported(input: ProviderRequest): void {
    const surface = input.target.surface ?? "openai-chat";
    if (input.target.providerId !== catalog.metadata.id) {
      throw new UpstreamError({
        kind: "capability_unsupported",
        message: `Adapter "${catalog.metadata.id}" cannot serve provider "${input.target.providerId}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (!catalog.capabilities.surfaces.includes(surface)) {
      throw new UpstreamError({
        kind: "capability_unsupported",
        message: `Provider "${catalog.metadata.id}" does not support surface "${input.target.surface}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    const model = catalog.models.get(input.target.modelId);
    if (model !== null && !model.capabilities.surfaces.includes(surface)) {
      throw new UpstreamError({
        kind: "capability_unsupported",
        message: `Model "${input.target.modelId}" on provider "${catalog.metadata.id}" does not support surface "${input.target.surface}"`,
        statusCode: 400,
        routeScope: "provider",
      });
    }
    if (input.request.stream && !catalog.capabilities.streaming) {
      throw new UpstreamError({
        kind: "capability_unsupported",
        message: `Adapter "${catalog.metadata.id}" does not support streaming`,
        statusCode: 400,
        routeScope: null,
      });
    }
  }

  return {
    ...catalog,
    async call(input: ProviderRequest): Promise<ProviderOutput> {
      assertSupported(input);
      const surface = input.target.surface ?? "openai-chat";
      const { request, credential } = input;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: request.stream ? "text/event-stream" : "application/json",
      };
      applyCompatibilityHeaders(headers, config.compatibility);
      if (auth === "bearer" && credential.length > 0) headers.authorization = `Bearer ${credential}`;
      else if (auth === "x-api-key" && credential.length > 0) headers["x-api-key"] = credential;
      if (surface === "anthropic-messages") {
        const modelCapabilities = resolveModelCapabilities(catalog.capabilities, catalog.models.get(input.target.modelId), surface);
        applyAnthropicCompatibilityHeaders(headers, input, config, modelCapabilities.cache.breakpoints);
        return dispatchAnthropic(input, baseUrl, headers, catalog.capabilities, modelCapabilities);
      }
      const modelCapabilities = resolveModelCapabilities(catalog.capabilities, catalog.models.get(input.target.modelId), surface);
      if (surface === "openai-responses") {
        return dispatchResponses(input, baseUrl, headers, {
          explicitCache: modelCapabilities.cache.breakpoints,
          capabilities: modelCapabilities,
          compatibility: config.compatibility,
        });
      }
      return dispatchChatCompletions(input, baseUrl, headers, {}, {
        explicitCache: modelCapabilities.cache.breakpoints,
        capabilities: modelCapabilities,
        compatibility: config.compatibility,
      });
    },
    mapError(error: unknown): InternalFailure {
      return internalFailureFromUnknown(error);
    },
  };
}
