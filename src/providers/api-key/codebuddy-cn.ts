
import { ApiKeyProviderBase } from "./base.js";
import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import type { ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { dispatchChatCompletions } from "../../proxy/upstream/openai.js";
import { UpstreamError } from "../../proxy/transport/errors.js";

const SURFACES = ["openai-chat"] as const;
const CN_BASE = "https://www.codebuddy.cn/v2";
const RAW: readonly [string,string,boolean,boolean,number|null,number|null][] = [
  ["glm-5.2","GLM 5.2",false,true,1_000_000,8_192], ["glm-5.1","GLM 5.1",false,true,200_000,8_192], ["glm-5.0","GLM 5.0",false,true,200_000,8_192], ["glm-5.0-turbo","GLM 5.0 Turbo",false,true,200_000,8_192], ["glm-5v-turbo","GLM 5v Turbo",false,true,200_000,8_192], ["glm-4.7","GLM 4.7",false,true,200_000,8_192], ["minimax-m3","MiniMax M3",false,true,512_000,8_192], ["minimax-m2.7","MiniMax M2.7",false,true,512_000,8_192], ["kimi-k2.7","Kimi K2.7",true,true,256_000,8_192], ["kimi-k2.6","Kimi K2.6",false,true,256_000,8_192], ["kimi-k2.5","Kimi K2.5",false,true,164_000,8_192], ["hy3-preview","Hunyuan Hy3 Preview",false,false,192_000,8_192], ["deepseek-v4-pro","DeepSeek V4 Pro",false,true,1_000_000,8_192], ["deepseek-v4-flash","DeepSeek V4 Flash",false,true,1_000_000,8_192], ["qwen3.7-max","Qwen 3.7 Max",false,true,1_000_000,8_192],
];
const models = RAW.map(([id,name,reasoning,vision,ctx,out]) => modelOf(id,name, capabilitiesOf({ surfaces: SURFACES, reasoning, images: vision }), { context: { inputTokens: ctx, outputTokens: out } }));
function headers(credential: string): Record<string,string>{ return { "content-type":"application/json", accept:"text/event-stream, application/json", authorization:`Bearer ${credential}`, "x-product":"SaaS", "x-domain":"www.codebuddy.cn", "x-requested-with":"XMLHttpRequest", "x-conversation-id":crypto.randomUUID(), "x-request-id":crypto.randomUUID().replace(/-/g,"") }; }
export class CodeBuddyCnProvider extends ApiKeyProviderBase {
  constructor(){ super({ metadata:{ id:"cbcn", displayName:"CodeBuddy CN", protocol:"openai", credentialKind:"api_key" }, capabilities: capabilitiesOf({ surfaces: SURFACES, reasoning:true, images:true, toolCalls:true, streaming:true }), models }); }
  call(input: ProviderRequest): Promise<ProviderOutput>{ if(!input.credential) throw new UpstreamError({ kind: "authentication_failed", message: "CodeBuddy CN requires API key", statusCode: 401, routeScope: "account" }); return dispatchChatCompletions(input, CN_BASE, headers(input.credential)); }
}
