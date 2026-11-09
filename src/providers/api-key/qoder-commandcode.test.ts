import { describe, expect, test } from "bun:test";
import { AbortCoordinator } from "../../proxy/transport/abort.js";
import { STREAM_BOUNDS } from "../../proxy/transport/sse.js"
import { transformQoderStream } from "./qoder.js";
import { transformNdjson } from "./commandcode.js";

function limits() {
  return {
    maxBodyBytes: 10_000_000,
    connectTimeoutMs: 30000,
    firstByteTimeoutMs: 60000,
    idleTimeoutMs: 60000,
    totalTimeoutMs: 600000,
  } as unknown as import("../../proxy/types/content.js").RequestLimits;
}

function sseQoderBody(innerData: string): ReadableStream<Uint8Array> {
  const envelope = JSON.stringify({ statusCodeValue: 200, body: innerData });
  const line = `data: ${envelope}\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(line));
      controller.close();
    },
  });
}

describe("Qoder EOF truncation", () => {
  test("EOF without terminal throws stream_truncated", async () => {
    // inner is a chat delta without finish, no [DONE]
    const inner = JSON.stringify({ choices: [{ delta: { content: "hi" } }] });
    const body = sseQoderBody(inner);
    const coord = new AbortCoordinator(new AbortController().signal, {
      connectTimeoutMs: 30000,
      firstByteTimeoutMs: 60000,
      idleTimeoutMs: 60000,
      totalTimeoutMs: 600000,
    });
    const iter = transformQoderStream(body, coord, limits());
    await expect((async () => { for await (const _ of iter) {} })()).rejects.toMatchObject({ kind: "stream_truncated" });
    coord.dispose();
  });

  test("oversized qoder stream rejected before parsing", async () => {
    const big = new Uint8Array(STREAM_BOUNDS.maxStreamBytes + 10);
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(big); c.close(); },
    });
    const coord = new AbortCoordinator(new AbortController().signal, {});
    const iter = transformQoderStream(body, coord, limits());
    await expect((async () => { for await (const _ of iter) {} })()).rejects.toMatchObject({ kind: "provider_protocol_error" });
    coord.dispose();
  });

  test("cancelled qoder stream propagates client_aborted", async () => {
    const controller = new AbortController();
    const coord = new AbortCoordinator(controller.signal, {});
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } });
    const iter = transformQoderStream(body, coord, limits());
    const pending = iter.next();
    controller.abort();
    const error = await pending.catch((value: unknown) => value);
    expect(["client_aborted", "stream_timeout", "provider_protocol_error"]).toContain((error as { kind?: string }).kind);
    coord.dispose();
  });
});

describe("CommandCode EOF and bounds", () => {
  test("EOF without finish yields synthetic terminal (beta behavior)", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify({ type: "text-delta", text: "a" }) + "\n"));
        c.close();
      },
    });
    const coord = new AbortCoordinator(new AbortController().signal, {});
    const events: import("../../proxy/types/stream.js").StreamEvent[] = [];
    for await (const ev of transformNdjson(body, coord)) events.push(ev);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(events.filter((e) => e.type === "message_stop")).toHaveLength(1);
    coord.dispose();
  });

  test("aborted coordinator rejects stream", async () => {
    const controller = new AbortController();
    const coord = new AbortCoordinator(controller.signal, {});
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } });
    const iter = transformNdjson(body, coord);
    const pending = iter.next();
    controller.abort();
    const error = await pending.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    coord.dispose();
  });

  test("normal NDJSON stream yields text_delta + terminal", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify({ type: "text-delta", text: "hello" }) + "\n"));
        c.enqueue(new TextEncoder().encode(JSON.stringify({ type: "finish", finishReason: "stop" }) + "\n"));
        c.close();
      },
    });
    const coord = new AbortCoordinator(new AbortController().signal, {});
    const events: import("../../proxy/types/stream.js").StreamEvent[] = [];
    for await (const ev of transformNdjson(body, coord)) events.push(ev);
    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(1);
    expect(events.filter((e) => e.type === "message_stop")).toHaveLength(1);
    coord.dispose();
  });
});
