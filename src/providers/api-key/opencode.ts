import { ApiKeyProviderBase } from "./base.js";
import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import { UpstreamError } from "../../proxy/transport/errors.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { PassthroughProviderResponse, ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { dispatchChatCompletions, dispatchResponses } from "../../proxy/upstream/openai.js";
import { fetchOpenAICompatibleModels } from "../fetch-models.js";
import type { DiscoveryInput } from "../../proxy/types/request.js";
import { createHmac } from "node:crypto";
import { getMontanaConfigRuntime } from "../../runtime/montana-config.js";
import type { Surface } from "../../proxy/types/surface.js";
import { AbortCoordinator } from "../../proxy/transport/abort.js";
import { executeFetch, readJsonObject } from "../../proxy/transport/fetch.js";
import { parseUpstreamFailure } from "../../proxy/transport/errors.js";

const CHAT_SURFACES = ["openai-chat"] as const;
const RESPONSES_SURFACES = ["openai-responses"] as const;
const SURFACES = ["openai-chat", "openai-responses"] as const;
export const OPENCODE_ZEN_API_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_GO_API_BASE_URL = "https://opencode.ai/zen/go/v1";

function configuredUpstream() {
  return getMontanaConfigRuntime()?.snapshot().upstream ?? null;
}

function configuredBaseUrl(fallback: string): string {
  return configuredUpstream()?.baseUrl ?? fallback;
}

function passthroughUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl.replace(/\/$/, "")}/`).toString();
}

function withStreamRelease(response: Response, release: () => Promise<void>): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let released = false;
  const finish = async (): Promise<void> => {
    if (released) return;
    released = true;
    await release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await finish();
        } else if (result.value !== undefined) {
          controller.enqueue(result.value);
        }
      } catch (error) {
        await finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { await finish(); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function passthroughResponse(
  input: import("../../proxy/types/request.js").PassthroughProviderRequest,
  baseUrl: string,
  publicAccess: boolean,
): Promise<PassthroughProviderResponse> {
  const requestModel = typeof input.body.model === "string" && input.body.model.trim().length > 0 ? input.body.model.trim() : input.target.upstreamModelId;
  const coordinator = new AbortCoordinator(input.signal, {
    connectTimeoutMs: input.limits.connectTimeoutMs,
    firstByteTimeoutMs: input.limits.firstByteTimeoutMs,
    idleTimeoutMs: input.limits.idleTimeoutMs,
    totalTimeoutMs: input.limits.totalTimeoutMs,
  });
  let streamHandedOff = false;
  try {
    const headers = opencodeHeaders(input.stream, publicAccess, publicAccess ? undefined : input.credential, input.path);
    const response = await executeFetch(passthroughUrl(baseUrl, input.path), {
      method: "POST",
      headers,
      body: JSON.stringify({ ...input.body, model: requestModel }),
    }, coordinator, input.network);
    if (!response.ok) throw await parseUpstreamFailure(response, input.target.providerId);
    if (input.stream) {
      streamHandedOff = true;
      return { response: withStreamRelease(response, async () => coordinator.dispose()), release: async () => coordinator.dispose() };
    }
    const body = await readJsonObject(response, coordinator);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    return { response: Response.json(body, { status: response.status, headers: responseHeaders }), release: async () => coordinator.dispose() };
  } finally {
    if (!streamHandedOff) coordinator.dispose();
  }
}

const model = (modelId: string, family: string, supportsMedia = false): ProviderModel =>
  modelOf(modelId, family, capabilitiesOf({ surfaces: CHAT_SURFACES, reasoning: true, images: supportsMedia }));

const museModel = (modelId: string, displayName: string): ProviderModel =>
  modelOf(modelId, displayName, capabilitiesOf({ surfaces: RESPONSES_SURFACES, reasoning: true, images: true }));

const FREE_MODELS: readonly ProviderModel[] = Object.freeze([
  model("big-pickle", "Big Pickle", true),

  model("mimo-v2.5-free", "MiMo V2.5", true),
  model("mimo-v2.6-flash-free", "MiMo V2.6 Flash", false),
  model("space-bunny-free", "Space Bunny", false),
  model("ling-3.0-flash-fin-free", "Ling 3.0 Flash", false),
  model("nemotron-3-ultra-free", "Nemotron 3 Ultra", false),
  model("nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning", false),
  museModel("muse-spark-1.3-contributor-free", "Muse Spark 1.3 Free"),
  museModel("muse-spark-1.2-contributor-free", "Muse Spark 1.2 Free"),
]);

const ZEN_MODELS: readonly ProviderModel[] = Object.freeze([
  ...FREE_MODELS.filter((m) => !m.id.startsWith("muse-spark")),
  museModel("muse-spark-1.3", "Muse Spark 1.3"),
  museModel("muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor"),
  museModel("muse-spark-1.2", "Muse Spark 1.2"),
  museModel("muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor"),
]);

const GO_MODELS: readonly ProviderModel[] = Object.freeze([
  museModel("muse-spark-1.3", "Muse Spark 1.3"),
  museModel("muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor"),
  museModel("muse-spark-1.3-contributor-free", "Muse Spark 1.3 Free"),
  museModel("muse-spark-1.2", "Muse Spark 1.2"),
  museModel("muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor"),
  museModel("muse-spark-1.2-contributor-free", "Muse Spark 1.2 Free"),
  model("grok-4.5", "Grok 4.5", false),
  model("glm-5.2", "GLM 5.2", false),
  model("kimi-k3", "Kimi K3", true),
  model("kimi-k2.7-code", "Kimi K2.7 Code", false),
  model("mimo-v2.5-pro", "MiMo V2.5", false),
  model("qwen3.7-max", "Qwen 3.7 Max", false),
  model("minimax-m3", "MiniMax 3", false),
  model("deepseek-v4-pro", "DeepSeek V4 Pro", false),
  model("deepseek-v4-flash", "DeepSeek V4 Flash", false),
  model("hy3", "HY3", false),
]);

const CHROME_PROFILES = [
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    brands: '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
    platform: '"Windows"',
  },
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    brands: '"Not_A Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"',
    platform: '"macOS"',
  },
  {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    brands: '"Not_A Brand";v="8", "Chromium";v="133", "Google Chrome";v="133"',
    platform: '"Linux"',
  },
] as const;

const RESERVED_EXTRA_HEADERS = new Set([
  "accept", "accept-language", "authorization", "connection", "content-length", "content-type", "host", "origin", "referer",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
  "transfer-encoding", "upgrade-insecure-requests", "user-agent", "x-relay-id", "x-relay-secret", "x-upstream-path",
]);

const MAX_EXTRA_HEADERS_JSON_CHARS = 16_384;
const MAX_EXTRA_HEADERS = 64;
let userAgentRotation = 0;

function upstreamOrigin(value: string | undefined): string {
  try {
    const parsed = new URL(value?.trim() || "https://opencode.ai");
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : "https://opencode.ai";
  } catch {
    return "https://opencode.ai";
  }
}

function extraHeaders(value: string | undefined): Record<string, string> {
  if (value === undefined || value.trim().length === 0 || value.length > MAX_EXTRA_HEADERS_JSON_CHARS) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [rawName, rawValue] of Object.entries(parsed).slice(0, MAX_EXTRA_HEADERS)) {
      const name = rawName.trim();
      const lower = name.toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || RESERVED_EXTRA_HEADERS.has(lower)) continue;
      if (typeof rawValue !== "string" || rawValue.length > 8_192 || /[\r\n]/.test(rawValue)) continue;
      result[name] = rawValue;
    }
    return result;
  } catch {
    return {};
  }
}

function signatureHeaders(configured: Readonly<Record<string, string>>, seed: string | undefined, method: string, path: string, nowSeconds: number): Record<string, string> {
  const hmac = seed === undefined || seed.length === 0
    ? ""
    : createHmac("sha256", seed).update(`${method.toUpperCase()}\n${path}\n${nowSeconds}`).digest("hex");
  const replacements: Readonly<Record<string, string>> = {
    "{{method}}": method.toUpperCase(),
    "{{path}}": path,
    "{{timestamp}}": String(nowSeconds),
    "{{exp}}": String(nowSeconds + 300),
    "{{hmac_sha256}}": hmac,
  };
  const result: Record<string, string> = {};
  for (const [name, configuredValue] of Object.entries(configured)) {
    const requiresHmac = configuredValue === "hmac-sha256" || configuredValue.includes("{{hmac_sha256}}");
    if (requiresHmac && hmac.length === 0) continue;
    let value = configuredValue === "hmac-sha256" ? hmac : configuredValue;
    for (const [token, replacement] of Object.entries(replacements)) value = value.split(token).join(replacement);
    result[name] = value;
  }
  return result;
}

export function buildOpenCodeHeaders(input: {
  readonly stream: boolean;
  readonly publicAccess: boolean;
  readonly credential?: string;
  readonly method?: string;
  readonly path: string;
  readonly origin?: string;
  readonly extraHeadersJson?: string;
  readonly signatureSeed?: string;
  readonly nowSeconds?: number;
  readonly userAgentIndex?: number;
}): Record<string, string> {
  const upstream = configuredUpstream();
  const origin = upstreamOrigin(input.origin ?? upstream?.origin);
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const profile = CHROME_PROFILES[(input.userAgentIndex ?? userAgentRotation++) % CHROME_PROFILES.length]!;
  const configured = extraHeaders(input.extraHeadersJson ?? (upstream === null ? undefined : JSON.stringify(upstream.extraHeaders)));
  const signature = signatureHeaders(configured, input.signatureSeed ?? upstream?.signatureSeed, input.method ?? "POST", input.path, nowSeconds);
  const headers: Record<string, string> = {
    ...signature,
    "content-type": "application/json",
    accept: input.stream ? "text/event-stream" : "application/json",
    "accept-language": "en-US,en;q=0.9",
    "x-opencode-client": "desktop",
    "x-opencode-session": `ses_${crypto.randomUUID().replaceAll("-", "")}`,
    "x-opencode-request": `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    "x-opencode-project": "global",
    "user-agent": profile.userAgent,
    origin,
    referer: `${origin.replace(/\/$/, "")}/`,
    "sec-ch-ua": profile.brands,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": profile.platform,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "upgrade-insecure-requests": "1",
  };
  if (!input.publicAccess && input.credential) headers.authorization = `Bearer ${input.credential}`;
  return headers;
}

function opencodeHeaders(stream: boolean, publicAccess: boolean, credential: string | undefined, path: string): Record<string, string> {
  const upstream = configuredUpstream();
  const effectiveCredential = credential !== undefined && credential.length > 0 ? credential : (upstream?.apiKey.length === 0 ? undefined : upstream?.apiKey);
  return buildOpenCodeHeaders({
    stream,
    publicAccess: publicAccess && effectiveCredential === undefined,
    credential: effectiveCredential,
    path,
    origin: upstream?.origin ?? process.env.MONTANA_UPSTREAM_ORIGIN,
    extraHeadersJson: upstream === null ? process.env.MONTANA_UPSTREAM_EXTRA_HEADERS : JSON.stringify(upstream.extraHeaders),
    signatureSeed: upstream?.signatureSeed ?? process.env.MONTANA_SIGNATURE_SEED,
  });
}

/** OpenCode Free — unauthenticated public route (opencode-public). */
export class OpenCodeFreeProvider extends ApiKeyProviderBase {
  constructor() {
    super({
      metadata: { id: "opencodeft", displayName: "OpenCode Free", protocol: "openai", credentialKind: "none" },
      capabilities: capabilitiesOf({ surfaces: SURFACES, reasoning: true, streaming: true }),
      models: FREE_MODELS,
    });
  }
  override resolveTarget(modelId: string, surface: Surface) {
    return super.resolveTarget(modelId.trim().length > 0 ? modelId : configuredUpstream()?.modelsDefault ?? modelId, surface);
  }
  call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.providerId !== "opencodeft" || (input.target.surface !== "openai-chat" && input.target.surface !== "openai-responses"))
      throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "opencodeft" only supports OpenAI Chat/Responses`, statusCode: 400, routeScope: null });
    const request = { ...input.request, model: input.target.upstreamModelId, wirePayload: { ...(input.request.wirePayload ?? {}), model: input.target.upstreamModelId } };
    const path = input.target.surface === "openai-responses" ? "/v1/responses" : "/v1/chat/completions";
    const headers = opencodeHeaders(request.stream, true, undefined, path);
    if (input.target.surface === "openai-responses") return dispatchResponses({ ...input, request }, configuredBaseUrl(OPENCODE_ZEN_API_BASE_URL), headers);
    return dispatchChatCompletions({ ...input, request }, configuredBaseUrl(OPENCODE_ZEN_API_BASE_URL), headers);
  }
  callPassthrough(input: import("../../proxy/types/request.js").PassthroughProviderRequest): Promise<PassthroughProviderResponse> {
    return passthroughResponse(input, configuredBaseUrl(OPENCODE_ZEN_API_BASE_URL), true);
  }
  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    return fetchOpenAICompatibleModels({
      baseUrl: configuredBaseUrl(OPENCODE_ZEN_API_BASE_URL),
      headers: opencodeHeaders(false, true, undefined, "/v1/models"),
      signal: input.signal,
    });
  }
}

/** OpenCode Zen — billed API-key route. */
export class OpenCodeZenProvider extends ApiKeyProviderBase {
  constructor() {
    super({
      metadata: { id: "opencodezen", displayName: "OpenCode Zen", protocol: "openai", credentialKind: "api_key" },
      capabilities: capabilitiesOf({ surfaces: SURFACES, reasoning: true, streaming: true }),
      models: ZEN_MODELS,
    });
  }
  override resolveTarget(modelId: string, surface: Surface) {
    return super.resolveTarget(modelId.trim().length > 0 ? modelId : configuredUpstream()?.modelsDefault ?? modelId, surface);
  }
  call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.providerId !== "opencodezen" || (input.target.surface !== "openai-chat" && input.target.surface !== "openai-responses"))
      throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "opencodezen" only supports OpenAI Chat/Responses`, statusCode: 400, routeScope: null });
    if (input.credential.length === 0 && (configuredUpstream()?.apiKey.length ?? 0) === 0) throw new UpstreamError({ kind: "authentication_failed", message: "OpenCode Zen requires an API key.", statusCode: 401, routeScope: "account" });
    const request = { ...input.request, model: input.target.upstreamModelId, wirePayload: { ...(input.request.wirePayload ?? {}), model: input.target.upstreamModelId } };
    const path = input.target.surface === "openai-responses" ? "/v1/responses" : "/v1/chat/completions";
    const headers = opencodeHeaders(request.stream, false, input.credential, path);
    if (input.target.surface === "openai-responses") return dispatchResponses({ ...input, request }, configuredBaseUrl(OPENCODE_ZEN_API_BASE_URL), headers);
    return dispatchChatCompletions({ ...input, request }, configuredBaseUrl(OPENCODE_ZEN_API_BASE_URL), headers);
  }
  callPassthrough(input: import("../../proxy/types/request.js").PassthroughProviderRequest): Promise<PassthroughProviderResponse> {
    if (input.credential.length === 0 && (configuredUpstream()?.apiKey.length ?? 0) === 0) throw new UpstreamError({ kind: "authentication_failed", message: "OpenCode Zen requires an API key.", statusCode: 401, routeScope: "account" });
    return passthroughResponse(input, configuredBaseUrl(OPENCODE_ZEN_API_BASE_URL), false);
  }
  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchOpenAICompatibleModels({
      baseUrl: configuredBaseUrl(OPENCODE_ZEN_API_BASE_URL),
      headers: opencodeHeaders(false, false, input.credential, "/v1/models"),
      signal: input.signal,
    });
  }
}

/** OpenCode Go — bundled API-key route. */
export class OpenCodeGoProvider extends ApiKeyProviderBase {
  constructor() {
    super({
      metadata: { id: "opencodego", displayName: "OpenCode Go", protocol: "openai", credentialKind: "api_key" },
      capabilities: capabilitiesOf({ surfaces: SURFACES, reasoning: true, streaming: true }),
      models: GO_MODELS,
    });
  }
  override resolveTarget(modelId: string, surface: Surface) {
    return super.resolveTarget(modelId.trim().length > 0 ? modelId : configuredUpstream()?.modelsDefault ?? modelId, surface);
  }
  call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.providerId !== "opencodego" || (input.target.surface !== "openai-chat" && input.target.surface !== "openai-responses"))
      throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "opencodego" only supports OpenAI Chat/Responses`, statusCode: 400, routeScope: null });
    if (input.credential.length === 0 && (configuredUpstream()?.apiKey.length ?? 0) === 0) throw new UpstreamError({ kind: "authentication_failed", message: "OpenCode Go requires an API key.", statusCode: 401, routeScope: "account" });
    const request = { ...input.request, model: input.target.upstreamModelId, wirePayload: { ...(input.request.wirePayload ?? {}), model: input.target.upstreamModelId } };
    const path = input.target.surface === "openai-responses" ? "/v1/responses" : "/v1/chat/completions";
    const headers = opencodeHeaders(request.stream, false, input.credential, path);
    if (input.target.surface === "openai-responses") return dispatchResponses({ ...input, request }, configuredBaseUrl(OPENCODE_GO_API_BASE_URL), headers);
    return dispatchChatCompletions({ ...input, request }, configuredBaseUrl(OPENCODE_GO_API_BASE_URL), headers);
  }
  callPassthrough(input: import("../../proxy/types/request.js").PassthroughProviderRequest): Promise<PassthroughProviderResponse> {
    if (input.credential.length === 0 && (configuredUpstream()?.apiKey.length ?? 0) === 0) throw new UpstreamError({ kind: "authentication_failed", message: "OpenCode Go requires an API key.", statusCode: 401, routeScope: "account" });
    return passthroughResponse(input, configuredBaseUrl(OPENCODE_GO_API_BASE_URL), false);
  }
  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchOpenAICompatibleModels({
      baseUrl: configuredBaseUrl(OPENCODE_GO_API_BASE_URL),
      headers: opencodeHeaders(false, false, input.credential, "/v1/models"),
      signal: input.signal,
    });
  }
}

export const freeAdapter = new OpenCodeFreeProvider();
export const zenAdapter = new OpenCodeZenProvider();
export const goAdapter = new OpenCodeGoProvider();
