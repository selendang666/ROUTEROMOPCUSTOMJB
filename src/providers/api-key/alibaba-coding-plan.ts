import { ApiKeyProviderBase } from "./base.js";
import { aggregateCapabilities, capabilitiesOf } from "../../proxy/types/provider.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { DiscoveryInput, ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import { dispatchChatCompletions } from "../../proxy/upstream/openai.js";

/**
 * alibaba-coding-plan provider — distinct from `alibaba` (dashscope compatible-mode).
 * Intl domain: https://coding-intl.dashscope.aliyuncs.com/v1
 * CN variant (coding-cn) deferred behind separate id if needed.
 */
const config = {
  id: "alibabacp",
  displayName: "Alibaba Coding Plan",
  baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
  credentialKind: "api_key" as const,
  credentialUrl: "https://bailian.console.aliyun.com/",
} as const;

const models: readonly ProviderModel[] = [];

export class AlibabaCodingPlanProvider extends ApiKeyProviderBase {
  constructor() {
    super({
      metadata: {
        id: config.id,
        displayName: config.displayName,
        protocol: "openai",
        credentialKind: "api_key",
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
      headers: { authorization: `Bearer ${input.credential}` },
      signal: input.signal,
    });
  }

  call(input: ProviderRequest): Promise<ProviderOutput> {
    return dispatchChatCompletions(input, config.baseUrl, {
      "content-type": "application/json",
      accept: input.request.stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${input.credential}`,
    });
  }
}

