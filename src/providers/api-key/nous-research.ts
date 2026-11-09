import { ApiKeyProviderBase } from "./base.js";
import { aggregateCapabilities, capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { DiscoveryInput, ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import { dispatchChatCompletions } from "../../proxy/upstream/openai.js";

/**
 * Nous Research — Hermes / inference-api.nousresearch.com
 * OpenAI-compatible. BaseUrl from hermes_cli/auth.py DEFAULT_NOUS_INFERENCE_URL.
 * Surface `openai-chat`.
 */
const config = {
  id: "hermes",
  displayName: "Nous Research",
  baseUrl: "https://inference-api.nousresearch.com/v1",
  credentialKind: "api_key" as const,
  credentialUrl: "https://portal.nousresearch.com/api-docs",
} as const;
const NOUS_PORTAL_TAGS = ["product=hermes-agent", "client=hermes-client-v0.13.0"] as const;

const models: readonly ProviderModel[] = Object.freeze([
  modelOf("poolside/laguna-s-2.1:free", "Poolside: Laguna S 2.1 (Free)", capabilitiesOf({ surfaces: ["openai-chat"], reasoning: true }), { context: { inputTokens: 262_144, outputTokens: 8_192 }, pricing: { inputPerMillion: 0, outputPerMillion: 0 } }),
  modelOf("poolside/laguna-xs-2.1:free", "Poolside: Laguna XS 2.1 (Free)", capabilitiesOf({ surfaces: ["openai-chat"], reasoning: true }), { context: { inputTokens: 262_144, outputTokens: 8_192 }, pricing: { inputPerMillion: 0, outputPerMillion: 0 } }),
  modelOf("tencent/hy3:free", "Tencent: Hy3 (Free)", capabilitiesOf({ surfaces: ["openai-chat"], reasoning: true, images: true }), { context: { inputTokens: 262_144, outputTokens: 8_192 }, pricing: { inputPerMillion: 0, outputPerMillion: 0 } }),
  modelOf("stepfun/step-3.7-flash:free", "StepFun: Step 3.7 Flash (Free)", capabilitiesOf({ surfaces: ["openai-chat"], reasoning: true }), { context: { inputTokens: 262_144, outputTokens: 8_192 }, pricing: { inputPerMillion: 0, outputPerMillion: 0 } }),
  modelOf("upstage/solar-pro4:free", "Upstage: Solar Pro 4 (Free)", capabilitiesOf({ surfaces: ["openai-chat"], reasoning: true }), { context: { inputTokens: 524_288, outputTokens: 8_192 }, pricing: { inputPerMillion: 0, outputPerMillion: 0 } }),
  modelOf("meituan/longcat-2.0:free", "Meituan: LongCat 2.0 (Free)", capabilitiesOf({ surfaces: ["openai-chat"], reasoning: true }), { context: { inputTokens: 1_048_576, outputTokens: 8_192 }, pricing: { inputPerMillion: 0, outputPerMillion: 0 } }),
]);

export class NousResearchProvider extends ApiKeyProviderBase {
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
    }, { tags: [...NOUS_PORTAL_TAGS] });
  }
}

