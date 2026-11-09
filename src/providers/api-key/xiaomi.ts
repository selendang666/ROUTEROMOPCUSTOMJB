import { ApiKeyProviderBase } from "./base.js";
import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import type { DiscoveryInput } from "../../proxy/types/request.js";
import { dispatchChatCompletions } from "../../proxy/upstream/openai.js";

const SURFACES = ["openai-chat"] as const;

const MODELS: readonly ProviderModel[] = [
  modelOf("mimo-v2.5-pro", "MiMo V2.5 Pro", capabilitiesOf({ surfaces: SURFACES, reasoning: true })),
  modelOf("mimo-v2.5", "MiMo V2.5", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
];

/** Xiaomi MiMo (PAYG) — own catalog + upstream. */
export class XiaomipgProvider extends ApiKeyProviderBase {
  constructor() {
    super({
      metadata: { id: "xiaomipg", displayName: "Xiaomi MiMo (PAYG)", protocol: "openai", credentialKind: "api_key" },
      capabilities: capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true, streaming: true }),
      models: MODELS,
    });
  }
  call(input: ProviderRequest): Promise<ProviderOutput> {
    return dispatchChatCompletions(input, "https://api.xiaomimimo.com/v1", {
      "content-type": "application/json",
      accept: input.request.stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${input.credential}`,
    });
  }
  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchOpenAICompatibleModels({
      baseUrl: "https://api.xiaomimimo.com/v1",
      headers: { authorization: `Bearer ${input.credential}` },
      signal: input.signal,
    });
  }
}

/** Xiaomi MiMo (Token Plan) — own catalog + upstream. */
export class XiaomitpProvider extends ApiKeyProviderBase {
  constructor() {
    super({
      metadata: { id: "xiaomitp", displayName: "Xiaomi MiMo (Token Plan)", protocol: "openai", credentialKind: "api_key" },
      capabilities: capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true, streaming: true }),
      models: MODELS,
    });
  }
  call(input: ProviderRequest): Promise<ProviderOutput> {
    return dispatchChatCompletions(input, "https://token-plan-sgp.xiaomimimo.com/v1", {
      "content-type": "application/json",
      accept: input.request.stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${input.credential}`,
    });
  }
  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchOpenAICompatibleModels({
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      headers: { authorization: `Bearer ${input.credential}` },
      signal: input.signal,
    });
  }
}

