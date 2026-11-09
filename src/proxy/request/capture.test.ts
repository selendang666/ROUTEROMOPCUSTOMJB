import { describe, expect, test } from "bun:test";
import { createPayloadCapture, MAX_CAPTURE_BYTES } from "./capture.js";

describe("bounded payload capture", () => {
  test("redacts large structured payloads without parsing or copying the whole body", () => {
    let artifact: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number } | null = null;
    const capture = createPayloadCapture("trace-1", {
      save(_requestId, _kind, value) {
        artifact = value;
      },
    });
    const large = `${"x".repeat(2 * 1024 * 1024)} token=secret-after-boundary`;
    capture.request({ messages: [{ role: "user", content: large }], authorization: "Bearer top-secret" });
    expect(artifact).not.toBeNull();
    expect(artifact?.truncated).toBe(true);
    expect(artifact?.capturedBytes).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(artifact?.originalBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(artifact?.text).not.toContain("secret-after-boundary");
    expect(artifact?.text).not.toContain("top-secret");
  });

  test("response tee captures at most the bounded prefix while preserving the stream", async () => {
    let artifact: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number } | null = null;
    const capture = createPayloadCapture("trace-2", {
      save(_requestId, _kind, value) {
        artifact = value;
      },
    });
    const body = new TextEncoder().encode(`${"a".repeat(2 * 1024 * 1024)} token=provider-secret`);
    const response = capture.observeResponse(new Response(body));
    const received = new Uint8Array(await response.arrayBuffer());
    await capture.settle();
    expect(received.byteLength).toBe(body.byteLength);
    expect(artifact?.truncated).toBe(true);
    expect(artifact?.capturedBytes).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(artifact?.text).not.toContain("provider-secret");
  });
});
