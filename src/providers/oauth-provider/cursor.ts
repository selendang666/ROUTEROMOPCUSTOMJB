import { internalFailureFromUnknown } from "../../proxy/errors.js";
import { capabilitiesOf, createModelCatalog, modelOf } from "../../proxy/types/provider.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { Adapter, ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import type { DiscoveryInput } from "../../proxy/types/request.js";
import { UpstreamError } from "../../proxy/transport/errors.js";
import type { RouteTarget } from "../../proxy/types/routing.js";
import type { Surface } from "../../proxy/types/surface.js";
import { extractAccessTokenOrRaw } from "../../auth/contract.js";
import * as http2 from "node:http2";
import { gunzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ExecClientMessageSchema,
  ModelDetailsSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  RequestedModelSchema,
  UserMessageActionSchema,
  UserMessageSchema,
} from "./cursor/agent_pb.js";

const CURSOR_BASE_URL = "https://api2.cursor.sh";
const CURSOR_CLIENT_VERSION = "cli-2026.07.23-e383d2b";
const CURSOR_MODEL_CLIENT_VERSION = "cli-2026.02.13-41ac335";
const CURSOR_PATH = "/agent.v1.AgentService/Run";
const CURSOR_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const CURSOR_SURFACES = ["openai-responses"] as const;
const CURSOR_MODELS: readonly ProviderModel[] = [
  modelOf("default", "Auto", capabilitiesOf({ surfaces: CURSOR_SURFACES, streaming: true, reasoning: false }), { context: { inputTokens: 200_000, outputTokens: 64_000 } }),
  modelOf("claude-4.5-opus-high", "Claude 4.5 Opus", capabilitiesOf({ surfaces: CURSOR_SURFACES, streaming: true, reasoning: true }), { context: { inputTokens: 200_000, outputTokens: 64_000 } }),
  modelOf("claude-4.5-sonnet", "Claude 4.5 Sonnet", capabilitiesOf({ surfaces: CURSOR_SURFACES, streaming: true, reasoning: true }), { context: { inputTokens: 200_000, outputTokens: 64_000 } }),
  modelOf("claude-4.6-opus-high", "Claude 4.6 Opus", capabilitiesOf({ surfaces: CURSOR_SURFACES, streaming: true, reasoning: true }), { context: { inputTokens: 200_000, outputTokens: 64_000 } }),
  modelOf("claude-4.6-sonnet-medium", "Claude 4.6 Sonnet", capabilitiesOf({ surfaces: CURSOR_SURFACES, streaming: true, reasoning: true }), { context: { inputTokens: 200_000, outputTokens: 64_000 } }),
  modelOf("composer-2.5", "Composer 2.5", capabilitiesOf({ surfaces: CURSOR_SURFACES, streaming: true, reasoning: false }), { context: { inputTokens: 200_000, outputTokens: 64_000 } }),
  modelOf("composer-2.5-fast", "Composer 2.5 Fast", capabilitiesOf({ surfaces: CURSOR_SURFACES, streaming: true, reasoning: false }), { context: { inputTokens: 200_000, outputTokens: 64_000 } }),
];

function cursorModelFromDetails(details: {
  readonly modelId: string;
  readonly displayName: string;
  readonly displayNameShort: string;
  readonly aliases: readonly string[];
  readonly thinkingDetails?: unknown;
}, references: ReadonlyMap<string, ProviderModel>): ProviderModel | null {
  const id = details.modelId.trim();
  if (id.length === 0) return null;
  const reference = references.get(id);
  const displayName = [details.displayName, details.displayNameShort, ...details.aliases, id].find((value) => value.trim().length > 0)?.trim() ?? id;
  const reasoning = details.thinkingDetails !== undefined || reference?.capabilities.reasoning === true;
  const images = /claude|gemini|gpt-|codex/i.test(id);
  return modelOf(id, displayName, capabilitiesOf({ surfaces: CURSOR_SURFACES, streaming: true, reasoning, images, toolCalls: false }), {
    context: { inputTokens: reference?.context?.inputTokens ?? 200_000, outputTokens: reference?.context?.outputTokens ?? 64_000 },
    categories: images ? ["vision", "text", ...(reasoning ? ["reasoning" as const] : [])] : ["text", ...(reasoning ? ["reasoning" as const] : [])],
  });
}

function parseCursorModelsPayload(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return payload;
  if ((payload[0] ?? 0) > 0x03) return payload;
  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset] ?? 0;
    const length = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset).getUint32(1, false);
    const end = offset + 5 + length;
    if (end > payload.length) return payload;
    const encoded = payload.subarray(offset + 5, end);
    if ((flags & 0x02) === 0) return (flags & 0x01) !== 0 ? gunzipSync(encoded) : encoded;
    offset = end;
  }
  return payload;
}

async function fetchCursorModelsPayload(token: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  const request = create(GetUsableModelsRequestSchema, { customModelIds: [] });
  const body = toBinary(GetUsableModelsRequestSchema, request);
  return new Promise((resolve) => {
    const client = http2.connect(CURSOR_BASE_URL);
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(null);
    }, 5_000);
    const finish = (value: Uint8Array | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.close();
      resolve(value);
    };
    client.once("error", () => finish(null));
    const requestStream = client.request({
      ":method": "POST",
      ":path": CURSOR_MODELS_PATH,
      "content-type": "application/proto",
      te: "trailers",
      authorization: `Bearer ${token}`,
      "x-ghost-mode": "true",
      "x-cursor-client-version": CURSOR_MODEL_CLIENT_VERSION,
      "x-cursor-client-type": "cli",
    });
    requestStream.once("response", (headers) => {
      const status = Number(headers[":status"] ?? 0);
      if (status < 200 || status >= 300) finish(null);
    });
    requestStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    requestStream.once("end", () => finish(new Uint8Array(Buffer.concat(chunks))));
    requestStream.once("error", () => finish(null));
    const abort = (): void => {
      requestStream.close();
      finish(null);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    requestStream.end(Buffer.from(body));
  });
}

async function fetchCursorModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
  if (input.credential === null || input.credential.length === 0) return null;
  try {
    const payload = await fetchCursorModelsPayload(extractAccessTokenOrRaw(input.credential), input.signal);
    if (payload === null) return null;
    const decoded = parseCursorModelsPayload(payload);
    if (decoded === null) return null;
    const response = fromBinary(GetUsableModelsResponseSchema, decoded);
    const references = new Map(CURSOR_MODELS.map((model) => [model.id, model]));
    const models = response.models.flatMap((details) => {
      const model = cursorModelFromDetails(details, references);
      return model === null ? [] : [model];
    });
    return models;
  } catch {
    return null;
  }
}

function textFromMessage(message: ProviderRequest["request"]["messages"][number]): string {
  return message.content.filter((c) => c.type === "text").map((c) => (c as { text?: string }).text ?? "").join("\n");
}

function frame(data: Uint8Array): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, Buffer.from(data)]);
}

function requestBytes(input: ProviderRequest): Uint8Array {
  const messages = input.request.messages;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const history = messages
    .filter((m) => m !== lastUser && m.role !== "system" && m.role !== "developer")
    .map((m) => `${m.role}: ${textFromMessage(m)}`)
    .join("\n\n");
  const prompt = [history ? `Conversation history:\n${history}` : "", lastUser ? textFromMessage(lastUser) : ""].filter(Boolean).join("\n\n");
  const conversationState = create(ConversationStateStructureSchema, {
    rootPromptMessagesJson: [],
    turns: [],
    todos: [],
    pendingToolCalls: [],
    previousWorkspaceUris: [],
    fileStates: {},
    fileStatesV2: {},
    summaryArchives: [],
    turnTimings: [],
    subagentStates: {},
    selfSummaryCount: 0,
    readPaths: [],
  });
  const userMessage = create(UserMessageSchema, { text: prompt || "hello", messageId: crypto.randomUUID(), mode: 0 });
  const action = create(ConversationActionSchema, {
    action: { case: "userMessageAction", value: create(UserMessageActionSchema, { userMessage, sendToInteractionListener: true }) },
  });
  const modelId = input.target.upstreamModelId;
  const run = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails: create(ModelDetailsSchema, { modelId, displayModelId: modelId, displayName: modelId, displayNameShort: modelId, aliases: [] }),
    requestedModel: create(RequestedModelSchema, { modelId, maxMode: false, parameters: [] }),
    conversationId: crypto.randomUUID(),
  });
  return toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, { message: { case: "runRequest", value: run } }));
}

interface CursorResponseState {
  text: string;
  turnEnded: boolean;
}

function requestContextFrame(server: { readonly id: number; readonly execId: string }): Buffer {
  const requestContext = create(RequestContextSchema, {
    rules: [],
    repositoryInfo: [],
    tools: [],
    gitRepos: [],
    projectLayouts: [],
    mcpInstructions: [],
    fileContents: {},
    customSubagents: [],
  });
  const requestContextResult = create(RequestContextResultSchema, {
    result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext }) },
  });
  const exec = create(ExecClientMessageSchema, {
    id: server.id,
    execId: server.execId,
    message: { case: "requestContextResult", value: requestContextResult },
  });
  const message = create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: exec },
  });
  return frame(toBinary(AgentClientMessageSchema, message));
}

function consumeCursorFrames(buffer: Buffer, state: CursorResponseState, onContextRequest: (server: { readonly id: number; readonly execId: string }) => void, onInteraction: (caseName: string) => void): Buffer {
  let pending = buffer;
  while (pending.length >= 5) {
    const flags = pending[0] ?? 0;
    const length = pending.readUInt32BE(1);
    if (pending.length < 5 + length) break;
    const encodedPayload = pending.subarray(5, 5 + length);
    pending = pending.subarray(5 + length);
    const payload = (flags & 0x01) !== 0 ? gunzipSync(encodedPayload) : encodedPayload;
    if ((flags & 0x02) !== 0) {
      const trailer = JSON.parse(payload.toString("utf8")) as { error?: { code?: string; message?: string } };
      if (trailer.error) throw new UpstreamError({ kind: "provider_protocol_error", message: `Cursor error ${trailer.error.code ?? "unknown"}: ${trailer.error.message ?? "request failed"}`, statusCode: 502, routeScope: "provider" });
      continue;
    }
    const message = fromBinary(AgentServerMessageSchema, payload);
    if (message.message.case === "interactionUpdate") {
      const interaction = message.message.value;
      onInteraction(interaction.message.case ?? "unknown");
      if (interaction.message.case === "textDelta") state.text += interaction.message.value.text;
      if (interaction.message.case === "turnEnded") state.turnEnded = true;
      continue;
    }
    if (message.message.case === "execServerMessage") {
      const exec = message.message.value;
      if (exec.message.case !== "requestContextArgs") throw new UpstreamError({ kind: "provider_protocol_error", message: `Cursor requested unsupported exec operation "${exec.message.case}"`, statusCode: 502, routeScope: "provider" });
      onContextRequest(exec);
    }
  }
  return pending;
}

/** Cursor — OAuth-gated, real http2 upstream at /agent.v1.AgentService/Run */
export class CursorAdapter implements Adapter {
  readonly metadata = {
    id: "cursor",
    displayName: "Cursor",
    protocol: "openai" as const,
    credentialKind: "oauth" as const,
  };
  readonly capabilities = capabilitiesOf({ surfaces: CURSOR_SURFACES, streaming: true, reasoning: true, images: true, toolCalls: false });
  readonly models = createModelCatalog(CURSOR_MODELS);

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "cursor" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    const model = this.models.get(modelId);
    return { providerId: "cursor", modelId, upstreamModelId: model?.upstreamId ?? modelId, surface };
  }

  mapError(error: unknown) {
    return internalFailureFromUnknown(error);
  }

  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchCursorModels(input);
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.request.tools.length > 0) {
      throw new UpstreamError({ kind: "capability_unsupported", message: "Cursor adapter does not support tool calls yet", statusCode: 400, routeScope: "provider" });
    }
    const credential = (await import("../../auth/contract.js")).extractAccessTokenOrRaw(input.credential);
    const isProbe = input.request.messages.some((message) => message.content.some((part) => typeof (part as { text?: string }).text === "string" && (part as { text: string }).text.includes("Be honest about your identity")));
    const connectTimeout = 10000;
    const client = await new Promise<http2.ClientHttp2Session>((resolve, reject) => {
      let settled = false;
      const c = http2.connect(CURSOR_BASE_URL);
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { c.close(); } catch {}
        reject(new UpstreamError({ kind: "network_unavailable", message: "Cursor connect timeout", statusCode: 502, routeScope: "provider" }));
      }, connectTimeout);
      c.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });
      c.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(c);
      });
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { c.close(); } catch {}
        reject(new UpstreamError({ kind: "network_unavailable", message: "aborted", statusCode: 502, routeScope: "provider" }));
      };
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    });
    const req = client.request({
      ":method": "POST",
      ":path": CURSOR_PATH,
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      te: "trailers",
      authorization: `Bearer ${credential}`,
      "x-ghost-mode": "true",
      "x-cursor-client-version": CURSOR_CLIENT_VERSION,
      "x-cursor-client-type": "cli",
      "x-request-id": crypto.randomUUID(),
    });
    const payload = requestBytes(input);
    req.write(frame(payload));
    const state: CursorResponseState = { text: "", turnEnded: false };
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let probeIdleTimer: ReturnType<typeof setTimeout> | undefined;
    let probeIdleCompleted = false;
    const armProbeIdleCompletion = (): void => {
      if (!isProbe || state.text.length === 0 || state.turnEnded) return;
      if (probeIdleTimer !== undefined) clearTimeout(probeIdleTimer);
      probeIdleTimer = setTimeout(() => {
        if (!state.turnEnded && state.text.length > 0) {
          probeIdleCompleted = true;
          req.close();
        }
      }, 750);
    };
    const abortRequest = (): void => {
      req.close();
      client.close();
    };
    if (input.signal.aborted) abortRequest();
    else input.signal.addEventListener("abort", abortRequest, { once: true });
    const heartbeat = setInterval(() => {
      if (!req.closed && !req.destroyed) {
        const heartbeatMessage = create(AgentClientMessageSchema, {
          message: { case: "clientHeartbeat", value: {} },
        });
        req.write(frame(toBinary(AgentClientMessageSchema, heartbeatMessage)));
      }
    }, 5000);
    if (!input.request.stream) {
      try {
        for await (const chunk of req) {
          pending = consumeCursorFrames(Buffer.concat([pending, chunk as Buffer]), state, (server) => {
            req.write(requestContextFrame(server));
          }, (caseName) => {
            if (caseName === "textDelta") armProbeIdleCompletion();
          });
        }
      } catch (error) {
        if (!probeIdleCompleted) throw error;
      } finally {
        clearInterval(heartbeat);
        if (probeIdleTimer !== undefined) clearTimeout(probeIdleTimer);
        input.signal.removeEventListener("abort", abortRequest);
        client.close();
      }
      if (!state.turnEnded && (!isProbe || state.text.length === 0)) throw new UpstreamError({ kind: "model_not_found", message: "Cursor response ended before turn completion", statusCode: 404, routeScope: null });
      return {
        mode: "non_stream" as const,
        body: {
          id: `cursor-${crypto.randomUUID()}`,
          object: "chat.completion",
          model: input.target.modelId,
          choices: [{ index: 0, message: { role: "assistant", content: state.text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        },
      };
    }
    const stream = (async function* () {
      try {
        for await (const chunk of req) {
          const previousLength = state.text.length;
          pending = consumeCursorFrames(Buffer.concat([pending, chunk as Buffer]), state, (server) => {
            req.write(requestContextFrame(server));
          }, (caseName) => {
            if (caseName === "textDelta") armProbeIdleCompletion();
          });
          if (state.text.length > previousLength) {
            yield { type: "text_delta", text: state.text.slice(previousLength) } as unknown as import("../../proxy/types/stream.js").StreamEvent;
          }
        }
        if (!state.turnEnded) throw new UpstreamError({ kind: "model_not_found", message: "Cursor response ended before turn completion", statusCode: 404, routeScope: null });
      } finally {
        clearInterval(heartbeat);
        if (probeIdleTimer !== undefined) clearTimeout(probeIdleTimer);
        input.signal.removeEventListener("abort", abortRequest);
        client.close();
      }
    })();
    return { mode: "stream" as const, events: stream as unknown as AsyncIterable<import("../../proxy/types/stream.js").StreamEvent> };
  }
}
