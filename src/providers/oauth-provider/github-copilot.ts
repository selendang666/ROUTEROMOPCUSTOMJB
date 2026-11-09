import { internalFailureFromUnknown } from "../../proxy/errors.js";
import { extractAccessTokenOrRaw } from "../../auth/contract.js";
import { dispatchChatCompletions } from "../../proxy/upstream/openai.js";
import { UpstreamError } from "../../proxy/transport/errors.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import { capabilitiesOf, createModelCatalog, modelOf } from "../../proxy/types/provider.js";
import type { ProviderModel, ProviderModelCatalog, ProviderMeta, ProviderCaps } from "../../proxy/types/provider.js";
import type { Adapter, DiscoveryInput, ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import type { RouteTarget } from "../../proxy/types/routing.js";
import type { Surface } from "../../proxy/types/surface.js";

const COPILOT_BASE_URL = "https://api.githubcopilot.com";
const COPILOT_SURFACES: readonly Surface[] = ["openai-chat"];
const COPILOT_HEADERS = {
  accept: "application/json",
  "x-github-api-version": "2026-06-01",
  "user-agent": "opencode/1.3.15",
} as const;
const COPILOT_BUILTIN_MODEL_IDS = [
  "copilot-search-a",
  "copilot-search-b",
  "copilot-search-c",
  "exec-agent-a",
  "gpt-3.5-turbo-0613",
  "gpt-4-o-preview",
  "gpt-4.1",
  "gpt-4.1-2025-04-14",
  "gpt-4o",
  "gpt-4o-2024-11-20",
  "gpt-4o-mini",
  "gpt-4o-mini-2024-07-18",
] as const;

/** GitHub Copilot OAuth adapter for Chat Completions and live model catalog. */
export class GithubCopilotProvider implements Adapter {
  readonly metadata: ProviderMeta = {
    id: "github",
    displayName: "GitHub Copilot",
    protocol: "openai",
    credentialKind: "oauth",
  };
  readonly capabilities: ProviderCaps = capabilitiesOf({ surfaces: COPILOT_SURFACES, streaming: true, reasoning: true, images: true, toolCalls: true });
  readonly models: ProviderModelCatalog = createModelCatalog(COPILOT_BUILTIN_MODEL_IDS.map((id) => modelOf(id, id, this.capabilities)));

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    const model = this.models.get(modelId);
    return { providerId: this.metadata.id, modelId, upstreamModelId: model?.upstreamId ?? modelId, surface };
  }

  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchOpenAICompatibleModels({
      baseUrl: COPILOT_BASE_URL,
      headers: { authorization: `Bearer ${extractAccessTokenOrRaw(input.credential)}`, ...COPILOT_HEADERS },
      signal: input.signal,
    });
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.surface !== "openai-chat") {
      throw new UpstreamError({ kind: "capability_unsupported", message: "GitHub Copilot requires the openai-chat surface.", statusCode: 400, routeScope: null });
    }
    return dispatchChatCompletions(input, COPILOT_BASE_URL, {
      ...COPILOT_HEADERS,
      authorization: `Bearer ${extractAccessTokenOrRaw(input.credential)}`,
    });
  }

  mapError(error: unknown): import("../../proxy/types/error-types.js").InternalFailure {
    return internalFailureFromUnknown(error);
  }
}
