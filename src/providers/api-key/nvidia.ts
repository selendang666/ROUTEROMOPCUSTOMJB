import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import { createSimpleOpenAIProvider } from "./simple-openai-provider.js";

const OPENAI_CHAT_SURFACES = ["openai-chat"] as const;

export const NvidiaProvider = createSimpleOpenAIProvider({
  id: "nvidia",
  displayName: "NVIDIA NIM",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  models: [
    modelOf("nvidia/llama-3.1-nemotron-ultra-253b-v1", "Nemotron Ultra 253B", capabilitiesOf({ surfaces: OPENAI_CHAT_SURFACES })),
    modelOf("deepseek-ai/deepseek-r1", "DeepSeek R1", capabilitiesOf({ surfaces: OPENAI_CHAT_SURFACES, reasoning: true, toolCalls: false })),
  ],
});
