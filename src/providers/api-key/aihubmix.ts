import { ApiKeyProviderBase } from "./base.js";
import { aggregateCapabilities, capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import type { DiscoveryInput } from "../../proxy/types/request.js";
import { dispatchChatCompletions, dispatchResponses } from "../../proxy/upstream/openai.js";

/**
 * AiHubMix — https://aihubmix.com/v1 (OpenAI-compatible forwarding)
 * Auth: Bearer sk-... (Api key from https://aihubmix.com/token)
 * Models: GET /v1/models (legacy OpenAI shape) + GET https://aihubmix.com/api/v1/models (new shape with model_id)
 * We use legacy /v1/models for discovery via fetchOpenAICompatibleModels (data[].id tolerant).
 * Supports chat/completions, responses, image-gen (we upstream chat+responses here).
 * Docs: https://docs.aihubmix.com/en/api/Aihubmix-Integration
 */
const AIHUBMIX_BASE_URL = "https://aihubmix.com/v1";

const AIHUBMIX_SURFACES = ["openai-chat", "openai-responses"] as const;

const AIHUBMIX_FALLBACK_MODELS: readonly ProviderModel[] = [
  modelOf("gpt-5", "GPT-5", capabilitiesOf({ surfaces: [...AIHUBMIX_SURFACES], reasoning: true, images: true })),
  modelOf("gpt-5-mini", "GPT-5 Mini", capabilitiesOf({ surfaces: [...AIHUBMIX_SURFACES], reasoning: true })),
  modelOf("claude-sonnet-4-5", "Claude Sonnet 4.5", capabilitiesOf({ surfaces: [...AIHUBMIX_SURFACES], reasoning: true, images: true })),
  modelOf("gemini-3-pro", "Gemini 3 Pro", capabilitiesOf({ surfaces: [...AIHUBMIX_SURFACES], reasoning: true, images: true })),
];

export class AihubmixProvider extends ApiKeyProviderBase {
  constructor() {
    super({
      metadata: {
        id: "aihubmix",
        displayName: "AiHubMix",
        protocol: "openai",
        credentialKind: "api_key",
        credentialUrl: "https://aihubmix.com",
      },
      capabilities: aggregateCapabilities(
        AIHUBMIX_FALLBACK_MODELS,
        capabilitiesOf({ surfaces: [...AIHUBMIX_SURFACES], reasoning: true, images: true, streaming: true }),
      ),
      models: AIHUBMIX_FALLBACK_MODELS,
    });
  }

  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    // Prefer legacy OpenAI shape at /v1/models; tolerant parser also handles new shape via fallback
    const discovered = await fetchOpenAICompatibleModels({
      baseUrl: AIHUBMIX_BASE_URL,
      headers: { authorization: `Bearer ${input.credential}` },
      signal: input.signal,
    });
    if (discovered !== null && discovered.length > 0) return discovered;
    // Fallback: try new API shape https://aihubmix.com/api/v1/models ( model_id, not id ) — map manually
    try {
      const url = "https://aihubmix.com/api/v1/models";
      const timeoutSignal = AbortSignal.timeout(10_000);
      const signal = input.signal === undefined ? timeoutSignal : AbortSignal.any([input.signal, timeoutSignal]);
      const resp = await fetch(url, { headers: { authorization: `Bearer ${input.credential}` }, signal });
      if (!resp.ok) return discovered;
      const payload = (await resp.json()) as Record<string, unknown>;
      const raw = Array.isArray(payload.data) ? (payload.data as Record<string, unknown>[]) : null;
      if (!raw || raw.length === 0) return discovered;
      const mapped: ProviderModel[] = raw.slice(0, 500).map((row) => {
        const id = typeof row.model_id === "string" ? row.model_id : typeof row.id === "string" ? row.id : String(row.model_id ?? row.id ?? "");
        const contextRaw = typeof row.context_length === "number" ? row.context_length : typeof row.context_length === "string" ? Number(row.context_length) : null;
        const context = contextRaw !== null && Number.isFinite(contextRaw) && contextRaw > 0 ? { inputTokens: contextRaw } : undefined;
        return modelOf(id, id, capabilitiesOf({ surfaces: [...AIHUBMIX_SURFACES], streaming: true }), context ? { context } : undefined);
      });
      return mapped.length > 0 ? mapped : discovered;
    } catch {
      return discovered;
    }
  }

  call(input: ProviderRequest): Promise<ProviderOutput> {
    const headers = {
      "content-type": "application/json",
      accept: input.request.stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${input.credential}`,
    };
    if (input.target.surface === "openai-responses") {
      return dispatchResponses(input, AIHUBMIX_BASE_URL, headers);
    }
    return dispatchChatCompletions(input, AIHUBMIX_BASE_URL, headers);
  }
}

