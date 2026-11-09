import { AbortCoordinator } from "../../proxy/transport/abort.js";
import { UpstreamError, parseUpstreamFailure } from "../../proxy/transport/errors.js";
import { internalFailureFromUnknown } from "../../proxy/errors.js";
import { capabilitiesOf, createModelCatalog, modelOf } from "../../proxy/types/provider.js";
import { executeFetch } from "../../proxy/transport/fetch.js";
import { mapSseStream, lineLimit } from "../../proxy/transport/sse.js";
import type { SseEvent } from "../../proxy/types/stream.js";
import { isRecord } from "../../proxy/validation.js";

import { buildGeminiPayload, mapGeminiUsage, transformGeminiGenerateContentStream, translateGeminiResponse } from "../../proxy/upstream/gemini.js";
import { RouteSessionStateStore, type RouteSessionStateInspection } from "../../proxy/routing/plan.js";
import { mergeProviderModels } from "../model-catalog.js";
import { markOverhead } from "../../runtime/overhead.js";
import type { ExtendedStreamEvent } from "../../proxy/types/stream.js";
import type { ProxyRequest, Adapter, ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import type { ProviderCaps, ProviderMeta, ProviderModel, ProviderModelCatalog } from "../../proxy/types/provider.js";
import type { Surface } from "../../proxy/types/surface.js";
import type { ProviderUsage } from "../../proxy/types/telemetry.js";
import type { InternalFailure } from "../../proxy/types/error-types.js";
import type { RouteTarget } from "../../proxy/types/routing.js";
import type { StreamEvent } from "../../proxy/types/stream.js";
import type { DiscoveryInput } from "../../proxy/types/request.js";


/**
 * Google Antigravity — the Cloud Code Assist agentic backend (Gemini 3,
 * Claude, GPT-OSS) authenticated with a Google OAuth access token plus a
 * provisioned Cloud Code Assist project id.
 *
 * The transport is Antigravity's internal `v1internal:streamGenerateContent`
 * SSE endpoint on `daily-cloudcode-pa.googleapis.com`, with a sandbox
 * fallback on 429/5xx. The request envelope is the Gemini agent shape: a
 * `project` + `requestId` (`agent/<id>/<ts>/<trajectory>/<step>`) + `labels`
 * wrapper around a standard Gemini generateContent payload, and responses are
 * Gemini `candidates`/`usageMetadata` frames — so the adapter reuses the
 * Gemini payload builder and stream mapper.
 *
 * Request-time credential: the current {@link ProviderRequest.credential}
 * channel is a bare string with no metadata fields, so the account's OAuth
 * token is stored as JSON (`{"accessToken": "...", "projectId": "..."}`, see
 * {@link parseAntigravityCredential} / `encodeAntigravityCredential` in the
 * Antigravity OAuth driver). The AntigravityOAuthDriver returns the project
 * id as the account id so the console can store it with the credential.
 */

export const ANTIGRAVITY_SURFACES: readonly Surface[] = ["openai-chat"];
export const ANTIGRAVITY_PRODUCTION_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const ANTIGRAVITY_ACTION = "v1internal:streamGenerateContent?alt=sse";
export const ANTIGRAVITY_VERSION_MANIFEST_URL = "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
export const DEFAULT_ANTIGRAVITY_VERSION = "2.9.1";
const ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_ANTIGRAVITY_CHANGE_LIST = "963137146";
const DEFAULT_ANTIGRAVITY_OS = "darwin";
const DEFAULT_ANTIGRAVITY_ARCH = "arm64";
const ANTIGRAVITY_SYSTEM_INSTRUCTION = "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";
let discoveredAntigravityVersion: string | null = null;
let antigravityVersionFetch: Promise<void> | null = null;

export interface EffortVariantFamily {
  readonly logicalId: string;
  readonly displayName: string;
  readonly variants: Readonly<Record<"minimal" | "low" | "medium" | "high", string>>;
}

export const ANTIGRAVITY_VARIANT_FAMILIES: readonly EffortVariantFamily[] = [
  {
    logicalId: "gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    variants: { minimal: "gemini-3.5-flash-extra-low", low: "gemini-3.5-flash-extra-low", medium: "gemini-3.5-flash-low", high: "gemini-3-flash-agent" },
  },
  {
    logicalId: "gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    variants: { minimal: "gemini-3.6-flash-extra-low", low: "gemini-3.6-flash-extra-low", medium: "gemini-3.6-flash-low", high: "gemini-3.6-flash-agent" },
  },
  {
    logicalId: "gemini-3.7-flash",
    displayName: "Gemini 3.7 Flash",
    variants: { minimal: "gemini-3.7-flash-extra-low", low: "gemini-3.7-flash-extra-low", medium: "gemini-3.7-flash-low", high: "gemini-3.7-flash-agent" },
  },
];

const ANTIGRAVITY_VARIANT_TO_LOGICAL = new Map<string, string>();
for (const family of ANTIGRAVITY_VARIANT_FAMILIES) {
  for (const variant of Object.values(family.variants)) ANTIGRAVITY_VARIANT_TO_LOGICAL.set(variant, family.logicalId);
}

export function collapseAntigravityVariant(modelId: string): string {
  return ANTIGRAVITY_VARIANT_TO_LOGICAL.get(modelId) ?? modelId;
}

export function antigravityVariantForEffort(modelId: string, effort: "minimal" | "low" | "medium" | "high" | undefined): string {
  const family = ANTIGRAVITY_VARIANT_FAMILIES.find((candidate) => candidate.logicalId === modelId);
  if (family === undefined) return modelId;
  return family.variants[effort ?? "high"];
}

export const ANTIGRAVITY_THINKING_BUDGETS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "gemini-3.5-flash": { minimal: 0, low: 1000, medium: 4000, high: 10000 },
  "gemini-3.6-flash": { minimal: 0, low: 1000, medium: 4000, high: 10000 },
  "gemini-3.7-flash": { minimal: 0, low: 1000, medium: 4000, high: 10000 },
};

export function thinkingBudgetFor(modelId: string, effort: string): number | null {
  const budgets = ANTIGRAVITY_THINKING_BUDGETS[modelId];
  if (budgets === undefined) return null;
  const value = budgets[effort];
  return typeof value === "number" ? value : null;
}

const ANTIGRAVITY_DISCOVERY_PATH = "/v1internal:fetchAvailableModels";
export const ANTIGRAVITY_DISCOVERY_PRIMARY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_DISCOVERY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW = 200_000;
const ANTIGRAVITY_DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const ANTIGRAVITY_DISCOVERY_DENYLIST: Readonly<Record<string, true>> = {
  chat_20706: true,
  chat_23310: true,
  "gemini-2.5-pro": true,
};

interface AntigravityDiscoveryModel {
  readonly displayName?: unknown;
  readonly maxTokens?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly supportsThinking?: unknown;
  readonly supportsImages?: unknown;
  readonly isInternal?: unknown;
}

interface AntigravityDiscoveryResponse {
  readonly models?: unknown;
}

export interface AntigravityDiscoveryOptions {
  readonly accessToken: string;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly endpoint?: string;
  readonly userAgent: string;
  readonly timeoutMs?: number;
}

export interface AntigravityDiscoveryResult {
  readonly models: readonly ProviderModel[];
  readonly endpoint: string;
}

function positiveAntigravityInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeAntigravityModels(value: unknown): readonly ProviderModel[] | null {
  if (!isRecord(value)) return null;
  const byId = new Map<string, ProviderModel>();
  for (const [wireId, raw] of Object.entries(value)) {
    if (ANTIGRAVITY_DISCOVERY_DENYLIST[wireId] === true || !isRecord(raw) || raw.isInternal === true) continue;
    const model = raw as AntigravityDiscoveryModel;
    const id = collapseAntigravityVariant(wireId);
    const displayName = typeof model.displayName === "string" && model.displayName.length > 0 ? model.displayName : id;
    const inputTokens = positiveAntigravityInt(model.maxTokens, ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW);
    const outputTokens = positiveAntigravityInt(model.maxOutputTokens, ANTIGRAVITY_DEFAULT_MAX_OUTPUT_TOKENS);
    const normalized = modelOf(
      id,
      displayName,
      capabilitiesOf({ surfaces: ["openai-chat"], reasoning: model.supportsThinking === true, images: model.supportsImages === true, search: true }),
      { upstreamId: wireId, context: { inputTokens, outputTokens } },
    );
    const existing = byId.get(id);
    if (existing === undefined || (normalized.context?.inputTokens ?? 0) > (existing.context?.inputTokens ?? 0)) byId.set(id, normalized);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function fetchAntigravityDiscoveryModelsInternal(
  options: AntigravityDiscoveryOptions,
): Promise<AntigravityDiscoveryResult | null> {
  const fetcher = options.fetcher ?? fetch;
  const endpoints =
    options.endpoint === undefined ? [ANTIGRAVITY_DISCOVERY_PRIMARY_ENDPOINT, ANTIGRAVITY_DISCOVERY_SANDBOX_ENDPOINT] : [options.endpoint];
  for (const endpoint of endpoints) {
    try {
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 3_000);
      const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
      const response = await fetcher(`${endpoint.replace(/\/+$/, "")}${ANTIGRAVITY_DISCOVERY_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.accessToken}`, "content-type": "application/json", "user-agent": options.userAgent },
        body: "{}",
        signal,
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as AntigravityDiscoveryResponse;
      const models = normalizeAntigravityModels(payload.models);
      if (models === null) continue;
      return { models, endpoint };
    } catch {
      // A failed live catalog must never break static routing.
    }
  }
  return null;
}

const ANTIGRAVITY_MODELS: readonly ProviderModel[] = [
  modelOf("gemini-3.1-pro", "Gemini 3.1 Pro", capabilitiesOf({ surfaces: ["openai-chat"], reasoning: true, images: true, search: true }), { upstreamId: "gemini-pro-agent" }),
  modelOf("gemini-3.5-flash", "Gemini 3.5 Flash", capabilitiesOf({ surfaces: ["openai-chat"], reasoning: true, images: true, search: true }), { upstreamId: "gemini-3.5-flash-extra-low" }),
  modelOf("gemini-3-flash", "Gemini 3 Flash", capabilitiesOf({ surfaces: ["openai-chat"], reasoning: true, images: true, search: true })),
  modelOf("gemini-3.6-flash", "Gemini 3.6 Flash", capabilitiesOf({ surfaces: ["openai-chat"], reasoning: true, images: true, search: true }), { context: { inputTokens: 1_000_000, outputTokens: 65_536 } }),
  modelOf("gemini-3.7-flash", "Gemini 3.7 Flash", capabilitiesOf({ surfaces: ["openai-chat"], reasoning: true, images: true, search: true }), { context: { inputTokens: 1_000_000, outputTokens: 65_536 } }),
  modelOf("claude-sonnet-4-6", "Claude Sonnet 4.6", capabilitiesOf({ surfaces: ["openai-chat"], reasoning: true, images: true, search: true })),
  modelOf("claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking", capabilitiesOf({ surfaces: ["openai-chat"], reasoning: true, images: true, search: true })),
  modelOf("gpt-oss-120b", "GPT-OSS 120B", capabilitiesOf({ surfaces: ["openai-chat"], reasoning: true, search: true }), { upstreamId: "gpt-oss-120b-medium" }),
];

const ANTIGRAVITY_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({ surfaces: ANTIGRAVITY_SURFACES, reasoning: true, images: true, search: true });

interface AntigravityWireProfile {
  modelEnum?: string;
  maxOutputTokens: number;
}

export interface AntigravitySessionState {
  agentId?: string;
  trajectoryId?: string;
  sessionId?: string;
  stepIndex?: number;
  lastExecutionId?: string;
  lastGoodEndpoint?: string;
}

/** Per-wire-id request constants captured from the real Antigravity client. */
export const ANTIGRAVITY_WIRE_PROFILES: Readonly<Record<string, AntigravityWireProfile>> = {
  "gemini-3.5-flash-extra-low": { modelEnum: "MODEL_PLACEHOLDER_M187", maxOutputTokens: 65_536 },
  "gemini-3.5-flash-low": { modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65_536 },
  "gemini-3-flash-agent": { modelEnum: "MODEL_PLACEHOLDER_M132", maxOutputTokens: 65_536 },
  "gemini-3.6-flash-extra-low": { maxOutputTokens: 65_536 },
  "gemini-3.6-flash-low": { maxOutputTokens: 65_536 },
  "gemini-3.6-flash-agent": { maxOutputTokens: 65_536 },
  "gemini-3.7-flash-extra-low": { maxOutputTokens: 65_536 },
  "gemini-3.7-flash-low": { maxOutputTokens: 65_536 },
  "gemini-3.7-flash-agent": { maxOutputTokens: 65_536 },
  "gemini-3.1-pro-low": { modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65_535 },
  "gemini-pro-agent": { modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65_535 },
  // Claude on `daily-cloudcode-pa` rejects maxOutputTokens > 64000 with 400.
  "claude-sonnet-4-6": { maxOutputTokens: 64_000 },
  "claude-opus-4-6-thinking": { maxOutputTokens: 64_000 },
};

/** Resolves the upstream Antigravity Hub version; never uses Oh My Omop - Router identity. */
export function getAntigravityVersion(): string {
  return (process.env.PI_AI_ANTIGRAVITY_VERSION as string | undefined) || discoveredAntigravityVersion || DEFAULT_ANTIGRAVITY_VERSION;
}

/** Builds the exact Antigravity Hub user-agent shape expected by Cloud Code Assist. */
export function getAntigravityUserAgent(): string {
  const version = getAntigravityVersion();
  const os = (process.env.PI_AI_ANTIGRAVITY_OS as string | undefined) || DEFAULT_ANTIGRAVITY_OS;
  const arch = (process.env.PI_AI_ANTIGRAVITY_ARCH as string | undefined) || DEFAULT_ANTIGRAVITY_ARCH;
  const changeList = (process.env.PI_AI_ANTIGRAVITY_CL as string | undefined) || DEFAULT_ANTIGRAVITY_CHANGE_LIST;
  return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${changeList})`;
}

/** Parses the upstream Hub version from an Electron-builder update manifest. */
export function parseAntigravityManifestVersion(value: string): string | null {
  for (const line of value.split(/\r?\n/)) {
    const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const version = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  }
  return null;
}

/** Refreshes the upstream Antigravity Hub version with a bounded, cached fetch. */
export async function ensureAntigravityVersion(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<void> {
  if ((process.env.PI_AI_ANTIGRAVITY_VERSION as string | undefined) || discoveredAntigravityVersion) return Promise.resolve();
  if (antigravityVersionFetch) return antigravityVersionFetch;
  antigravityVersionFetch = (async () => {
    try {
      const timeoutSignal = AbortSignal.timeout(ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS);
      const response = await fetcher(ANTIGRAVITY_VERSION_MANIFEST_URL, {
        headers: { "Cache-Control": "no-cache", "User-Agent": "electron-builder" },
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
      if (response.ok) {
        discoveredAntigravityVersion = parseAntigravityManifestVersion(await response.text());
      }
    } catch {
      // Silent: the pinned fallback remains valid when version discovery fails.
    } finally {
      if (!discoveredAntigravityVersion) antigravityVersionFetch = null;
    }
  })();
  return antigravityVersionFetch;
}
/** Collapses logical Antigravity model ids to the wire ids accepted upstream. */
export function antigravityWireModelId(modelId: string): string {
  if (modelId === "opus[1m]" || modelId === "opus") return "claude-opus-4-6-thinking";
  if (modelId === "gemini-3.1-pro" || modelId === "gemini-3.1-pro-high") return "gemini-pro-agent";
  if (modelId === "gemini-3.1-pro-low") return "gemini-3.1-pro-low";
  if (modelId === "gemini-3.5-flash") return "gemini-3.5-flash-extra-low";
  if (modelId === "gemini-3.5-flash-medium") return "gemini-3.5-flash-low";
  if (modelId === "gemini-3.5-flash-high") return "gemini-3-flash-agent";
  if (modelId === "gemini-3.6-flash") return "gemini-3.6-flash-extra-low";
  if (modelId === "gemini-3.6-flash-medium") return "gemini-3.6-flash-low";
  if (modelId === "gemini-3.6-flash-high") return "gemini-3.6-flash-agent";
  if (modelId === "gemini-3.7-flash") return "gemini-3.7-flash-extra-low";
  if (modelId === "gemini-3.7-flash-medium") return "gemini-3.7-flash-low";
  if (modelId === "gemini-3.7-flash-high") return "gemini-3.7-flash-agent";
  if (modelId === "gpt-oss-120b") return "gpt-oss-120b-medium";
  return modelId;
}

/** Thinking budget per wire model, matching the Antigravity client's effort tiers. */
export function antigravityThinkingBudget(modelId: string): number | undefined {
  if (!modelId.includes("claude") && !modelId.includes("gemini-3")) return undefined;
  if (modelId.endsWith("-low")) return 1_000;
  if (modelId.endsWith("-medium")) return 4_000;
  if (modelId.endsWith("-high")) return 10_000;
  return modelId.includes("3.1-pro") ? 10_001 : 10_000;
}

function wantsWebSearch(request: ProxyRequest): boolean {
  return request.tools.some((tool) => tool.kind === "hosted" && tool.hostedType === "web_search");
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { content: value };
  } catch {
    return value.length > 0 ? { content: value } : {};
  }
}

/** Decoded request-time credential: Google OAuth access token + Cloud Code project id. */
export interface AntigravityCredential {
  readonly accessToken: string;
  readonly projectId: string;
}

/**
 * Parses the Antigravity request-time credential. Accepts the composite JSON
 * form (`{"accessToken", "projectId"}`) produced by the OAuth driver's
 * `encodeAntigravityCredential`, or the persisted token-set form where the
 * project id is stored as `providerAccountId`; anything else (a bare JWT, empty string)
 * returns null so the adapter can raise a typed authentication error.
 */
export function parseAntigravityCredential(credential: string): AntigravityCredential | null {
  if (credential.length === 0 || credential.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(credential);
      if (isRecord(parsed)) {
        const accessToken = typeof parsed.accessToken === "string" && parsed.accessToken.length > 0 ? parsed.accessToken : undefined;
        const projectIdValue = parsed.projectId ?? parsed.providerAccountId;
        const projectId = typeof projectIdValue === "string" && projectIdValue.length > 0 ? projectIdValue : undefined;
        if (accessToken !== undefined && projectId !== undefined) return { accessToken, projectId };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function signedAntigravitySessionId(seed?: string): string {
  if (seed && /^\\d+$/.test(seed)) return seed;
  const hex = (seed ?? crypto.randomUUID()).replace(/[^0-9a-f]/gi, "").slice(0, 15) || "1";
  return String(BigInt(`0x${hex}`));
}

export function buildAntigravityRequest(request: ProxyRequest, credential: AntigravityCredential, modelId: string, conversationId?: string, sessionState?: AntigravitySessionState): Record<string, unknown> {
  const geminiPayload = buildGeminiPayload(request);
  const state = sessionState;
  if (state) {
    state.agentId ??= crypto.randomUUID();
    state.trajectoryId ??= crypto.randomUUID();
    state.sessionId ??= signedAntigravitySessionId(conversationId);
    state.stepIndex = (state.stepIndex ?? 1) + 1;
  }
  const trajectoryId = state?.trajectoryId ?? crypto.randomUUID();
  const agentId = state?.agentId ?? crypto.randomUUID();
  const step = state?.stepIndex ?? 2;
  const wireModelId = antigravityWireModelId(modelId);
  const wireProfile = ANTIGRAVITY_WIRE_PROFILES[wireModelId];
  const labels: Record<string, string> = {
    ...(state?.lastExecutionId ? { last_execution_id: state.lastExecutionId } : {}),
    trajectory_id: trajectoryId,
    last_step_index: String(step - 1),
    used_claude: String(modelId.includes("claude")),
    used_claude_conservative: String(modelId.includes("claude")),
  };
  if (wireProfile?.modelEnum !== undefined) labels.model_enum = wireProfile.modelEnum;

  const generationConfig: Record<string, unknown> = isRecord(geminiPayload.generationConfig) ? { ...geminiPayload.generationConfig } : {};
  if (wireProfile !== undefined) generationConfig.maxOutputTokens = wireProfile.maxOutputTokens;
  const budget = antigravityThinkingBudget(wireModelId);
  if (budget !== undefined) generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: budget };

  const existingContents = Array.isArray(geminiPayload.contents) ? geminiPayload.contents as Record<string, unknown>[] : [];
  const hasIdentity = existingContents.some((content) => Array.isArray(content.parts) && (content.parts as unknown[]).some((part) => isRecord(part) && part.text === ANTIGRAVITY_SYSTEM_INSTRUCTION));
  const injectIdentity = modelId.toLowerCase().includes("claude") || modelId.toLowerCase().includes("gemini-3");
  const contents = !injectIdentity || hasIdentity ? existingContents : [{ role: "user", parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }] }, ...existingContents];
  const requestPayload: Record<string, unknown> = { ...geminiPayload, contents, labels, sessionId: state?.sessionId ?? signedAntigravitySessionId(conversationId) };
  if (Object.keys(generationConfig).length > 0) requestPayload.generationConfig = generationConfig;
  if (wantsWebSearch(request)) {
    const tools = Array.isArray(requestPayload.tools) ? [...(requestPayload.tools as Record<string, unknown>[])] : [];
    tools.push({ googleSearch: {} });
    requestPayload.tools = tools;
    // Gemini with websearch + function calling needs server side invocations enabled
    if (!modelId.includes("claude")) {
      const currentToolConfig = isRecord(requestPayload.toolConfig) ? { ...(requestPayload.toolConfig as Record<string, unknown>) } : {};
      const funcConfig = isRecord(currentToolConfig.functionCallingConfig) ? { ...(currentToolConfig.functionCallingConfig as Record<string, unknown>) } : {};
      if (!isRecord(currentToolConfig.functionCallingConfig)) currentToolConfig.functionCallingConfig = funcConfig;
      (funcConfig as Record<string, unknown>).mode = (funcConfig as Record<string, unknown>).mode ?? "VALIDATED";
      (currentToolConfig as Record<string, unknown>).includeServerSideToolInvocations = true;
      requestPayload.toolConfig = currentToolConfig;
    }
  }
  if (modelId.includes("claude")) {
    const currentToolConfig = isRecord(requestPayload.toolConfig) ? { ...(requestPayload.toolConfig as Record<string, unknown>) } : {};
    const funcConfig = isRecord(currentToolConfig.functionCallingConfig) ? { ...(currentToolConfig.functionCallingConfig as Record<string, unknown>) } : {};
    if (!isRecord(currentToolConfig.functionCallingConfig)) currentToolConfig.functionCallingConfig = funcConfig;
    (funcConfig as Record<string, unknown>).mode = (funcConfig as Record<string, unknown>).mode ?? "VALIDATED";
    if (wantsWebSearch(request)) {
      (currentToolConfig as Record<string, unknown>).includeServerSideToolInvocations = true;
    }
    requestPayload.toolConfig = currentToolConfig;
  }

  return {
    project: credential.projectId,
    requestId: `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`,
    model: wireModelId,
    userAgent: "antigravity",
    requestType: "agent",
    request: requestPayload,
  };
}

/**
 * Cloud Code Assist nests `usageMetadata` inside the `response` object of
 * each SSE frame (the plain Gemini API emits it at the top level). Hoist it
 * before the shared Gemini mapper runs so usage accounting works on both
 * wire shapes; malformed frames pass through untouched.
 */
export function normalizeAntigravityFrame(sse: SseEvent): SseEvent {
  if (sse.data.length === 0) return sse;
  try {
    const parsed: unknown = JSON.parse(sse.data);
    if (isRecord(parsed) && isRecord(parsed.response) && !isRecord(parsed.usageMetadata) && isRecord(parsed.response.usageMetadata)) {
      return { event: sse.event, data: JSON.stringify({ ...parsed, usageMetadata: parsed.response.usageMetadata }) };
    }
  } catch {
    return sse;
  }
  return sse;
}

/**
 * Folds a Gemini-style SSE event stream into a single non-stream response
 * body (the Antigravity transport only exposes the streaming endpoint).
 */
export async function foldAntigravityStream(events: AsyncIterable<ExtendedStreamEvent>, _model: string): Promise<{ readonly body: Record<string, unknown>; readonly usage: ProviderUsage | null }> {
  const parts: Record<string, unknown>[] = [];
  const pendingCalls = new Map<string, { name: string; args: string[] }>();
  let finishReason: string | null = null;
  let responseId: string | null = null;
  let usage: ProviderUsage | null = null;
  for await (const event of events as AsyncIterable<StreamEvent & ExtendedStreamEvent>) {
    switch (event.type) {
      case "message_start":
        responseId = responseId ?? event.id;
        break;
      case "thinking_delta":
        parts.push({ text: event.text, thought: true });
        break;
      case "text_delta":
        parts.push({ text: event.text });
        break;
      case "tool_call_start":
        pendingCalls.set(event.callId, { name: event.name, args: [] });
        break;
      case "tool_call_delta": {
        const call = pendingCalls.get(event.callId);
        if (call !== undefined) call.args.push(event.delta);
        break;
      }
      case "tool_call_end": {
        const call = pendingCalls.get(event.callId);
        if (call !== undefined) parts.push({ functionCall: { id: event.callId, name: call.name, args: parseJsonObject(call.args.join("")) } });
        break;
      }
      case "native_block_start": {
        const ext = event as unknown as { block: Readonly<Record<string, unknown>> };
        const block = ext.block;
        const source = isRecord(block.source) ? block.source : null;
        if (block.type === "image" && source !== null && source.type === "base64" && typeof source.data === "string") {
          parts.push({ inlineData: { data: source.data, mimeType: typeof (block as Record<string, unknown>).media_type === "string" ? (block as Record<string, unknown>).media_type as string : "image/png" } });
        }
        break;
      }
      case "native_block_delta":
      case "native_block_stop":
        break;
      case "usage":
        usage = event.usage;
        break;
      case "message_stop":
        finishReason = event.reason;
        break;
    }
  }
  const usageMetadata: Record<string, unknown> = {};
  if (usage !== null) {
    if (usage.inputTokens !== null) usageMetadata.promptTokenCount = usage.inputTokens;
    if (usage.outputTokens !== null) usageMetadata.candidatesTokenCount = usage.outputTokens;
    if (usage.totalTokens !== null) usageMetadata.totalTokenCount = usage.totalTokens;
    if (usage.cacheReadTokens !== null) usageMetadata.cachedContentTokenCount = usage.cacheReadTokens;
  }
  const body: Record<string, unknown> = {
    candidates: [{ content: { role: "model", parts }, finishReason: finishReason === "length" ? "MAX_TOKENS" : "STOP" }],
    usageMetadata,
  };
  if (responseId !== null) body.responseId = responseId;
  return { body, usage: usage ?? mapGeminiUsage(body) };
}

/** Maximum in-memory conversation sessions retained by the adapter. */
const MAX_SESSION_STATES = 256;
const DEFAULT_SESSION_STATE_IDLE_TTL_MS = 30 * 60_000;

function sessionIdentityDigest(value: string): string {
  let hash = 1469598103934665603n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, "0");
}

function sessionStateKey(routeIdentity: string, providerId: string, upstreamModelId: string): string {
  return `${sessionIdentityDigest(routeIdentity)}:${providerId}:${upstreamModelId}`;
}

function sessionStateRoutePrefix(routeIdentity: string): string {
  return `${sessionIdentityDigest(routeIdentity)}:`;
}

function sessionRouteIdentity(input: ProviderRequest, projectId: string): string {
  const conversationId = input.headers?.get("x-conversation-id");
  if (typeof conversationId === "string" && conversationId.length > 0) return conversationId;
  return `project:${projectId}`;
}

/** Options for bounded Antigravity conversation state. */
export interface AntigravityAdapterOptions {
  /** Inject a store when the host needs explicit limits or test inspection. */
  readonly sessionStateStore?: RouteSessionStateStore<AntigravitySessionState>;
  /** Maximum state entries when a store is not injected. */
  readonly sessionStateMaxEntries?: number;
  /** Idle state lifetime in milliseconds when a store is not injected. */
  readonly sessionStateIdleTtlMs?: number;
  /** Injectable clock used when a store is not injected. */
  readonly now?: () => number;
  /** Injectable manifest fetcher for Antigravity Hub version discovery. */
  readonly versionFetcher?: typeof fetch;
  /** Injectable live-catalog fetcher for model discovery. */
  readonly discoveryFetcher?: typeof fetch;
  /** Live catalog cache TTL; discovery never blocks static fallback routing. */
  readonly discoveryTtlMs?: number;
}

/** Google Antigravity (Cloud Code Assist) adapter. */
export class AntigravityAdapter implements Adapter {
  private readonly sessionStates: RouteSessionStateStore<AntigravitySessionState>;
  private readonly versionFetcher: typeof fetch;
  private readonly discoveryFetcher: typeof fetch;
  private readonly discoveryTtlMs: number;
  private modelCatalog = createModelCatalog(ANTIGRAVITY_MODELS);
  private discoveryCredential: string | null = null;
  private discoveryExpiresAt = 0;
  private discoveryEndpoint: string | null = null;
  private discoveryInFlight: Promise<void> | null = null;
  readonly metadata: ProviderMeta = {
    id: "antigravity",
    displayName: "Antigravity",
    protocol: "gemini",
    credentialKind: "oauth",
  };
  readonly capabilities: ProviderCaps = { ...ANTIGRAVITY_FALLBACK_CAPABILITIES, streaming: true };

  constructor(options: AntigravityAdapterOptions = {}) {
    this.sessionStates = options.sessionStateStore ?? new RouteSessionStateStore({
      maxEntries: options.sessionStateMaxEntries ?? MAX_SESSION_STATES,
      idleTtlMs: options.sessionStateIdleTtlMs ?? DEFAULT_SESSION_STATE_IDLE_TTL_MS,
      now: options.now,
    });
    this.versionFetcher = options.versionFetcher ?? fetch;
    this.discoveryFetcher = options.discoveryFetcher ?? fetch;
    this.discoveryTtlMs = options.discoveryTtlMs ?? 5 * 60_000;
  }

  get models(): ProviderModelCatalog {
    return this.modelCatalog;
  }

  /** Returns the number of non-expired Antigravity route states. */
  sessionStateSize(): number {
    return this.sessionStates.size;
  }

  /** Returns bounded state metadata for focused integration tests. */
  inspectSessionStates(): readonly RouteSessionStateInspection<AntigravitySessionState>[] {
    return this.sessionStates.inspect();
  }

  /** Refreshes the live model catalog for one OAuth credential without dispatching a generation request. */
  async refreshCatalog(credentialValue: string, signal: AbortSignal = new AbortController().signal): Promise<void> {
    const credential = parseAntigravityCredential(credentialValue);
    if (credential !== null) await this.refreshDiscovery(credential, signal, true);
  }

  /** Resets one conversation/model state, or all model states for a conversation. */
  resetSession(conversationId: string, upstreamModelId?: string): number {
    if (upstreamModelId !== undefined) return this.sessionStates.reset(sessionStateKey(conversationId, this.metadata.id, upstreamModelId));
    return this.sessionStates.reset((entry) => entry.key.startsWith(sessionStateRoutePrefix(conversationId)));
  }

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    const entry = this.models.get(modelId);
    if (entry !== null && !entry.capabilities.surfaces.includes(surface)) {
      throw new UpstreamError({ kind: "capability_unsupported", message: `Model "${modelId}" does not support surface "${surface}"`, statusCode: 400, routeScope: "provider" });
    }
    return { providerId: this.metadata.id, modelId, surface, upstreamModelId: entry?.upstreamId ?? modelId };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.providerId !== this.metadata.id) {
      throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support the requested model surface`, statusCode: 400, routeScope: null });
    }
    const credential = parseAntigravityCredential(input.credential);
    if (credential === null) {
      throw new UpstreamError({ kind: "authentication_failed", message: "Antigravity requires an OAuth credential with its Cloud Code project id.", statusCode: 401, routeScope: "account" });
    }
    const entry = this.models.get(input.target.modelId);
    const upstreamModelId = entry?.upstreamId ?? input.target.modelId;
    const conversationId = input.headers?.get("x-conversation-id") ?? `${credential.projectId}:${input.target.modelId}`;
    const routeIdentity = sessionRouteIdentity(input, credential.projectId);
    const routePrefix = sessionStateRoutePrefix(routeIdentity);
    const stateKey = sessionStateKey(routeIdentity, this.metadata.id, upstreamModelId);
    this.sessionStates.reset((entry) => entry.key.startsWith(routePrefix) && entry.key !== stateKey);
    const state = this.sessionStates.create(stateKey, () => ({}));
    if (state.lastGoodEndpoint === undefined && this.discoveryEndpoint !== null) {
      state.lastGoodEndpoint = this.discoveryEndpoint;
    }
    const payload = buildAntigravityRequest(input.request, credential, upstreamModelId, conversationId, state);
    void ensureAntigravityVersion(this.versionFetcher, input.signal);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${credential.accessToken}`,
      "user-agent": getAntigravityUserAgent(),
    };
    try {
      const endpoints = [...new Set([
        state.lastGoodEndpoint,
        ANTIGRAVITY_PRODUCTION_ENDPOINT,
        ANTIGRAVITY_DAILY_ENDPOINT,
        ANTIGRAVITY_SANDBOX_ENDPOINT,
      ].filter((endpoint): endpoint is string => endpoint !== undefined))];
      const attempt = async (endpoint: string): Promise<ProviderOutput> => {
        const output = await this.roundTrip(input, endpoint, payload, headers, state, stateKey);
        state.lastGoodEndpoint = endpoint;
        return output;
      };
      for (const [index, endpoint] of endpoints.entries()) {
        try {
          return await attempt(endpoint);
        } catch (error) {
          const statusCode = error instanceof UpstreamError ? error.statusCode ?? 0 : 0;
          const canTryNext = statusCode === 404 || statusCode === 429 || statusCode >= 500;
          if (!canTryNext || index === endpoints.length - 1) throw error;
        }
      }
      throw new UpstreamError({ kind: "provider_unavailable", message: "Antigravity endpoints were exhausted.", routeScope: "provider" });
    } finally {
      this.sessionStates.touch(stateKey);
    }
  }

  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    const credential = parseAntigravityCredential(input.credential);
    if (credential === null) return null;
    const result = await fetchAntigravityDiscoveryModelsInternal({
      accessToken: credential.accessToken,
      fetcher: this.discoveryFetcher,
      signal: input.signal,
      userAgent: getAntigravityUserAgent(),
    });
    return result?.models ?? null;
  }

  private async refreshDiscovery(
    credential: AntigravityCredential,
    signal: AbortSignal,
    force: boolean = false,
  ): Promise<void> {
    const now = Date.now();
    if (this.discoveryCredential === credential.accessToken && now < this.discoveryExpiresAt) return;
    const canServeStale = this.discoveryCredential === credential.accessToken;
    if (this.discoveryInFlight !== null) {
      if (!force && canServeStale) return;
      return this.discoveryInFlight;
    }
    this.discoveryInFlight = (async () => {
      const stop = markOverhead("providers.discovery", { provider: this.metadata.id, stale: canServeStale });
      try {
        const result = await fetchAntigravityDiscoveryModelsInternal({
          accessToken: credential.accessToken,
          fetcher: this.discoveryFetcher,
          signal,
          userAgent: getAntigravityUserAgent(),
        });
        if (result !== null && result.models.length > 0) {
          this.modelCatalog = createModelCatalog(mergeProviderModels(ANTIGRAVITY_MODELS, [result.models]));
          this.discoveryEndpoint = result.endpoint;
        }
        this.discoveryCredential = credential.accessToken;
        this.discoveryExpiresAt = Date.now() + this.discoveryTtlMs;
      } finally {
        stop();
      }
    })().finally(() => {
      this.discoveryInFlight = null;
    });
    if (!force && canServeStale) {
      void this.discoveryInFlight.catch(() => {});
      return;
    }
    return this.discoveryInFlight;
  }

  private async roundTrip(input: ProviderRequest, endpoint: string, payload: Record<string, unknown>, headers: Record<string, string>, state: AntigravitySessionState, stateKey: string): Promise<ProviderOutput> {
    const { request, signal, network } = input;
    const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, firstByteTimeoutMs: request.limits.firstByteTimeoutMs, idleTimeoutMs: request.limits.idleTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
    let streamHandedOff = false;
    try {
      const response = await executeFetch(`${endpoint}/${ANTIGRAVITY_ACTION}`, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, network, input.capture);
      if (!response.ok) throw await parseUpstreamFailure(response);
      if (!response.body) throw new UpstreamError({ kind: "provider_protocol_error", message: "Antigravity returned an empty stream body", routeScope: "provider" });
      const mapper = transformGeminiGenerateContentStream(input.target.providerId);
      const events = mapSseStream(
        { body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs },
        (sse) => mapper(normalizeAntigravityFrame(sse)),
      );
      if (!request.stream) {
        const folded = await foldAntigravityStream(events, request.model);
        if (typeof folded.body.responseId === "string") state.lastExecutionId = folded.body.responseId;
        const body = translateGeminiResponse(folded.body, "openai-chat", request.model);
        return { mode: "non_stream", body, usage: folded.usage ?? undefined };
      }
      streamHandedOff = true;
      const sessionStates = this.sessionStates;
      const statefulEvents = (async function* (): AsyncIterable<StreamEvent> {
        try {
          for await (const event of events) {
            if (event.type === "message_start" && event.id) state.lastExecutionId = event.id;
            yield event;
          }
        } finally {
          sessionStates.touch(stateKey);
        }
      })() as unknown as AsyncIterable<ExtendedStreamEvent>;
      return { mode: "stream", events: statefulEvents as unknown as AsyncIterable<StreamEvent> };
    } finally {
      if (!streamHandedOff) coordinator.dispose();
    }
  }
  mapError(error: unknown): InternalFailure {
    return internalFailureFromUnknown(error);
  }
}

/**
 * Convenience instance for non-registry wiring (console probes, tests).
 * The default registry constructs its own instance.
 */
export const antigravityAdapter = new AntigravityAdapter();