import { ApiKeyProviderBase } from "./base.js";
import { aggregateCapabilities, capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import type { DiscoveryInput } from "../../proxy/types/request.js";
import { dispatchChatCompletions, dispatchResponses } from "../../proxy/upstream/openai.js";
import { dispatchAnthropic } from "../../proxy/upstream/anthropic.js";

/**
 * B.AI provider — unified gateway (https://api.b.ai/v1) supporting
 * OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages
 * on the same API key (Bearer or x-api-key). Discovery via GET /v1/models
 * (OpenAI-compatible, {object:"list", success:true, data:[{id}]}).
 * Docs: https://docs.b.ai/llmservice/api/
 */

const BAI_BASE_URL = "https://api.b.ai/v1";
const BAI_SURFACES = ["openai-chat", "openai-responses", "anthropic-messages"] as const;

const BAI_FALLBACK_MODELS: readonly ProviderModel[] = [
  modelOf("gpt-5", "B.AI GPT-5", capabilitiesOf({ surfaces: ["openai-chat", "openai-responses"], reasoning: true, images: true })),
  modelOf("claude-4-sonnet", "B.AI Claude 4 Sonnet", capabilitiesOf({ surfaces: ["anthropic-messages", "openai-chat"], reasoning: true, images: true })),
  modelOf("gemini-3-pro", "B.AI Gemini 3 Pro", capabilitiesOf({ surfaces: ["openai-chat", "openai-responses"], reasoning: true, images: true })),
];

export class BaiProvider extends ApiKeyProviderBase {
  constructor() {
    super({
      metadata: {
        id: "bai",
        displayName: "B.AI",
        protocol: "openai",
        credentialKind: "api_key",
        credentialUrl: "https://b.ai",
      },
      capabilities: aggregateCapabilities(
        BAI_FALLBACK_MODELS,
        capabilitiesOf({ surfaces: [...BAI_SURFACES], reasoning: true, images: true, streaming: true, search: true }),
      ),
      models: BAI_FALLBACK_MODELS,
    });
  }

  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchOpenAICompatibleModels({
      baseUrl: BAI_BASE_URL,
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
    // Dispatch based on requested surface — B.AI supports all three on same baseUrl.
    if (input.target.surface === "anthropic-messages") {
      return dispatchAnthropic(
        { ...input, target: { ...input.target, surface: "anthropic-messages" as const } } as Parameters<typeof dispatchAnthropic>[0],
        BAI_BASE_URL,
        headers,
        this.capabilities,
      );
    }
    if (input.target.surface === "openai-responses") {
      return dispatchResponses(input, BAI_BASE_URL, headers);
    }
    return dispatchChatCompletions(input, BAI_BASE_URL, headers);
  }
}

