import { ApiKeyProviderBase } from "./base.js";
import { aggregateCapabilities, capabilitiesOf } from "../../proxy/types/provider.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { DiscoveryInput, ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import { dispatchChatCompletions } from "../../proxy/upstream/openai.js";

/**
 * Configuration for creating a simple OpenAI-compatible provider.
 * Covers the common pattern shared by ~20 providers (groq, deepseek,
 * openrouter, cerebras, mistral, nvidia, siliconflow, alibaba, fireworks,
 * cloudflare, blackboxai, gmi-cloud, tokenharbor, aihubmix, bai, etc.).
 */
export interface SimpleOpenAIProviderConfig {
  /** Provider id used in routing and metadata. */
  readonly id: string;
  /** Human-readable provider name. */
  readonly displayName: string;
  /** OpenAI-compatible base URL (without trailing /v1 or /chat/completions). */
  readonly baseUrl: string;
  /** Static model catalog. */
  readonly models: readonly ProviderModel[];
  /** Optional URL for credential provisioning. */
  readonly credentialUrl?: string;
  /** Extra headers merged into every request (e.g. custom auth, org ids). */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /**
   * Whether to implement `discoverModels` via `/models` endpoint.
   * Defaults to `true`. Set `false` for providers without a models listing.
   */
  readonly discoverModels?: boolean;
}

/**
 * Factory that produces an `ApiKeyProviderBase` subclass for a simple
 * OpenAI-compatible provider. The returned class handles:
 * - metadata + capabilities construction from the static model list
 * - `call()` delegating to `dispatchChatCompletions`
 * - optional `discoverModels()` via `fetchOpenAICompatibleModels`
 *
 * Providers with non-standard upstream behavior (e.g. ollama uses
 * `dispatchResponses`) or complex message conversion should extend
 * `ApiKeyProviderBase` directly instead.
 */
export function createSimpleOpenAIProvider(cfg: SimpleOpenAIProviderConfig): new () => ApiKeyProviderBase {
  const shouldDiscover = cfg.discoverModels !== false;

  return class extends ApiKeyProviderBase {
    constructor() {
      super({
        metadata: {
          id: cfg.id,
          displayName: cfg.displayName,
          protocol: "openai",
          credentialKind: "api_key",
          ...(cfg.credentialUrl !== undefined ? { credentialUrl: cfg.credentialUrl } : {}),
        },
        capabilities: aggregateCapabilities(cfg.models, capabilitiesOf({ surfaces: ["openai-chat"], streaming: true })),
        models: cfg.models,
      });
    }

    async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
      if (!shouldDiscover) return null;
      if (input.credential === null || input.credential.length === 0) return null;
      return fetchOpenAICompatibleModels({
        baseUrl: cfg.baseUrl,
        headers: { authorization: `Bearer ${input.credential}` },
        signal: input.signal,
      });
    }

    call(input: ProviderRequest): Promise<ProviderOutput> {
      return dispatchChatCompletions(input, cfg.baseUrl, {
        "content-type": "application/json",
        accept: input.request.stream ? "text/event-stream" : "application/json",
        authorization: `Bearer ${input.credential}`,
        ...cfg.extraHeaders,
      });
    }
  };
}
