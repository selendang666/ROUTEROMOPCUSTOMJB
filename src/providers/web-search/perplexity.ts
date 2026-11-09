import { ApiKeyProviderBase } from "../api-key/base.js";
import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import type { ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { AbortCoordinator } from "../../proxy/transport/abort.js";
import { executeFetch, readJsonObject } from "../../proxy/transport/fetch.js";
import { UpstreamError } from "../../proxy/transport/errors.js";
import { throwUpstreamHttpFailure } from "../shared.js";


const models = [
  modelOf("perplexity-search", "Perplexity Search", capabilitiesOf({ surfaces: ["web-search"], search: true })),
  modelOf("perplexity-deep-research", "Perplexity Deep Research", capabilitiesOf({ surfaces: ["web-search"], search: true })),
];

/** Perplexity provider — web-search surface via Perplexity API (sonar) */
export class PerplexityProvider extends ApiKeyProviderBase {
  constructor() {
    super({
      metadata: { id: "perplexity", displayName: "Perplexity", protocol: "openai", credentialKind: "api_key" },
      capabilities: capabilitiesOf({ surfaces: ["web-search"], search: true, streaming: false }),
      models,
    });
  }
  async call(input: ProviderRequest): Promise<ProviderOutput> {
    const last = [...input.request.messages].reverse().find((message) => message.role === "user");
    const query = last?.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();
    if (!query) throw new UpstreamError({ kind: "invalid_request", message: "Search query is required.", statusCode: 400, routeScope: null });
    const coordinator = new AbortCoordinator(input.signal, {
      connectTimeoutMs: input.request.limits.connectTimeoutMs,
      firstByteTimeoutMs: input.request.limits.firstByteTimeoutMs,
      idleTimeoutMs: input.request.limits.idleTimeoutMs,
      totalTimeoutMs: input.request.limits.totalTimeoutMs,
    });
    try {
      const response = await executeFetch(
        "https://api.perplexity.ai/search",
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${input.credential}` },
          body: JSON.stringify({ query, num_results: 10 }),
        },
        coordinator,
        input.network,
        input.capture,
      );
      if (!response.ok) throw await throwUpstreamHttpFailure(response, "perplexity", input.capture);
      const body = (await readJsonObject(response, coordinator)) as Record<string, unknown>;
      const results = Array.isArray(body.results) ? body.results : Array.isArray((body as Record<string, unknown>).results) ? (body as Record<string, unknown>).results as unknown[] : [];
      const text =
        (results as unknown[])
          .map((result) => {
            const item = result as Record<string, unknown>;
            return `[${String(item.title ?? "Result")}](${String(item.url ?? "")})\n${String(item.snippet ?? item.summary ?? "")}`;
          })
          .join("\n\n---\n\n") || String((body as Record<string, unknown>).answer ?? (body as Record<string, unknown>).content ?? "No results found.");
      return {
        mode: "non_stream",
        body: {
          id: `perplexity-${crypto.randomUUID()}`,
          object: "chat.completion",
          model: input.request.model,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        },
      };
    } finally {
      coordinator.dispose();
    }
  }
}
