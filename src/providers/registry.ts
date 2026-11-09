import { internalFailureFromUnknown } from "../proxy/errors.js";
import type { Adapter, ProviderRequest } from "../proxy/types/request.js";
import type { ProviderCatalogAdapter } from "../proxy/types/provider.js";
import type { RouteTarget } from "../proxy/types/routing.js";
import type { Surface } from "../proxy/types/surface.js";
import { UpstreamError } from "../proxy/transport/errors.js";
import type { ProviderAccess, ProviderDefinition } from "./model-catalog.js";
import { OAUTH_PROVIDER_DEFINITIONS } from "./oauth-provider/provider-definitions.js";

/**
 * Typed ProviderAdapter registry. Registration is id-keyed; resolution
 * prefers adapters whose catalog knows the model, otherwise the first
 * adapter declaring the surface. Unsupported surfaces fail with a typed
 * capability_unsupported error rather than an empty success.
 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, Adapter>();
  private readonly loaders = new Map<string, () => Promise<Adapter>>();
  private readonly adaptersBySurface = new Map<Surface, Adapter[]>();

  register(adapter: Adapter): void {
    const id = adapter.metadata.id;
    const existing = this.adapters.get(id);
    if (existing !== undefined && existing !== adapter) {
      throw new UpstreamError({ kind: "internal_error", message: `Provider "${id}" is already registered`, routeScope: null });
    }
    this.adapters.set(id, adapter);
    for (const surface of adapter.capabilities.surfaces) {
      const adapters = this.adaptersBySurface.get(surface);
      if (adapters === undefined) this.adaptersBySurface.set(surface, [adapter]);
      else if (!adapters.includes(adapter)) adapters.push(adapter);
    }
    this.loaders.delete(id);
  }

  registerLazy(catalog: ProviderCatalogAdapter, loader: () => Promise<Adapter>): void {
    const id = catalog.metadata.id;
    if (this.adapters.has(id)) {
      throw new UpstreamError({ kind: "internal_error", message: `Provider "${id}" is already registered`, routeScope: null });
    }
    let pending: Promise<Adapter> | null = null;
    let settledAdapter: Adapter | null = null;
    const lazyAdapter: Adapter = {
      metadata: catalog.metadata,
      capabilities: catalog.capabilities,
      models: catalog.models,
      resolveTarget: catalog.resolveTarget.bind(catalog),
      call: (input: ProviderRequest) => ensureLoaded().then((adapter) => adapter.call(input)),
      mapError: (error: unknown) => ensureLoaded().then((adapter) => adapter.mapError(error)).catch(() => internalFailureFromUnknown(error)),
    } as unknown as Adapter;
    const ensureLoaded = (): Promise<Adapter> => {
      if (settledAdapter !== null) return Promise.resolve(settledAdapter);
      if (pending !== null) return pending;
      pending = loader()
        .then((real) => {
          if (real.metadata.id !== id) {
            throw new UpstreamError({ kind: "internal_error", message: `Lazy loader for "${id}" returned mismatched id "${real.metadata.id}"`, routeScope: null });
          }
          // Swap lazy for real in main map and surface indexes
          this.adapters.set(id, real);
          for (const surface of catalog.capabilities.surfaces) {
            const list = this.adaptersBySurface.get(surface);
            if (list !== undefined) {
              const idx = list.indexOf(lazyAdapter);
              if (idx !== -1) list.splice(idx, 1);
            }
          }
          for (const surface of real.capabilities.surfaces) {
            const list = this.adaptersBySurface.get(surface);
            if (list === undefined) this.adaptersBySurface.set(surface, [real]);
            else if (!list.includes(real)) list.push(real);
          }
          settledAdapter = real;
          this.loaders.delete(id);
          return real;
        })
        .catch((error: unknown) => {
          pending = null;
          throw error;
        });
      return pending;
    };
    this.adapters.set(id, lazyAdapter);
    this.loaders.set(id, ensureLoaded);
    for (const surface of catalog.capabilities.surfaces) {
      const adapters = this.adaptersBySurface.get(surface);
      if (adapters === undefined) this.adaptersBySurface.set(surface, [lazyAdapter]);
      else if (!adapters.includes(lazyAdapter)) adapters.push(lazyAdapter);
    }
  }

  get(providerId: string): Adapter | null {
    return this.adapters.get(providerId) ?? null;
  }

  unregister(providerId: string): boolean {
    const adapter = this.adapters.get(providerId);
    if (adapter === undefined) return false;
    this.loaders.delete(providerId);
    this.adapters.delete(providerId);
    for (const [surface, list] of this.adaptersBySurface) {
      const idx = list.indexOf(adapter);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this.adaptersBySurface.delete(surface);
    }
    return true;
  }

  list(): readonly Adapter[] {
    return [...this.adapters.values()];
  }

  get size(): number {
    return this.adapters.size;
  }

  supportedSurfaces(): readonly Surface[] {
    return [...this.adaptersBySurface.keys()];
  }

  adapterFor(modelId: string, surface: Surface): Adapter {
    // 1) Exact model match — canonical routing, regardless of surface.
    const byModel = [...this.adapters.values()].find((adapter) => adapter.models.get(modelId) !== null);
    if (byModel !== undefined) return byModel;
    // 2) Unknown model — explicit surface fallback to first provider declaring the surface.
    // This keeps legacy permissive routing for custom/unknown models while remaining explicit.
    const bySurface = this.adaptersBySurface.get(surface);
    if (bySurface !== undefined && bySurface.length > 0) return bySurface[0]!;
    throw new UpstreamError({ kind: "capability_unsupported", message: `No provider supports surface "${surface}" for model "${modelId}"`, statusCode: 400, routeScope: null });
  }

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    const adapter = this.adapterFor(modelId, surface);
    return adapter.resolveTarget(modelId, surface);
  }
}

const API_KEY_PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  { id: "openai", displayName: "OpenAI", access: "api_key", protocol: "openai" },
  { id: "anthropic", displayName: "Anthropic", access: "api_key", protocol: "anthropic" },
  { id: "gemini", displayName: "Google Gemini", access: "api_key", protocol: "gemini" },
  { id: "openrouter", displayName: "OpenRouter", access: "api_key", protocol: "openai" },
  { id: "groq", displayName: "Groq", access: "api_key", protocol: "openai" },
  { id: "alibaba", displayName: "Alibaba Cloud", access: "api_key", protocol: "openai" },
  { id: "fireworks", displayName: "Fireworks AI", access: "api_key", protocol: "openai" },
  { id: "deepseek", displayName: "DeepSeek", access: "api_key", protocol: "openai" },
  { id: "mistral", displayName: "Mistral AI", access: "api_key", protocol: "openai" },
  { id: "siliconflow", displayName: "SiliconFlow", access: "api_key", protocol: "openai" },
  { id: "cerebras", displayName: "Cerebras", access: "api_key", protocol: "openai" },
  { id: "nvidia", displayName: "NVIDIA", access: "api_key", protocol: "openai" },
  { id: "xiaomipg", displayName: "Xiaomi MiMo (PAYG)", access: "api_key", protocol: "openai" },
  { id: "xiaomitp", displayName: "Xiaomi MiMo (Token Plan)", access: "api_key", protocol: "openai" },
  { id: "blackboxai", displayName: "Blackbox AI", access: "api_key", protocol: "openai" },
  { id: "ollama", displayName: "Ollama", access: "api_key", protocol: "openai" },
  { id: "cloudflare", displayName: "Cloudflare", access: "api_key", protocol: "openai" },
  { id: "cb", displayName: "CodeBuddy", access: "api_key", protocol: "openai" },
  { id: "cbcn", displayName: "CodeBuddy CN", access: "api_key", protocol: "openai" },
  { id: "opencodeft", displayName: "OpenCode Free", access: "api_key", protocol: "openai" },
  { id: "opencodezen", displayName: "OpenCode Zen", access: "api_key", protocol: "openai" },
  { id: "opencodego", displayName: "OpenCode Go", access: "api_key", protocol: "openai" },

  { id: "commandcode", displayName: "Command Code", access: "api_key", protocol: "openai" },
  { id: "qoder", displayName: "Qoder", access: "api_key", protocol: "openai" },
  { id: "agentrouter", displayName: "AgentRouter", access: "api_key", protocol: "openai" },
  { id: "exa", displayName: "Exa", access: "api_key", protocol: "openai" },
  { id: "devin-search", displayName: "Devin", access: "api_key", protocol: "openai" },
  { id: "perplexity", displayName: "Perplexity", access: "api_key", protocol: "openai" },
  { id: "parallel", displayName: "Parallel", access: "api_key", protocol: "openai" },
  { id: "inferhub", displayName: "InferHub", access: "api_key", protocol: "openai" },
  { id: "gmi", displayName: "GMI Cloud", access: "api_key", protocol: "openai" },
  { id: "zai", displayName: "Z.AI", access: "api_key", protocol: "openai" },

  { id: "alibabacp", displayName: "Alibaba Coding Plan", access: "api_key", protocol: "openai" },
  { id: "hermes", displayName: "Nous Research", access: "api_key", protocol: "openai" },
  { id: "bai", displayName: "B.AI", access: "api_key", protocol: "openai" },
  { id: "tokenharbor", displayName: "TokenHarbor", access: "api_key", protocol: "openai" },
  { id: "aihubmix", displayName: "AiHubMix", access: "api_key", protocol: "openai" },
] as const;
const BUILTIN_PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = Object.freeze([...OAUTH_PROVIDER_DEFINITIONS, ...API_KEY_PROVIDER_DEFINITIONS]);
const BUILTIN_PROVIDER_ACCESS = new Map(BUILTIN_PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition.access]));

/** Resolves the primary access class for provider filtering. */
export function providerAccessFor(providerId: string): ProviderAccess | null { return BUILTIN_PROVIDER_ACCESS.get(providerId) ?? null; }

/** Returns provider access definitions derived from the registry provider IDs. */
export function builtinProviderDefinitions(): readonly ProviderDefinition[] { return BUILTIN_PROVIDER_DEFINITIONS; }

/** Loads one OAuth provider into the registry. API-key providers are eagerly composed by default-registry. */
export async function loadOptionalProvider(providerId: string, registry: ProviderRegistry): Promise<Adapter | null> {
  const loaders: Record<string, () => Promise<Adapter>> = {
    codex: async () => { const { CodexAdapter } = await import("./oauth-provider/codex.js"); return new CodexAdapter(); },
    antigravity: async () => { const { AntigravityAdapter } = await import("./oauth-provider/antigravity.js"); return new AntigravityAdapter(); },
    claude: async () => { const { AnthropicOAuthAdapter } = await import("./oauth-provider/claude-code.js"); return new AnthropicOAuthAdapter(); },
    cursor: async () => { const { CursorAdapter } = await import("./oauth-provider/cursor.js"); return new CursorAdapter(); },
    devin: async () => { const { DevinAdapter } = await import("./oauth-provider/devin.js"); return new DevinAdapter(); },
  };
  const loader = loaders[providerId];
  if (!loader) return null;
  const adapter = await loader();
  registry.register(adapter);
  return adapter;
}
