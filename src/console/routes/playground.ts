import type { Elysia } from "elysia";
import { errorResponse, jsonResponse } from "../../api/errors.js";
import { internalFailureFromUnknown } from "../../proxy/errors.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ProviderCaps } from "../../proxy/types/provider.js";
import type { StreamEvent } from "../../proxy/types/stream.js";
import type { ProxyRequestPort } from "../../api/v1.js";
import type { RouteSnapshot } from "../../persistence/types.js";
import { createRelaySecretService } from "../../relay/secret.js";
import type { ConsoleDependencies } from "../api.js";

type ReasoningEffort = "none" | "low" | "medium" | "high";

interface PlaygroundMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface PlaygroundRequest {
  readonly model: string;
  readonly messages: readonly PlaygroundMessage[];
  readonly maxTokens: number;
  readonly reasoningEffort: ReasoningEffort;
  readonly stream: true;
}

type ParseResult = { readonly ok: true; readonly value: PlaygroundRequest } | { readonly ok: false; readonly code: "invalid_request"; readonly message: string };

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function failure(message: string): ParseResult {
  return { ok: false, code: "invalid_request", message };
}

export function parsePlaygroundRequest(value: unknown): ParseResult {
  const body = recordOf(value);
  if (body === null) return failure("request body must be an object");
  const keys = ["model", "messages", "maxTokens", "reasoningEffort", "stream"];
  if (Object.keys(body).some((key) => !keys.includes(key)) || keys.some((key) => !(key in body))) return failure("request body has an invalid shape");
  if (typeof body.model !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(body.model.trim()) || body.model.length > 512) return failure("model must be a qualified provider/model id");
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 100) return failure("messages must contain 1 to 100 messages");
  const messages: PlaygroundMessage[] = [];
  for (const item of body.messages) {
    const message = recordOf(item);
    if (message === null || Object.keys(message).some((key) => key !== "role" && key !== "content") || !["system", "user", "assistant"].includes(String(message.role)) || typeof message.content !== "string" || message.content.length > 200_000) return failure("each message must have a valid role and string content");
    messages.push({ role: message.role as PlaygroundMessage["role"], content: message.content });
  }
  if (typeof body.maxTokens !== "number" || !Number.isInteger(body.maxTokens) || body.maxTokens < 1 || body.maxTokens > 32_768) return failure("maxTokens must be an integer from 1 to 32768");
  if (!["none", "low", "medium", "high"].includes(String(body.reasoningEffort))) return failure("reasoningEffort is invalid");
  if (body.stream !== true) return failure("stream must be true");
  return { ok: true, value: { model: body.model.trim(), messages, maxTokens: body.maxTokens, reasoningEffort: body.reasoningEffort as ReasoningEffort, stream: true } };
}

export interface PlaygroundModelEntry {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly status: "active" | "inactive";
  readonly reason: string | null;
  readonly capabilities: ProviderCaps | null;
  readonly routingHealth: {
    readonly accountCount: number;
    readonly healthyAccountCount: number;
    readonly accounts: readonly { readonly id: string; readonly healthy: boolean; readonly enabled: boolean; readonly status: string | null; readonly retryAt: string | null; readonly quotaAvailable: boolean; readonly modelLockCount: number }[];
  };
}

function modelId(provider: string, model: string): string {
  return model.includes("/") ? model : `${provider}/${model}`;
}

function catalogEntry(provider: string, modelIdValue: string, displayName: string, capabilities: ProviderCaps | null, enabled: boolean, snapshot: RouteSnapshot, credentialKind: string): PlaygroundModelEntry {
  const accounts = snapshot.accounts.filter((account) => account.providerId === provider);
  const healthyAccountCount = accounts.filter((account) => account.healthy && account.enabled).length;
  const active = enabled && (credentialKind === "none" || healthyAccountCount > 0);
  const reason = !enabled ? "Model is disabled in provider_models" : active ? null : "No healthy enabled account is available";
  return {
    id: modelId(provider, modelIdValue),
    provider,
    displayName,
    status: active ? "active" : "inactive",
    reason,
    capabilities,
    routingHealth: {
      accountCount: accounts.length,
      healthyAccountCount,
      accounts: accounts.map((account) => ({
        id: account.accountId,
        healthy: account.healthy,
        enabled: account.enabled,
        status: account.health?.status ?? (account.healthy ? "healthy" : "unavailable"),
        retryAt: account.health?.retryAt ?? null,
        quotaAvailable: account.quotaAvailable ?? true,
        modelLockCount: account.modelLocks?.size ?? 0,
      })),
    },
  };
}

export function buildPlaygroundCatalog(snapshot: RouteSnapshot, registry: ProviderRegistry): readonly PlaygroundModelEntry[] {
  const rows = new Map(snapshot.models.map((model) => [`${model.providerId}/${model.modelId}`, model]));
  const entries: PlaygroundModelEntry[] = [];
  const seen = new Set<string>();
  for (const adapter of registry.list()) {
    for (const model of adapter.models.list) {
      const key = `${adapter.metadata.id}/${model.id}`;
      const row = rows.get(key);
      const id = modelId(adapter.metadata.id, model.id);
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push(catalogEntry(adapter.metadata.id, model.id, model.displayName, model.capabilities, row?.enabled ?? true, snapshot, adapter.metadata.credentialKind));
    }
  }
  for (const row of rows.values()) {
    if (seen.has(modelId(row.providerId, row.modelId))) continue;
    const adapter = registry.get(row.providerId);
    entries.push(catalogEntry(row.providerId, row.modelId, row.displayName ?? row.modelId, adapter?.models.get(row.modelId)?.capabilities ?? null, row.enabled, snapshot, adapter?.metadata.credentialKind ?? "api_key"));
  }
  return Object.freeze(entries.sort((left, right) => left.id.localeCompare(right.id)));
}

function sseEvent(name: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function safeUsage(value: unknown): Record<string, number | string | null> | null {
  const usage = recordOf(value);
  if (usage === null) return null;
  const result: Record<string, number | string | null> = {};
  for (const key of ["promptTokens", "completionTokens", "totalTokens", "cachedTokens", "reasoningTokens", "inputTokens", "outputTokens", "source"]) {
    const item = usage[key];
    if (typeof item === "number" || typeof item === "string" || item === null) result[key] = item;
  }
  return result;
}

function jsonText(value: Record<string, unknown>): string {
  const choices = Array.isArray(value.choices) ? value.choices : [];
  return choices.map((choice) => {
    const message = recordOf(recordOf(choice)?.message);
    return typeof message?.content === "string" ? message.content : "";
  }).join("");
}

async function streamEvents(
  proxy: ProxyRequestPort,
  input: PlaygroundRequest,
  request: Request,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  const abort = (): void => controller.abort(request.signal.reason);
  request.signal.addEventListener("abort", abort, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const emit = (name: string, data: unknown): void => streamController.enqueue(sseEvent(name, data));
      try {
        const result = await proxy.handle({
          endpoint: "/v1/chat/completions",
          surface: "openai-chat",
          body: {
            model: input.model,
            messages: input.messages,
            max_tokens: input.maxTokens,
            stream: true,
            reasoning: input.reasoningEffort === "none" ? { enabled: false } : { effort: input.reasoningEffort },
          },
          estimatedInputTokens: Math.max(1, Math.ceil(JSON.stringify(input.messages).length / 4)),
          headers: new Headers({ "x-client-name": "opencode", "x-request-id": requestId }),
          signal: controller.signal,
          requestId,
          clientIp: null,
          apiKeyId: "console-playground",
        });
        emit("meta", { requestId, model: input.model });
        if (result.body.mode === "json") {
          const value = result.body.value;
          const hasError = "error" in value;
          const error = hasError ? recordOf(value.error) : null;
          const usage = safeUsage("usage" in value ? value.usage : undefined);
          const text = hasError ? "" : jsonText(value);
          if (text.length > 0) emit("text", { text });
          if (usage !== null) emit("usage", usage);
          if (hasError) emit("error", { code: typeof error?.code === "string" ? error.code : "provider_error", message: typeof error?.message === "string" ? error.message : "Upstream provider request failed." });
          emit("done", { reason: hasError ? "error" : "completed" });
          return;
        }
        let usage: Record<string, number | string | null> | null = null;
        for await (const event of result.body.events as AsyncIterable<StreamEvent>) {
          if (event.type === "text_delta") emit("text", { text: event.text });
          else if (event.type === "thinking_delta") emit("reasoning", { text: event.text });
          else if (event.type === "tool_call_start") emit("tool", { callId: event.callId, name: event.name });
          else if (event.type === "usage") usage = safeUsage(event.usage) ?? usage;
          else if (event.type === "message_stop") {
            if (event.error !== undefined) emit("error", { code: event.error.kind, message: event.error.safeMessage ?? "Upstream provider request failed." });
            if (usage !== null) emit("usage", usage);
            emit("done", { reason: event.reason });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const failure = internalFailureFromUnknown(error);
          emit("error", { code: failure.kind, message: failure.safeMessage ?? "Upstream provider request failed." });
          emit("done", { reason: "error" });
        }
      } finally {
        request.signal.removeEventListener("abort", abort);
        streamController.close();
      }
    },
    cancel() {
      controller.abort(request.signal.reason);
      request.signal.removeEventListener("abort", abort);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      "x-request-id": requestId,
      "x-accel-buffering": "no",
    },
  });
}

export function registerPlaygroundRoutes(app: Elysia, deps: ConsoleDependencies): void {
  const router = app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown; post: (path: string, handler: (ctx: unknown) => unknown) => unknown };
  router.get("/console/api/playground/catalog", async () => {
    if (deps.routeRepositories === undefined || deps.registry === undefined) return errorResponse(501, "capability_unsupported", "Playground catalog is not configured");
    const snapshot = await deps.routeRepositories.getRouteSnapshot();
    return jsonResponse({ items: buildPlaygroundCatalog(snapshot, deps.registry), generatedAt: new Date().toISOString() });
  });
  router.post("/console/api/playground/stream", async (context) => {
    const { request, body } = context as { request: Request; body: unknown };
    const parsed = parsePlaygroundRequest(body);
    if (!parsed.ok) return errorResponse(400, parsed.code, parsed.message);
    if (deps.proxy === undefined) return errorResponse(501, "capability_unsupported", "Playground proxy is not configured");
    return streamEvents(deps.proxy, parsed.value, request);
  });
  const relay = deps.pool === undefined ? null : createRelaySecretService(deps.pool);
  router.get("/console/api/playground/relay-secret", async () => {
    if (relay === null) return errorResponse(501, "capability_unsupported", "Relay secret storage is not configured");
    return jsonResponse({ ...(await relay.get()), deploymentGuidance: "Vercel platform access tokens are deployment-only and cannot be entered in the dashboard. Configure the relay secret here; configure platform tokens in the Vercel deployment environment." });
  });
  router.post("/console/api/playground/relay-secret", async (context) => {
    if (relay === null) return errorResponse(501, "capability_unsupported", "Relay secret storage is not configured");
    const { body } = context as { body: unknown };
    const result = await relay.update(body);
    if (!result.ok) return errorResponse(result.status, "invalid_request", result.message ?? "Invalid relay secret");
    return jsonResponse(result.data);
  });
}
