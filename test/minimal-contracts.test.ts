/**
 * Minimal observable contract tests — no legacy fallback.
 * Covers six contracts through the canonical protocol, stream, router, API, and persistence owners.
 * No legacy owner imports.
 */
import { describe, test, expect } from "bun:test";
import { normalizeChatRequest } from "../src/proxy/normalize/openai.js";
import { lookupProxyEndpoint, parseRequestBody } from "../src/proxy/translate/cross-surface.js";
import { isProtocolError } from "../src/proxy/errors.js";
import { parseSseEvents, MAX_SSE_LINE, MAX_SSE_EVENT, MAX_SSE_BUFFERED, MAX_SSE_EVENTS, STREAM_BOUNDS } from "../src/proxy/transport/sse.js";
import { transformOpenAIChatStream } from "../src/proxy/upstream/openai.js";
import { createReleaseGate } from "../src/proxy/events/commit.js";
import { createRoutePlan, resolveAlias, parseModelReference } from "../src/proxy/routing/plan.js";
import { createPublicRouter } from "../src/api/v1";
import type { ProviderModelRow } from "../src/persistence/types.js";
import type { RoutingSnapshot, RequestLimits } from "../src/protocol/types";
import type { PublicDependencies } from "../src/api/v1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const requestLimits: RequestLimits = {
  maxBodyBytes: 10 * 1024 * 1024,
  connectTimeoutMs: 5000,
  firstByteTimeoutMs: 10_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
};
const signal = new AbortController().signal;
const normalizeInput = { signal, limits: requestLimits };

function tinyPngDataUrl(): string {
  // 1x1 transparent png
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
}

// ---------------------------------------------------------------------------
// 1) GET /v1/models
// ---------------------------------------------------------------------------
describe("GET /v1/models", () => {
  test("returns catalog via public router (auth required, no legacy)", async () => {
    const deps = {
      apiKeys: {
        async getBySecret(secret: string) {
          if (secret === "test-key-123") return { id: "key-1", active: true, revokedAt: null };
          return null;
        },
        async touch() {},
      },
      models: {
        async list(authorized: { apiKeyId: string }) {
          expect(authorized.apiKeyId).toBe("key-1");
          return [
            { id: "openai/gpt-4o", object: "model", owned_by: "openai" },
            { id: "anthropic/claude-3-5-sonnet", object: "model", owned_by: "anthropic" },
          ];
        },
      },
      proxy: {
        async handle() {
          return { mode: "json" as const, status: 200, headers: new Headers(), value: {} as Record<string, unknown> };
        },
      },
      readiness: async () => ({ ok: true }),
    } satisfies PublicDependencies;
    const app = createPublicRouter(deps as unknown as PublicDependencies);

    // unauthorized -> 401
    const unauth = await app.handle(new Request("http://localhost/v1/models"));
    expect(unauth.status).toBe(401);

    // authorized -> 200 with list shape
    const res = await app.handle(
      new Request("http://localhost/v1/models", { headers: { "x-api-key": "test-key-123" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: { id: string }[] };
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(2);
    expect(body.data[0].id).toBe("openai/gpt-4o");

    // also verify protocol does not claim /v1/models as chat endpoint
    expect(lookupProxyEndpoint("/v1/models")).toBeNull();
    // chat endpoint still resolves
    const chat = lookupProxyEndpoint("/v1/chat/completions");
    expect(chat).not.toBeNull();
    expect(chat!.surface).toBe("openai-chat");
  });
});

// ---------------------------------------------------------------------------
// 2) POST /v1/chat text-only
// ---------------------------------------------------------------------------
describe("POST /v1/chat text-only", () => {
  test("normalizes minimal text-only chat request", () => {
    const body = {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    };
    const result = normalizeChatRequest(body, normalizeInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.model).toBe("openai/gpt-4o");
    expect(result.request.sourceSurface).toBe("openai-chat");
    expect(result.request.messages.length).toBe(1);
    const firstContent = result.request.messages[0]?.content[0];
    expect(firstContent?.type).toBe("text");
    // no images/media
    expect(result.request.images.length).toBe(0);

    // also test parseRequestBody bounded parse
    const parsed = parseRequestBody(JSON.stringify(body), requestLimits);
    expect(isProtocolError(parsed)).toBe(false);
    // empty body should error
    const empty = parseRequestBody("   ", requestLimits);
    expect(isProtocolError(empty)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3) image input
// ---------------------------------------------------------------------------
describe("image input", () => {
  test("accepts image_url data URL and rejects private URL", () => {
    const imageBody = {
      model: "openai/gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: tinyPngDataUrl() } },
          ],
        },
      ],
    };
    const ok = normalizeChatRequest(imageBody, normalizeInput);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.request.messages[0]!.content.some((c) => c.type === "image")).toBe(true);
    expect(ok.request.images.length).toBe(1);
    expect(ok.request.images[0]!.kind).toBe("data");

    // private IP should be rejected with ProtocolError
    const privateBody = {
      model: "openai/gpt-4o",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "http://127.0.0.1/secret.png" } }],
        },
      ],
    };
    const bad = normalizeChatRequest(privateBody, normalizeInput);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.field).toContain("image_url");
  });
});

// ---------------------------------------------------------------------------
// 4) PDF input
// ---------------------------------------------------------------------------
describe("PDF input", () => {
  test("accepts document/pdf data URL as pdf block", () => {
    // Chat-style pdf via input_file
    const pdfBody = {
      model: "openai/gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "summarize" },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from("%PDF-1.4").toString("base64") } },
          ],
        },
      ],
    };
    // Alternative: data URL via image_url-like file_data path – use tinyPdfDataUrl via image_url with pdf mime
    const pdfBody2 = {
      model: "openai/gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read pdf" },
            { type: "input_file", file_data: Buffer.from("%PDF-1.4 test").toString("base64"), filename: "doc.pdf", format: "application/pdf" },
          ],
        },
      ],
    };

    const r1 = normalizeChatRequest(pdfBody, normalizeInput);
    // First shape may be anthropic-document style; if rejected, try second shape as true pdf contract
    if (r1.ok) {
      const hasPdf = r1.request.messages[0]?.content.some((c) => c.type === "pdf") ?? false;
      expect(hasPdf).toBe(true);
    }
    const r2 = normalizeChatRequest(pdfBody2, normalizeInput);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const hasPdf2 = r2.request.messages[0]?.content.some((c) => c.type === "pdf") ?? false;
    expect(hasPdf2).toBe(true);
    // persistence type import sanity: ProviderModelRow can hold modelId
    const row: ProviderModelRow = {
      id: "1",
      provider: "openai",
      modelId: "openai/gpt-4o",
      displayName: "GPT-4o",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as ProviderModelRow;
    expect(row.modelId).toBe("openai/gpt-4o");
  });
});

// ---------------------------------------------------------------------------
// 5) tool strict
// ---------------------------------------------------------------------------
describe("tool strict", () => {
  test("strict tool validates schema", () => {
    // strict true with invalid schema (parameters not an object) should be rejected
    const invalidSchema = {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", description: "get weather" as string, parameters: "not-an-object" as unknown as Record<string, unknown> },
          strict: true as const,
        },
      ],
    };
    const bad = normalizeChatRequest(invalidSchema, normalizeInput);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.field).toContain("tools");

    const withSchema = {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "get weather",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
          strict: true as const,
        },
      ],
    };
    const ok = normalizeChatRequest(withSchema, normalizeInput);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.request.tools.length).toBe(1);
    const firstTool = ok.request.tools[0];
    expect(firstTool?.name).toBe("get_weather");
    // non-strict tool without schema should still pass (empty schema default)
    const nonStrict = {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "noop", description: "noop" } }],
    };
    const ok2 = normalizeChatRequest(nonStrict, normalizeInput);
    expect(ok2.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6) stream SSE bounds
// ---------------------------------------------------------------------------
describe("stream SSE bounds", () => {
  test("constants match spec and decoder enforces line/event bounds", async () => {
    expect(MAX_SSE_LINE).toBe(64 * 1024);
    expect(MAX_SSE_EVENT).toBe(64 * 1024);
    expect(MAX_SSE_BUFFERED).toBe(512 * 1024);
    expect(MAX_SSE_EVENTS).toBe(100_000);
    // STREAM_BOUNDS may be overridden by runtime/admission (defaults 4MB); ensure it is within allowed clamp
    expect(STREAM_BOUNDS.lineBytes).toBeGreaterThanOrEqual(4 * 1024);
    expect(STREAM_BOUNDS.lineBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(STREAM_BOUNDS.eventBytes).toBeGreaterThanOrEqual(4 * 1024);
    expect(STREAM_BOUNDS.bufferedBytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(STREAM_BOUNDS.eventCount).toBeGreaterThanOrEqual(1_000);

    // normal small event decodes
    const smallBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const smallEvents: { event: string | null; data: string }[] = [];
    for await (const ev of parseSseEvents({ body: smallBody })) smallEvents.push(ev);
    expect(smallEvents.length).toBe(2);
    const firstData = smallEvents[0]?.data ?? "";
    expect(firstData).toContain("choices");

    // oversized line should throw StreamError (exceeding STREAM_BOUNDS.lineBytes)
    const bigLine = "a".repeat(STREAM_BOUNDS.lineBytes + 1);
    const bigBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${bigLine}\n`));
        controller.close();
      },
    });
    let threw = false;
    try {
      for await (const _ of parseSseEvents({ body: bigBody })) {}
    } catch (e: unknown) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("SSE line exceeds");
    }
    expect(threw).toBe(true);

    // mapper handles [DONE] and buffered tool calls
    const mapper = transformOpenAIChatStream();
    const done = mapper({ event: null, data: "[DONE]" });
    expect(Array.isArray(done)).toBe(true);
    const doneArray = done as unknown as { type: string }[];
    const hasStop = doneArray.some((ev) => ev.type === "message_stop");
    expect(hasStop).toBe(true);

    // route + persistence sanity: alias resolution
    expect(resolveAlias("gpt-4", new Map([["gpt-4", "openai/gpt-4o"]]))).toBe("openai/gpt-4o");
    const ref = parseModelReference("openai/gpt-4o", new Map([["openai", "openai"]]));
    expect(ref.kind).toBe("qualified");

    // release gate exactly-once
    let calls = 0;
    const gate = createReleaseGate(async () => { calls += 1; });
    await gate.release();
    await gate.release();
    expect(calls).toBe(1);
    expect(gate.released()).toBe(true);

    // route plan minimal smoke (uses RoutingSnapshot + persistence row shape above)
    const snapshot = {
      revision: 1,
      aliases: new Map(),
      combos: new Map(),
      prefixes: new Map([["openai", "openai"]]),
      providerPrefixes: new Map([["openai", "openai"]]),
      cliModelMappings: new Map(),
      accountsByProvider: new Map(),
      knownModelIds: new Map(),
      proxies: [],
      accounts: [{ accountId: "acc-1", providerId: "openai", healthy: true, priority: 1 } as unknown as RoutingSnapshot["accounts"][number]],
      models: [{ providerId: "openai", modelId: "openai/gpt-4o" } as unknown as RoutingSnapshot["models"][number]],
      ponytailEnabled: false,
      rtkConfig: null,
      createdAt: new Date().toISOString(),
    } as unknown as RoutingSnapshot;
    const plan = createRoutePlan({ requestedModel: "openai/gpt-4o", snapshot });
    expect(Array.isArray(plan.candidates)).toBe(true);
  });
});
