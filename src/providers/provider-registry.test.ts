import { expect, test } from "bun:test";
import { customProviderDefinition } from "./api-key/custom-provider.js";
import { builtinProviderDefinitions, providerAccessFor } from "./registry.js";
import { createDefaultRegistry } from "./default-registry.js";

test("built-in provider definitions expose OAuth and API key filtering", () => {
  const definitions = builtinProviderDefinitions();
  expect(definitions).toHaveLength(47);
  expect(definitions.filter((definition) => definition.access === "oauth")).toHaveLength(10);
  expect(definitions.filter((definition) => definition.access === "api_key")).toHaveLength(37);
  expect(providerAccessFor("antigravity")).toBe("oauth");
  expect(providerAccessFor("opencodeft")).toBe("api_key");
  expect(providerAccessFor("unknown-provider")).toBeNull();
});

test("every eager registry adapter has a built-in provider definition", async () => {
  const registry = await createDefaultRegistry();
  const definitions = builtinProviderDefinitions();
  // kimi-code has no eager adapter, so registry is definitions minus one
  const expectedSize = definitions.length - 1;
  expect(registry.size).toBe(expectedSize);
  for (const adapter of registry.list()) {
    expect(providerAccessFor(adapter.metadata.id)).not.toBeNull();
  }
});

test("database custom providers project into API key definitions", () => {
  expect(customProviderDefinition({
    slug: "internal-anthropic",
    name: "Internal Anthropic",
    baseUrl: "https://provider.example/v1",
    type: "anthropic-compatible",
    models: [],
    customHeaders: {},
    timeoutSeconds: 30,
  })).toEqual({
    id: "internal-anthropic",
    displayName: "Internal Anthropic",
    access: "api_key",
    protocol: "anthropic",
  });
});
