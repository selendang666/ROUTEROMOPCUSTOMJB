import { ApiKeyProviderBase } from "./base.js";
import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { DiscoveryInput, ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import { dispatchResponses } from "../../proxy/upstream/openai.js";

const SURFACES = ["openai-responses"] as const;

const models = [
  modelOf("gpt-oss:20b", "GPT-OSS 20B", capabilitiesOf({ surfaces: SURFACES, reasoning: true })),
  modelOf("gpt-oss:120b", "GPT-OSS 120B", capabilitiesOf({ surfaces: SURFACES, reasoning: true })),
  modelOf("gemma4:31b", "Gemma 4 31B", capabilitiesOf({ surfaces: SURFACES, reasoning: true })),
  modelOf("minimax-m2.5", "MiniMax M2.5", capabilitiesOf({ surfaces: SURFACES, reasoning: true })),
  modelOf("minimax-m3", "MiniMax M3", capabilitiesOf({ surfaces: SURFACES, reasoning: true })),
  modelOf("nemotron-3-super", "Nemotron 3 Super", capabilitiesOf({ surfaces: SURFACES, reasoning: true })),
];

/** Ollama Cloud provider */
export class OllamaProvider extends ApiKeyProviderBase {
  constructor() { super({ metadata: { id: "ollama", displayName: "Ollama Cloud", protocol: "openai", credentialKind: "api_key" }, capabilities: capabilitiesOf({ surfaces: SURFACES, reasoning: true, streaming: true }), models }); }
  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchOpenAICompatibleModels({ baseUrl: "https://ollama.com/v1", headers: { authorization: `Bearer ${input.credential}` }, signal: input.signal });
  }
  call(input: ProviderRequest): Promise<ProviderOutput> { return dispatchResponses(input, "https://ollama.com/v1", { "content-type": "application/json", authorization: `Bearer ${input.credential}` }); }
}
