import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import { createSimpleOpenAIProvider } from "./simple-openai-provider.js";

const OPENAI_CHAT_SURFACES = ["openai-chat"] as const;

export const MistralProvider = createSimpleOpenAIProvider({
  id: "mistral",
  displayName: "Mistral",
  baseUrl: "https://api.mistral.ai/v1",
  models: [
    modelOf("mistral-large-latest", "Mistral Large", capabilitiesOf({ surfaces: OPENAI_CHAT_SURFACES })),
    modelOf("mistral-small-latest", "Mistral Small", capabilitiesOf({ surfaces: OPENAI_CHAT_SURFACES })),
  ],
});
