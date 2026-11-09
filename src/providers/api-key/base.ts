import { internalFailureFromUnknown } from "../../proxy/errors.js";
import { createModelCatalog } from "../../proxy/types/provider.js";
import { UpstreamError } from "../../proxy/transport/errors.js";
import type { Adapter, ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import type { ProviderCaps, ProviderMeta, ProviderModel, ProviderModelCatalog } from "../../proxy/types/provider.js";
import type { RouteTarget } from "../../proxy/types/routing.js";
import type { Surface } from "../../proxy/types/surface.js";


/** Shared lifecycle for one API-key provider module. */
export abstract class ApiKeyProviderBase implements Adapter {
  readonly metadata: ProviderMeta;
  readonly capabilities: ProviderCaps;
  readonly models: ProviderModelCatalog;

  protected constructor(input: { metadata: ProviderMeta; capabilities: ProviderCaps; models: readonly ProviderModel[] }) {
    this.metadata = input.metadata;
    this.capabilities = input.capabilities;
    this.models = createModelCatalog(input.models);
  }

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) throw new UpstreamError({ kind: "capability_unsupported", statusCode: 400, routeScope: null, message: `Provider "${this.metadata.id}" does not support surface "${surface}"` });
    let lookupId = modelId;
    const prefix = `${this.metadata.id}/`;
    if (modelId.startsWith(prefix)) lookupId = modelId.slice(prefix.length);
    const model = this.models.get(lookupId) ?? this.models.get(modelId);
    const upstreamId = model?.upstreamId ?? lookupId;
    return { providerId: this.metadata.id, modelId, upstreamModelId: upstreamId, surface };
  }

  mapError(error: unknown) { return internalFailureFromUnknown(error); }
  abstract call(input: ProviderRequest): Promise<ProviderOutput>;
}
