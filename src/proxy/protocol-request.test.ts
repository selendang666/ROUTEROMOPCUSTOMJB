import { describe, expect, test } from "bun:test";
import {
  BoundedBodyTooLargeError,
  groupToolResults,
  jsonObject,
  messageText,
  normalizeFail,
  normalizeOk,
  orderedToolResultParts,
  readBoundedBytes,
  readBoundedJson,
  toRequestDocument,
  visibleMessageText,
  visibleTextParts,
} from "./protocol-request.js";
import type { NormalizedMessage } from "./types/content.js";
import type { ProxyRequest } from "./types/request.js";

function msg(content: NormalizedMessage["content"]): NormalizedMessage {
  return { role: "user", content } as NormalizedMessage;
}

describe("normalizeOk / normalizeFail", () => {
  test("normalizeOk wraps request", () => {
    const req = { model: "m" } as unknown as ProxyRequest;
    const r = normalizeOk(req);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request).toBe(req);
  });
  test("normalizeFail wraps error", () => {
    const err = { kind: "invalid_request", statusCode: 400, safeMessage: "bad", retryable: false, routeScope: null, retryAt: null, field: "model" } as const;
    const r = normalizeFail(err as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("model");
  });
});

describe("messageText / visible helpers", () => {
  test("joins text blocks with newline", () => {
    const m = msg([{ type: "text", text: "hello" } as never, { type: "text", text: "world" } as never]);
    expect(messageText(m)).toBe("hello\nworld");
  });
  test("ignores non-text blocks", () => {
    const m = msg([{ type: "text", text: "hi" } as never, { type: "image", image: { kind: "url", value: "https://x", mediaType: null } } as never]);
    expect(messageText(m)).toBe("hi");
  });
  test("empty content yields empty string", () => {
    expect(messageText(msg([]))).toBe("");
  });
  test("visibleTextParts returns only text strings", () => {
    const m = msg([{ type: "text", text: "a" } as never, { type: "reasoning", reasoningText: "r" } as never]);
    expect(visibleTextParts(m)).toEqual(["a"]);
  });
  test("visibleMessageText delegates to messageText", () => {
    const m = msg([{ type: "text", text: "x" } as never]);
    expect(visibleMessageText(m)).toBe(messageText(m));
  });
});

describe("jsonObject", () => {
  test("object passthrough", () => {
    expect(jsonObject({ a: 1 })).toEqual({ a: 1 });
  });
  test("valid JSON string parsed", () => {
    expect(jsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  test("non-object JSON returns {}", () => {
    expect(jsonObject("[1,2]")).toEqual({});
    expect(jsonObject("123")).toEqual({});
  });
  test("invalid JSON returns {}", () => {
    expect(jsonObject("{bad")).toEqual({});
  });
  test("non-string non-object returns {}", () => {
    expect(jsonObject(42)).toEqual({});
    expect(jsonObject(null)).toEqual({});
  });
});

describe("groupToolResults / orderedToolResultParts", () => {
  test("groups by toolCallId preserving order", () => {
    const blocks = [
      { type: "tool_result", toolCallId: "a", text: "1" },
      { type: "tool_result", toolCallId: "b", text: "2" },
      { type: "tool_result", toolCallId: "a", text: "3" },
      { type: "text", text: "hi" },
    ] as unknown as NormalizedMessage["content"];
    const grouped = groupToolResults(blocks);
    expect(grouped.get("a")?.length).toBe(2);
    expect(grouped.get("b")?.length).toBe(1);
  });
  test("orderedToolResultParts filters tool_result only", () => {
    const m = msg([{ type: "tool_result", toolCallId: "a", text: "1" } as never, { type: "text", text: "x" } as never]);
    expect(orderedToolResultParts(m).length).toBe(1);
  });
});

describe("toRequestDocument", () => {
  function makeRequest(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
    return {
      model: "gpt-4",
      messages: [msg([{ type: "text", text: "hi" } as never])],
      tools: [],
      reasoning: "none",
      responseFormat: { kind: "text" },
      maxOutputTokens: null,
      images: [],
      sourceSurface: "openai-chat",
      stream: false,
      limits: { maxBodyBytes: 1024, connectTimeoutMs: 1000, firstByteTimeoutMs: 1000, idleTimeoutMs: 10000, totalTimeoutMs: 60000 },
      ...overrides,
    } as unknown as ProxyRequest;
  }

  test("maps canonical fields and dispositions", () => {
    const doc = toRequestDocument(makeRequest());
    expect(doc.model).toBe("gpt-4");
    expect(doc.messages.length).toBe(1);
    expect(doc.source.surface).toBe("openai-chat");
    expect(doc.dispositions.some((d) => d.path === "model")).toBe(true);
  });

  test("includes wirePayload disposition when present", () => {
    const req = makeRequest({ wirePayload: { model: "gpt-4" } } as Partial<ProxyRequest>);
    const doc = toRequestDocument(req);
    expect(doc.dispositions.some((d) => d.path === "wirePayload")).toBe(true);
  });

  test("passes through optional metadata and extensions", () => {
    const doc = toRequestDocument(makeRequest({ metadataUserId: "u-1" } as Partial<ProxyRequest>), { extensions: { foo: "bar" } });
    expect(doc.metadata.userId).toBe("u-1");
    expect(doc.extensions.foo).toBe("bar");
  });
});

describe("readBoundedBytes / readBoundedJson", () => {
  test("reads JSON within limit", async () => {
    const req = new Request("http://x", { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "content-type": "application/json" } });
    const r = await readBoundedJson(req, 10_000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const value = r.value as unknown as Record<string, unknown>;
      expect(value.a).toBe(1);
    }
  });

  test("returns too_large when content-length exceeds max", async () => {
    const req = new Request("http://x", { method: "POST", body: "hi", headers: { "content-length": "99999" } });
    const r = await readBoundedBytes(req, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_large");
  });

  test("returns invalid for malformed JSON", async () => {
    const req = new Request("http://x", { method: "POST", body: "{bad json", headers: { "content-type": "application/json" } });
    const r = await readBoundedJson(req, 10_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid");
  });

  test("returns invalid when body is null", async () => {
    const req = new Request("http://x", { method: "GET" });
    const r = await readBoundedBytes(req, 10_000);
    expect(r.ok).toBe(false);
  });

  test("BoundedBodyTooLargeError has correct name", () => {
    const e = new BoundedBodyTooLargeError();
    expect(e.name).toBe("BoundedBodyTooLargeError");
  });
});
