import { ApiKeyProviderBase } from "./base.js";
import { aggregateCapabilities, capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import type { DiscoveryInput } from "../../proxy/types/request.js";
import { dispatchChatCompletions } from "../../proxy/upstream/openai.js";

/** openrouter provider: local config, models, adapter, and upstream behavior. */
const config = { id: "openrouter", displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", credentialKind: "api_key" };
const models: readonly ProviderModel[] = "models" in config && Array.isArray(config.models) ? config.models as readonly ProviderModel[] : [];

export class OpenrouterProvider extends ApiKeyProviderBase {
  constructor() {
    super({ metadata: { id: config.id, displayName: config.displayName, protocol: "openai", credentialKind: "api_key", ...("credentialUrl" in config && typeof config.credentialUrl === "string" ? { credentialUrl: config.credentialUrl } : {}) }, capabilities: aggregateCapabilities(models, capabilitiesOf({ surfaces: ["openai-chat"], streaming: true })), models });
  }
  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchOpenAICompatibleModels({ baseUrl: config.baseUrl, headers: { authorization: `Bearer ${input.credential}` }, signal: input.signal });
  }
  call(input: ProviderRequest): Promise<ProviderOutput> {
    return dispatchChatCompletions(input, config.baseUrl, { "content-type": "application/json", accept: input.request.stream ? "text/event-stream" : "application/json", authorization: "Bearer " + input.credential, "HTTP-Referer": "https://endpoint-proxy.local", "X-Title": "Endpoint Proxy" });
  }
}

