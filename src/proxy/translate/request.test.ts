import { describe, expect, test } from "bun:test";
import { buildChatPayload, buildResponsesPayload, toOpenAIImageUrl } from "./request.js";
import type { ProxyRequest } from "../types/request.js";

const limits = {
  maxBodyBytes: 1_000_000,
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
};

function request(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    model: "gpt-4",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    stream: false,
    responseFormat: { kind: "text" },
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits,
    ...overrides,
  };
}

describe("buildChatPayload", () => {
  test("builds minimal chat payload", () => {
    const payload = buildChatPayload(request());
    expect(payload.model).toBe("gpt-4");
    expect(payload.stream).toBe(false);
    expect(Array.isArray(payload.messages)).toBe(true);
    const msgs = payload.messages as Array<{ role: string }>;
    expect(msgs[0]?.role).toBe("user");
  });

  test("maps system message", () => {
    const payload = buildChatPayload(
      request({ messages: [{ role: "system", content: [{ type: "text", text: "sys" }] }] }),
    );
    const msgs = payload.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toBe("sys");
  });

  test("maps tools to OpenAI function tools", () => {
    const payload = buildChatPayload(
      request({ tools: [{ kind: "function", name: "fn", description: "desc", inputSchema: { type: "object" } }] }),
    );
    const tools = payload.tools as Array<{ type: string; function: { name: string } }>;
    expect(tools[0]?.type).toBe("function");
    expect(tools[0]?.function.name).toBe("fn");
  });

  test("throws on non-function tool kind", () => {
    expect(() =>
      buildChatPayload(request({ tools: [{ kind: "hosted", hostedType: "web_search" } as never] })),
    ).toThrow();
  });

  test("includes max_tokens when set", () => {
    const payload = buildChatPayload(request({ maxOutputTokens: 256 }));
    expect(payload.max_tokens).toBe(256);
  });

  test("includes reasoning_effort when enabled", () => {
    const payload = buildChatPayload(request({ reasoning: "enabled", reasoningConfig: { effort: "high" } }));
    expect(payload.reasoning_effort).toBe("high");
  });

  test("maps assistant tool_use to tool_calls", () => {
    const payload = buildChatPayload(
      request({
        messages: [
          { role: "assistant", content: [{ type: "tool_use", toolCallId: "call_1", toolName: "fn", toolArguments: '{"x":1}' }] },
        ],
      }),
    );
    const msgs = payload.messages as Array<{ tool_calls?: Array<{ id: string }> }>;
    expect(msgs[0]?.tool_calls?.[0]?.id).toBe("call_1");
  });

  test("maps image to image_url blocks", () => {
    const payload = buildChatPayload(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "image", image: { kind: "url", value: "https://example.com/img.png", mediaType: "image/png" } },
            ],
          },
        ],
      }),
    );
    const msgs = payload.messages as Array<{ content: unknown }>;
    // when has media, content is array with image_url
    const content = msgs[0]?.content as unknown[];
    expect(Array.isArray(content)).toBe(true);
  });

  test("sets tool_choice when tools present", () => {
    const payload = buildChatPayload(
      request({
        tools: [{ kind: "function", name: "fn", description: null, inputSchema: {} }],
        toolChoice: { kind: "auto" },
      }),
    );
    expect(payload.tool_choice).toBe("auto");
  });

  test("upstreamModel override", () => {
    const payload = buildChatPayload(request(), { upstreamModel: "gpt-4o" });
    expect(payload.model).toBe("gpt-4o");
  });
});

describe("buildResponsesPayload", () => {
  test("builds minimal responses payload", () => {
    const payload = buildResponsesPayload(request({ sourceSurface: "openai-responses" }));
    expect(payload.model).toBe("gpt-4");
    expect(Array.isArray(payload.input)).toBe(true);
  });

  test("maps tools", () => {
    const payload = buildResponsesPayload(
      request({
        sourceSurface: "openai-responses",
        tools: [{ kind: "function", name: "fn", description: "d", inputSchema: { type: "object" } }],
      }),
    );
    const tools = payload.tools as Array<{ name: string }>;
    expect(tools[0]?.name).toBe("fn");
  });

  test("maps hosted tool", () => {
    const payload = buildResponsesPayload(
      request({
        sourceSurface: "openai-responses",
        tools: [{ kind: "hosted", hostedType: "web_search", nativeOptions: {} } as never],
      }),
    );
    const tools = payload.tools as Array<{ type: string }>;
    expect(tools[0]?.type).toBe("web_search");
  });

  test("includes reasoning wire", () => {
    const payload = buildResponsesPayload(
      request({ sourceSurface: "openai-responses", reasoning: "enabled", reasoningConfig: { effort: "medium" } }),
    );
    expect(payload.reasoning).toBeDefined();
  });

  test("maps user message with media", () => {
    const payload = buildResponsesPayload(
      request({
        sourceSurface: "openai-responses",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "image", image: { kind: "url", value: "https://example.com/a.png", mediaType: "image/png" } },
            ],
          },
        ],
      }),
    );
    const input = payload.input as Array<{ content: unknown }>;
    expect(input.length).toBeGreaterThan(0);
  });
});

describe("toOpenAIImageUrl", () => {
  test("returns url for url kind", () => {
    expect(toOpenAIImageUrl({ kind: "url", value: "https://example.com/x.png", mediaType: "image/png" })).toBe("https://example.com/x.png");
  });

  test("returns data url as-is when already data:", () => {
    const url = "data:image/png;base64,abc123";
    expect(toOpenAIImageUrl({ kind: "data", value: url, mediaType: "image/png" })).toBe(url);
  });

  test("wraps raw base64 with data prefix", () => {
    const result = toOpenAIImageUrl({ kind: "data", value: "abc123", mediaType: "image/png" });
    expect(result).toBe("data:image/png;base64,abc123");
  });

  test("returns empty for undefined", () => {
    expect(toOpenAIImageUrl(undefined)).toBe("");
  });

  test("throws for file kind", () => {
    expect(() => toOpenAIImageUrl({ kind: "file", value: "file_123", mediaType: null } as never)).toThrow();
  });
});
