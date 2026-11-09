import { describe, expect, test } from "bun:test";
import type { PostgresPool } from "../persistence/pool.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { Adapter } from "../proxy/types/request.js";
import { capabilitiesOf, createModelCatalog, modelOf } from "../proxy/types/provider.js";
import { createPublicPorts } from "./public-ports.js";

function createMockPool(dbRows: Array<{ provider: string; model_id: string }>): PostgresPool {
  return (async (strings: TemplateStringsArray) => {
    const query = strings.join("");
    if (query.includes("FROM provider_models")) return dbRows;
    return [];
  }) as unknown as PostgresPool;
}

function createRegistryWithModel(providerId: string, modelId: string): ProviderRegistry {
  const registry = new ProviderRegistry();
  const capabilities = capabilitiesOf({ surfaces: ["openai-chat"] });
  const adapter = {
    metadata: { id: providerId, displayName: providerId, protocol: "openai", credentialKind: "none" },
    capabilities,
    models: createModelCatalog([modelOf(modelId, modelId, capabilities)]),
  } as unknown as Adapter;
  registry.register(adapter);
  return registry;
}

describe("model-list cache", () => {
  test("returns cached result within TTL", async () => {
    const dbRows = [{ provider: "openai", model_id: "gpt-4o" }];
    const pool = createMockPool(dbRows);
    const registry = createRegistryWithModel("openai", "gpt-4o");
    const ports = createPublicPorts(pool, registry);

    const first = await ports.models.list({ apiKeyId: "test" });
    const second = await ports.models.list({ apiKeyId: "test" });

    // Same reference proves cache hit (Object.freeze preserves identity)
    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(0);
  });

  test("returns frozen array that cannot be mutated by callers", async () => {
    const dbRows = [{ provider: "openai", model_id: "gpt-4o" }];
    const pool = createMockPool(dbRows);
    const registry = createRegistryWithModel("openai", "gpt-4o");
    const ports = createPublicPorts(pool, registry);

    const result = await ports.models.list({ apiKeyId: "test" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("invalidateModelCache forces fresh fetch on next call", async () => {
    let dbRows = [{ provider: "openai", model_id: "gpt-4o" }];
    const pool = (async (strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("FROM provider_models")) return dbRows;
      return [];
    }) as unknown as PostgresPool;
    const registry = createRegistryWithModel("openai", "gpt-4o");
    const ports = createPublicPorts(pool, registry);

    const first = await ports.models.list({ apiKeyId: "test" });
    expect(first.some((m) => m.id === "openai/gpt-4o")).toBe(true);

    // Mutate DB rows and invalidate cache
    dbRows = [{ provider: "openai", model_id: "gpt-4o-mini" }];
    ports.invalidateModelCache();

    const second = await ports.models.list({ apiKeyId: "test" });
    // Different reference proves cache was invalidated
    expect(second).not.toBe(first);
    expect(second.some((m) => m.id === "openai/gpt-4o-mini")).toBe(true);
  });

  test("deduplicates models from DB and registry", async () => {
    const dbRows = [{ provider: "openai", model_id: "gpt-4o" }];
    const pool = createMockPool(dbRows);
    const registry = createRegistryWithModel("openai", "gpt-4o");
    const ports = createPublicPorts(pool, registry);

    const result = await ports.models.list({ apiKeyId: "test" });
    const gpt4o = result.filter((m) => m.id === "openai/gpt-4o");
    expect(gpt4o).toHaveLength(1);
  });
});
