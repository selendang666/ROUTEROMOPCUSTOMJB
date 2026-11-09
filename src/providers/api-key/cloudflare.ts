import { ApiKeyProviderBase } from "./base.js";
import { capabilitiesOf } from "../../proxy/types/provider.js";
import type { ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { dispatchChatCompletions } from "../../proxy/upstream/openai.js";
import { UpstreamError } from "../../proxy/transport/errors.js";

const CLOUDFLARE_BASE_URL = "https://api.cloudflare.com/client/v4/accounts";

interface CloudflareCredential { readonly apiKey: string; readonly accountId: string; }

function parseCredential(value: string): CloudflareCredential {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid credential");
    const record = parsed as Record<string, unknown>;
    if (typeof record.apiKey !== "string" || record.apiKey.trim().length === 0) throw new Error("missing apiKey");
    if (typeof record.accountId !== "string" || !/^[a-f0-9]{32}$/i.test(record.accountId.trim())) throw new Error("invalid accountId");
    return { apiKey: record.apiKey.trim(), accountId: record.accountId.trim() };
  } catch {
    throw new UpstreamError({ kind: "authentication_failed", message: "Cloudflare requires JSON credential with apiKey and accountId.", statusCode: 401, routeScope: "account" });
  }
}

/** Cloudflare Workers AI provider: credential parsing, URL, headers, and adapter ownership. */
export class CloudflareProvider extends ApiKeyProviderBase {
  constructor() {
    super({ metadata: { id: "cloudflare", displayName: "Cloudflare Workers AI", protocol: "openai", credentialKind: "api_key", credentialUrl: "https://dash.cloudflare.com/profile/api-tokens" }, capabilities: capabilitiesOf({ surfaces: ["openai-chat"], streaming: true, reasoning: true }), models: [] });
  }

  call(input: ProviderRequest): Promise<ProviderOutput> {
    const credential = parseCredential(input.credential);
    return dispatchChatCompletions(input, `${CLOUDFLARE_BASE_URL}/${credential.accountId}/ai/v1`, { "content-type": "application/json", accept: input.request.stream ? "text/event-stream" : "application/json", authorization: `Bearer ${credential.apiKey}` });
  }
}

