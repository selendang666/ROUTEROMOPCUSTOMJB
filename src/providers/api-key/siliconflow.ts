import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import { createSimpleOpenAIProvider } from "./simple-openai-provider.js";

const OPENAI_CHAT_SURFACES = ["openai-chat"] as const;

export const SiliconflowProvider = createSimpleOpenAIProvider({
  id: "siliconflow",
  displayName: "SiliconFlow",
  baseUrl: "https://api.siliconflow.cn/v1",
  models: [
    modelOf("deepseek-ai/DeepSeek-V3", "DeepSeek V3", capabilitiesOf({ surfaces: OPENAI_CHAT_SURFACES })),
    modelOf("deepseek-ai/DeepSeek-R1", "DeepSeek R1", capabilitiesOf({ surfaces: OPENAI_CHAT_SURFACES, reasoning: true, toolCalls: false })),
    modelOf("Qwen/Qwen3-235B-A22B-Thinking", "Qwen3 Thinking", capabilitiesOf({ surfaces: OPENAI_CHAT_SURFACES, reasoning: true })),
  ],
});
