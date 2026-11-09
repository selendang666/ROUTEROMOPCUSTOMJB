import { describe, expect, test } from "bun:test";
import type { PostgresPool } from "../../persistence/pool.js";
import { capabilitiesOf, modelOf, createModelCatalog } from "../../proxy/types/provider.js";
import type { Adapter } from "../../proxy/types/request.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { createProvidersService } from "./providers.js";

describe("provider model discovery persistence", () => {
  test("skips existing models and inserts only newly discovered models", async () => {
    const registry = new ProviderRegistry();
    const capabilities = capabilitiesOf({ surfaces: ["openai-chat"] });
    const adapter = {
      metadata: { id: "custom-a", displayName: "Custom A", protocol: "openai", credentialKind: "none" },
      capabilities,
      models: createModelCatalog([]),
      discoverModels: async () => [
        modelOf("existing", "Remote Existing", capabilities),
        modelOf("new", "Remote New", capabilities),
      ],
    } as unknown as Adapter;
    registry.register(adapter);

    const writes: string[] = [];
    const pool = (async (strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("FROM custom_providers")) return [{ id: "custom-a", slug: "custom-a", base_url: "https://provider.test" }];
      if (query.includes("FROM provider_accounts")) return [];
      if (query.includes("SELECT model_id FROM provider_models")) return [{ model_id: "existing" }];
      if (query.includes("INSERT INTO provider_models")) writes.push(query);
      return [];
    }) as unknown as PostgresPool;

    const result = await createProvidersService(pool, registry).fetchModels("custom-a");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ fetched: 2, added: 1 });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("DO NOTHING");
    expect(writes[0]).not.toContain("DO UPDATE");
  });
});

describe("provider catalog visibility", () => {
  test("keeps custom registry adapters out of built-in provider sections", async () => {
    const registry = new ProviderRegistry();
    const capabilities = capabilitiesOf({ surfaces: ["openai-chat"] });
    const createAdapter = (id: string, displayName: string): Adapter => ({
      metadata: { id, displayName, protocol: "openai", credentialKind: "api_key" },
      capabilities,
      models: createModelCatalog([]),
      resolveTarget: () => ({ providerId: id, modelId: "model", surface: "openai-chat" }),
      call: async () => { throw new Error("not called"); },
      mapError: (error: unknown) => error as never,
    });
    registry.register(createAdapter("cerebras", "Cerebras"));
    registry.register(createAdapter("manual-b3f2c1", "Manual BYOK"));

    const pool = (async () => []) as unknown as PostgresPool;
    const builtins = await createProvidersService(pool, registry).listBuiltins();

    expect(builtins.some((provider) => provider.id === "manual-b3f2c1")).toBe(false);
    expect(builtins.find((provider) => provider.id === "cerebras")).toMatchObject({ source: "builtin" });
  });

  test("marks custom provider API rows as custom", async () => {
    const registry = new ProviderRegistry();
    const pool = (async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("FROM custom_providers")) {
        return [{ id: "manual-b3f2c1", slug: "manual-b3f2c1", name: "Manual BYOK", type: "openai-compatible", base_url: "https://provider.test", models_json: [], timeout_seconds: 30, headers_json: {} }];
      }
      return [];
    }) as unknown as PostgresPool;

    const custom = await createProvidersService(pool, registry).list();

    expect(custom).toMatchObject([{ id: "manual-b3f2c1", source: "custom" }]);
  });
});
