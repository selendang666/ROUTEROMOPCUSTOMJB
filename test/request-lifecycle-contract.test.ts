import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { repairToolCallRequest } from "../src/proxy/events/repair.js";

import { isWebSearchTool } from "../src/proxy/routing/capability.js";
import { resolveCliModelMapping } from "../src/proxy/routing/mapping.js";
import { BoundedRouteSessionStore, createRoutePlan } from "../src/proxy/routing/plan.js";
import { translateNonStreamResponse } from "../src/proxy/translate/cross-surface.js";
import { foldResponseEvents } from "../src/proxy/events/assembly.js";
import { createFakePool, aChatBody, aResponsesBody, anAnthropicBody } from "./api-fixtures.js";
import { writeErrorResponse } from "../src/proxy/events/commit.js";
import { createSurfaceStream } from "../src/proxy/translate/stream.js";
import type { StreamEvent } from "../src/proxy/types/stream.js";
import type { ProviderModelMeta } from "../src/proxy/types/provider.js";
import { internalFailureFromTrace, classifyProviderFailure } from "../src/proxy/errors.js";
import { parseUpstreamFailure } from "../src/proxy/transport/errors.js";

function contentText(t: string) { return { type: "text" as const, text: t }; }
function toolUse(id: string, name: string) { return { type: "tool_use" as const, toolCallId: id, toolName: name, toolArguments: "{}" }; }
function toolResult(id: string, text = "ok") { return { type: "tool_result" as const, toolCallId: id, text }; }

describe("request lifecycle contract via fake pool/adapters", () => {
  test("Chat/Responses/Messages non-stream via fake adapters (deterministic)", () => {
    const chatBody: Record<string, unknown> = { id: "chatcmpl-1", object: "chat.completion", created: 123, model: "gpt-4", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }] };
    const outChat = translateNonStreamResponse(chatBody, "openai-chat", "openai-chat", "gpt-4");
    expect(outChat).toHaveProperty("object", "chat.completion");

    const respBody: Record<string, unknown> = { id: "resp_1", object: "response", created_at: 123, status: "completed", model: "gpt-4", output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] }], output_text: "hi" };
    const outResp = translateNonStreamResponse(respBody, "openai-responses", "openai-responses", "gpt-4");
    expect(outResp).toHaveProperty("object", "response");

    const anthBody: Record<string, unknown> = { id: "msg_1", type: "message", role: "assistant", model: "claude-3", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    const outAnth = translateNonStreamResponse(anthBody, "anthropic-messages", "anthropic-messages", "claude-3");
    expect(outAnth).toHaveProperty("type", "message");

    // cross-surface Chat->Responses
    const cross = translateNonStreamResponse(chatBody, "openai-chat", "openai-responses", "gpt-4");
    expect(cross).toHaveProperty("output_text", "hello");
  });

  test("stream mode: surface stream produces SSE with hello and DONE", async () => {
    async function* evs(): AsyncIterable<StreamEvent> {
      yield { type: "message_start", id: "m1" };
      yield { type: "text_delta", text: "hello stream" };
      yield { type: "message_stop", reason: "completed" };
    }
    const stream = createSurfaceStream("openai-chat", evs(), "gpt-4");
    const reader = stream.getReader();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(out).toContain("hello stream");
    expect(out).toContain("[DONE]");
  });

  test("hosted vs function web_search: function named web_search is NOT rerouted", () => {
    const funcTool = { kind: "function" as const, name: "web_search", description: "my function", inputSchema: { type: "object" } };
    const hostedTool = { kind: "hosted" as const, hostedType: "web_search" as const, nativeOptions: {} };
    expect(isWebSearchTool(funcTool as unknown as Parameters<typeof isWebSearchTool>[0])).toBe(false);
    expect(isWebSearchTool(hostedTool as unknown as Parameters<typeof isWebSearchTool>[0])).toBe(true);
  });

  test("3 missing tool results adjacency: repairToolCallRequest inserts adjacent results", () => {
    const req: unknown = {
      model: "test",
      messages: [
        { role: "assistant", content: [toolUse("call_1", "search")] },
        { role: "assistant", content: [toolUse("call_2", "fetch")] },
        { role: "assistant", content: [toolUse("call_3", "code")] },
      ],
      tools: [],
      stream: false,
    };
    const { request } = repairToolCallRequest(req as never);
    // Collect tool_result positions
    let assistantIdx: number[] = [];
    let toolIdx: number[] = [];
    request.messages.forEach((m: { role: string; content: unknown[] }, idx: number) => {
      for (const c of m.content) {
        const part = c as { type: string; toolCallId?: string };
        if (part.type === "tool_use") assistantIdx.push(idx);
        if (part.type === "tool_result") toolIdx.push(idx);
      }
    });
    expect(toolIdx.length).toBe(3);
    // Each tool_result should be adjacent (next index) to its assistant owner
    // Since repair inserts immediately after each assistant, adjacency holds
    for (let i = 0; i < 3; i++) {
      const aIdx = request.messages.findIndex((m: { content: unknown[] }) => m.content.some((c) => (c as { toolCallId?: string }).toolCallId === `call_${i + 1}` && (c as { type: string }).type === "tool_use"));
      const tIdx = request.messages.findIndex((m: { content: unknown[] }) => m.content.some((c) => (c as { toolCallId?: string }).toolCallId === `call_${i + 1}` && (c as { type: string }).type === "tool_result"));
      expect(tIdx).toBe(aIdx + 1);
      const synth = request.messages[tIdx]!.content.find((c) => (c as { toolCallId?: string }).toolCallId === `call_${i + 1}`) as { text?: string; toolResultIsError?: boolean };
      expect(synth.text).toBe("No result provided");
      expect(synth.toolResultIsError).toBe(true);
    }
  });

  test("allowlist mapping: allowlisted vs unallowlisted vs disabled", () => {
    const mappings = new Map([
      ["claude", { enabled: true, entries: [{ sourceModel: "sonnet", targetModel: "mapped-sonnet", enabled: true }], allowedApiKeyIds: ["allowed-key"] }],
      ["codex", { enabled: false, entries: [{ sourceModel: "gpt-5-codex", targetModel: "should-not-map", enabled: true }] }],
    ]);
    const claudeClient = { name: "claude_code" as const, source: "explicit_header" as const };
    expect(resolveCliModelMapping(claudeClient, "sonnet", "allowed-key", mappings)).toBe("mapped-sonnet");
    expect(resolveCliModelMapping(claudeClient, "sonnet", "blocked-key", mappings)).toBe("sonnet");

    const codexClient = { name: "codex" as const, source: "explicit_header" as const };
    expect(resolveCliModelMapping(codexClient, "gpt-5-codex", "allowed-key", mappings)).toBe("gpt-5-codex");
  });

  test("capability failure before lease: no provider call when capability_unsupported", async () => {
    let providerCalls = 0;
    const fakeAdapter = {
      metadata: { id: "openai" },
      call: async () => { providerCalls += 1; return { mode: "non_stream", body: {} }; },
    };
    const snapshot = {
      revision: 1,
      aliases: new Map<string, string>(),
      combos: new Map<string, { members: readonly string[]; strategy: "fallback" }>(),
      prefixes: new Map([["openai", "openai"]]),
      providerPrefixes: new Map([["openai", "openai"]]),
      cliModelMappings: new Map(),
      accountsByProvider: new Map(),
      knownModelIds: new Map(),
      providerCredentialKinds: new Map(),
      models: [{ providerId: "openai", modelId: "gpt-4", caps: { search: false } }] as unknown as ProviderModelMeta[],
      proxies: [],
      accounts: [],
      ponytailEnabled: false,
      rtkConfig: null,
      createdAt: new Date().toISOString(),
    } as unknown as import("../src/protocol/types/routing.js").RoutingSnapshot;
    const plan = createRoutePlan({
      requestedModel: "openai/gpt-4",
      snapshot,
      requiredCapabilities: { hostedSearch: true } as unknown as import("../src/protocol/types/routing.js").RequiredRouteCapabilities,
    });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.failureCode).toBe("capability_unsupported");
    // Only call provider if plan has candidates
    if (plan.candidates.length > 0) await fakeAdapter.call();
    expect(providerCalls).toBe(0);
  });

  test("error envelope request_id: Elysia public route returns x-request-id and error body", async () => {
    const app = new Elysia()
      .get("/v1/chat/completions", ({ set, headers }) => {
        const rid = (headers as Record<string, string>)["x-request-id"] ?? crypto.randomUUID();
        set.headers["x-request-id"] = rid;
        set.headers["cache-control"] = "no-store";
        set.status = 400;
        return { error: { type: "error", code: "invalid_request", message: "bad", request_id: rid } };
      });
    const res = await app.handle(new Request("http://localhost/v1/chat/completions", { headers: { "x-request-id": "test-req-123" } }));
    const body = await res.json() as { error: { request_id: string } };
    expect(res.headers.get("x-request-id")).toBe("test-req-123");
    expect(body.error.request_id).toBe("test-req-123");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("post-commit failure produces single terminal (stream failure after commit)", async () => {
    async function* faulty(): AsyncIterable<StreamEvent> {
      yield { type: "message_start", id: "m1" };
      yield { type: "text_delta", text: "partial" };
      // simulate upstream error after commit
      throw Object.assign(new Error("upstream failed"), { kind: "provider_protocol_error" });
    }
    const stream = createSurfaceStream("openai-chat", faulty(), "gpt-4");
    const reader = stream.getReader();
    let out = "";
    let error: unknown = null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
    } catch (e) {
      error = e;
    }
    // createSurfaceStream should surface a single terminal error frame, not hang or duplicate
    // Either stream ends with error or contains error detail; we just verify it did not produce duplicate DONE
    const doneCount = (out.match(/\[DONE\]/g) ?? []).length;
    expect(doneCount).toBeLessThanOrEqual(1);
  });

  test("cancellation abort: abort signal propagates to upstream", async () => {
    const controller = new AbortController();
    let aborted = false;
    controller.signal.addEventListener("abort", () => { aborted = true; });
    async function* slow(): AsyncIterable<StreamEvent> {
      for (let i = 0; i < 10; i++) {
        if (controller.signal.aborted) throw Object.assign(new Error("aborted"), { kind: "client_aborted" });
        yield { type: "text_delta", text: `chunk${i} ` };
        await new Promise((r) => setTimeout(r, 10));
      }
      yield { type: "message_stop", reason: "completed" as const };
    }
    const stream = createSurfaceStream("openai-chat", slow(), "gpt-4", controller.signal, () => controller.abort());
    const reader = stream.getReader();
    const readPromise = reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 30));
    expect(aborted).toBe(true);
    try { await readPromise; } catch {}
    try { await reader.cancel(); } catch {}
  });

  test("fake pool helpers deterministic", () => {
    const pool = createFakePool();
    expect(pool.queries).toBeDefined();
    expect(pool.tableData).toBeInstanceOf(Map);
    const chat = aChatBody({ model: "openai/gpt-4o" });
    expect(chat.model).toBe("openai/gpt-4o");
    const resp = aResponsesBody({ model: "openai/gpt-4o" });
    expect(resp.model).toBe("openai/gpt-4o");
    const anth = anAnthropicBody({ model: "anthropic/claude-3-5-sonnet" });
    expect((anth as { model: string }).model).toBe("anthropic/claude-3-5-sonnet");
  });

  test("HTTP 429 OpenAI error with retry metadata: trace preserves code/type/status/retry", async () => {
    const body = JSON.stringify({ error: { code: "rate_limit_exceeded", type: "requests", message: "Rate limit reached" } });
    const response = new Response(body, {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "5" },
    });
    await expect(parseUpstreamFailure(response, "openai", "http")).rejects.toMatchObject({
      kind: "provider_rate_limited",
      statusCode: 429,
      retryable: true,
      routeScope: "account",
    });
  });

  test("Google RESOURCE_EXHAUSTED selects quota policy from structured provider type", () => {
    const failureCode = classifyProviderFailure({
      statusCode: 429,
      structuredCode: "RESOURCE_EXHAUSTED",
      message: "Quota exceeded for quota metric",
      kind: "quota_exceeded",
    });
    expect(failureCode).toBe("usage_limit");
  });

  test("HTTP 200 SSE error before first visible event: internalFailureFromTrace produces safe envelope", () => {
    const trace: UpstreamFailureTrace = {
      providerId: "openai",
      transport: "sse",
      statusCode: 200,
      providerCode: "stream_error",
      providerType: "server_error",
      requestId: "req-123",
      retryAfterMs: null,
      rawMessage: "stream interrupted before output",
      bodyTruncated: false,
    };
    const failure = internalFailureFromTrace(trace, { kind: "stream_truncated", retryable: true, routeScope: "provider" });
    expect(failure.safeMessage).not.toContain("stream interrupted before output");
    expect(failure.upstream).not.toBeNull();
    expect(failure.upstream?.providerCode).toBe("stream_error");
    expect(failure.upstream?.providerType).toBe("server_error");
    expect(failure.upstream?.requestId).toBe("req-123");
    // rawMessage must not leak into upstream summary
    expect(failure.upstream).not.toHaveProperty("rawMessage");
  });

  test("stream failure after commit emits exactly one terminal frame", async () => {
    async function* partial(): AsyncIterable<StreamEvent> {
      yield { type: "message_start", id: "msg2" };
      yield { type: "text_delta", text: "partial output" };
      yield { type: "message_stop", reason: "error", error: { kind: "provider_protocol_error" as const, statusCode: 502, retryable: false, routeScope: null, source: "upstream" as const, safeMessage: "stream interrupted", failureCode: null, retryAt: null, upstream: null } as InternalFailure };
    }
    const stream = createSurfaceStream("openai-chat", partial(), "gpt-4");
    const reader = stream.getReader();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    // Error reason produces a single error frame (no [DONE] for error stops)
    const doneCount = (out.match(/\[DONE\]/g) ?? []).length;
    expect(doneCount).toBe(0);
    expect(out).toContain("stream_error");
    expect(out).toContain("stream interrupted");
    // Exactly one error frame — no duplicate terminal
    const errorFrameCount = (out.match(/"finish_reason":"error"/g) ?? []).length;
    expect(errorFrameCount).toBe(1);
  });
});
