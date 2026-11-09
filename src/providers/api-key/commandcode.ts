import { ApiKeyProviderBase } from "./base.js";
import { aggregateCapabilities, capabilitiesOf, createModelCatalog, modelOf } from "../../proxy/types/provider.js";
import type { ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import type { Surface } from "../../proxy/types/surface.js";
import type { ProviderCaps, ProviderModel } from "../../proxy/types/provider.js";
import type { StreamEvent, StopReason } from "../../proxy/types/stream.js";
import type { NormalizedMessage, ContentPart } from "../../proxy/types/content.js";
import { messageText } from "../../proxy/protocol-request.js";

import { AbortCoordinator } from "../../proxy/transport/abort.js";
import { executeFetch } from "../../proxy/transport/fetch.js";
import { readJsonObject } from "../../proxy/transport/fetch.js"
import { UpstreamError, parseUpstreamFailure } from "../../proxy/transport/errors.js";
import { createInternalFailure } from "../../proxy/errors.js";

const SURFACES: readonly Surface[] = ["openai-chat"];
const URL = "https://api.commandcode.ai/alpha/generate";
const VERSION = "1.4.4";
const DEFAULT_MAX_TOKENS = 4096;
const FALLBACK_CAPS: ProviderCaps = capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true });
const MODELS: readonly ProviderModel[] = [
  modelOf("moonshotai/Kimi-K2.6", "Kimi K2.6", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
  modelOf("qwen/qwen3.5-plus", "Qwen 3.5 Plus", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
  modelOf("minimax/minimax-m2.7-highspeed", "MiniMax M2.7", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
  modelOf("z-ai/glm-5.1", "GLM 5.1", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
  modelOf("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
  modelOf("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
  modelOf("moonshotai/Kimi-K3", "Kimi K3", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
  modelOf("moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
  modelOf("zai-org/GLM-5.2", "GLM 5.2", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
  modelOf("zai-org/GLM-5.2-Fast", "GLM 5.2 Fast", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
  modelOf("MiniMaxAI/MiniMax-M3", "MiniMax M3", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
  modelOf("Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
  modelOf("Qwen/Qwen3.7-Max", "Qwen 3.7 Max", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
  modelOf("xiaomi/mimo-v2.5-pro", "Xiaomi MiMo v2.5 Pro", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
  modelOf("poolside/laguna-s-2.1-free", "Poolside Laguna S 2.1 Free", capabilitiesOf({ surfaces: SURFACES, reasoning: true })),
  modelOf("nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra", capabilitiesOf({ surfaces: SURFACES, reasoning: true, images: true })),
];

function convertMessages(messages: readonly NormalizedMessage[]): { messages: Array<Record<string, unknown>>; system?: string } {
  const out: Array<Record<string, unknown>> = [];
  let system: string | undefined;
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = messageText(message);
      if (text) system = system ? `${system}\n${text}` : text;
      continue;
    }
    if (message.role === "tool") {
      // OpenAI upstream: one message per tool_result block with role "tool"
      for (const block of message.content) {
        if (block.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: block.toolCallId, content: block.text ?? "" });
        }
      }
      continue;
    }
    if (message.role === "assistant") {
      const text = messageText(message);
      const toolCalls = message.content
        .filter((b): b is Extract<ContentPart, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({ id: b.toolCallId, type: "function", function: { name: b.toolName, arguments: b.toolArguments } }));
      const msg: Record<string, unknown> = { role: "assistant" };
      msg.content = text.length > 0 ? text : toolCalls.length > 0 ? null : "";
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }
    // user message
    out.push({ role: "user", content: messageText(message) });
  }
  return { messages: out, system };
}
function buildRequest(modelId: string, request: { messages: readonly NormalizedMessage[]; tools: readonly { readonly name: string; readonly description: string | null; readonly inputSchema: Record<string, unknown> }[]; maxOutputTokens: number | null }, threadId: string): Record<string, unknown> {
  const { messages, system } = convertMessages(request.messages);
  const params: Record<string, unknown> = { model: modelId, messages, stream: true, max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS, temperature: 0.3 };
  if (system) params.system = system;
  if (request.tools.length > 0) params.tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description ?? undefined, input_schema: tool.inputSchema }));
  return { threadId, memory: "", config: { workingDir: "", date: new Date().toISOString().slice(0, 10), environment: "", structure: [], isGitRepo: false, currentBranch: "", mainBranch: "", gitStatus: "", recentCommits: [] }, params };
}
function headers(sessionId: string, token: string): Record<string, string> {
  return { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${token}`, "x-command-code-version": VERSION, "x-cli-environment": "cli", "x-session-id": sessionId };
}
type StreamState = { toolIndexById: Map<string, number>; nextToolIndex: number; finishReason: string | undefined; usage: Record<string, unknown> | undefined; };
function ccEventString(event: Record<string, unknown>, key: string): string | undefined { const v = event[key]; return typeof v === "string" ? v : undefined; }
function ccEventNumber(record: Record<string, unknown>, key: string): number | undefined { const v = record[key]; return typeof v === "number" && Number.isFinite(v) ? v : undefined; }
export function ccMapFinishReason(reason: string): StopReason { return reason === "length" ? "length" : reason === "tool_calls" ? "tool_call" : reason === "content_filter" ? "content_filter" : "completed"; }
export function transformLine(line: string, state: StreamState): StreamEvent[] {
  let event: Record<string, unknown>; try { event = JSON.parse(line) as Record<string, unknown>; } catch { return []; } const type = ccEventString(event, "type"); if (!type) return [];
  if (type === "text-delta" || type === "reasoning-delta") { const text = ccEventString(event, "text") || ccEventString(event, "delta"); return text ? [{ type: "text_delta", text }] : []; }
  if (type === "tool-input-start") { const id = ccEventString(event, "id") || ccEventString(event, "toolCallId"); if (!id || state.toolIndexById.has(id)) return []; state.toolIndexById.set(id, state.nextToolIndex++); return [{ type: "tool_call_start", callId: id, name: ccEventString(event, "toolName") ?? "" }]; }
  if (type === "tool-input-delta") { const id = ccEventString(event, "id") || ccEventString(event, "toolCallId"); const delta = ccEventString(event, "delta") || ccEventString(event, "inputTextDelta"); if (!id || !delta || !state.toolIndexById.has(id)) return []; return [{ type: "tool_call_delta", callId: id, delta }]; }
  if (type === "tool-call") { const id = ccEventString(event, "toolCallId"); if (!id || state.toolIndexById.has(id)) return []; state.toolIndexById.set(id, state.nextToolIndex++); const input = typeof event.input === "string" ? event.input : JSON.stringify(event.input ?? {}); return [{ type: "tool_call_start", callId: id, name: ccEventString(event, "toolName") ?? "" }, { type: "tool_call_delta", callId: id, delta: input }]; }
  if (type === "finish-step") { const reason = ccEventString(event, "finishReason"); if (reason) state.finishReason = reason; if (typeof event.usage === "object" && event.usage !== null && !Array.isArray(event.usage)) state.usage = event.usage as Record<string, unknown>; return []; }
  if (type === "finish") {
    const events: StreamEvent[] = [{ type: "message_stop", reason: ccMapFinishReason(state.finishReason ?? ccEventString(event, "finishReason") ?? "stop") }];
    if (state.usage) { const prompt = ccEventNumber(state.usage, "promptTokens") ?? ccEventNumber(state.usage, "inputTokens") ?? 0; const completion = ccEventNumber(state.usage, "completionTokens") ?? ccEventNumber(state.usage, "outputTokens") ?? 0; const total = ccEventNumber(state.usage, "totalTokens") ?? prompt + completion; const cached = ccEventNumber(state.usage, "cachedTokens") ?? ccEventNumber(state.usage, "cacheReadTokens") ?? 0; events.push({ type: "usage", usage: { promptTokens: prompt, completionTokens: completion, totalTokens: total, cachedTokens: cached, inputTokens: prompt, outputTokens: completion, cacheReadTokens: cached || null, cacheWriteTokens: ccEventNumber(state.usage, "cacheWriteTokens") ?? null, source: "provider" } }); }
    return events;
  }
  if (type === "error") {
    const raw = (event.error ?? event.message ?? event) as unknown;
    const providerCode = typeof (event as Record<string, unknown>).code === "string" ? ((event as Record<string, unknown>).code as string) : null;
    const providerType = typeof (event as Record<string, unknown>).type === "string" ? ((event as Record<string, unknown>).type as string) : null;
    const rawMessage = typeof raw === "string" ? raw : JSON.stringify(raw);
    throw createInternalFailure({ kind: "provider_protocol_error", safeMessage: rawMessage, statusCode: 200, retryable: false, routeScope: null, failureCode: null, upstream: { providerId: "commandcode", transport: "ndjson", statusCode: 200, providerCode, providerType, requestId: null, retryAfterMs: null, bodyTruncated: false } });
  }
  return [];
}
/** NDJSON transform — beta-style simple loop + signal-aware read for abort/timeout propagation. */
export async function* transformNdjson(body: ReadableStream<Uint8Array>, coordinator: AbortCoordinator): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: StreamState = { toolIndexById: new Map(), nextToolIndex: 0, finishReason: undefined, usage: undefined };
  let buffer = "";
  let hasTerminal = false;
  const signal = coordinator.signal;
  const readWithAbort = (): Promise<{ done: boolean; value?: Uint8Array }> => {
    if (signal.aborted) throw new UpstreamError({ kind: "client_aborted", message: "Command Code stream aborted", routeScope: null });
    const { promise, resolve, reject } = Promise.withResolvers<{ done: boolean; value?: Uint8Array }>();
    const onAbort = (): void => {
      const cause = coordinator.causeOf();
      if (cause === "stream_limit") reject(new UpstreamError({ kind: "provider_protocol_error", message: "Command Code stream exceeded the configured byte limit", routeScope: "provider" }));
      else reject(new UpstreamError({ kind: cause === "first_body_timeout" || cause === "idle_timeout" || cause === "total_timeout" ? "stream_timeout" : "client_aborted", message: "Command Code stream aborted", retryable: cause?.includes("timeout") === true, routeScope: null }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    return promise;
  };
  try {
    while (true) {
      const { done, value } = await readWithAbort();
      if (done) break;
      coordinator.markBodyByteReceived?.();
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) for (const ev of transformLine(line, state)) { if (ev.type === "message_stop") hasTerminal = true; yield ev; }
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) for (const ev of transformLine(tail, state)) { if (ev.type === "message_stop") hasTerminal = true; yield ev; }
    // Beta behavior: always yield terminal if upstream omitted finish — avoids stream_truncated / JSON parse error on non_stream probes
    if (!hasTerminal) yield { type: "message_stop", reason: ccMapFinishReason(state.finishReason ?? "stop") };
  } finally {
    try { reader.releaseLock?.(); } catch {}
    void reader.cancel().catch(() => {});
  }
}

/** CommandCode — owns catalog + upstream. */
export class CommandCodeProvider extends ApiKeyProviderBase {
  constructor() {
    const caps = { ...aggregateCapabilities(MODELS, FALLBACK_CAPS), streaming: true } as ProviderCaps;
    super({ metadata: { id: "commandcode", displayName: "Command Code", protocol: "openai", credentialKind: "api_key" }, capabilities: caps, models: MODELS });
  }
  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.surface !== "openai-chat") throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "commandcode" only supports the OpenAI Chat surface`, statusCode: 400, routeScope: null });
    if (input.credential.length === 0) throw new UpstreamError({ kind: "authentication_failed", message: "A Command Code bearer API key is required.", statusCode: 401, routeScope: "account" });
    const { request, signal, network } = input;
    const tools = request.tools.filter((tool): tool is import("../../proxy/types/content.js").NormalizedFunctionTool => tool.kind === "function");
    if (tools.length !== request.tools.length) {
      throw new UpstreamError({ kind: "capability_unsupported", message: "Command Code supports function tools only", statusCode: 400, routeScope: "provider" });
    }
    const sessionId = crypto.randomUUID();
    const upstreamModelId = input.target.upstreamModelId ?? input.target.modelId;
    const payload = buildRequest(upstreamModelId, { messages: request.messages, tools, maxOutputTokens: request.maxOutputTokens }, sessionId);
    const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, firstByteTimeoutMs: request.limits.firstByteTimeoutMs, idleTimeoutMs: request.limits.idleTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
    let handedOff = false;
    try {
      const response = await executeFetch(URL, { method: "POST", headers: headers(sessionId, input.credential), body: JSON.stringify(payload) }, coordinator, network, input.capture);
      if (!response.ok) throw await parseUpstreamFailure(response);
      if (!request.stream) {
        // Command Code streams NDJSON even for non_stream probes — collect stream to synthetic body to avoid JSON parse error
        if (response.body) {
          let text = "";
          for await (const ev of transformNdjson(response.body, coordinator)) {
            if (ev.type === "text_delta") text += ev.text;
          }
          return { mode: "non_stream", body: { id: `cc-${sessionId}`, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], model: upstreamModelId } as unknown as Record<string, unknown> };
        }
        const body = await readJsonObject(response, coordinator); return { mode: "non_stream", body: body as Record<string, unknown> };
      }
      if (!response.body) throw new UpstreamError({ kind: "provider_protocol_error", message: "Command Code returned an empty stream body", routeScope: "provider" });
      handedOff = true; return { mode: "stream", events: transformNdjson(response.body, coordinator) };
    } finally { if (!handedOff) coordinator.dispose(); }
  }
}
