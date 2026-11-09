
import { ApiKeyProviderBase } from "./base.js";
import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import type { ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { dispatchChatCompletions } from "../../proxy/upstream/openai.js";
import { UpstreamError } from "../../proxy/transport/errors.js";

const SURFACES = ["openai-chat"] as const;
const GLOBAL_BASE = "https://www.codebuddy.ai/v2";

function upstreamIdFor(id: string): string {
  const clean = id.replace(/-thinking$/, "");
  if (/^(opus|sonnet|haiku)-/.test(clean)) return `claude-${clean}`;
  if (clean === "deepseek-v3-2") return "deepseek-v3-2-volc";
  if (clean === "enowx") return "enowx-default";
  return clean;
}
const RAW: readonly [string,string,boolean,boolean,number|null,number|null][] = [
  ["opus-4.8","Claude Opus 4.8",true,true,1_000_000,64_000], ["opus-4.8-1m","Claude Opus 4.8 1M",true,true,1_000_000,64_000], ["opus-4.7","Claude Opus 4.7",true,true,1_000_000,64_000], ["opus-4.7-1m","Claude Opus 4.7 1M",true,true,1_000_000,64_000], ["opus-4.6","Claude Opus 4.6",true,true,1_000_000,64_000], ["sonnet-4.6","Claude Sonnet 4.6",true,true,200_000,64_000], ["haiku-4.5","Claude Haiku 4.5",true,true,200_000,8_192],
  ["gpt-5.1","GPT-5.1",true,true,null,null], ["gpt-5.1-codex","GPT-5.1 Codex",true,true,null,null], ["gpt-5.1-codex-max","GPT-5.1 Codex Max",true,true,null,null], ["gpt-5.1-codex-mini","GPT-5.1 Codex Mini",true,true,null,null], ["gpt-5.2","GPT-5.2",true,true,null,null], ["gpt-5.2-codex","GPT-5.2 Codex",true,true,null,null], ["gpt-5.3-codex","GPT-5.3 Codex",true,true,null,null], ["gpt-5.4","GPT-5.4",true,true,null,null], ["gpt-5.5","GPT-5.5",true,true,null,null], ["gpt-5.5-xhigh","GPT-5.5 xhigh",true,true,null,null],
  ["gemini-2.5-flash","Gemini 2.5 Flash",true,true,null,null], ["gemini-2.5-pro","Gemini 2.5 Pro",true,true,null,null], ["gemini-3.0-flash","Gemini 3 Flash",false,true,null,null], ["gemini-3.1-flash-lite","Gemini 3.1 Flash Lite",false,true,null,null], ["gemini-3.1-pro","Gemini 3.1 Pro",false,true,null,null], ["gemini-3.5-flash","Gemini 3.5 Flash",true,true,null,null], ["deepseek-v3-2","DeepSeek V3.2",false,false,null,null], ["kimi-k2.5","Kimi K2.5",false,false,null,null], ["enowx","Enowx",false,true,null,null],
];
const models = RAW.map(([id,name,reasoning,vision,ctx,out]) => modelOf(id,name, capabilitiesOf({ surfaces: SURFACES, reasoning, images: vision }), { upstreamId: upstreamIdFor(id), context: { inputTokens: ctx, outputTokens: out } }));
function headers(credential: string): Record<string,string>{ return { "content-type":"application/json", accept:"text/event-stream, application/json", authorization:`Bearer ${credential}`, "x-product":"SaaS", "x-domain":"www.codebuddy.ai", "x-requested-with":"XMLHttpRequest", "x-conversation-id":crypto.randomUUID(), "x-request-id":crypto.randomUUID().replace(/-/g,"") }; }
export class CodeBuddyProvider extends ApiKeyProviderBase {
  constructor(){ super({ metadata:{ id:"cb", displayName:"CodeBuddy", protocol:"openai", credentialKind:"api_key" }, capabilities: capabilitiesOf({ surfaces: SURFACES, reasoning:true, images:true, toolCalls:true, streaming:true }), models }); }
  call(input: ProviderRequest): Promise<ProviderOutput>{ if(!input.credential) throw new UpstreamError({ kind: "authentication_failed", message: "CodeBuddy requires API key", statusCode: 401, routeScope: "account" }); return dispatchChatCompletions(input, GLOBAL_BASE, headers(input.credential)); }
}
