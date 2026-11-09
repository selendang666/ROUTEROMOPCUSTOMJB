import { describe, expect, test } from "bun:test";
import { downgradeForcedToolChoice } from "./repair.js";
import { foldResponseEvents } from "./assembly.js";
import { isProtocolError } from "../errors.js";
import { stringifyToolArguments } from "./repair.js";
import type { StreamEvent } from "../types/stream.js";

describe("foldResponseEvents — tool call correctness", () => {
  test("delta before start is buffered, not emitted as anonymous name", () => {
    const events: StreamEvent[] = [
      { type: "tool_call_delta", callId: "c1", delta: "{\"x\":" },
      { type: "tool_call_start", callId: "c1", name: "search" },
      { type: "tool_call_delta", callId: "c1", delta: "1}" },
      { type: "message_stop", reason: "tool_call" },
    ];
    const folded = foldResponseEvents(events);
    expect(folded.toolCalls.length).toBe(1);
    expect(folded.toolCalls[0]!.name).toBe("search");
    expect(folded.toolCalls[0]!.arguments).toBe("{\"x\":1}");
  });

  test("end without start (orphan) is dropped, not emitted anonymously", () => {
    const events: StreamEvent[] = [
      { type: "tool_call_delta", callId: "ghost", delta: "abc" },
      { type: "tool_call_end", callId: "ghost" },
      { type: "message_stop", reason: "completed" },
    ];
    const folded = foldResponseEvents(events);
    expect(folded.toolCalls.length).toBe(0);
  });

  test("parallel interleaved tool calls keep separate args", () => {
    const events: StreamEvent[] = [
      { type: "tool_call_start", callId: "a", name: "one" },
      { type: "tool_call_start", callId: "b", name: "two" },
      { type: "tool_call_delta", callId: "a", delta: "{\"a\":1}" },
      { type: "tool_call_delta", callId: "b", delta: "{\"b\":2}" },
      { type: "message_stop", reason: "tool_call" },
    ];
    const folded = foldResponseEvents(events);
    expect(folded.toolCalls.map((c) => c.name)).toEqual(["one", "two"]);
    expect(folded.toolCalls[0]!.arguments).toBe("{\"a\":1}");
    expect(folded.toolCalls[1]!.arguments).toBe("{\"b\":2}");
  });

  test("unbounded streamed args throw a bounded ProtocolError, not OOM", () => {
    const big = "x".repeat(50_000);
    const events: StreamEvent[] = [{ type: "tool_call_start", callId: "c", name: "big" }];
    for (let i = 0; i < 20; i += 1) events.push({ type: "tool_call_delta", callId: "c", delta: big });
    events.push({ type: "message_stop", reason: "tool_call" });
    let caught: unknown;
    try { foldResponseEvents(events); } catch (e) { caught = e; }
    expect(isProtocolError(caught)).toBe(true);
    expect((caught as { statusCode: number }).statusCode).toBe(413);
  });
});

describe("stringifyToolArguments — truncation not crash", () => {
  test("oversized string is truncated into parseable JSON envelope", () => {
    const huge = "a".repeat(200_000);
    const out = stringifyToolArguments(huge);
    const parsed = JSON.parse(out) as { __ohmyomop_router_truncated__?: boolean; original_length?: number };
    expect(parsed.__ohmyomop_router_truncated__).toBe(true);
    expect(parsed.original_length).toBe(200_000);
    expect(out.length).toBeLessThanOrEqual(128_000);
  });

  test("small value passes through unchanged", () => {
    expect(stringifyToolArguments("{\"ok\":1}")).toBe("{\"ok\":1}");
  });
});

describe("downgradeForcedToolChoice — capability gate", () => {
  test("required downgraded to auto when forcedChoice false", () => {
    expect(downgradeForcedToolChoice({ kind: "required" }, false)).toEqual({ kind: "auto" });
  });
  test("specific-function object downgraded to auto when unsupported", () => {
    expect(downgradeForcedToolChoice({ kind: "function", name: "f" }, false)).toEqual({ kind: "auto" });
  });
  test("auto/none always preserved", () => {
    expect(downgradeForcedToolChoice({ kind: "auto" }, false)).toEqual({ kind: "auto" });
    expect(downgradeForcedToolChoice({ kind: "none" }, false)).toEqual({ kind: "none" });
  });
  test("no capability signal preserves choice", () => {
    expect(downgradeForcedToolChoice({ kind: "required" }, undefined)).toEqual({ kind: "required" });
  });
  test("supported forced choice preserved", () => {
    expect(downgradeForcedToolChoice({ kind: "required" }, true)).toEqual({ kind: "required" });
  });
});
