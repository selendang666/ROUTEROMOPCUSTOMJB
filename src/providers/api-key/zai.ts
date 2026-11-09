import { ApiKeyProviderBase } from "./base.js";
import { aggregateCapabilities, capabilitiesOf } from "../../proxy/types/provider.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { DiscoveryInput, ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import { dispatchChatCompletions } from "../../proxy/upstream/openai.js";
import { extractAccessTokenOrRaw } from "../../auth/contract.js";

/**
 * zai provider — Z.AI / Zhipu Coding Plan.
 * Primary baseUrl https://api.z.ai/api/paas/v4 (intl).
 * CN fallback https://open.bigmodel.cn/api/coding/paas/v4 is region-specific and not auto-switched;
 * use separate provider id later if needed.
 */
const config = {
  id: "zai",
  displayName: "Z.AI",
  baseUrl: "https://api.z.ai/api/paas/v4",
  credentialKind: "api_key" as const,
  credentialUrl: "https://z.ai/manage-apikey/apikey-list",
} as const;

const models: readonly ProviderModel[] = [];

export class ZaiProvider extends ApiKeyProviderBase {
  constructor(overrideId?: string) {
    const id = overrideId ?? config.id;
    super({
      metadata: {
        id,
        displayName: id === "zaicp" ? "Z.AI Coding Plan" : "Z.AI (API Key)",
        protocol: "openai",
        credentialKind: id === "zaicp" ? "oauth" : "api_key",
        ...(id === "zaicp" ? { credentialKinds: ["oauth", "api_key"] as const } : {}),
        credentialUrl: config.credentialUrl,
      },
      capabilities: aggregateCapabilities(models, capabilitiesOf({ surfaces: ["openai-chat"], streaming: true })),
      models,
    });
  }

  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchOpenAICompatibleModels({
      baseUrl: config.baseUrl,
      headers: { authorization: `Bearer ${extractAccessTokenOrRaw(input.credential)}` },
      signal: input.signal,
    });
  }

  call(input: ProviderRequest): Promise<ProviderOutput> {
    return dispatchChatCompletions(input, config.baseUrl, {
      "content-type": "application/json",
      accept: input.request.stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${extractAccessTokenOrRaw(input.credential)}`,
    });
  }
}

