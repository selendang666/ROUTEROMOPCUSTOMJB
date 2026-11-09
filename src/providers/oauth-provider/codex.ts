import { AbortCoordinator } from "../../proxy/transport/abort.js";
import { UpstreamError, parseUpstreamFailure } from "../../proxy/transport/errors.js";
import { internalFailureFromUnknown } from "../../proxy/errors.js";
import { capabilitiesOf, createModelCatalog, modelOf } from "../../proxy/types/provider.js";
import { parseSseEvents, lineLimit, parseSseData, mapSseStream } from "../../proxy/transport/sse.js";
import { executeFetch } from "../../proxy/transport/fetch.js";
import { isRecord } from "../../proxy/validation.js";

import { buildResponsesPayload } from "../../proxy/translate/request.js";
import { mapResponsesUsage } from "../../proxy/translate/response.js";
import { transformOpenAIResponsesStream } from "../../proxy/upstream/openai.js";
import { mergeProviderModels } from "../model-catalog.js";
import { markOverhead } from "../../runtime/overhead.js";
import type { Adapter, ProviderOutput, ProviderRequest, ProxyRequest } from "../../proxy/types/request.js";
import type { ProviderCaps, ProviderMeta, ProviderModel, ProviderModelCatalog } from "../../proxy/types/provider.js";
import type { Surface } from "../../proxy/types/surface.js";
import type { RouteTarget } from "../../proxy/types/routing.js";
import type { InternalFailure } from "../../proxy/types/error-types.js";
import type { DiscoveryInput } from "../../proxy/types/request.js";

/**
 * OpenAI Codex — the ChatGPT Codex backend
 * (https://chatgpt.com/backend-api/codex/responses) authenticated with an
 * OAuth access token whose JWT payload carries the ChatGPT account identity
 * (`chatgpt-account-id`). Speaks the OpenAI Responses upstream format; the Codex
 * backend rejects sampling controls and output-token caps, so those are
 * stripped and the request is forced to stream. The account id is extracted
 * from the access-token JWT so no out-of-band account metadata is required.
 */
const CODEX_SURFACES: readonly Surface[] = ["openai-responses"];
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_VERSION = "0.144.1";
const CODEX_ORIGINATOR = "pi";
const CODEX_AUTH_PATH = "https://api.openai.com/auth";
const CODEX_DISCOVERY_PATHS = ["/codex/models", "/models"] as const;
const CODEX_DEFAULT_CONTEXT_WINDOW = 272_000;
const CODEX_GPT_5_6_CONTEXT_WINDOW = 372_000;
const CODEX_GPT_5_6_1M_CONTEXT_WINDOW = 1_000_000;
const CODEX_DEFAULT_MAX_OUTPUT_TOKENS = 128_000;
const CODEX_ONE_MILLION_CONTEXT_SKUS: Readonly<Record<string, true>> = {
  "gpt-5.6-luna": true,
  "gpt-5.6-sol": true,
  "gpt-5.6-terra": true,
};

const CODEX_MODELS: readonly ProviderModel[] = [
  modelOf("gpt-5.6-sol", "GPT 5.6 Sol", capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true, search: true, compact: true }), { context: { inputTokens: 1_000_000, outputTokens: 128_000 } }),
  modelOf("gpt-5.6-terra", "GPT 5.6 Terra", capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true, search: true, compact: true }), { context: { inputTokens: 1_000_000, outputTokens: 128_000 } }),
  modelOf("gpt-5.6-luna", "GPT 5.6 Luna", capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true, search: true, compact: true }), { context: { inputTokens: 1_000_000, outputTokens: 128_000 } }),
  modelOf("gpt-5.5", "GPT 5.5", capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true, search: true, compact: true }), { context: { inputTokens: 272_000, outputTokens: 128_000 } }),
  modelOf("gpt-5.4", "GPT 5.4", capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true, search: true, compact: true })),
  modelOf("gpt-5.4-mini", "GPT 5.4 Mini", capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true, search: true, compact: true })),
  modelOf("gpt-5.3-codex-spark", "GPT 5.3 Codex Spark", capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true, search: true, compact: true })),
];

const CODEX_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true, search: true, compact: true });

function base64Decode(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

interface CodexCredential {
  readonly accessToken: string;
  readonly accountId?: string;
}

function codexAccountId(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64Decode(parts[1] ?? "")) as Record<string, unknown>;
    const auth = payload[CODEX_AUTH_PATH];
    if (isRecord(auth)) {
      const id = nonEmpty(auth.chatgpt_account_id);
      if (id) return id;
    }
    return nonEmpty(payload.chatgpt_account_id) ?? nonEmpty(payload.account_id) ?? null;
  } catch {
    return null;
  }
}

/** Accepts both the durable OAuth bundle and a raw Codex access token. */
function codexCredential(value: string): CodexCredential | null {
  let accessToken = value.trim();
  let accountId: string | undefined;
  if (accessToken.startsWith("{")) {
    try {
      const parsed = JSON.parse(accessToken) as unknown;
      if (isRecord(parsed)) {
        accessToken = nonEmpty(parsed.accessToken) ?? nonEmpty(parsed.access_token) ?? nonEmpty(parsed.access) ?? "";
        accountId = nonEmpty(parsed.providerAccountId) ?? nonEmpty(parsed.accountId) ?? nonEmpty(parsed.account_id) ?? nonEmpty(parsed.chatgpt_account_id);
      }
    } catch {
      return null;
    }
  }
  if (accessToken.length === 0) return null;
  return { accessToken, accountId: accountId ?? codexAccountId(accessToken) ?? undefined };
}

async function readCodexNonStream(response: Response, coordinator: AbortCoordinator, request: ProviderRequest["request"]): Promise<ProviderOutput> {
  if (!response.body) throw new UpstreamError({ kind: "provider_protocol_error", message: "Codex returned an empty stream body", routeScope: "provider" });
  let completed: Record<string, unknown> | null = null;
  let text = "";
  let reasoning = "";
  const calls = new Map<string, { name: string; arguments: string }>();
  for await (const sse of parseSseEvents({ body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs })) {
    if (sse.data === "[DONE]") continue;
    const parsed = parseSseData(sse.data);
    if (!isRecord(parsed)) continue;
    if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") text += parsed.delta;
    if ((parsed.type === "response.reasoning_text.delta" || parsed.type === "response.reasoning_summary_text.delta") && typeof parsed.delta === "string") reasoning += parsed.delta;
    if (parsed.type === "response.output_item.added" || parsed.type === "response.output_item.done") {
      const item = isRecord(parsed.item) ? parsed.item : null;
      if (item?.type === "function_call") {
        const callId = nonEmpty(item.call_id) ?? nonEmpty(item.id);
        if (callId !== undefined) calls.set(callId, { name: nonEmpty(item.name) ?? "", arguments: typeof item.arguments === "string" ? item.arguments : calls.get(callId)?.arguments ?? "" });
      }
    }
    if (parsed.type === "response.function_call_arguments.delta" && typeof parsed.delta === "string") {
      const callId = nonEmpty(parsed.item_id) ?? nonEmpty(parsed.call_id);
      if (callId !== undefined) {
        const previous = calls.get(callId) ?? { name: "", arguments: "" };
        calls.set(callId, { ...previous, arguments: previous.arguments + parsed.delta });
      }
    }
    if ((parsed.type === "response.completed" || parsed.type === "response.done") && isRecord(parsed.response)) completed = parsed.response;
  }
  if (completed === null) throw new UpstreamError({ kind: "provider_protocol_error", message: "Codex stream ended without a completed response", routeScope: "provider" });
  const existingOutput = Array.isArray(completed.output) ? completed.output.filter(isRecord) : [];
  const additions: Record<string, unknown>[] = [];
  const hasReasoning = existingOutput.some((item) => item.type === "reasoning");
  const hasText = existingOutput.some((item) => {
    if (item.type !== "message" || !Array.isArray(item.content)) return false;
    return item.content.some((part) => isRecord(part) && part.type === "output_text" && typeof part.text === "string" && part.text.length > 0);
  });
  if (reasoning.length > 0 && !hasReasoning) additions.push({ type: "reasoning", id: `${String(completed.id ?? "resp")}-reasoning`, summary: [{ type: "summary_text", text: reasoning }] });
  if (text.length > 0 && !hasText) additions.push({ type: "message", id: `${String(completed.id ?? "resp")}-message`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
  for (const [callId, call] of calls) {
    if (!existingOutput.some((item) => item.type === "function_call" && item.call_id === callId)) {
      additions.push({ type: "function_call", id: callId, call_id: callId, name: call.name, arguments: call.arguments, status: "completed" });
    }
  }
  const body: Record<string, unknown> = additions.length > 0 ? { ...completed, output: [...existingOutput, ...additions] } : { ...completed };
  if (text.length > 0 && (typeof body.output_text !== "string" || body.output_text.length === 0)) body.output_text = text;
  const usageRecord = isRecord(body.usage) ? body.usage : null;
  return { mode: "non_stream", body, usage: usageRecord !== null ? mapResponsesUsage(usageRecord) : undefined };
}

function positiveCodexInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function canonicalCodexId(value: string): string {
  if (!value.endsWith("-wm")) return value;
  const plain = value.slice(0, -3);
  return plain.length > 0 ? plain : value;
}

function modelEntries(value: unknown): readonly Record<string, unknown>[] | null {
  if (!isRecord(value)) return null;
  const candidates = [value.data, value.models, value.items];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    return candidate.filter(isRecord);
  }
  return null;
}

function normalizeCodexModels(value: unknown): readonly ProviderModel[] | null {
  const entries = modelEntries(value);
  if (entries === null) return null;
  const byId = new Map<string, ProviderModel>();
  for (const entry of entries) {
    const id = stringField(entry, "slug") ?? stringField(entry, "id") ?? stringField(entry, "model");
    if (id === null) continue;
    const canonicalId = canonicalCodexId(id);
    const reportedContext = positiveCodexInt(entry.context_window) ?? positiveCodexInt(entry.contextWindow);
    const fallbackContext = id.startsWith("gpt-5.6") ? CODEX_GPT_5_6_CONTEXT_WINDOW : CODEX_DEFAULT_CONTEXT_WINDOW;
    const contextWindow =
      CODEX_ONE_MILLION_CONTEXT_SKUS[canonicalId] === true
        ? Math.max(reportedContext ?? fallbackContext, CODEX_GPT_5_6_1M_CONTEXT_WINDOW)
        : reportedContext ?? fallbackContext;
    const outputTokens = Math.min(
      positiveCodexInt(entry.max_output_tokens) ?? positiveCodexInt(entry.maxTokens) ?? CODEX_DEFAULT_MAX_OUTPUT_TOKENS,
      CODEX_DEFAULT_MAX_OUTPUT_TOKENS,
      contextWindow,
    );
    const displayName = stringField(entry, "display_name") ?? stringField(entry, "name") ?? canonicalId;
    byId.set(
      canonicalId,
      modelOf(
        canonicalId,
        displayName,
        capabilitiesOf({ surfaces: ["openai-responses"], reasoning: true, images: true, search: true }),
        { upstreamId: id, context: { inputTokens: contextWindow, outputTokens } },
      ),
    );
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function fetchCodexModelsInternal(options: {
  readonly accessToken: string;
  readonly accountId: string;
  readonly clientVersion: string;
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<readonly ProviderModel[] | null> {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = (options.baseUrl ?? CODEX_BASE_URL).replace(/\/+$/, "");
  for (const path of CODEX_DISCOVERY_PATHS) {
    try {
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 3_000);
      const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
      const response = await fetcher(`${baseUrl}${path}`, {
        headers: {
          authorization: `Bearer ${options.accessToken}`,
          "chatgpt-account-id": options.accountId,
          originator: CODEX_ORIGINATOR,
          version: options.clientVersion,
          "user-agent": `codex-cli/${options.clientVersion}`,
        },
        signal,
      });
      if (!response.ok) continue;
      const models = normalizeCodexModels(await response.json());
      if (models !== null) return models;
    } catch {
      // Discovery is advisory; static/last-known catalog remains routable.
    }
  }
  return null;
}

export interface CodexAdapterOptions {
  readonly discoveryFetcher?: typeof fetch;
  readonly discoveryTtlMs?: number;
}

/** Codex is the OAuth-gated ChatGPT Codex Responses transport. */
export class CodexAdapter implements Adapter {
  private readonly discoveryFetcher: typeof fetch;
  private readonly discoveryTtlMs: number;
  private modelCatalog = createModelCatalog(CODEX_MODELS);
  private readonly discoveredByAccount = new Map<string, readonly ProviderModel[]>();
  private readonly discoveryExpiresAt = new Map<string, number>();
  private readonly discoveryInFlight = new Map<string, Promise<void>>();
  readonly metadata: ProviderMeta = {
    id: "codex",
    displayName: "Codex ChatGPT",
    protocol: "openai",
    credentialKind: "oauth",
  };
  readonly capabilities: ProviderCaps = { ...CODEX_FALLBACK_CAPABILITIES, streaming: true };

  constructor(options: CodexAdapterOptions = {}) {
    this.discoveryFetcher = options.discoveryFetcher ?? fetch;
    this.discoveryTtlMs = options.discoveryTtlMs ?? 5 * 60_000;
  }

  get models(): ProviderModelCatalog {
    return this.modelCatalog;
  }

  /** Refreshes the account-scoped live catalog without dispatching a generation request. */
  async refreshCatalog(credentialValue: string, signal: AbortSignal = new AbortController().signal): Promise<void> {
    const credential = codexCredential(credentialValue);
    if (credential?.accountId !== undefined) await this.refreshDiscovery({ ...credential, accountId: credential.accountId }, signal);
  }

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    return { providerId: this.metadata.id, modelId, surface, upstreamModelId: this.models.get(modelId)?.upstreamId ?? modelId };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.providerId !== this.metadata.id) {
      throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support the OpenAI Responses surface`, statusCode: 400, routeScope: null });
    }
    if (input.credential.length === 0) {
      throw new UpstreamError({ kind: "authentication_failed", message: "A Codex OAuth access token is required.", statusCode: 401, routeScope: "account" });
    }
    const credential = codexCredential(input.credential);
    const accountId = credential?.accountId ?? null;
    if (credential === null || accountId === null) {
      throw new UpstreamError({ kind: "authentication_failed", message: "Codex OAuth credential is missing its ChatGPT account identity.", statusCode: 401, routeScope: "account" });
    }
    await this.refreshDiscovery({ ...credential, accountId }, input.signal);
    const entry = this.models.get(input.target.modelId);
    const upstreamModelId = entry?.upstreamId ?? input.target.modelId;
    const { request, signal, network } = input;
    // Codex rejects sampling controls and output-token caps with 400; the
    // native client lets the Codex backend choose these values.
    const shapedRequest: ProxyRequest = { ...request, model: upstreamModelId };
    const payload = buildResponsesPayload(shapedRequest);
    delete payload.temperature;
    delete payload.top_p;
    delete payload.max_output_tokens;
    delete payload.max_completion_tokens;
    payload.store = false;
    payload.stream = true;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${credential.accessToken}`,
      "chatgpt-account-id": accountId,
      "openai-beta": "responses=experimental",
      originator: CODEX_ORIGINATOR,
      version: CODEX_VERSION,
      "user-agent": `codex-cli/${CODEX_VERSION}`,
    };
    const isCompact = request.operation === "compact";
    const endpointBase = input.endpoint?.baseUrl?.replace(/\/+$/, "") ?? CODEX_BASE_URL;
    const compactPath = isCompact ? "/codex/responses/compact" : "/codex/responses";
    const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, firstByteTimeoutMs: request.limits.firstByteTimeoutMs, idleTimeoutMs: request.limits.idleTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
    let streamHandedOff = false;
    try {
      const response = await executeFetch(`${endpointBase}${compactPath}`, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, network, input.capture);
      if (!response.ok) throw await parseUpstreamFailure(response);
      if (!request.stream) return await readCodexNonStream(response, coordinator, request);
      if (!response.body) throw new UpstreamError({ kind: "provider_protocol_error", message: "Codex returned an empty stream body", routeScope: "provider" });
      streamHandedOff = true;
      return { mode: "stream", events: mapSseStream(
        { body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs },
        transformOpenAIResponsesStream(input.target.providerId),
      ) };
    } finally {
      if (!streamHandedOff) coordinator.dispose();
    }
  }

  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    const credential = codexCredential(input.credential);
    if (credential === null || credential.accountId === undefined) return null;
    return fetchCodexModelsInternal({
      accessToken: credential.accessToken,
      accountId: credential.accountId,
      clientVersion: CODEX_VERSION,
      fetcher: this.discoveryFetcher,
      signal: input.signal,
    });
  }

  private async refreshDiscovery(
    credential: CodexCredential & { readonly accountId: string },
    signal: AbortSignal,
    force: boolean = false,
  ): Promise<void> {
    const expiresAt = this.discoveryExpiresAt.get(credential.accountId) ?? 0;
    if (Date.now() < expiresAt) return;
    const canServeStale = this.discoveredByAccount.has(credential.accountId);
    const inFlight = this.discoveryInFlight.get(credential.accountId);
    if (inFlight !== undefined) {
      if (!force && canServeStale) return;
      return inFlight;
    }
    const refresh = (async () => {
      const stop = markOverhead("providers.discovery", { provider: this.metadata.id, stale: canServeStale });
      try {
        const models = await fetchCodexModelsInternal({
          accessToken: credential.accessToken,
          accountId: credential.accountId,
          clientVersion: CODEX_VERSION,
          fetcher: this.discoveryFetcher,
          signal,
        });
        if (models !== null) {
          this.discoveredByAccount.set(credential.accountId, models);
          this.modelCatalog = createModelCatalog(mergeProviderModels(CODEX_MODELS, this.discoveredByAccount.values()));
        }
        this.discoveryExpiresAt.set(credential.accountId, Date.now() + this.discoveryTtlMs);
      } finally {
        stop();
      }
    })().finally(() => {
      this.discoveryInFlight.delete(credential.accountId);
    });
    this.discoveryInFlight.set(credential.accountId, refresh);
    if (!force && canServeStale) {
      void refresh.catch(() => {});
      return;
    }
    return refresh;
  }


  mapError(error: unknown): InternalFailure {
    return internalFailureFromUnknown(error);
  }
}

