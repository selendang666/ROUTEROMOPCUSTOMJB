import { buildMessagesPayload, mapAnthropicUsage } from "../../proxy/normalize/anthropic.js";
import { buildChatPayload } from "../../proxy/translate/request.js";
import { mapChatUsage } from "../../proxy/translate/response.js";
import { classifyCompatibilityRejection, recordCompatibilityFallback, removeCompatibilityProjection } from "../../proxy/translate/policy.js";
import { isRecord } from "../../proxy/validation.js";
import { internalFailureFromUnknown } from "../../proxy/errors.js";
import { providerQuirkPolicy } from "../../proxy/policy/profiles.js";

import { aggregateCapabilities, capabilitiesOf, categoriesOf, createModelCatalog, modelOf } from "../../proxy/types/provider.js";
import type { Adapter, ProviderOutput, ProviderRequest, ProxyRequest } from "../../proxy/types/request.js";
import type { AnthropicCompatibilityProfile, CompatibilityProfile, ProviderCaps, ProviderCatalogAdapter, ProviderMeta, ProviderModel, ProviderModelCatalog } from "../../proxy/types/provider.js";
import type { RouteTarget } from "../../proxy/types/routing.js";
import type { Surface } from "../../proxy/types/surface.js";
import { transformOpenAIChatStream } from "../../proxy/upstream/openai.js";
import { lineLimit, mapSseStream as mapDomainSseStream, mapSseStream as mapTransportSseStream, parseSseEvents } from "../../proxy/transport/sse.js";
import { transformAnthropicMessagesStream } from "../../proxy/upstream/anthropic.js";
import { AbortCoordinator } from "../../proxy/transport/abort.js";
import { UpstreamError, parseUpstreamFailure } from "../../proxy/transport/errors.js";
import { assertUpstreamContentType } from "../../proxy/transport/fetch.js";
import { assertPublicUrlAtDispatch } from "../../proxy/transport/network.js";
import { executeFetch } from "../../proxy/transport/fetch.js";
import { readJsonObject } from "../../proxy/transport/fetch.js"
import { applyAnthropicCompatibilityHeaders, applyCompatibilityHeaders, applyCompatibilityRequestRules, compatibilityUrl } from "../../proxy/upstream/compatibility.js";
import type { ProviderRegistry } from "../registry.js";
import type { ProviderDefinition } from "../model-catalog.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import type { DiscoveryInput } from "../../proxy/types/request.js";

/** Minimal shape for runtime-registered custom providers; persistence layer supplies records. */
export interface CustomProviderRecord {
  readonly slug: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly type: "openai-compatible" | "anthropic-compatible";
  readonly models: readonly unknown[];
  readonly customHeaders: Record<string, string>;
  readonly timeoutSeconds: number;
  readonly compatibility?: CompatibilityProfile;
  readonly anthropic?: AnthropicCompatibilityProfile;
}

export interface CustomProviderRepository {
  list(): readonly CustomProviderRecord[];
  getBySlug(slug: string): CustomProviderRecord | null;
}

const CUSTOM_OPENAI_SURFACES: readonly Surface[] = ["openai-chat"];

const CUSTOM_ANTHROPIC_SURFACES: readonly Surface[] = ["anthropic-messages"];

/** Read side of the custom provider repository (list + slug lookup). */
export type CustomProviderSource = Pick<CustomProviderRepository, "list" | "getBySlug">;

/**
 * Turns stored discovered-model records (objects with `id`, plain ids, or
 * legacy display-name entries) into application ProviderModels.
 */
function storedModels(models: readonly unknown[], capabilities: ProviderCaps): readonly ProviderModel[] {
  const result: ProviderModel[] = [];
  for (const value of models) {
    if (typeof value === "string") {
      if (value.length > 0) result.push(modelOf(value, value, capabilities));
      continue;
    }
    if (!isRecord(value)) continue;
    const id = value["id"];
    if (typeof id !== "string" || id.length === 0) continue;
    const name = typeof value["name"] === "string" ? value["name"] : typeof value["displayName"] === "string" ? value["displayName"] : id;
    result.push(modelOf(id, name, capabilities));
  }
  return result;
}

/**
 * Catalog that always answers: stored models are listed (console display),
 * and `get` returns a synthetic entry for any id so routing stays
 * permissive exactly like legacy.
 */
function createCustomCatalog(models: readonly ProviderModel[], capabilities: ProviderCaps): ProviderModelCatalog {
  const byId = new Map(models.map((model) => [model.id, model]));
  return {
    list: Object.freeze([...models]),
    get: (modelId: string): ProviderModel =>
      byId.get(modelId) ?? {
        id: modelId,
        displayName: modelId,
        capabilities,
        context: { inputTokens: null, outputTokens: null },
        categories: categoriesOf(capabilities),
        pricing: { inputPerMillion: null, outputPerMillion: null },
      },
  };
}

export class CustomProviderAdapter implements Adapter {
  readonly metadata: ProviderMeta;
  readonly capabilities: ProviderCaps;
  readonly models: ProviderModelCatalog;

  private readonly source: CustomProviderSource;
  constructor(record: CustomProviderRecord, source: CustomProviderSource) {
    this.source = source;
    const nativeSurfaces = record.type === "anthropic-compatible" ? CUSTOM_ANTHROPIC_SURFACES : CUSTOM_OPENAI_SURFACES;
    const fallbackCapabilities = capabilitiesOf({ surfaces: nativeSurfaces });
    const models = storedModels(record.models, fallbackCapabilities);
    this.models = createCustomCatalog(models, fallbackCapabilities);
    this.capabilities = aggregateCapabilities(models, fallbackCapabilities);
    this.metadata = {
      id: record.slug,
      displayName: record.name,
      protocol: record.type === "anthropic-compatible" ? "anthropic" : "openai",
      credentialKind: "api_key",
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
    return { providerId: this.metadata.id, modelId, surface, upstreamModelId: modelId };
  }

  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    const record = this.source.getBySlug(this.metadata.id);
    if (record === null) return null;
    if (input.credential === null || input.credential.length === 0) return null;
    const headers: Record<string, string> =
      record.type === "anthropic-compatible"
        ? { "x-api-key": input.credential, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${input.credential}` };
    return fetchOpenAICompatibleModels({ baseUrl: record.baseUrl, headers, signal: input.signal });
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    this.assertSupported(input);
    const record = this.source.getBySlug(this.metadata.id);
    if (record === null) {
      throw new UpstreamError({ kind: "invalid_request", message: `Custom provider "${this.metadata.id}" no longer exists.`, statusCode: 404, routeScope: "provider" });
    }
    const baseUrl = record.baseUrl.replace(/\/+$/, "");
    const anthropic = record.type === "anthropic-compatible";
    const url = compatibilityUrl(baseUrl, anthropic ? "/messages" : "/chat/completions", record.compatibility);
    await assertPublicUrlAtDispatch(url, { label: `Custom provider "${record.name}" base URL` });
    const coordinator = new AbortCoordinator(input.signal, {
      connectTimeoutMs: input.request.limits.connectTimeoutMs,
      firstByteTimeoutMs: input.request.limits.firstByteTimeoutMs,
      idleTimeoutMs: input.request.limits.idleTimeoutMs,
      totalTimeoutMs: Math.min(input.request.limits.totalTimeoutMs, Math.max(1, Math.min(300, record.timeoutSeconds)) * 1000),
    });
    let streamHandedOff = false;
    try {
      const { request } = input;
      const headers = customHeaders(record, input.credential, request.stream, input.headers);
      applyCompatibilityHeaders(headers, record.compatibility);
      if (anthropic) applyAnthropicCompatibilityHeaders(headers, input, { anthropic: record.anthropic }, this.capabilities.explicitCache);
      const entry = this.models.get(input.target.modelId);
      const upstreamModelId = entry?.upstreamId ?? input.target.modelId;
      const shapedRequest: ProxyRequest = { ...request, model: upstreamModelId };
      const payload = anthropic
        ? buildMessagesPayload(shapedRequest, this.capabilities, {
            quirks: providerQuirkPolicy(input.target.providerId),
          })
        : applyCompatibilityRequestRules(
            buildChatPayload(shapedRequest, {
              streamUsage: record.compatibility?.streamUsage,
              structuredOutputs: record.compatibility?.structuredOutputs,
            }),
            record.compatibility?.requestRules,
          );
      payload.model = upstreamModelId;
      let response = await executeFetch(url, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, input.network, input.capture);
      if (!response.ok) {
        try {
          await parseUpstreamFailure(response);
        } catch (error) {
          const rejection = error instanceof UpstreamError ? classifyCompatibilityRejection(internalFailureFromUnknown(error)) : null;
          if (rejection === null || !rejection.retryable || !removeCompatibilityProjection(payload, rejection)) throw error;
          recordCompatibilityFallback(input, rejection);
          response = await executeFetch(url, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, input.network, input.capture);
        }
      }
      if (!response.ok) throw await parseUpstreamFailure(response);
      if (!request.stream) {
        const body = await readJsonObject(response, coordinator);
        const usageRecord = isRecord(body.usage) ? body.usage : null;
        return {
          mode: "non_stream",
          body,
          usage: usageRecord !== null ? (anthropic ? mapAnthropicUsage(usageRecord) : mapChatUsage(usageRecord)) : undefined,
        };
      }
      if (!response.body) {
        throw new UpstreamError({ kind: "provider_protocol_error", message: "Upstream returned an empty stream body", routeScope: "provider" });
      }
      streamHandedOff = true;
      const sse = { body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs } as const;
      return {
        mode: "stream",
        events: (anthropic
          ? mapTransportSseStream(sse, transformAnthropicMessagesStream(input.target.providerId))
          : mapDomainSseStream(sse, transformOpenAIChatStream())) as unknown as AsyncIterable<import("../../proxy/types/stream.js").StreamEvent>,
      };
    } finally {
      if (!streamHandedOff) coordinator.dispose();
    }
  }

  mapError(error: unknown): import("../../proxy/types/error-types.js").InternalFailure {
    return internalFailureFromUnknown(error);
  }

  private assertSupported(input: ProviderRequest): void {
    if (input.target.providerId !== this.metadata.id) {
      throw new UpstreamError({ kind: "capability_unsupported", message: `Adapter "${this.metadata.id}" cannot serve provider "${input.target.providerId}"`, statusCode: 400, routeScope: null });
    }
    if (input.request.stream && !this.capabilities.streaming) {
      throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support streaming`, statusCode: 400, routeScope: null });
    }
  }
}

/**
 * Custom provider outbound headers.
 */
const BLOCKED_CUSTOM_HEADERS = new Set([
  "host",
  "content-type",
  "accept",
  "authorization",
  "proxy-authorization",
  "proxy-authenticate",
  "x-api-key",
  "cookie",
  "set-cookie",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "origin",
  "referer",
  "content-length",
  "transfer-encoding",
  "connection",
]);

function customHeaders(record: CustomProviderRecord, credential: string, stream: boolean, sourceHeaders?: Headers): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
  };
  if (record.type === "anthropic-compatible") {
    headers["x-api-key"] = credential;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${credential}`;
  }
  for (const [name, value] of Object.entries(record.customHeaders)) {
    const lower = name.toLowerCase();
    if (name.length === 0 || BLOCKED_CUSTOM_HEADERS.has(lower)) continue;
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) continue;
    headers[lower] = value;
  }
  if (record.type === "anthropic-compatible") {
    const version = sourceHeaders?.get("anthropic-version");
    if (version !== null && version !== undefined && version.length > 0) headers["anthropic-version"] = version;
    const beta = sourceHeaders?.get("anthropic-beta");
    if (beta !== null && beta !== undefined) headers["anthropic-beta"] = beta;
    const workspace = sourceHeaders?.get("anthropic-workspace-id");
    if (workspace !== null && workspace !== undefined) headers["anthropic-workspace-id"] = workspace;
  }
  return headers;
}

/**
 * Reconciles the runtime registry with the configured custom provider
 * records: registers (or refreshes) one adapter per record, keyed by slug,
 * and unregisters adapters whose records were deleted.
 */
export function syncCustomAdapters(registry: ProviderRegistry, source: CustomProviderSource): void {
  const live = new Set<string>();
  for (const record of source.list()) {
    live.add(record.slug);
    const existing = registry.get(record.slug);
    if (existing !== null && !(existing instanceof CustomProviderAdapter)) continue;
    if (existing !== null) registry.unregister(record.slug);
    registry.register(new CustomProviderAdapter(record, source));
  }
  for (const adapter of registry.list()) {
    if (adapter instanceof CustomProviderAdapter && !live.has(adapter.metadata.id)) {
      registry.unregister(adapter.metadata.id);
    }
  }
}

/** Projects a database-defined compatible provider into the same filter definition contract as built-ins. */
export function customProviderDefinition(record: CustomProviderRecord): ProviderDefinition {
  return {
    id: record.slug,
    displayName: record.name,
    access: "api_key",
    protocol: record.type === "anthropic-compatible" ? "anthropic" : "openai",
  };
}
