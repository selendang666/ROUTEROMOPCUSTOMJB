import type { PublicDependencies } from "../api/v1.js";
import { createApiKeysServices } from "../console/services/api-keys.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { PostgresPool } from "../persistence/pool.js";
import type { TelemetryPipeline } from "../persistence/telemetry/pipeline.js";

export interface PublicPorts {
  readonly apiKeys: PublicDependencies["apiKeys"];
  readonly models: PublicDependencies["models"];
  readonly consoleApiKeys: ReturnType<typeof createApiKeysServices>["consoleApiKeys"];
  readonly invalidateModelCache: () => void;
}

export function createPublicPorts(pool: PostgresPool, registry: ProviderRegistry, telemetry?: TelemetryPipeline): PublicPorts {
  const apiKeyServices = createApiKeysServices(pool, telemetry === undefined ? {} : { usage: telemetry });
  // 30-second merged model-list cache. Invalidated on mutation callback or after TTL.
  const MODEL_CACHE_TTL_MS = 30_000;
  let modelCache: { readonly data: ReadonlyArray<{ readonly id: string; readonly object: "model"; readonly owned_by: string }>; readonly expiresAt: number } | null = null;
  let modelCacheGeneration = 0;
  let modelPending: Promise<ReadonlyArray<{ readonly id: string; readonly object: "model"; readonly owned_by: string }>> | null = null;

  /** Invalidate the model cache immediately (called on provider/model mutation). */
  const invalidateModelCache = (): void => {
    modelCacheGeneration += 1;
    modelCache = null;
  };

  const models: PublicDependencies["models"] = {
    async list(_authorized: { apiKeyId: string }) {
      const now = Date.now();
      if (modelCache !== null && now < modelCache.expiresAt) return modelCache.data;
      if (modelPending !== null) return modelPending;

      const generation = modelCacheGeneration;
      modelPending = (async () => {
        const [dbRows, registryModels] = await Promise.all([
          pool`SELECT provider, model_id FROM provider_models WHERE enabled = true ORDER BY provider, model_id` as unknown as Promise<Array<{ provider: string; model_id: string }>>,
          Promise.resolve([...registry.list()].flatMap((adapter) => adapter.models.list.map((model) => ({ provider: adapter.metadata.id, model_id: model.id })))),
        ]);
        const seen = new Set<string>();
        const merged: Array<{ id: string; object: "model"; owned_by: string }> = [];
        for (const row of [...dbRows, ...registryModels]) {
          const key = `${row.provider}/${row.model_id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push({ id: row.model_id.includes("/") ? row.model_id : `${row.provider}/${row.model_id}`, object: "model", owned_by: row.provider });
          if (!row.model_id.includes("/") && !seen.has(row.model_id)) {
            seen.add(row.model_id);
            merged.push({ id: row.model_id, object: "model", owned_by: row.provider });
          }
        }
        const sorted = Object.freeze(merged.sort((left, right) => left.id.localeCompare(right.id)));
        if (generation === modelCacheGeneration) modelCache = { data: sorted, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
        return sorted;
      })().finally(() => {
        modelPending = null;
      });
      return modelPending;
    },
  };

  return { apiKeys: apiKeyServices.publicApiKeys, models, consoleApiKeys: apiKeyServices.consoleApiKeys, invalidateModelCache };
}
