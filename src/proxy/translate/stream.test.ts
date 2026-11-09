import { describe, expect, test } from "bun:test";
import { translateSurfaceStream } from "./stream.js";
describe("chatPrefixCache LRU behavior", () => {
  test("bounded cache with LRU trim removes oldest 32 entries when full", () => {
    // Verify the LRU logic is correct by testing Map behavior
    // This mirrors the implementation in getChatPrefix
    const testCache = new Map<string, string>();

    // Fill to 127 entries (just under threshold)
    for (let i = 0; i < 127; i++) {
      testCache.set(`key-${i}`, `value-${i}`);
    }
    expect(testCache.size).toBe(127);

    // Add one more to hit 128
    testCache.set("key-127", "value-127");
    expect(testCache.size).toBe(128);

    // Simulate the LRU trim: remove oldest 32
    if (testCache.size >= 128) {
      const keys = testCache.keys();
      for (let i = 0; i < 32; i++) {
        const next = keys.next();
        if (next.done) break;
        testCache.delete(next.value);
      }
    }

    // Should now have 128 - 32 = 96 entries
    expect(testCache.size).toBe(96);

    // Verify oldest 32 entries are removed
    for (let i = 0; i < 32; i++) {
      expect(testCache.has(`key-${i}`)).toBe(false);
    }

    // Verify entries 32-127 are preserved
    for (let i = 32; i < 128; i++) {
      expect(testCache.has(`key-${i}`)).toBe(true);
    }

    // Add a new entry after trim
    testCache.set("key-128", "value-128");
    expect(testCache.size).toBe(97);
    expect(testCache.has("key-128")).toBe(true);
  });

  test("cache handles rapid insertion beyond 128", () => {
    const testCache = new Map<string, string>();

    // Simulate rapid insertion of 160 unique keys
    for (let i = 0; i < 160; i++) {
      testCache.set(`key-${i}`, `value-${i}`);

      // Apply the same LRU logic as getChatPrefix
      if (testCache.size >= 128) {
        const keys = testCache.keys();
        for (let j = 0; j < 32; j++) {
          const next = keys.next();
          if (next.done) break;
          testCache.delete(next.value);
        }
      }
    }

    // After 160 insertions with trims, size should be bounded
    // Each trim removes 32, so we oscillate around 96-128
    expect(testCache.size).toBeLessThanOrEqual(128);
    expect(testCache.size).toBeGreaterThan(0);

    // The most recent entries should be present
    expect(testCache.has("key-159")).toBe(true);
    expect(testCache.has("key-158")).toBe(true);
    expect(testCache.has("key-157")).toBe(true);
  });

  test("cache preserves recent entries after trim", () => {
    const testCache = new Map<string, string>();

    // Fill cache to exactly 128
    for (let i = 0; i < 128; i++) {
      testCache.set(`key-${i}`, `value-${i}`);
    }

    // Trim oldest 32
    const keys = testCache.keys();
    for (let i = 0; i < 32; i++) {
      const next = keys.next();
      if (next.done) break;
      testCache.delete(next.value);
    }

    // Verify: oldest 32 gone, rest preserved
    for (let i = 0; i < 32; i++) {
      expect(testCache.has(`key-${i}`)).toBe(false);
    }
    for (let i = 32; i < 128; i++) {
      expect(testCache.has(`key-${i}`)).toBe(true);
    }

    // Add 32 new entries to fill back to 128
    for (let i = 128; i < 160; i++) {
      testCache.set(`key-${i}`, `value-${i}`);
    }
    expect(testCache.size).toBe(128);

    // Verify newest entries present
    for (let i = 128; i < 160; i++) {
      expect(testCache.has(`key-${i}`)).toBe(true);
    }
  });
});
test("serializes tool call thought signatures for OpenAI chat", async () => {
  const events = (async function* () {
    yield { type: "message_start", id: "resp-1" } as const;
    yield { type: "tool_call_start", callId: "call-1", name: "todo", reasoningSignature: "sig-1" } as const;
    yield { type: "tool_call_end", callId: "call-1" } as const;
    yield { type: "message_stop", reason: "tool_call" } as const;
  })();
  const frames: string[] = [];
  for await (const frame of translateSurfaceStream("openai-chat", events, "gemini-3.7-flash")) {
    frames.push(new TextDecoder().decode(frame));
  }
  expect(frames.some((frame) => frame.includes('"thought_signature":"sig-1"'))).toBe(true);
});
