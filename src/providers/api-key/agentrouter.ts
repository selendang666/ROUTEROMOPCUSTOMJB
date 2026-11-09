import { ApiKeyProviderBase } from "./base.js";
import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import type { ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { buildMessagesPayload, mapAnthropicUsage } from "../../proxy/normalize/anthropic.js";
import { AbortCoordinator } from "../../proxy/transport/abort.js";
import { executeFetch, readJsonObject } from "../../proxy/transport/fetch.js";
import { UpstreamError, parseUpstreamFailure } from "../../proxy/transport/errors.js";
import { transformAnthropicMessagesStream } from "../../proxy/upstream/anthropic.js";
import { lineLimit, mapSseStream } from "../../proxy/transport/sse.js";
import { isRecord } from "../../proxy/validation.js";
import { providerQuirkPolicy } from "../../proxy/policy/profiles.js";


/**
 * AgentRouter — free-credits ($200 on signup) multi-model gateway speaking
 * native Anthropic Messages (https://agentrouter.org/v1/messages?beta=true).
 * AgentRouter gates on client identity: fixed User-Agent, Stainless fingerprint,
 * beta flags, and session id are required — dropping any gets rejected upstream.
 */

const BODY_FIELD_ORDER = [
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "metadata",
  "max_tokens",
  "thinking",
  "output_config",
  "stream",
] as const;

function reorderBody(body: Record<string, unknown>): Record<string, unknown> {
  const reordered: Record<string, unknown> = {};
  const remaining = new Set(Object.keys(body));
  for (const key of BODY_FIELD_ORDER) {
    if (key in body) {
      reordered[key] = body[key];
      remaining.delete(key);
    }
  }
  for (const key of remaining) reordered[key] = body[key];
  return reordered;
}

function buildHeaders(apiKey: string, stream: boolean): Record<string, string> {
  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "user-agent": "claude-cli/2.1.195 (external, sdk-cli)",
    "x-claude-code-session-id": crypto.randomUUID(),
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "600",
    "x-stainless-lang": "js",
    "x-stainless-package-version": "0.94.0",
    "x-stainless-os": "MacOS",
    "x-stainless-arch": "arm64",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v24.3.0",
    accept: stream ? "text/event-stream" : "application/json",
    "accept-encoding": "gzip, deflate, br, zstd",
    "x-api-key": apiKey,
  };
}

const AGENTROUTER_SURFACES = ["anthropic-messages"] as const;

const models = [modelOf("claude-opus-4-8", "Claude Opus 4.8", capabilitiesOf({ surfaces: AGENTROUTER_SURFACES, reasoning: true, images: true }))];

export class AgentRouterProvider extends ApiKeyProviderBase {
  constructor() {
    super({
      metadata: { id: "agentrouter", displayName: "AgentRouter", protocol: "anthropic", credentialKind: "api_key" },
      capabilities: capabilitiesOf({ surfaces: AGENTROUTER_SURFACES, reasoning: true, images: true, streaming: true }),
      models,
    });
  }
  async call(input: ProviderRequest): Promise<ProviderOutput> {
    const payloadRaw = buildMessagesPayload(input.request, this.capabilities, {
      quirks: providerQuirkPolicy(input.target.providerId),
    });
    (payloadRaw as Record<string, unknown>).model = input.target.upstreamModelId;
    const payload = reorderBody(payloadRaw as unknown as Record<string, unknown>);
    const headers = buildHeaders(input.credential, input.request.stream);
    const coordinator = new AbortCoordinator(input.signal, {
      connectTimeoutMs: input.request.limits.connectTimeoutMs,
      firstByteTimeoutMs: input.request.limits.firstByteTimeoutMs,
      idleTimeoutMs: input.request.limits.idleTimeoutMs,
      totalTimeoutMs: input.request.limits.totalTimeoutMs,
    });
    let streamHandedOff = false;
    try {
      const response = await executeFetch("https://agentrouter.org/v1/messages?beta=true", { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, input.network, input.capture);
      if (!response.ok) throw await parseUpstreamFailure(response);
      if (!input.request.stream) {
        const body = (await readJsonObject(response, coordinator)) as Record<string, unknown>;
        const usageRecord = isRecord(body.usage) ? (body.usage as Record<string, unknown>) : null;
        return { mode: "non_stream", body, usage: usageRecord !== null ? mapAnthropicUsage(usageRecord) : undefined };
      }
      if (!response.body) throw new UpstreamError({ kind: "provider_protocol_error", message: "Upstream returned an empty stream body", routeScope: "provider" });
      streamHandedOff = true;
      return { mode: "stream", events: mapSseStream({ body: response.body, coordinator, maxLineBytes: lineLimit(input.request.limits), idleTimeoutMs: input.request.limits.idleTimeoutMs }, transformAnthropicMessagesStream(input.target.providerId)) };
    } finally {
      if (!streamHandedOff) coordinator.dispose();
    }
  }
}
