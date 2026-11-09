import { describe, expect, test } from "bun:test";
import { builtinProviderDefinitions, providerAccessFor, ProviderRegistry } from "./registry.js";
import { createDefaultRegistry } from "./default-registry.js";
import { OAUTH_PROVIDER_DEFINITIONS } from "./oauth-provider/provider-definitions.js";
import { AnthropicOAuthAdapter } from "./oauth-provider/claude-code.js";
import { fetchProviderQuota } from "./quota-fetch/fetch.js";
import { fetchOpenAICompatibleModels } from "./fetch-models.js";
import { capabilitiesOf, createModelCatalog, modelOf } from "../proxy/types/provider.js";
import type { Adapter } from "../proxy/types/request.js";

describe("canonical provider identity", () => {
  test("oauth definitions are canonical claude (short)", () => {
    const ids = OAUTH_PROVIDER_DEFINITIONS.map((d) => d.id);
    expect(ids).toContain("claude");
    expect(ids).not.toContain("claude-code");
    expect(ids).toContain("codex");
    expect(ids).toContain("antigravity");
  });

  test("AnthropicOAuthAdapter metadata is claude", () => {
    const adapter = new AnthropicOAuthAdapter();
    expect(adapter.metadata.id).toBe("claude");
    expect(adapter.metadata.protocol).toBe("anthropic");
    expect(adapter.metadata.credentialKind).toBe("oauth");
  });

  test("quota fetch dispatches claude", async () => {
    const fetcher = (async () => Response.json({ five_hour: { utilization: 10, resets_at: new Date().toISOString() }, seven_day: { utilization: 20, resets_at: new Date().toISOString() } })) as typeof fetch;
    const result = await fetchProviderQuota("claude", "token", undefined, fetcher);
    expect(result.source).toBe("claude");
    expect(result.error).toBeNull();
  });

  test("builtin definitions parity and match registry", async () => {
    const defs = builtinProviderDefinitions();
    expect(defs).toHaveLength(47);
    expect(defs.filter((d) => d.access === "oauth")).toHaveLength(10);
    expect(defs.filter((d) => d.access === "api_key")).toHaveLength(37);
    expect(providerAccessFor("claude")).toBe("oauth");
    expect(providerAccessFor("claude-code")).toBeNull();
    expect(providerAccessFor("codex")).toBe("oauth");
    expect(providerAccessFor("antigravity")).toBe("oauth");
    expect(providerAccessFor("openai")).toBe("api_key");
    // registry size matches eager adapters plus lazy OAuth providers
    const registry = await createDefaultRegistry();
    const expectedSize = defs.length - 1; // kimi-code has no eager adapter
    expect(registry.size).toBe(expectedSize);
    const adapterIds = new Set(registry.list().map((a) => a.metadata.id));
    // Every adapter must have a definition; oauth definitions may exceed lazy adapters
    for (const id of adapterIds) expect(defs.some((d) => d.id === id)).toBe(true);
    // representative sample — use short ids where applicable
    for (const id of ["openai", "anthropic", "gemini", "codex", "claude", "antigravity", "openrouter", "ollama", "blackboxai", "cb", "cbcn", "hermes", "gmi", "alibabacp", "zaicp", "github"]) {
      expect(providerAccessFor(id)).not.toBeNull();
    }
  });
});

describe("registry unknown model/surface fallback explicit", () => {
  test("known model routes to owning provider regardless of surface order", () => {
    const registry = new ProviderRegistry();
    const a: Adapter = {
      metadata: { id: "openai", displayName: "OpenAI", protocol: "openai", credentialKind: "api_key" },
      capabilities: capabilitiesOf({ surfaces: ["openai-chat"] }),
      models: createModelCatalog([modelOf("gpt-4", "GPT-4", capabilitiesOf({ surfaces: ["openai-chat"] }))]),
      resolveTarget: (modelId, surface) => ({ providerId: "openai", modelId, surface, upstreamModelId: modelId }),
      call: async () => ({ body: {} }),
      mapError: (e) => e as never,
    } as unknown as Adapter;
    const b: Adapter = {
      metadata: { id: "anthropic", displayName: "Anthropic", protocol: "anthropic", credentialKind: "api_key" },
      capabilities: capabilitiesOf({ surfaces: ["anthropic-messages"] }),
      models: createModelCatalog([modelOf("claude-3", "Claude 3", capabilitiesOf({ surfaces: ["anthropic-messages"] }))]),
      resolveTarget: (modelId, surface) => ({ providerId: "anthropic", modelId, surface, upstreamModelId: modelId }),
      call: async () => ({ body: {} }),
      mapError: (e) => e as never,
    } as unknown as Adapter;
    registry.register(a);
    registry.register(b);
    expect(registry.adapterFor("gpt-4", "openai-chat").metadata.id).toBe("openai");
    // unknown model falls back to surface first
    expect(registry.adapterFor("unknown-model-x", "anthropic-messages").metadata.id).toBe("anthropic");
    expect(registry.adapterFor("unknown-model-x", "openai-chat").metadata.id).toBe("openai");
  });

  test("unsupported surface throws capability_unsupported", () => {
    const registry = new ProviderRegistry();
    const a: Adapter = {
      metadata: { id: "openai", displayName: "OpenAI", protocol: "openai", credentialKind: "api_key" },
      capabilities: capabilitiesOf({ surfaces: ["openai-chat"] }),
      models: createModelCatalog([]),
      resolveTarget: (modelId, surface) => ({ providerId: "openai", modelId, surface, upstreamModelId: modelId }),
      call: async () => ({ body: {} }),
      mapError: (e) => e as never,
    } as unknown as Adapter;
    registry.register(a);
    expect(() => registry.adapterFor("unknown", "anthropic-messages" as never)).toThrow();
  });
});

describe("registry lazy single-flight and surface indexes", () => {
  test("lazy registration is functional with surface indexes and single-flight", async () => {
    const registry = new ProviderRegistry();
    let loaderCalls = 0;
    const catalog = {
      metadata: { id: "lazy-provider", displayName: "Lazy", protocol: "openai" as const, credentialKind: "api_key" as const },
      capabilities: capabilitiesOf({ surfaces: ["openai-chat"] }),
      models: createModelCatalog([modelOf("lazy-model", "Lazy Model", capabilitiesOf({ surfaces: ["openai-chat"] }))]),
      resolveTarget: (modelId: string, surface: never) => ({ providerId: "lazy-provider", modelId, surface, upstreamModelId: modelId }),
    };
    const realAdapter: Adapter = {
      metadata: { id: "lazy-provider", displayName: "Lazy", protocol: "openai", credentialKind: "api_key" },
      capabilities: capabilitiesOf({ surfaces: ["openai-chat"] }),
      models: createModelCatalog([modelOf("lazy-model", "Lazy Model", capabilitiesOf({ surfaces: ["openai-chat"] }))]),
      resolveTarget: (modelId, surface) => ({ providerId: "lazy-provider", modelId, surface, upstreamModelId: modelId }),
      call: async () => ({ body: { ok: true } }),
      mapError: (e) => e as never,
    } as unknown as Adapter;
    registry.registerLazy(catalog as never, async () => {
      loaderCalls++;
      return realAdapter;
    });
    // Before load, surface fallback should find lazy
    expect(registry.supportedSurfaces()).toContain("openai-chat");
    expect(registry.adapterFor("unknown-lazy", "openai-chat").metadata.id).toBe("lazy-provider");
    expect(registry.get("lazy-provider")).not.toBeNull();
    // Concurrent calls single-flight
    const input = { target: { providerId: "lazy-provider", modelId: "lazy-model", surface: "openai-chat", upstreamModelId: "lazy-model" }, request: { model: "lazy-model", messages: [], tools: [], stream: false, limits: { maxBodyBytes: 1000, connectTimeoutMs: 1000, firstByteTimeoutMs: 1000, idleTimeoutMs: 1000, totalTimeoutMs: 10000 } }, credential: "k", network: { proxyId: null, url: null, release: async () => {} }, headers: new Headers(), signal: new AbortController().signal } as never;
    const [r1, r2] = await Promise.all([registry.get("lazy-provider")!.call(input), registry.get("lazy-provider")!.call(input)]);
    expect(loaderCalls).toBe(1);
    expect(r1).toEqual({ body: { ok: true } });
    expect(r2).toEqual({ body: { ok: true } });
    // After settlement, get returns real adapter directly
    expect(registry.get("lazy-provider")).toBe(realAdapter);
    expect(registry.adapterFor("lazy-model", "openai-chat").metadata.id).toBe("lazy-provider");
  });

  test("lazy loader error resets pending and retries", async () => {
    const registry = new ProviderRegistry();
    let attempts = 0;
    const catalog = {
      metadata: { id: "retry-lazy", displayName: "Retry", protocol: "openai" as const, credentialKind: "api_key" as const },
      capabilities: capabilitiesOf({ surfaces: ["openai-chat"] }),
      models: createModelCatalog([]),
      resolveTarget: (modelId: string, surface: never) => ({ providerId: "retry-lazy", modelId, surface, upstreamModelId: modelId }),
    };
    const good: Adapter = {
      metadata: { id: "retry-lazy", displayName: "Retry", protocol: "openai" as const, credentialKind: "api_key" as const },
      capabilities: capabilitiesOf({ surfaces: ["openai-chat"] }),
      models: createModelCatalog([]),
      resolveTarget: (m, s) => ({ providerId: "retry-lazy", modelId: m, surface: s, upstreamModelId: m }),
      call: async () => ({ body: {} }),
      mapError: (e) => e as never,
    } as unknown as Adapter;
    registry.registerLazy(catalog as never, async () => {
      attempts++;
      if (attempts === 1) throw new Error("first fail");
      return good;
    });
    const input = { target: { providerId: "retry-lazy", modelId: "m", surface: "openai-chat", upstreamModelId: "m" }, request: { model: "m", messages: [], tools: [], stream: false, limits: { maxBodyBytes: 1, connectTimeoutMs: 1, firstByteTimeoutMs: 1, idleTimeoutMs: 1, totalTimeoutMs: 1 } }, credential: "k", network: { proxyId: null, url: null, release: async () => {} }, headers: new Headers(), signal: new AbortController().signal } as never;
    await expect(registry.get("retry-lazy")!.call(input)).rejects.toThrow("first fail");
    await expect(registry.get("retry-lazy")!.call(input)).resolves.toEqual({ body: {} });
    expect(attempts).toBe(2);
  });
});

describe("generic discovery endpoint isolation", () => {
  test("different baseUrls fetch independently via helper", async () => {
    const fetcherA = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("example-a.com")) return Response.json({ data: [{ id: "model-a" }] });
      return Response.json({ data: [{ id: "model-b" }] });
    }) as typeof fetch;
    const modelsA = await fetchOpenAICompatibleModels({ baseUrl: "https://example-a.com/v1", fetcher: fetcherA });
    const modelsB = await fetchOpenAICompatibleModels({ baseUrl: "https://example-b.com/v1", fetcher: fetcherA });
    expect(modelsA?.[0]?.id).toBe("model-a");
    expect(modelsB?.[0]?.id).toBe("model-b");
  });
  test("fetchOpenAICompatibleModels returns null on incompatible payload", async () => {
    const fetcher = (async () => Response.json({ unexpected: true })) as typeof fetch;
    const models = await fetchOpenAICompatibleModels({ baseUrl: "https://example.com/v1", fetcher });
    expect(models).toBeNull();
  });
});
