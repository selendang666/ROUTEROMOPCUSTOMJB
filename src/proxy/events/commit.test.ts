import { describe, expect, test } from "bun:test";
import {
  classifyTerminal,
  createCommitGate,
  createReleaseGate,
  isCommitEvent,
  recoverCall,
  shouldRetryAfterCommit,
  wrapWithRelease,
  writeErrorResponse,
  writeResponse,
} from "./commit.js";
import type { StreamEvent } from "../types/stream.js";
import type { ProviderOutput } from "../types/request.js";
import type { InternalFailure } from "../types/error-types.js";

function ev(type: StreamEvent["type"], extra: Record<string, unknown> = {}): StreamEvent {
  return { type, ...extra } as unknown as StreamEvent;
}

describe("isCommitEvent", () => {
  test("commit types return true", () => {
    expect(isCommitEvent(ev("text_delta", { text: "hi" }))).toBe(true);
    expect(isCommitEvent(ev("thinking_delta", { text: "think" }))).toBe(true);
    expect(isCommitEvent(ev("tool_call_start", { callId: "c1", name: "fn" }))).toBe(true);
    expect(isCommitEvent(ev("tool_call_delta", { callId: "c1", delta: "{}" }))).toBe(true);
    expect(isCommitEvent(ev("tool_call_end", { callId: "c1" }))).toBe(true);
    expect(isCommitEvent(ev("message_stop", { reason: "completed" }))).toBe(true);
    expect(isCommitEvent(ev("native_block_start", { index: 0, block: {} }))).toBe(true);
    expect(isCommitEvent(ev("native_block_delta", { index: 0, delta: {} }))).toBe(true);
    expect(isCommitEvent(ev("native_block_stop", { index: 0 }))).toBe(true);
    expect(isCommitEvent(ev("server_tool_result", { block: {} }))).toBe(true);
    expect(isCommitEvent(ev("context_item", { phase: "added", outputIndex: 0, item: {} }))).toBe(true);
  });

  test("non-commit types return false", () => {
    expect(isCommitEvent(ev("message_start", { id: "m1" }))).toBe(false);
    expect(isCommitEvent(ev("usage", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }))).toBe(false);
  });
});

describe("classifyTerminal", () => {
  test("error => failed non-retryable", () => {
    expect(classifyTerminal("error")).toEqual({ status: "failed", retryable: false });
  });
  test("length/content_filter => incomplete", () => {
    expect(classifyTerminal("length").status).toBe("incomplete");
    expect(classifyTerminal("content_filter").status).toBe("incomplete");
  });
  test("completed/tool_call => completed", () => {
    expect(classifyTerminal("completed").status).toBe("completed");
    expect(classifyTerminal("tool_call").status).toBe("completed");
  });
});

describe("shouldRetryAfterCommit", () => {
  test("committed prevents retry even if retryable", () => {
    expect(shouldRetryAfterCommit(true, { retryable: true })).toBe(false);
  });
  test("not committed + retryable => true", () => {
    expect(shouldRetryAfterCommit(false, { retryable: true })).toBe(true);
  });
  test("not committed + not retryable => false", () => {
    expect(shouldRetryAfterCommit(false, { retryable: false })).toBe(false);
    expect(shouldRetryAfterCommit(false, {})).toBe(false);
  });
});

describe("createCommitGate exactly-once", () => {
  test("not committed until commit event", () => {
    const gate = createCommitGate();
    expect(gate.committed()).toBe(false);
    gate.onEvent(ev("message_start", { id: "1" }));
    expect(gate.committed()).toBe(false);
    gate.onEvent(ev("text_delta", { text: "hi" }));
    expect(gate.committed()).toBe(true);
  });

  test("once committed stays committed", () => {
    const gate = createCommitGate();
    gate.onEvent(ev("text_delta", { text: "x" }));
    expect(gate.committed()).toBe(true);
    gate.onEvent(ev("usage", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }));
    expect(gate.committed()).toBe(true);
  });

  test("onEvent returns committed flag", () => {
    const gate = createCommitGate();
    expect(gate.onEvent(ev("message_start", { id: "1" }))).toBe(false);
    expect(gate.onEvent(ev("tool_call_start", { callId: "c", name: "fn" }))).toBe(true);
  });
});

describe("createReleaseGate exactly-once", () => {
  test("release called exactly once despite repeated calls", async () => {
    let calls = 0;
    const gate = createReleaseGate(async () => { calls++; });
    expect(gate.released()).toBe(false);
    await gate.release();
    expect(gate.released()).toBe(true);
    await gate.release();
    await gate.release();
    expect(calls).toBe(1);
  });

  test("concurrent releases share same promise", async () => {
    let calls = 0;
    const gate = createReleaseGate(async () => { calls++; });
    const p1 = gate.release();
    const p2 = gate.release();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });
});

describe("wrapWithRelease", () => {
  test("releases after iteration completes", async () => {
    let released = false;
    async function* gen() { yield 1; yield 2; }
    const wrapped = wrapWithRelease(gen(), async () => { released = true; });
    const out: number[] = [];
    for await (const v of wrapped) out.push(v);
    expect(out).toEqual([1, 2]);
    expect(released).toBe(true);
  });

  test("releases on throw", async () => {
    let released = false;
    async function* gen() { yield 1; throw new Error("fail"); }
    const wrapped = wrapWithRelease(gen(), async () => { released = true; });
    await expect(async () => { for await (const _ of wrapped) {} }).toThrow();
    expect(released).toBe(true);
  });

  test("onError called when release throws after primary error", async () => {
    let onErrorCalled = false;
    async function* gen() { yield 1; throw new Error("primary"); }
    const wrapped = wrapWithRelease(gen(), async () => { throw new Error("release fail"); }, () => { onErrorCalled = true; });
    await expect(async () => { for await (const _ of wrapped) {} }).toThrow("primary");
    expect(onErrorCalled).toBe(true);
  });
});

describe("recoverCall", () => {
  test("succeeds on first attempt without retry", async () => {
    let attempts = 0;
    const result = await recoverCall({
      signal: new AbortController().signal,
      maxAttempts: 3,
      attempt: async () => { attempts++; return { mode: "non_stream", body: { ok: true } } as unknown as ProviderOutput; },
    });
    expect(attempts).toBe(1);
    expect(result.mode).toBe("non_stream");
  });

  test("retries on retryable error and eventually succeeds", async () => {
    let calls = 0;
    const result = await recoverCall({
      signal: new AbortController().signal,
      maxAttempts: 3,
      attempt: async () => {
        calls++;
        if (calls < 3) throw { kind: "provider_unavailable", retryable: true, retryAt: null, safeMessage: "retry", statusCode: 502, routeScope: null };
        return { mode: "non_stream", body: { ok: true } } as unknown as ProviderOutput;
      },
    });
    expect(calls).toBe(3);
    expect(result.mode).toBe("non_stream");
  });

  test("does not retry non-retryable error", async () => {
    let calls = 0;
    await expect(
      recoverCall({
        signal: new AbortController().signal,
        maxAttempts: 3,
        attempt: async () => { calls++; throw { kind: "invalid_request", retryable: false, retryAt: null, safeMessage: "bad", statusCode: 400, routeScope: null }; },
      }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    expect(calls).toBe(1);
  });

  test("aborted signal throws client_aborted immediately", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      recoverCall({
        signal: ctrl.signal,
        maxAttempts: 3,
        attempt: async () => ({ mode: "non_stream", body: {} } as unknown as ProviderOutput),
      }),
    ).rejects.toMatchObject({ kind: "client_aborted" });
  });

  test("respects maxAttempts boundary", async () => {
    let calls = 0;
    await expect(
      recoverCall({
        signal: new AbortController().signal,
        maxAttempts: 2,
        attempt: async () => { calls++; throw { kind: "provider_unavailable", retryable: true, retryAt: null, safeMessage: "r", statusCode: 502, routeScope: null }; },
      }),
    ).rejects.toMatchObject({ kind: "provider_unavailable" });
    expect(calls).toBe(2);
  });

  test("onFailure and mapError hooks are invoked", async () => {
    let mapped = false;
    let failed = 0;
    await expect(
      recoverCall({
        signal: new AbortController().signal,
        maxAttempts: 1,
        attempt: async () => { throw new Error("raw"); },
        mapError: (e) => { mapped = true; return { kind: "provider_unavailable", retryable: false, retryAt: null, safeMessage: String(e), statusCode: 502, routeScope: null } as unknown as InternalFailure; },
        onFailure: async () => { failed++; },
      }),
    ).rejects.toMatchObject({ kind: "provider_unavailable" });
    expect(mapped).toBe(true);
    expect(failed).toBe(1);
  });
});

describe("writeErrorResponse / writeResponse", () => {
  test("writeErrorResponse formats public error", () => {
    const res = writeErrorResponse({ kind: "invalid_request", safeMessage: "bad request", statusCode: 400, retryable: false, routeScope: null } as unknown as InternalFailure, "req-1");
    expect(res.status).toBe(400);
    expect(res.headers.get("x-request-id")).toBe("req-1");
    expect(res.body.mode).toBe("json");
  });

  test("writeErrorResponse preserves upstream code when available", () => {
    const res = writeErrorResponse({
      kind: "provider_protocol_error",
      safeMessage: "Provider returned an invalid response.",
      statusCode: 502,
      retryable: false,
      routeScope: null,
      upstream: { providerId: "anthropic", transport: "http", statusCode: 502, providerCode: "provider_unavailable", providerType: "error", requestId: "up-1", retryAfterMs: null, bodyTruncated: false },
      failureCode: "provider_finish_error",
    } as unknown as InternalFailure, "req-2");
    expect(res.body.mode).toBe("json");
    if (res.body.mode === "json") {
      expect((res.body.value as { error: { code: string | null; message: string } }).error.code).toBe("provider_unavailable");
      expect((res.body.value as { error: { code: string | null; message: string } }).error.message).toBe("Provider returned an invalid response.");
    }
  });

  test("writeResponse for stream sets event-stream headers", () => {
    async function* evs() { yield { type: "text_delta", text: "hi" } as StreamEvent; }
    const res = writeResponse({ mode: "stream", events: evs() }, "req-2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.body.mode).toBe("stream");
  });

  test("writeResponse for json sets json headers", () => {
    const res = writeResponse({ mode: "non_stream", body: { id: "1" } }, "req-3");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
