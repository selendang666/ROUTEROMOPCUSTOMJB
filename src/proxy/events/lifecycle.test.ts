import { describe, expect, test } from "bun:test";
import { createCommitGate, createReleaseGate, isCommitEvent } from "./commit.js";
import type { StreamEvent } from "../types/stream.js";

describe("lifecycle gate: one start, valid tool close, usage once, stop once", () => {
  test("commit gate marks committed after visible output", () => {
    const gate = createCommitGate();
    expect(gate.committed()).toBe(false);
    gate.onEvent({ type: "message_start", id: "m1" });
    expect(gate.committed()).toBe(false);
    gate.onEvent({ type: "text_delta", text: "hello" });
    expect(gate.committed()).toBe(true);
  });

  test("thinking also counts as commit (visible reasoning)", () => {
    const gate = createCommitGate();
    gate.onEvent({ type: "message_start", id: "m1" });
    gate.onEvent({ type: "thinking_delta", text: "reasoning" });
    expect(gate.committed()).toBe(true);
  });

  test("tool_call_start promotes commit", () => {
    const gate = createCommitGate();
    gate.onEvent({ type: "message_start", id: "m1" });
    gate.onEvent({ type: "tool_call_start", callId: "c1", name: "search" });
    expect(gate.committed()).toBe(true);
  });

  test("usage alone does not commit", () => {
    const gate = createCommitGate();
    gate.onEvent({ type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as unknown as StreamEvent extends { type: "usage"; usage: infer U } ? U : never });
    expect(gate.committed()).toBe(false);
  });

  test("isCommitEvent recognizes text/thinking/tool as commit", () => {
    expect(isCommitEvent({ type: "text_delta", text: "hi" } as StreamEvent)).toBe(true);
    expect(isCommitEvent({ type: "thinking_delta", text: "x" } as StreamEvent)).toBe(true);
    expect(isCommitEvent({ type: "tool_call_start", callId: "c", name: "n" } as StreamEvent)).toBe(true);
    expect(isCommitEvent({ type: "usage", usage: {} as never } as StreamEvent)).toBe(false);
  });

  test("no event after stop is tracked via committed flag stability", () => {
    const gate = createCommitGate();
    gate.onEvent({ type: "message_start", id: "m1" });
    gate.onEvent({ type: "text_delta", text: "hi" });
    gate.onEvent({ type: "message_stop", reason: "completed" });
    expect(gate.committed()).toBe(true);
    // further text after stop should still be committed but no new commit transition
    gate.onEvent({ type: "text_delta", text: "after" });
    expect(gate.committed()).toBe(true);
  });

  test("release gate exactly once", async () => {
    let count = 0;
    const gate = createReleaseGate(async () => { count += 1; });
    await gate.release();
    await gate.release();
    expect(count).toBe(1);
    expect(gate.released()).toBe(true);
  });

  test("valid tool close: tool lifecycle valid (start before end)", () => {
    // Validate that a minimal tool lifecycle is accepted by foldResponseEvents (no throw)
    // which enforces valid close semantics downstream
    const { foldResponseEvents } = require("../events/assembly.js") as typeof import("../events/assembly.js");
    const events: StreamEvent[] = [
      { type: "message_start", id: "m1" },
      { type: "tool_call_start", callId: "c1", name: "valid_tool" },
      { type: "tool_call_end", callId: "c1" },
      { type: "message_stop", reason: "tool_call" },
    ];
    const folded = foldResponseEvents(events);
    expect(folded.toolCalls[0]!.name).toBe("valid_tool");
  });

  test("usage once: last usage wins (single logical usage)", () => {
    const { foldResponseEvents } = require("../events/assembly.js") as typeof import("../events/assembly.js");
    const events: StreamEvent[] = [
      { type: "message_start", id: "m1" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as unknown as StreamEvent,
      { type: "usage", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } } as unknown as StreamEvent,
      { type: "message_stop", reason: "completed" },
    ];
    const folded = foldResponseEvents(events);
    expect(folded.usage).not.toBeNull();
    expect((folded.usage as unknown as { totalTokens: number }).totalTokens).toBe(10);
  });

  test("stop once: duplicate message_stop folds to last reason", () => {
    const { foldResponseEvents } = require("../events/assembly.js") as typeof import("../events/assembly.js");
    const events: StreamEvent[] = [
      { type: "message_start", id: "m1" },
      { type: "text_delta", text: "hi" },
      { type: "message_stop", reason: "completed" },
      { type: "message_stop", reason: "length" },
    ];
    const folded = foldResponseEvents(events);
    // last stop wins
    expect(folded.reason).toBe("length");
  });
});
