import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import { createSimpleOpenAIProvider } from "./simple-openai-provider.js";

const OPENAI_CHAT_SURFACES = ["openai-chat"] as const;

export const DeepseekProvider = createSimpleOpenAIProvider({
  id: "deepseek",
  displayName: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  models: [
    modelOf("deepseek-chat", "DeepSeek V3", capabilitiesOf({ surfaces: OPENAI_CHAT_SURFACES })),
    modelOf("deepseek-reasoner", "DeepSeek R1", capabilitiesOf({ surfaces: OPENAI_CHAT_SURFACES, reasoning: true, toolCalls: false })),
  ],
});
