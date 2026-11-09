import { ApiKeyProviderBase } from "./base.js";
import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { DiscoveryInput, ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import { dispatchChatCompletions } from "../../proxy/upstream/openai.js";

const models = [
  modelOf("z-ai/glm-5.2", "GLM 5.2", capabilitiesOf({ surfaces: ["openai-chat"] as const, reasoning: true, images: true }), { upstreamId: "blackboxai/z-ai/glm-5.2" }),
  modelOf("z-ai/glm-5.2-vercel", "GLM 5.2 Vercel", capabilitiesOf({ surfaces: ["openai-chat"] as const, reasoning: true, images: true }), { upstreamId: "blackboxai/z-ai/glm-5.2-vercel" }),
];

/** Blackbox AI — owns catalog + upstream dispatch, no central provider-data. */
export class BlackboxAIProvider extends ApiKeyProviderBase {
  constructor() {
    super({
      metadata: { id: "blackboxai", displayName: "Blackbox AI", protocol: "openai", credentialKind: "api_key" },
      capabilities: capabilitiesOf({ surfaces: ["openai-chat"] as const, reasoning: true, images: true, streaming: true }),
      models,
    });
  }
  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchOpenAICompatibleModels({
      baseUrl: "https://api.blackbox.ai/v1",
      headers: { authorization: `Bearer ${input.credential}` },
      signal: input.signal,
    });
  }

  call(input: ProviderRequest): Promise<ProviderOutput> {
    return dispatchChatCompletions(input, "https://api.blackbox.ai/v1", {
      "content-type": "application/json",
      authorization: `Bearer ${input.credential}`,
    });
  }
}
