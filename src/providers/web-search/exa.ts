import { ApiKeyProviderBase } from "../api-key/base.js";
import { capabilitiesOf, modelOf } from "../../proxy/types/provider.js";
import type { ProviderOutput, ProviderRequest } from "../../proxy/types/request.js";
import { AbortCoordinator } from "../../proxy/transport/abort.js";
import { executeFetch, readJsonObject } from "../../proxy/transport/fetch.js";
import { UpstreamError } from "../../proxy/transport/errors.js";
import { throwUpstreamHttpFailure } from "../shared.js";


const models = [
  modelOf("exa-search", "Exa Neural Search", capabilitiesOf({ surfaces: ["web-search"], search: true })),
  modelOf("exa-deep-research", "Exa Deep Researcher", capabilitiesOf({ surfaces: ["web-search"], search: true })),
];

/** Exa provider: local search catalog and web-search request/response behavior. */
export class ExaProvider extends ApiKeyProviderBase {
  constructor() { super({ metadata: { id: "exa", displayName: "Exa AI", protocol: "exa", credentialKind: "api_key" }, capabilities: capabilitiesOf({ surfaces: ["web-search"], search: true, streaming: false }), models }); }
  async call(input: ProviderRequest): Promise<ProviderOutput> {
    const last = [...input.request.messages].reverse().find((message) => message.role === "user");
    const query = last?.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();
    if (!query) throw new UpstreamError({ kind: "invalid_request", message: "Search query is required.", statusCode: 400, routeScope: null });
    const coordinator = new AbortCoordinator(input.signal, { connectTimeoutMs: input.request.limits.connectTimeoutMs, firstByteTimeoutMs: input.request.limits.firstByteTimeoutMs, idleTimeoutMs: input.request.limits.idleTimeoutMs, totalTimeoutMs: input.request.limits.totalTimeoutMs });
    try {
      const response = await executeFetch("https://api.exa.ai/search", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-api-key": input.credential }, body: JSON.stringify({ query, type: "auto", numResults: 10, contents: { text: { maxCharacters: 3000 }, highlights: true, summary: { query: "Main points" } } }) }, coordinator, input.network, input.capture);
      if (!response.ok) throw await throwUpstreamHttpFailure(response, "exa", input.capture);
      const body = await readJsonObject(response, coordinator) as Record<string, unknown>;
      const results = Array.isArray(body.results) ? body.results : [];
      const text = results.map((result) => { const item = result as Record<string, unknown>; return `[${String(item.title ?? "Result")}](${String(item.url ?? "")})\n${String(item.summary ?? "")}`; }).join("\n\n---\n\n") || "No results found.";
      return { mode: "non_stream", body: { id: `exa-${crypto.randomUUID()}`, object: "chat.completion", model: input.request.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } };
    } finally { coordinator.dispose(); }
  }
}
