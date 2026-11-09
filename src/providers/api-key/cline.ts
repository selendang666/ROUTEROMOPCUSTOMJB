import { ApiKeyProviderBase } from "./base.js";
import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { ProviderOutput, ProviderRequest, DiscoveryInput } from "../../proxy/types/request.js";
import { buildChatPayload } from "../../proxy/translate/request.js";
import { isRecord } from "../../proxy/validation.js";

import { transformOpenAIChatStream } from "../../proxy/upstream/openai.js";
import { lineLimit, mapSseStream } from "../../proxy/transport/sse.js";
import { AbortCoordinator } from "../../proxy/transport/abort.js";
import { executeFetch } from "../../proxy/transport/fetch.js";
import { UpstreamError, parseUpstreamFailure } from "../../proxy/transport/errors.js";
import { createInternalFailure } from "../../proxy/errors.js";
import { extractAccessTokenOrRaw } from "../../auth/contract.js";
const CLINE_CLIENT_VERSION = "3.0.60";

const CLINE_BASE_URL = "https://api.cline.bot/api/v1";
const CLINE_CHAT_URL = `${CLINE_BASE_URL}/chat/completions`;
const CLINE_RECOMMENDED_MODELS_URL = `${CLINE_BASE_URL}/ai/cline/recommended-models`;
const CLINE_SURFACES = ["openai-chat"] as const;

const CLINE_MODELS: readonly ProviderModel[] = [
  modelOf("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("z-ai/glm-5.2", "GLM 5.2", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("openai/gpt-5.6-sol", "GPT 5.6 Sol", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("openai/gpt-5.6-terra", "GPT 5.6 Terra", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("openai/gpt-5.6-luna", "GPT 5.6 Luna", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("minimax/minimax-m2.5", "MiniMax M2.5", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
  modelOf("google/gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite", capabilitiesOf({ surfaces: CLINE_SURFACES })),
  modelOf("kwaipilot/kat-coder-pro-v2", "Kat Coder Pro V2", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
];

const CLINE_PASS_MODELS: readonly ProviderModel[] = [
  modelOf("cline-pass/glm-5.2", "GLM 5.2 (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("cline-pass/kimi-k2.7-code", "Kimi K2.7 Code (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("cline-pass/kimi-k2.6", "Kimi K2.6 (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("cline-pass/deepseek-v4-pro", "DeepSeek V4 Pro (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
  modelOf("cline-pass/deepseek-v4-flash", "DeepSeek V4 Flash (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
  modelOf("cline-pass/mimo-v2.5", "MiMo V2.5 (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
  modelOf("cline-pass/mimo-v2.5-pro", "MiMo V2.5 Pro (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
  modelOf("cline-pass/minimax-m3", "MiniMax M3 (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
  modelOf("cline-pass/qwen3.7-max", "Qwen 3.7 Max (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
  modelOf("cline-pass/qwen3.7-plus", "Qwen 3.7 Plus (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
];

async function materializeClineStream(response: Response, coordinator: AbortCoordinator, model: string, limits: ProviderRequest["request"]["limits"]): Promise<ProviderOutput> {
  if (!response.body) throw new UpstreamError({ kind: "provider_protocol_error", message: "Cline returned an empty stream", routeScope: "provider" });
  const events = mapSseStream({ body: response.body, coordinator, maxLineBytes: lineLimit(limits), idleTimeoutMs: limits.idleTimeoutMs }, transformOpenAIChatStream());
  let text = "";
  for await (const event of events) {
    if (event.type === "text_delta") text += event.text;
    if (event.type === "message_stop" && (event as unknown as { error?: { message?: string; code?: string; type?: string; requestId?: string } }).error) {
      const err = (event as unknown as { error: { message?: string; code?: string; type?: string; requestId?: string } }).error;
      throw createInternalFailure({ kind: "provider_protocol_error", safeMessage: err.message ?? "Cline stream failed", statusCode: 200, retryable: false, routeScope: null, upstream: { providerId: "cline", transport: "sse", statusCode: 200, providerCode: err.code ?? null, providerType: err.type ?? null, requestId: err.requestId ?? null, retryAfterMs: null, bodyTruncated: false } });
    }
  }
  if (text.length === 0) throw new UpstreamError({ kind: "provider_protocol_error", message: "Cline returned no final text output", routeScope: "provider" });
  return { mode: "non_stream", body: { id: `cline-${crypto.randomUUID()}`, object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] } };
}

function headers(token: string, stream: boolean): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    authorization: `Bearer ${token}`,
    "http-referer": "https://cline.bot",
    "x-title": "Cline",
    "x-platform": "server",
    "x-platform-version": "1.0.0",
    "x-client-type": "cline-cli",
    "x-client-version": CLINE_CLIENT_VERSION,
    "x-core-version": CLINE_CLIENT_VERSION,
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "x-is-multi-root": "false",
    "user-agent": `Cline/${CLINE_CLIENT_VERSION}`,
  };
}

function workosToken(token: string): string {
  return token.startsWith("workos:") ? token : `workos:${token}`;
}

interface ClineRecommendedModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly tags?: unknown;
}

interface ClineRecommendedPayload {
  readonly free?: unknown;
  readonly clinePass?: unknown;
}

function modelEntries(value: unknown): readonly ClineRecommendedModel[] {
  return Array.isArray(value) ? value.filter((entry): entry is ClineRecommendedModel => typeof entry === "object" && entry !== null && !Array.isArray(entry)) : [];
}

function recommendedModels(value: unknown, pass: boolean): readonly ProviderModel[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const payload = value as ClineRecommendedPayload;
  const entries = pass ? [...modelEntries(payload.clinePass), ...modelEntries(payload.free)] : modelEntries(payload.free);
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id.length === 0 || seen.has(id)) return [];
    seen.add(id);
    const name = typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : id;
    const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.toLowerCase()) : [];
    const images = tags.some((tag) => tag.includes("vision") || tag.includes("multimodal"));
    return [modelOf(id, name, capabilitiesOf({ surfaces: CLINE_SURFACES, streaming: true, reasoning: true, toolCalls: true, images }), {
      context: { inputTokens: 128_000, outputTokens: 8_192 },
      categories: images ? ["vision", "text", "reasoning"] : ["text", "reasoning"],
    })];
  });
}

async function fetchRecommendedModels(input: DiscoveryInput, pass: boolean): Promise<readonly ProviderModel[] | null> {
  const timeout = AbortSignal.timeout(10_000);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
  try {
    const response = await fetch(CLINE_RECOMMENDED_MODELS_URL, { headers: { accept: "application/json" }, signal });
    if (!response.ok) return null;
    const models = recommendedModels(await response.json(), pass);
    return models;
  } catch {
    return null;
  }
}

/** Cline — local catalog + upstream (workos prefix). */
export class ClineProvider extends ApiKeyProviderBase {
  constructor() {
    super({
      metadata: { id: "cline", displayName: "Cline", protocol: "openai", credentialKind: "api_key", credentialKinds: ["api_key", "oauth"] },
      capabilities: capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true, streaming: true }),
      models: CLINE_MODELS,
    });
  }
  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchRecommendedModels(input, false);
  }
  async call(input: ProviderRequest): Promise<ProviderOutput> {
    const token = extractAccessTokenOrRaw(input.credential);
    if (!token) throw new UpstreamError({ kind: "authentication_failed", message: "Cline credential is required", statusCode: 401, routeScope: "account" });
    const request = input.request;
    const materializeStream = !request.stream && input.target.upstreamModelId.includes("deepseek-v4-flash");
    const payload = buildChatPayload({ ...request, model: input.target.upstreamModelId }, { upstreamModel: input.target.upstreamModelId });
    const messages = Array.isArray((payload as Record<string, unknown>).messages) ? ((payload as Record<string, unknown>).messages as unknown[]).filter(isRecord) : [];
    if (!messages.some((m) => (m as Record<string, unknown>).role === "system" || (m as Record<string, unknown>).role === "developer")) (payload as Record<string, unknown>).messages = [{ role: "system", content: "" }, ...messages];
    const coordinator = new AbortCoordinator(input.signal, { connectTimeoutMs: request.limits.connectTimeoutMs, firstByteTimeoutMs: request.limits.firstByteTimeoutMs, idleTimeoutMs: request.limits.idleTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
    let handedOff = false;
    try {
      const materializedPayload = materializeStream
        ? { ...payload, stream: true, reasoning_effort: "none", max_tokens: Math.max(typeof payload.max_tokens === "number" ? payload.max_tokens : 0, 256) }
        : payload;
      const response = await executeFetch(CLINE_CHAT_URL, { method: "POST", headers: headers(workosToken(token), materializeStream || request.stream), body: JSON.stringify(materializedPayload) }, coordinator, input.network, input.capture);
      if (!response.ok) throw await parseUpstreamFailure(response);
      if (materializeStream) return await materializeClineStream(response, coordinator, input.target.upstreamModelId, request.limits);
      if (!request.stream) return { mode: "non_stream", body: (await response.json()) as Record<string, unknown> };
      if (!response.body) throw new UpstreamError({ kind: "provider_protocol_error", message: "Cline returned an empty stream", routeScope: "provider" });
      handedOff = true;
      return { mode: "stream", events: mapSseStream({ body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs }, transformOpenAIChatStream()) };
    } finally { if (!handedOff) coordinator.dispose(); }
  }
}

/** Cline Pass — local catalog + upstream (direct bearer). */
export class ClinePassProvider extends ApiKeyProviderBase {
  constructor() {
    super({
      metadata: { id: "cline-pass", displayName: "Cline Pass", protocol: "openai", credentialKind: "api_key", credentialKinds: ["api_key", "oauth"] },
      capabilities: capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true, streaming: true }),
      models: CLINE_PASS_MODELS,
    });
  }
  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchRecommendedModels(input, true);
  }
  async call(input: ProviderRequest): Promise<ProviderOutput> {
    const token = extractAccessTokenOrRaw(input.credential);
    if (!token) throw new UpstreamError({ kind: "authentication_failed", message: "Cline Pass credential is required", statusCode: 401, routeScope: "account" });
    const request = input.request;
    const payload = buildChatPayload({ ...request, model: input.target.upstreamModelId }, { upstreamModel: input.target.upstreamModelId });
    const messages = Array.isArray((payload as Record<string, unknown>).messages) ? ((payload as Record<string, unknown>).messages as unknown[]).filter(isRecord) : [];
    if (!messages.some((m) => (m as Record<string, unknown>).role === "system" || (m as Record<string, unknown>).role === "developer")) (payload as Record<string, unknown>).messages = [{ role: "system", content: "" }, ...messages];
    const coordinator = new AbortCoordinator(input.signal, { connectTimeoutMs: request.limits.connectTimeoutMs, firstByteTimeoutMs: request.limits.firstByteTimeoutMs, idleTimeoutMs: request.limits.idleTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
    let handedOff = false;
    try {
      const response = await executeFetch(CLINE_CHAT_URL, { method: "POST", headers: headers(token, request.stream), body: JSON.stringify(payload) }, coordinator, input.network, input.capture);
      if (!response.ok) throw await parseUpstreamFailure(response);
      if (!request.stream) return { mode: "non_stream", body: (await response.json()) as Record<string, unknown> };
      if (!response.body) throw new UpstreamError({ kind: "provider_protocol_error", message: "Cline Pass returned an empty stream", routeScope: "provider" });
      handedOff = true;
      return { mode: "stream", events: mapSseStream({ body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs }, transformOpenAIChatStream()) };
    } finally { if (!handedOff) coordinator.dispose(); }
  }
}

