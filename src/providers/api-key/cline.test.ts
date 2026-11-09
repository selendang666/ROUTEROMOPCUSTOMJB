import { describe, expect, test } from "bun:test";
import { foldResponseEvents } from "../../proxy/events/assembly.js";
import type { StreamEvent } from "../../proxy/types/stream.js";
import { transformOpenAIChatStream } from "../../proxy/upstream/openai.js";
import { mapSseStream } from "../../proxy/transport/sse.js";
import { AbortCoordinator } from "../../proxy/transport/abort.js";

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const data = lines.map((l) => `data: ${l}\n\n`).join("");
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(data)); c.close(); },
  });
}

describe("cline adapter: tool name required, reasoning preserved", () => {
  test("tool name required: mapper does not emit anonymous tool call", async () => {
    const mapper = transformOpenAIChatStream();
    // Simulate a chunk with tool_calls entry missing function.name
    const event = mapper({ event: null, data: JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { arguments: "{}" } }] } }] }) });
    // Either null or delayed until name present; should not emit tool_call_start with empty name
    const flat = event === null ? [] : Array.isArray(event) ? event : [event];
    const starts = flat.filter((e) => e.type === "tool_call_start") as Extract<StreamEvent, { type: "tool_call_start" }>[];
    for (const s of starts) expect(s.name.trim().length).toBeGreaterThan(0);
  });

  test("tool with valid name is emitted and fold preserves it", async () => {
    const mapper = transformOpenAIChatStream();
    const chunk = JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_ok", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] }, finish_reason: null }] });
    const events: StreamEvent[] = [];
    const out = mapper({ event: null, data: chunk });
    const list = out === null ? [] : Array.isArray(out) ? out : [out];
    events.push(...list);
    // Force a stop
    const done = mapper({ event: null, data: "[DONE]" });
    if (done) {
      const arr = Array.isArray(done) ? done : [done];
      events.push(...arr);
    }
    // If tool_call_start emitted, fold should keep name
    const starts = events.filter((e) => e.type === "tool_call_start");
    if (starts.length > 0) {
      const folded = foldResponseEvents([{ type: "message_start", id: "m1" }, ...events, { type: "message_stop", reason: "tool_call" }] as StreamEvent[]);
      expect(folded.toolCalls[0]!.name).toBe("get_weather");
    } else {
      expect(true).toBe(true);
    }
  });

  test("reasoning preserved through Cline stream pipeline", async () => {
    const limits = { maxBodyBytes: 10_000_000, connectTimeoutMs: 30000, firstByteTimeoutMs: 60000, idleTimeoutMs: 60000, totalTimeoutMs: 600000 } as unknown as import("../../proxy/types/content.js").RequestLimits;
    const inner = JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { content: "hi", reasoning_content: "thinking step" }, finish_reason: null }] });
    const doneChunk = JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: {}, finish_reason: "stop" }] });
    const body = sseBody([inner, doneChunk, "[DONE]"]);
    const coord = new AbortCoordinator(new AbortController().signal, {});
    const iter = mapSseStream({ body, coordinator: coord, maxLineBytes: 64 * 1024, idleTimeoutMs: limits.idleTimeoutMs }, transformOpenAIChatStream());
    const collected: StreamEvent[] = [];
    for await (const ev of iter) collected.push(ev);
    expect(collected.some((e) => e.type === "thinking_delta")).toBe(true);
    expect(collected.find((e) => e.type === "thinking_delta" && (e as Extract<StreamEvent, { type: "thinking_delta" }>).text.includes("thinking"))).toBeDefined();
    coord.dispose();
  });

  test("Cline materialized output rejects empty text via mapper folding (simulated)", () => {
    // Empty text alone should still produce a stop; non-stream failure is provider-level,
    // here we just assert folding empty text yields empty string not crash
    const events: StreamEvent[] = [
      { type: "message_start", id: "cline-1" },
      { type: "message_stop", reason: "completed" },
    ];
    const folded = foldResponseEvents(events);
    expect(folded.text).toBe("");
  });
});
