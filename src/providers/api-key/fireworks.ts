import { createSimpleOpenAIProvider } from "./simple-openai-provider.js";

export const FireworksProvider = createSimpleOpenAIProvider({
  id: "fireworks",
  displayName: "Fireworks AI",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  credentialUrl: "https://fireworks.ai/account/api-keys",
  models: [],
});
