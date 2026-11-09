import { ApiKeyProviderBase } from "./base.js";
import { aggregateCapabilities, capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import type { DiscoveryInput } from "../../proxy/types/request.js";
import { dispatchChatCompletions, dispatchResponses } from "../../proxy/upstream/openai.js";

/**
 * TokenHarbor — unified gateway at https://tokenharbor.ai/v1
 * OpenAI-compatible. Auth: Bearer thk_live_... (Universal Key).
 * Models: GET /v1/models → {data:[{id,object,created}]}
 * Chat: POST /v1/chat/completions, Responses: POST /v1/responses (when enabled)
 * Docs: https://tokenharbor.ai/docs/getting-started/quickstart
 */
const TOKENHARBOR_BASE_URL = "https://tokenharbor.ai/v1";

const TOKENHARBOR_SURFACES = ["openai-chat", "openai-responses"] as const;

const TOKENHARBOR_FALLBACK_MODELS: readonly ProviderModel[] = [
  modelOf("th-orchestra", "TH Orchestra", capabilitiesOf({ surfaces: [...TOKENHARBOR_SURFACES], reasoning: true, images: true })),
  modelOf("gpt-5", "GPT-5", capabilitiesOf({ surfaces: [...TOKENHARBOR_SURFACES], reasoning: true, images: true })),
  modelOf("claude-opus-4-5", "Claude Opus 4.5", capabilitiesOf({ surfaces: [...TOKENHARBOR_SURFACES], reasoning: true, images: true })),
];

export class TokenharborProvider extends ApiKeyProviderBase {
  constructor() {
    super({
      metadata: {
        id: "tokenharbor",
        displayName: "TokenHarbor",
        protocol: "openai",
        credentialKind: "api_key",
        credentialUrl: "https://tokenharbor.ai",
      },
      capabilities: aggregateCapabilities(
        TOKENHARBOR_FALLBACK_MODELS,
        capabilitiesOf({ surfaces: [...TOKENHARBOR_SURFACES], reasoning: true, images: true, streaming: true }),
      ),
      models: TOKENHARBOR_FALLBACK_MODELS,
    });
  }

  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchOpenAICompatibleModels({
      baseUrl: TOKENHARBOR_BASE_URL,
      headers: { authorization: `Bearer ${input.credential}` },
      signal: input.signal,
    });
  }

  call(input: ProviderRequest): Promise<ProviderOutput> {
    const headers = {
      "content-type": "application/json",
      accept: input.request.stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${input.credential}`,
    };
    if (input.target.surface === "openai-responses") {
      return dispatchResponses(input, TOKENHARBOR_BASE_URL, headers);
    }
    return dispatchChatCompletions(input, TOKENHARBOR_BASE_URL, headers);
  }
}

