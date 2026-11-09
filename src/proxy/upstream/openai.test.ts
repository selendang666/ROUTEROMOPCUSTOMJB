import { describe, expect, test } from "bun:test";
import { dispatchResponses, transformOpenAIChatStream } from "./openai.js";
import { transformOpenAIResponsesStream } from "./openai.js";
import { mapSseStream } from "../transport/sse.js";
import { AbortCoordinator } from "../transport/abort.js";
import type { StreamEvent } from "../types/stream.js";
import type { ProviderRequest } from "../types/request.js";

function bodyFromLines(lines: string[]): ReadableStream<Uint8Array> {
  const raw = lines.map((l) => `data: ${l}\n\n`).join("");
  return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(raw)); c.close(); } });
}

function makeResponsesRequest(overrides: Partial<ProviderRequest["request"]> = {}): ProviderRequest {
  return {
    target: { providerId: "codex", modelId: "gpt-5.6", upstreamModelId: "gpt-5.6", surface: "openai-responses" },
    request: {
      model: "gpt-5.6",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      stream: false,
      responseFormat: "text",
      reasoning: "disabled",
      maxOutputTokens: 64,
      temperature: 0.2,
      topP: 0.7,
      sourceSurface: "openai-responses",
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 64 * 1024, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, totalTimeoutMs: 1_000 },
      ...overrides,
    },
    credential: "token",
    network: { url: null },
    signal: new AbortController().signal,
    headers: undefined,
    capture: undefined,
  } as unknown as ProviderRequest;
}

describe("stream-contract deterministic upstream chunks -> canonical events", () => {
  test("openai-chat textDelta -> text_delta canonical", async () => {
    const chunk = JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { content: "hello" }, finish_reason: null }] });
    const body = bodyFromLines([chunk, JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: {}, finish_reason: "stop" }] }), "[DONE]"]);
    const coord = new AbortCoordinator(new AbortController().signal, {});
    const events: StreamEvent[] = [];
    for await (const ev of mapSseStream({ body, coordinator: coord, maxLineBytes: 64 * 1024 }, transformOpenAIChatStream())) events.push(ev);
    expect(events.some((e) => e.type === "text_delta" && (e as Extract<StreamEvent, { type: "text_delta" }>).text === "hello")).toBe(true);
    expect(events.some((e) => e.type === "message_stop" && (e as Extract<StreamEvent, { type: "message_stop" }>).reason === "completed")).toBe(true);
    coord.dispose();
  });

  test("openai-chat reasoning_content -> thinking_delta canonical", async () => {
    const chunk = JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { reasoning_content: "step 1" }, finish_reason: null }] });
    const body = bodyFromLines([chunk, JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: {}, finish_reason: "stop" }] }), "[DONE]"]);
    const coord = new AbortCoordinator(new AbortController().signal, {});
    const events: StreamEvent[] = [];
    for await (const ev of mapSseStream({ body, coordinator: coord, maxLineBytes: 64 * 1024 }, transformOpenAIChatStream())) events.push(ev);
    expect(events.some((e) => e.type === "thinking_delta")).toBe(true);
    coord.dispose();
  });

  test("openai-chat tool_calls -> tool_call_start canonical", async () => {
    const chunk1 = JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] });
    const chunk2 = JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] }, finish_reason: null }] });
    const body = bodyFromLines([chunk1, chunk2, JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: {}, finish_reason: "tool_calls" }] }), "[DONE]"]);
    const coord = new AbortCoordinator(new AbortController().signal, {});
    const events: StreamEvent[] = [];
    for await (const ev of mapSseStream({ body, coordinator: coord, maxLineBytes: 64 * 1024 }, transformOpenAIChatStream())) events.push(ev);
    expect(events.some((e) => e.type === "tool_call_start" && (e as Extract<StreamEvent, { type: "tool_call_start" }>).name === "get_weather")).toBe(true);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    coord.dispose();
  });

  test("openai-responses delta -> terminal canonical", async () => {
    const delta = JSON.stringify({ type: "response.output_text.delta", delta: "hi" });
    const done = JSON.stringify({ type: "response.completed", response: { id: "resp_1" } });
    const body = bodyFromLines([delta, done]);
    const coord = new AbortCoordinator(new AbortController().signal, {});
    const events: StreamEvent[] = [];
    for await (const ev of mapSseStream({ body, coordinator: coord, maxLineBytes: 64 * 1024 }, transformOpenAIResponsesStream("openai"))) events.push(ev);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    coord.dispose();
  });

  test("usage event is emitted before stop", async () => {
    const chunk = JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { content: "hi" }, finish_reason: null }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    const body = bodyFromLines([chunk, JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), "[DONE]"]);
    const coord = new AbortCoordinator(new AbortController().signal, {});
    const events: StreamEvent[] = [];
    for await (const ev of mapSseStream({ body, coordinator: coord, maxLineBytes: 64 * 1024 }, transformOpenAIChatStream())) events.push(ev);
    const usageIdx = events.findIndex((e) => e.type === "usage");
    const stopIdx = events.findIndex((e) => e.type === "message_stop");
    if (usageIdx !== -1 && stopIdx !== -1) expect(usageIdx).toBeLessThan(stopIdx);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    coord.dispose();
  });

  test("malformed JSON in stream yields provider_protocol_error", async () => {
    const body = bodyFromLines(["{not-json"]);
    const coord = new AbortCoordinator(new AbortController().signal, {});
    const iter = mapSseStream({ body, coordinator: coord, maxLineBytes: 64 * 1024 }, transformOpenAIChatStream());
    await expect((async () => { for await (const _ of iter) {} })()).rejects.toMatchObject({ kind: "provider_protocol_error" });
    coord.dispose();
  });

  test("dispatchResponses applies codex quirk field dropping", async () => {
    const request = makeResponsesRequest({ temperature: 0.9, topP: 0.4, maxOutputTokens: 128 });
    const originalFetch = globalThis.fetch;
    let capturedBody = "";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({ id: "resp_1" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      await dispatchResponses(request, "https://chatgpt.com/backend-api", { authorization: "Bearer token" });
      const payload = JSON.parse(capturedBody) as Record<string, unknown>;
      expect(payload).not.toHaveProperty("temperature");
      expect(payload).not.toHaveProperty("top_p");
      expect(payload).not.toHaveProperty("max_output_tokens");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
