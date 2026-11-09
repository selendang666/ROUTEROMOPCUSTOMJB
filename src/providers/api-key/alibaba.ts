import { createSimpleOpenAIProvider } from "./simple-openai-provider.js";

export const AlibabaProvider = createSimpleOpenAIProvider({
  id: "alibaba",
  displayName: "Alibaba Cloud / DashScope",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  credentialUrl: "https://bailian.console.aliyun.com/?apiKey=1",
  models: [],
});
