import { describe, expect, test } from "bun:test";
import { parseSseEvents } from "./sse.js"
import { StreamError } from "./sse.js"

const utf8 = new TextEncoder();

function streamFromChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>, maxLineBytes: number = 64 * 1024) {
  const events = [];
  for await (const event of parseSseEvents({ body, maxLineBytes })) events.push(event);
  return events;
}

describe("byte-oriented SSE parser", () => {
  test("preserves UTF-8 code points split across chunks", async () => {
    const bytes = utf8.encode('event: message\ndata: {"text":"🌸"}\n\n');
    const flower = utf8.encode("🌸");
    let flowerOffset = -1;
    for (let index = 0; index <= bytes.length - flower.length; index += 1) {
      if (flower.every((value, offset) => bytes[index + offset] === value)) {
        flowerOffset = index;
        break;
      }
    }
    expect(flowerOffset).toBeGreaterThan(0);
    const split = flowerOffset + 2;
    const events = await collect(streamFromChunks([bytes.slice(0, split), bytes.slice(split)]));
    expect(events).toEqual([{ event: "message", data: '{"text":"🌸"}' }]);
  });

  test("joins multiline data and flushes an unterminated final event", async () => {
    const bytes = utf8.encode("data: first\ndata: second");
    const events = await collect(streamFromChunks([bytes]));
    expect(events).toEqual([{ event: null, data: "first\nsecond" }]);
  });

  test("rejects a line before buffered memory can grow beyond its bound", async () => {
    const body = streamFromChunks([utf8.encode(`data: ${"x".repeat(64)}`)]);
    let error: unknown;
    try {
      await collect(body, 16);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StreamError);
    expect((error as StreamError).message).toContain("SSE line exceeds 16 bytes");
  });
});
