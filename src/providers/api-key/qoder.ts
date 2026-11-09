import { constants, createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";
import { ApiKeyProviderBase } from "./base.js";
import { aggregateCapabilities, capabilitiesOf, createModelCatalog, modelOf } from "../../proxy/types/provider.js";
import type { ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import type { Surface } from "../../proxy/types/surface.js";
import type { ProviderCaps, ProviderModel } from "../../proxy/types/provider.js";
import { isRecord } from "../../proxy/validation.js";
import { AbortCoordinator } from "../../proxy/transport/abort.js";
import { executeFetch, readJsonObject } from "../../proxy/transport/fetch.js";
import { UpstreamError, parseUpstreamFailure } from "../../proxy/transport/errors.js";
import { throwUpstreamHttpFailure } from "../shared.js";


import { transformOpenAIChatStream } from "../../proxy/upstream/openai.js";
import { isTerminalEvent, lineLimit, parseSseEvents } from "../../proxy/transport/sse.js";
import type { ProxyRequest } from "../../proxy/types/request.js";
import type { RequestLimits } from "../../proxy/types/content.js";
import type { SseEvent, StopReason, StreamEvent } from "../../proxy/types/stream.js";

const QODER_MODE_PROFILE = { cosyVersion: "1.0.22", chatUrl: "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1", businessProduct: "cli", businessType: "agent", businessVersion: "1.0.22", cosyScene: "assistant", mirrorTopLevelSystem: true, sendBusinessHeaders: true, sendModelSourceHeaders: true, emptyAliyunUserType: true } as const;
const QODER_CHAT_URL = QODER_MODE_PROFILE.chatUrl;
const QODER_MODEL_CONFIGS: Record<string, { id: string; display_name: string; max_input_tokens: number; max_output_tokens?: number; is_vl: boolean; is_reasoning: boolean; source?: string }> = {
  auto: { id: "auto", display_name: "Auto", max_input_tokens: 180000, is_vl: true, is_reasoning: false },
  ultimate: { id: "ultimate", display_name: "Ultimate", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  performance: { id: "performance", display_name: "Performance", max_input_tokens: 272000, is_vl: true, is_reasoning: false },
  efficient: { id: "efficient", display_name: "Efficient", max_input_tokens: 180000, is_vl: true, is_reasoning: false },
  lite: { id: "lite", display_name: "Lite", max_input_tokens: 180000, is_vl: false, is_reasoning: true },
  qmodel: { id: "qmodel", display_name: "Qwen 3.6 Plus", max_input_tokens: 180000, is_vl: true, is_reasoning: false },
  qmodel_latest: { id: "qmodel_latest", display_name: "Qwen 3.7 Max", max_input_tokens: 1000000, is_vl: true, is_reasoning: false },
  qmodel_preview: { id: "qmodel_preview", display_name: "Qwen 3.8 Max", max_input_tokens: 1000000, is_vl: true, is_reasoning: false },
  dmodel: { id: "dmodel", display_name: "DeepSeek V4 Pro", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  dfmodel: { id: "dfmodel", display_name: "DeepSeek V4 Flash", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  gm51model: { id: "gm51model", display_name: "GLM 5.1", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  kmodel: { id: "kmodel", display_name: "Kimi K2.6", max_input_tokens: 256000, is_vl: true, is_reasoning: false },
  mmodel: { id: "mmodel", display_name: "MiniMax M2.7", max_input_tokens: 180000, is_vl: true, is_reasoning: false },
  kmodel_latest: { id: "kmodel_latest", display_name: "Kimi K2.7 Latest", max_input_tokens: 256000, is_vl: true, is_reasoning: false },
};

const SURFACES_Q: readonly Surface[] = ["openai-chat"];
const QODER_MODELS_LOCAL: readonly ProviderModel[] = [
  modelOf("auto", "Qoder Auto", capabilitiesOf({ surfaces: SURFACES_Q, reasoning: true, images: true })),
  modelOf("ultimate", "Qoder Ultimate", capabilitiesOf({ surfaces: SURFACES_Q, reasoning: true, images: true })),
  modelOf("performance", "Qoder Performance", capabilitiesOf({ surfaces: SURFACES_Q, reasoning: true, images: true })),
  modelOf("efficient", "Qoder Efficient", capabilitiesOf({ surfaces: SURFACES_Q, reasoning: true, images: true })),
  modelOf("lite", "Qoder Lite", capabilitiesOf({ surfaces: SURFACES_Q, reasoning: true })),
  modelOf("qmodel", "Qoder Qwen 3.6 Plus", capabilitiesOf({ surfaces: SURFACES_Q, reasoning: true, images: true })),
  modelOf("qmodel_latest", "Qoder Qwen 3.7 Max", capabilitiesOf({ surfaces: SURFACES_Q, reasoning: true, images: true })),
  modelOf("qmodel_preview", "Qoder Qwen 3.8 Max", capabilitiesOf({ surfaces: SURFACES_Q, reasoning: true, images: true })),
  modelOf("dmodel", "Qoder DeepSeek V4 Pro", capabilitiesOf({ surfaces: SURFACES_Q, reasoning: true, images: true })),
  modelOf("dfmodel", "Qoder DeepSeek V4 Flash", capabilitiesOf({ surfaces: SURFACES_Q, reasoning: true, images: true })),
  modelOf("gm51model", "Qoder GLM 5.2", capabilitiesOf({ surfaces: SURFACES_Q, reasoning: true, images: true })),
  modelOf("kmodel", "Qoder Kimi K2.7", capabilitiesOf({ surfaces: SURFACES_Q, reasoning: true, images: true })),
  modelOf("kmodel_latest", "Qoder Kimi K2.7 Latest", capabilitiesOf({ surfaces: SURFACES_Q, images: true })),
];

const QODER_SURFACES_FACTORY: readonly Surface[] = ["openai-chat"];
const QODER_FALLBACK_CAPABILITIES_FACTORY: ProviderCaps = capabilitiesOf({ surfaces: QODER_SURFACES_FACTORY, reasoning: true, images: true });
const QODER_APPCODE = "cosy";
const QODER_SIG_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";
const QODER_JOB_TOKEN_URL = "https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1";
const QODER_STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export interface QoderAuth { userId: string; userName: string; userType: string; securityOauthToken: string; refreshToken: string; machineId: string; }
export interface QoderModelConfig { id: string; display_name: string; max_input_tokens: number; max_output_tokens?: number; is_vl: boolean; is_reasoning: boolean; source?: string; }
type QoderFetcher = (url: string, init: RequestInit) => Promise<Response>;

function qoderMd5(value: string | Uint8Array): string { return createHash("md5").update(value).digest("hex"); }
function qoderPathSignature(url: string): string { const path = new URL(url).pathname; return path.startsWith("/algo") ? path.slice(5) : path; }

const QODER_MACHINE_ID_TTL_MS = 60 * 60 * 1000;
const QODER_MAX_MACHINE_IDS = 1_024;
const qoderMachineIds = new Map<string, { id: string; expiresAt: number }>();
function qoderMachineIdFromPat(pat: string): string {
  const key = createHash("sha256").update(pat).digest("hex"); const now = Date.now(); const existing = qoderMachineIds.get(key); if (existing && existing.expiresAt > now) return existing.id;
  const id = randomUUID(); qoderMachineIds.delete(key); qoderMachineIds.set(key, { id, expiresAt: now + QODER_MACHINE_ID_TTL_MS });
  for (const [candidate, value] of qoderMachineIds) { if (value.expiresAt <= now) qoderMachineIds.delete(candidate); }
  while (qoderMachineIds.size > QODER_MAX_MACHINE_IDS) { const oldest = qoderMachineIds.keys().next(); if (oldest.done) break; qoderMachineIds.delete(oldest.value); }
  return id;
}
function qoderStaticHeaders(machineId: string): Record<string, string> {
  const date = new Date().toUTCString();
  return { "cosy-machinetoken": machineId, "cosy-machinetype": "5", "cosy-machineid": machineId, "cosy-clienttype": "5", "cosy-version": QODER_MODE_PROFILE.cosyVersion, "login-version": "v2", appcode: QODER_APPCODE, accept: "application/json", "accept-encoding": "identity", date, signature: qoderMd5(`${QODER_APPCODE}&${QODER_SIG_SECRET}&${date}`), "content-type": "application/json", "user-agent": "Go-http-client/2.0" };
}
export function transformQoderBody(plaintext: string): Uint8Array {
  const base64 = Buffer.from(plaintext).toString("base64");
  const third = Math.floor(base64.length / 3);
  const reordered = base64.slice(base64.length - third) + base64.slice(third, base64.length - third) + base64.slice(0, third);
  let encoded = ""; for (const char of reordered) { if (char === "=") encoded += "$"; else encoded += QODER_ALPHABET[QODER_STANDARD_ALPHABET.indexOf(char)] ?? char; }
  return Buffer.from(encoded, "latin1");
}
function qoderBuildCosyHeaders(body: Uint8Array, url: string, auth: QoderAuth): Record<string, string> {
  const key = randomUUID().replaceAll("-", "").slice(0, 16);
  const identity = JSON.stringify({ name: auth.userName, aid: auth.userId, uid: auth.userId, yx_uid: "", organization_id: "", organization_name: "", user_type: auth.userType, security_oauth_token: auth.securityOauthToken, refresh_token: auth.refreshToken });
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(key)); const info = Buffer.concat([cipher.update(identity), cipher.final()]).toString("base64");
  const cosyKey = publicEncrypt({ key: QODER_RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(key)).toString("base64");
  const payload = Buffer.from(JSON.stringify({ version: "v1", requestId: randomUUID(), info, cosyVersion: QODER_MODE_PROFILE.cosyVersion, ideVersion: "" })).toString("base64");
  const date = String(Math.floor(Date.now() / 1000)); const signature = qoderMd5(`${payload}\n${cosyKey}\n${date}\n${Buffer.from(body).toString("latin1")}\n${qoderPathSignature(url)}`);
  return { authorization: `Bearer COSY.${payload}.${signature}`, "cosy-data-policy": "agree", "cosy-machinetype": "5", "cosy-machineos": "x86_64_windows", "cosy-clienttype": "5", "cosy-date": date, "cosy-user": auth.userId, "cosy-key": cosyKey, "cosy-bodyhash": qoderMd5(body), "cosy-bodylength": String(body.byteLength), "cosy-sigpath": qoderPathSignature(url), "cosy-organization-id": "", "cosy-organization-tags": "", "x-request-id": randomUUID(), ...(QODER_MODE_PROFILE.sendBusinessHeaders ? { "cosy-business-product": QODER_MODE_PROFILE.businessProduct, "cosy-business-type": QODER_MODE_PROFILE.businessType, "cosy-business-version": QODER_MODE_PROFILE.businessVersion, "cosy-scene": QODER_MODE_PROFILE.cosyScene } : {}), "cosy-version": QODER_MODE_PROFILE.cosyVersion, "login-version": "v2", appcode: QODER_APPCODE, accept: "application/json", "accept-encoding": "identity", date: new Date().toUTCString(), signature: qoderMd5(`${QODER_APPCODE}&${QODER_SIG_SECRET}&${new Date().toUTCString()}`), "content-type": "application/json", "user-agent": "Go-http-client/2.0" };
}
export async function exchangeQoderPat(pat: string, signal: AbortSignal, fetcher: QoderFetcher = fetch): Promise<QoderAuth> {
  const machineId = qoderMachineIdFromPat(pat);
  const encodedBody = transformQoderBody(JSON.stringify({ payload: JSON.stringify({ personalToken: pat, securityOauthToken: "", refreshToken: "", needRefresh: false, authInfo: {} }), encodeVersion: "1" }));
  const response = await fetcher(QODER_JOB_TOKEN_URL, { method: "POST", headers: qoderStaticHeaders(machineId), body: encodedBody, signal });
  if (!response.ok) throw await throwUpstreamHttpFailure(response, "qoder");
  let responseBody: unknown; try { responseBody = await response.json(); } catch { throw new UpstreamError({ kind: "provider_protocol_error", message: "Qoder PAT exchange returned invalid JSON.", routeScope: "provider" }); }
  if (!isRecord(responseBody)) throw new UpstreamError({ kind: "provider_protocol_error", message: "Qoder PAT exchange returned an unexpected response.", routeScope: "provider" });
  if (typeof responseBody.id !== "string" || typeof responseBody.securityOauthToken !== "string") throw new UpstreamError({ kind: "provider_protocol_error", message: "Qoder PAT exchange returned incomplete credentials.", routeScope: "provider" });
  return { userId: responseBody.id, userName: typeof responseBody.name === "string" ? responseBody.name : "", userType: typeof responseBody.userType === "string" ? responseBody.userType : "personal_standard", securityOauthToken: responseBody.securityOauthToken, refreshToken: typeof responseBody.refreshToken === "string" ? responseBody.refreshToken : "", machineId };
}
export async function fetchQoderUsage(auth: QoderAuth, signal: AbortSignal, fetcher: QoderFetcher = fetch): Promise<unknown> {
  const response = await fetcher("https://openapi.qoder.sh/api/v2/quota/usage", { method: "GET", headers: { authorization: `Bearer ${auth.securityOauthToken}`, accept: "application/json", "user-agent": "pi-provider-qoder" }, signal });
  if (!response.ok) throw await throwUpstreamHttpFailure(response, "qoder");
  try { return await response.json(); } catch { throw new UpstreamError({ kind: "provider_protocol_error", message: "Qoder usage returned invalid JSON.", routeScope: "provider" }); }
}
export async function callQoder(url: string, body: Record<string, unknown>, modelId: string, auth: QoderAuth, signal: AbortSignal, fetcher: QoderFetcher = fetch): Promise<Response> {
  const encoded = transformQoderBody(JSON.stringify(body));
  const modelConfig = isRecord(body.model_config) ? body.model_config : null;
  return fetcher(url, { method: "POST", headers: { ...qoderBuildCosyHeaders(encoded, url, auth), ...(QODER_MODE_PROFILE.sendModelSourceHeaders ? { "x-model-key": modelId, "x-model-source": typeof modelConfig?.source === "string" ? modelConfig.source : "system" } : {}), Accept: "text/event-stream", "Cache-Control": "no-cache", "Accept-Encoding": "identity" }, body: encoded, signal });
}
function qoderStableHash(prefix: string, ...parts: string[]): string { const h = createHash("sha256"); h.update(prefix); for (const p of parts) { h.update("\0"); h.update(p); } return h.digest("hex").slice(0, 16); }
function qoderStableRecordId(modelId: string, messages: readonly import("../../proxy/types/content.js").NormalizedMessage[], maxTokens: number): string { const h = createHash("sha256"); h.update("qoder-record\0"); h.update(modelId); for (const m of messages) { h.update("\0"); h.update(m.role); const text = flattenQoderContent(m.content); if (text) { h.update("\0"); h.update(text); } } h.update(`\0mt=${maxTokens}`); return h.digest("hex").slice(0, 16); }
function flattenQoderContent(content: readonly import("../../proxy/types/content.js").ContentBlock[]): string { return content.filter((b) => b.type === "text" || b.type === "tool_result").map((b) => b.text ?? "").join("\n"); }
function qoderRequestedMaxTokens(body: ProxyRequest, modelConfig: QoderModelConfig): number { const configured = typeof modelConfig.max_output_tokens === "number" ? modelConfig.max_output_tokens : 32768; const requested = body.maxOutputTokens; return typeof requested === "number" && requested > 0 ? Math.min(requested, configured) : configured; }
function buildQoderRequest(modelId: string, body: ProxyRequest, modelConfig: QoderModelConfig, auth: QoderAuth): Record<string, unknown> {
  const messages = body.messages; const system = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => flattenQoderContent(m.content)).filter(Boolean).join("\n\n");
  const qoderMessages = messages.filter((m) => m.role !== "system" && m.role !== "developer").map((m) => { const flat = flattenQoderContent(m.content); const mapped: Record<string, unknown> = { role: m.role === "assistant" ? "assistant" : m.role === "tool" ? "tool" : "user", content: flat, contents: [{ type: "text", text: flat }] }; if (m.role === "tool") { const block = m.content[0]; if (block?.toolCallId) mapped.tool_call_id = block.toolCallId; } return mapped; });
  const latestUserMessage = [...qoderMessages].reverse().find((m) => m.role === "user"); const latestUserText = typeof latestUserMessage?.content === "string" ? latestUserMessage.content : ""; const maxTokens = qoderRequestedMaxTokens(body, modelConfig); const reasoning = modelConfig.is_reasoning === true;
  const sessionId = qoderStableHash("qoder-session", auth.userId, modelId); const recordId = qoderStableRecordId(modelId, messages, maxTokens);
  return { request_id: randomUUID(), request_set_id: recordId, chat_record_id: recordId, session_id: sessionId, stream: true, ...(QODER_MODE_PROFILE.emptyAliyunUserType ? { aliyun_user_type: "" } : {}), chat_task: "FREE_INPUT", is_reply: true, is_retry: false, source: 1, version: "3", session_type: "qodercli", agent_id: "agent_common", task_id: "common", code_language: "", chat_prompt: "", image_urls: null, chat_context: { chatPrompt: "", imageUrls: null, extra: { context: [], modelConfig: { key: modelId, is_reasoning: reasoning }, originalContent: latestUserText }, features: [], text: latestUserText }, model_config: { key: modelId, display_name: modelConfig.display_name, is_vl: modelConfig.is_vl, is_reasoning: modelConfig.is_reasoning, max_input_tokens: modelConfig.max_input_tokens, max_output_tokens: modelConfig.max_output_tokens ?? 32768, source: modelConfig.source ?? "system" }, messages: qoderMessages, max_tokens: maxTokens };
}
export function qoderEnvelopeToFrames(data: string): SseEvent[] {
  if (data === "[DONE]") return [{ event: null, data: "[DONE]" }];
  let envelope: unknown;
  try {
    envelope = JSON.parse(data);
  } catch {
    return [];
  }
  if (!isRecord(envelope)) return [];
  if (envelope.statusCodeValue !== undefined && envelope.statusCodeValue !== 200) {
    const status = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 502;
    // Preserve actual body for diagnostics instead of manufacturing a generic status-only error
    throw new UpstreamError({
      kind: status === 401 ? "authentication_failed" : status === 429 ? "provider_rate_limited" : status >= 500 ? "provider_unavailable" : "provider_protocol_error",
      message: `Qoder stream envelope returned HTTP ${status}`,
      statusCode: status,
      retryable: status === 429 || status >= 500,
      routeScope: status === 401 || status === 429 ? "account" : "provider",
    });
  }
  const body = envelope.body;
  if (body === "[DONE]") return [{ event: null, data: "[DONE]" }];
  if (typeof body !== "string") return [];
  return [{ event: null, data: body.replace(/\r?\n/g, "") }];
}
export async function* unwrapQoderEnvelopes(body: ReadableStream<Uint8Array>, coordinator: AbortCoordinator, limits: RequestLimits): AsyncGenerator<SseEvent> {
  for await (const sse of parseSseEvents({ body, coordinator, maxLineBytes: lineLimit(limits), idleTimeoutMs: limits.idleTimeoutMs, signal: coordinator.signal })) {
    for (const frame of qoderEnvelopeToFrames(sse.data)) yield frame;
  }
}
export async function* transformQoderStream(body: ReadableStream<Uint8Array>, coordinator: AbortCoordinator, limits: RequestLimits): AsyncGenerator<StreamEvent> {
  let terminal = false;
  const mapper = transformOpenAIChatStream();
  try {
    for await (const sse of unwrapQoderEnvelopes(body, coordinator, limits)) {
      if (coordinator.signal.aborted) {
        const cause = coordinator.causeOf();
        if (cause === "caller") throw new UpstreamError({ kind: "client_aborted", message: "Request aborted by caller", retryable: false, routeScope: null });
        if (cause === "stream_limit") throw new UpstreamError({ kind: "provider_protocol_error", message: "Upstream stream exceeded the configured byte limit", retryable: false, routeScope: "provider" });
        throw new UpstreamError({ kind: "stream_timeout", message: "Upstream stream timed out", retryable: true, routeScope: "provider" });
      }
      const mapped = mapper(sse);
      if (mapped === null) continue;
      const events = Array.isArray(mapped) ? mapped : [mapped];
      for (const event of events) {
        yield event;
        if (isTerminalEvent(event)) terminal = true;
      }
    }
    if (!terminal) throw new UpstreamError({ kind: "stream_truncated", message: "Qoder stream ended before a terminal event", retryable: true, routeScope: "provider" });
  } finally {
    // parseSseEvents handles reader cancellation; coordinator disposal is owned by caller
  }
}
interface MaterializedChat { text: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; stopReason: StopReason; usage: import("../../proxy/types/telemetry.js").ProviderUsage; }
async function materializeQoderChatEvents(events: AsyncIterable<StreamEvent>): Promise<MaterializedChat> {
  let text = ""; const toolsById = new Map<string, { id: string; name: string; arguments: string }>(); let stopReason: StopReason = "completed"; let usage: import("../../proxy/types/telemetry.js").ProviderUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, source: "provider" };
  for await (const ev of events) { switch (ev.type) { case "text_delta": text += ev.text; break; case "tool_call_start": { const existing = toolsById.get(ev.callId); if (!existing) toolsById.set(ev.callId, { id: ev.callId, name: ev.name, arguments: "" }); else if (existing.name !== ev.name) existing.name = ev.name; break; } case "tool_call_delta": { const existing = toolsById.get(ev.callId); if (existing) existing.arguments += ev.delta; break; } case "message_stop": stopReason = ev.reason; break; case "usage": usage = ev.usage; break; } }
  return { text, toolCalls: [...toolsById.values()], stopReason, usage };
}
function qoderStopReasonToOpenAI(reason: StopReason): "stop" | "length" | "tool_calls" | "content_filter" { switch (reason) { case "length": return "length"; case "tool_call": return "tool_calls"; case "content_filter": return "content_filter"; default: return "stop"; } }
function qoderMaterializedToChatResponse(result: MaterializedChat, model: string): Record<string, unknown> {
  const finishReason = result.toolCalls.length > 0 ? "tool_calls" : qoderStopReasonToOpenAI(result.stopReason); const message: Record<string, unknown> = { role: "assistant", content: result.text }; if (result.toolCalls.length > 0) message.tool_calls = result.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } }));
  return { id: `chatcmpl-${randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: finishReason }], usage: { prompt_tokens: (result.usage.promptTokens ?? result.usage.inputTokens ?? 0) + (result.usage.cachedTokens ?? result.usage.cacheReadTokens ?? 0), completion_tokens: result.usage.completionTokens ?? result.usage.outputTokens ?? 0, total_tokens: result.usage.totalTokens ?? ((result.usage.promptTokens ?? result.usage.inputTokens ?? 0) + (result.usage.cachedTokens ?? result.usage.cacheReadTokens ?? 0) + (result.usage.completionTokens ?? result.usage.outputTokens ?? 0)), prompt_tokens_details: { cached_tokens: result.usage.cachedTokens ?? result.usage.cacheReadTokens ?? 0 } } };
}

// ---------------------------------------------------------------------------


const FALLBACK_CAPS_Q: ProviderCaps = capabilitiesOf({ surfaces: SURFACES_Q, reasoning: true, images: true });

/** Qoder — owns catalog + COSY upstream (no central). */
export class QoderProvider extends ApiKeyProviderBase {
  constructor() {
    const caps = aggregateCapabilities(QODER_MODELS_LOCAL, FALLBACK_CAPS_Q) as ProviderCaps;
    super({ metadata: { id: "qoder", displayName: "Qoder", protocol: "openai", credentialKind: "api_key" }, capabilities: caps, models: QODER_MODELS_LOCAL });
  }
  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.providerId !== "qoder" || input.target.surface !== "openai-chat") throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "qoder" only supports the OpenAI Chat surface`, statusCode: 400, routeScope: null });
    if (input.credential.length === 0) throw new UpstreamError({ kind: "authentication_failed", message: "A Qoder personal access token is required.", statusCode: 401, routeScope: "account" });
    const { request, signal, network } = input;
    const modelConfig = (QODER_MODEL_CONFIGS as Record<string, { id: string; display_name: string; max_input_tokens: number; max_output_tokens?: number; is_vl: boolean; is_reasoning: boolean; source?: string }>)[input.target.modelId] ?? { id: input.target.modelId, display_name: input.target.modelId, max_input_tokens: 180_000, is_vl: true, is_reasoning: false };
    const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, firstByteTimeoutMs: request.limits.firstByteTimeoutMs, idleTimeoutMs: request.limits.idleTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
    const fetcher = (url: string, init: RequestInit) => executeFetch(url, init, coordinator, network, input.capture);
    let handedOff = false;
    try {
      const auth = await exchangeQoderPat(input.credential, coordinator.signal, fetcher as any);
      const qoderBody = buildQoderRequest(input.target.modelId, request as any, modelConfig as any, auth as any);
      const response = await callQoder(QODER_CHAT_URL, qoderBody, input.target.modelId, auth as any, coordinator.signal, fetcher as any);
      if (!response.ok) throw await parseUpstreamFailure(response);
      if (!response.body) throw new UpstreamError({ kind: "provider_protocol_error", message: "Qoder returned an empty response body", routeScope: "provider" });
      const events = transformQoderStream(response.body, coordinator, request.limits);
      if (request.stream) { handedOff = true; return { mode: "stream", events: events as AsyncIterable<import("../../proxy/types/stream.js").StreamEvent> }; }
      const materialized = await materializeQoderChatEvents(events as AsyncIterable<import("../../proxy/types/stream.js").StreamEvent>); return { mode: "non_stream", body: qoderMaterializedToChatResponse(materialized as any, request.model) as Record<string, unknown>, usage: (materialized as any).usage };
    } finally { if (!handedOff) coordinator.dispose(); }
  }
}
