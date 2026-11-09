import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import { createSimpleOpenAIProvider } from "./simple-openai-provider.js";

const OPENAI_CHAT_SURFACES = ["openai-chat"] as const;

export const CerebrasProvider = createSimpleOpenAIProvider({
  id: "cerebras",
  displayName: "Cerebras",
  baseUrl: "https://api.cerebras.ai/v1",
  models: [
    modelOf("llama-3.3-70b", "Llama 3.3 70B", capabilitiesOf({ surfaces: OPENAI_CHAT_SURFACES })),
    modelOf("llama-4-scout-17b-16e-instruct", "Llama 4 Scout", capabilitiesOf({ surfaces: OPENAI_CHAT_SURFACES })),
  ],
});
