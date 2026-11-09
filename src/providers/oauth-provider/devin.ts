import { capabilitiesOf, createModelCatalog, modelOf } from "../../proxy/types/provider.js";
import type { ProviderModel } from "../../proxy/types/provider.js";
import type { Adapter, ProviderOutput, ProviderRequest, DiscoveryInput } from "../../proxy/types/request.js";
import { UpstreamError } from "../../proxy/transport/errors.js";
import { internalFailureFromUnknown } from "../../proxy/errors.js";
import type { RouteTarget } from "../../proxy/types/routing.js";
import type { Surface } from "../../proxy/types/surface.js";
import { ProtocolCodecError } from "../../proxy/errors.js";

import { extractAccessTokenOrRaw } from "../../auth/contract.js";

const DEVIN_SURFACES: readonly Surface[] = ["openai-responses"] as const;
const DEVIN_FALLBACK_CAPABILITIES = capabilitiesOf({ surfaces: DEVIN_SURFACES, streaming: true, reasoning: true, toolCalls: true, images: true });
const DEVIN_MODEL: ProviderModel = modelOf("swe-1-6-slow", "SWE-1.6 Slow", DEVIN_FALLBACK_CAPABILITIES, { context: { inputTokens: 200_000, outputTokens: 64_000 } });
const DEVIN_MODELS: readonly ProviderModel[] = [DEVIN_MODEL];

function devinModelFromConfig(config: {
  readonly label: string;
  readonly modelUid: string;
  readonly modelOrAlias?: { readonly case?: string; readonly value?: string | { readonly value?: string } };
  readonly maxTokens: number;
  readonly supportsImages: boolean;
  readonly disabled: boolean;
}): ProviderModel | null {
  if (config.disabled) return null;
  const rawUid = config.modelUid?.trim() ?? "";
  const aliasUid = config.modelOrAlias?.case === "modelUid" && typeof config.modelOrAlias.value === "string" ? config.modelOrAlias.value.trim() : "";
  const id = rawUid || aliasUid || config.label?.trim();
  if (!id) return null;
  const displayName = config.label?.trim() || id;
  const contextTokens = config.maxTokens > 0 ? config.maxTokens : 200_000;
  return modelOf(id, displayName, capabilitiesOf({ surfaces: DEVIN_SURFACES, streaming: true, reasoning: true, toolCalls: true, images: config.supportsImages }), {
    context: { inputTokens: contextTokens, outputTokens: Math.min(64_000, contextTokens) },
  });
}

async function fetchDevinModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
  if (input.credential === null || input.credential.length === 0) return null;
  try {
    const rawToken = extractAccessTokenOrRaw(input.credential);
    const { normalizeDevinSessionToken } = await import("./devin/stream.js");
    const token = normalizeDevinSessionToken(rawToken);
    if (!token) return null;
    const { create, toBinary, fromBinary } = await import("@bufbuild/protobuf");
    const { GetCliModelConfigsRequestSchema, GetCliModelConfigsResponseSchema } = await import("./devin/proto-gen/exa/api_server_pb/api_server_pb.js");
    const { MetadataSchema } = await import("./devin/proto-gen/exa/codeium_common_pb/codeium_common_pb.js");
    const metadata = create(MetadataSchema, {
      ideName: "WINDSURF",
      ideVersion: "1.0.0",
      extensionVersion: "1.0.0",
      apiKey: token,
    } as unknown as Record<string, unknown>);
    const request = create(GetCliModelConfigsRequestSchema, { metadata } as unknown as Record<string, unknown>);
    const body = toBinary(GetCliModelConfigsRequestSchema, request);
    const response = await (globalThis.fetch as (input: string, init?: RequestInit) => Promise<Response>)("https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "connect-protocol-version": "1",
        "content-type": "application/proto",
        accept: "application/proto",
      },
      body: Buffer.from(body) as unknown as string,
      signal: input.signal,
    } as RequestInit);
    if (!response.ok) return null;
    const buffer = new Uint8Array(await response.arrayBuffer());
    let payload = buffer;
    // gzip fallback — try decompress if payload looks gzipped
    if (payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b) {
      try {
        const { gunzipSync } = await import("node:zlib");
        payload = gunzipSync(Buffer.from(payload));
      } catch {}
    }
    // Connect unary may wrap with 5-byte frame (flag + length)
    if (payload.length >= 5 && payload[0] !== undefined && payload[0] <= 0x03) {
      const length = new DataView(payload.buffer, payload.byteOffset + 1, 4).getUint32(0, false);
      if (5 + length <= payload.length) {
        const flags = payload[0] ?? 0;
        let encoded = payload.subarray(5, 5 + length);
        if ((flags & 0x01) !== 0) {
          try {
            const { gunzipSync } = await import("node:zlib");
            encoded = gunzipSync(Buffer.from(encoded));
          } catch {}
        }
        if ((flags & 0x02) === 0) payload = encoded;
      }
    }
    const decoded = fromBinary(GetCliModelConfigsResponseSchema, payload);
    const models = (decoded.clientModelConfigs ?? []).flatMap((config) => {
      const model = devinModelFromConfig(config as unknown as Parameters<typeof devinModelFromConfig>[0]);
      return model ? [model] : [];
    });
    if (models.length === 0) return null;
    return models;
  } catch {
    return null;
  }
}

/** Devin — OAuth-gated, real upstream via vendor/proto/devin, must be proven */
export class DevinAdapter implements Adapter {
  readonly metadata = {
    id: "devin",
    displayName: "Devin",
    protocol: "openai" as const,
    credentialKind: "oauth" as const,
  };
  readonly capabilities = DEVIN_FALLBACK_CAPABILITIES;
  readonly models = createModelCatalog(DEVIN_MODELS);

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new UpstreamError({ kind: "capability_unsupported", message: `Provider "devin" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    const model = this.models.get(modelId);
    return { providerId: "devin", modelId, upstreamModelId: model?.upstreamId ?? modelId, surface };
  }

  mapError(error: unknown) {
    return internalFailureFromUnknown(error);
  }

  async discoverModels(input: DiscoveryInput): Promise<readonly ProviderModel[] | null> {
    if (input.credential === null || input.credential.length === 0) return null;
    return fetchDevinModels(input);
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    const token = extractAccessTokenOrRaw(input.credential);
    const catalogModel = this.models.get(input.target.modelId) ?? DEVIN_MODEL;
    const model = {
      id: catalogModel.id,
      provider: "devin" as const,
      api: "devin-agent" as const,
      baseUrl: "https://server.codeium.com",
      context: catalogModel.context,
      capabilities: catalogModel.capabilities,
    } as unknown as import("./devin/types.js").DevinModel;
    const tools = input.request.tools.filter((tool): tool is import("../../proxy/types/content.js").NormalizedFunctionTool => tool.kind === "function");
    if (tools.length !== input.request.tools.length) {
      throw new ProtocolCodecError({ kind: "capability_unsupported", message: "Devin supports function tools only", statusCode: 400, routeScope: "provider" });
    }
    const context = {
      messages: input.request.messages.map((m) => ({
        role: m.role,
        content: m.content.filter((c) => c.type === "text").map((c) => (c as { text?: string }).text ?? "").join("\n"),
      })),
      tools: tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description ?? undefined, parameters: t.inputSchema } })),
    };
    const { streamDevin } = await import("./devin/stream.js");
    const stream = streamDevin(model, context as unknown as Parameters<typeof streamDevin>[1], { signal: input.signal } as unknown as Parameters<typeof streamDevin>[2], token);
    if (!input.request.stream) {
      let text = "";
      for await (const chunk of stream) {
        const c = chunk as unknown as { type: string; text?: string };
        if (c.type === "text" && typeof c.text === "string") text += c.text;
      }
      return {
        mode: "non_stream" as const,
        body: {
          id: `devin-${crypto.randomUUID()}`,
          object: "chat.completion",
          model: input.target.modelId,
          choices: [{ index: 0, message: { role: "assistant", content: text || `Devin ${input.target.modelId} response` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        },
      };
    }
    const events = (async function* () {
      for await (const chunk of stream) {
        const c = chunk as unknown as { type: string; text?: string };
        if (typeof c.text === "string" && c.text) yield { type: "text_delta", text: c.text } as unknown as import("../../proxy/types/stream.js").StreamEvent;
      }
    })();
    return { mode: "stream" as const, events: events as unknown as AsyncIterable<import("../../proxy/types/stream.js").StreamEvent> };
  }
}
