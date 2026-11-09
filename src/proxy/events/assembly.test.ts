import { describe, expect, test } from "bun:test";
import { foldResponseEvents, orderedResponseItems } from "./assembly.js";
import { translateNonStreamResponse } from "../translate/cross-surface.js";
import type { StreamEvent } from "../types/stream.js";

function ev(...events: StreamEvent[]): StreamEvent[] {
  return events;
}

describe("foldResponseEvents validation", () => {
  test("empty tool name -> provider_protocol_error", () => {
    const events: StreamEvent[] = [
      { type: "message_start", id: "resp_1" },
      { type: "tool_call_start", callId: "call_1", name: "" },
      { type: "message_stop", reason: "completed" },
    ];
    expect(() => foldResponseEvents(events)).toThrow();
    try {
      foldResponseEvents(events);
    } catch (e) {
      expect((e as { kind?: string }).kind ?? (e as { message?: string }).message).toMatch(/provider_protocol_error|missing name/i);
    }
  });

  test("empty callId -> provider_protocol_error", () => {
    const events: StreamEvent[] = [
      { type: "message_start", id: "resp_2" },
      { type: "tool_call_start", callId: "", name: "search" },
      { type: "message_stop", reason: "completed" },
    ];
    expect(() => foldResponseEvents(events)).toThrow();
  });

  test("valid tool_call_start is accepted", () => {
    const events: StreamEvent[] = [
      { type: "message_start", id: "resp_ok" },
      { type: "tool_call_start", callId: "call_ok", name: "get_weather" },
      { type: "tool_call_delta", callId: "call_ok", delta: '{"city":"Paris"}' },
      { type: "tool_call_end", callId: "call_ok" },
      { type: "message_stop", reason: "tool_call" },
    ];
    const folded = foldResponseEvents(events);
    expect(folded.toolCalls).toHaveLength(1);
    expect(folded.toolCalls[0]!.name).toBe("get_weather");
    expect(folded.toolCalls[0]!.arguments).toBe('{"city":"Paris"}');
  });

  test("tool ordering preserved (insertion order)", () => {
    const events: StreamEvent[] = [
      { type: "message_start", id: "id1" },
      { type: "tool_call_start", callId: "a", name: "tool_a" },
      { type: "tool_call_start", callId: "b", name: "tool_b" },
      { type: "tool_call_start", callId: "c", name: "tool_c" },
      { type: "message_stop", reason: "tool_call" },
    ];
    const folded = foldResponseEvents(events);
    expect(folded.toolCalls.map((c) => c.callId)).toEqual(["a", "b", "c"]);
  });

  test("extended events are tolerated (native_block, compaction, server_tool)", () => {
    const events: StreamEvent[] = [
      { type: "message_start", id: "id_ext" },
      { type: "text_delta", text: "hello " },
      { type: "native_block_start", index: 0, block: { type: "image", url: "x" } },
      { type: "native_block_delta", index: 0, delta: { data: "abc" } },
      { type: "native_block_stop", index: 0 },
      { type: "server_tool_result", block: { tool: "search", result: "ok" } },
      { type: "compaction_start" },
      { type: "compaction_delta", text: "compacted" },
      { type: "compaction_stop" },
      { type: "context_item", phase: "added", outputIndex: 0, item: { type: "context" } },
      { type: "text_delta", text: "world" },
      { type: "message_stop", reason: "completed" },
    ];
    const folded = foldResponseEvents(events);
    expect(folded.text).toBe("hello world");
    // extended events should not throw and not corrupt text
    expect(folded.reason).toBe("completed");
  });

  test("orderedResponseItems preserves arrival interleaving", () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "thinking " },
      { type: "text_delta", text: "answer" },
      { type: "tool_call_start", callId: "call_1", name: "search" },
      { type: "tool_call_delta", callId: "call_1", delta: '{"q":"hi"}' },
      { type: "tool_call_end", callId: "call_1" },
      { type: "message_stop", reason: "completed" },
    ];
    const items = orderedResponseItems(events);
    expect(items.map((i) => i.kind)).toEqual(["thinking", "text", "tool_call"]);
    expect(items[2]!.kind).toBe("tool_call");
    if (items[2]!.kind === "tool_call") {
      expect(items[2]!.arguments).toBe('{"q":"hi"}');
    }
  });
});

describe("Responses <-> Messages non-stream translation", () => {
  test("openai-chat -> openai-responses non-stream translation", () => {
    const body: Record<string, unknown> = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 123,
      model: "gpt-4",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const out = translateNonStreamResponse(body, "openai-chat", "openai-responses", "gpt-4");
    expect(out).toHaveProperty("object", "response");
    expect((out as { output_text?: string }).output_text).toBe("hello");
  });

  test("openai-chat -> anthropic-messages non-stream translation", () => {
    const body: Record<string, unknown> = {
      id: "chatcmpl-2",
      object: "chat.completion",
      created: 123,
      model: "gpt-4",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    };
    const out = translateNonStreamResponse(body, "openai-chat", "anthropic-messages", "gpt-4");
    expect(out).toHaveProperty("type", "message");
    expect((out as { content: unknown[] }).content).toBeDefined();
  });

  test("openai-responses -> openai-chat non-stream translation", () => {
    const body: Record<string, unknown> = {
      id: "resp_1",
      object: "response",
      created_at: 123,
      status: "completed",
      model: "gpt-4",
      output: [{ type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] }],
      output_text: "hello",
    };
    const out = translateNonStreamResponse(body, "openai-responses", "openai-chat", "gpt-4");
    expect(out).toHaveProperty("object", "chat.completion");
  });

  test("anthropic-messages -> openai-chat non-stream translation", () => {
    const body: Record<string, unknown> = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const out = translateNonStreamResponse(body, "anthropic-messages", "openai-chat", "claude-3-5-sonnet");
    expect(out).toHaveProperty("object", "chat.completion");
  });

  test("Responses <-> Messages missing direct edge throws capability_unsupported (current impl)", () => {
    const respBody: Record<string, unknown> = {
      id: "resp_x",
      object: "response",
      created_at: 123,
      status: "completed",
      model: "gpt-4",
      output: [{ type: "message", id: "msg-x", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] }],
      output_text: "hi",
    };
    // This edge is not registered in current impl; it should throw capability_unsupported
    let threw = false;
    try {
      translateNonStreamResponse(respBody, "openai-responses", "anthropic-messages", "gpt-4");
    } catch (e) {
      threw = true;
      expect((e as { kind?: string }).kind ?? String(e)).toMatch(/capability_unsupported/);
    }
    const anthBody: Record<string, unknown> = {
      id: "msg_y",
      type: "message",
      role: "assistant",
      model: "claude-3",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    let threw2 = false;
    try {
      translateNonStreamResponse(anthBody, "anthropic-messages", "openai-responses", "claude-3");
    } catch (e) {
      threw2 = true;
      expect((e as { kind?: string }).kind ?? String(e)).toMatch(/capability_unsupported/);
    }
    // At least one direction should throw with current registry
    expect(threw || threw2).toBe(true);
  });
});
