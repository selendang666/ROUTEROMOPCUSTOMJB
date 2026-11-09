import { createSimpleOpenAIProvider } from "./simple-openai-provider.js";

export const GmiCloudProvider = createSimpleOpenAIProvider({
  id: "gmi",
  displayName: "GMI Cloud",
  baseUrl: "https://api.gmi-serving.com/v1",
  credentialUrl: "https://gmi-serving.com/console/api-keys",
  models: [],
});
