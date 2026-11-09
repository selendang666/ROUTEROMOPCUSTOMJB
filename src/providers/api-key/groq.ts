import { createSimpleOpenAIProvider } from "./simple-openai-provider.js";

/** groq provider: OpenAI-compatible, static empty catalog + runtime discovery. */
export const GroqProvider = createSimpleOpenAIProvider({
  id: "groq",
  displayName: "Groq",
  baseUrl: "https://api.groq.com/openai/v1",
  credentialUrl: "https://console.groq.com/keys",
  models: [],
});
