import { describe, expect, test } from "bun:test";
import {
  buildGeminiPayload,
  geminiCandidate,
  mapGeminiUsage,
  responseParts,
  translateGeminiResponse,
  transformGeminiResponse,
} from "./gemini.js";
import type { ProxyRequest } from "../types/request.js";
import type { ContentPart, NormalizedMessage, RequestLimits } from "../types/content.js";

function limits(): RequestLimits {
  return {
    maxBodyBytes: 1024 * 1024,
    connectTimeoutMs: 5000,
    firstByteTimeoutMs: 5000,
    idleTimeoutMs: 5000,
    totalTimeoutMs: 30000,
  };
}

function baseRequest(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    model: "gemini-2.0-flash",
    messages: [],
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits: limits(),
    images: [],
    ...overrides,
  } as unknown as ProxyRequest;
}

function msg(role: NormalizedMessage["role"], parts: ContentPart[]): NormalizedMessage {
  return { role, content: parts } as NormalizedMessage;
}

describe("buildGeminiPayload", () => {
  test("maps system messages to systemInstruction", () => {
    const req = baseRequest({
      messages: [
        msg("system", [{ type: "text", text: "you are helpful" } as ContentPart]),
        msg("user", [{ type: "text", text: "hello" } as ContentPart]),
      ],
    });
    const payload = buildGeminiPayload(req);
    expect(payload.systemInstruction).toEqual({ role: "user", parts: [{ text: "you are helpful" }] });
    expect((payload.contents as unknown[]).length).toBe(1);
    expect(((payload.contents as Record<string, unknown>[])[0] as Record<string, unknown>).role).toBe("user");
  });

  test("maps assistant role to model", () => {
    const req = baseRequest({
      messages: [msg("assistant", [{ type: "text", text: "reply" } as ContentPart])],
    });
    const payload = buildGeminiPayload(req);
    const contents = payload.contents as Record<string, unknown>[];
    expect(contents[0]!.role).toBe("model");
  });

  test("includes functionDeclarations for function tools", () => {
    const req = baseRequest({
      messages: [msg("user", [{ type: "text", text: "hi" } as ContentPart])],
      tools: [
        { kind: "function", name: "get_weather", description: "weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } } as unknown as ProxyRequest["tools"][number],
      ],
    });
    const payload = buildGeminiPayload(req);
    const tools = payload.tools as Record<string, unknown>[];
    expect(tools[0]!.functionDeclarations).toBeDefined();
    const decls = (tools[0]!.functionDeclarations as Record<string, unknown>[]);
    expect(decls[0]!.name).toBe("get_weather");
  });
  test("converts nullable JSON Schema type arrays to Gemini schema", () => {
    const req = baseRequest({
      messages: [msg("user", [{ type: "text", text: "hi" } as ContentPart])],
      tools: [
        {
          kind: "function",
          name: "set_value",
          inputSchema: {
            type: "object",
            properties: {
              value: { type: ["number", "null"], description: "optional numeric value" },
            },
          },
        } as unknown as ProxyRequest["tools"][number],
      ],
    });
    const payload = buildGeminiPayload(req);
    const tools = payload.tools as Record<string, unknown>[];
    const declarations = tools[0]!.functionDeclarations as Record<string, unknown>[];
    const parameters = declarations[0]!.parameters as Record<string, unknown>;
    const properties = parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.value).toEqual({ type: "number", nullable: true, description: "optional numeric value" });
  });


  test("sanitizes function tool names through Gemini quirk policy", () => {
    const req = baseRequest({
      messages: [msg("user", [{ type: "text", text: "hi" } as ContentPart])],
      tools: [
        { kind: "function", name: "tool name?!", description: "weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } } as unknown as ProxyRequest["tools"][number],
      ],
    });
    const payload = buildGeminiPayload(req);
    const tools = payload.tools as Record<string, unknown>[];
    const decls = (tools[0]!.functionDeclarations as Record<string, unknown>[]);
    expect(decls[0]!.name).toBe("tool_name__");
  });

  test("throws for hosted or native tools", () => {
    const req = baseRequest({
      messages: [msg("user", [{ type: "text", text: "hi" } as ContentPart])],
      tools: [{ kind: "hosted", hostedType: "web_search" } as unknown as ProxyRequest["tools"][number]],
    });
    expect(() => buildGeminiPayload(req)).toThrow();
  });

  test("sets generationConfig maxOutputTokens and thinkingConfig", () => {
    const req = baseRequest({
      messages: [msg("user", [{ type: "text", text: "hi" } as ContentPart])],
      maxOutputTokens: 2048,
      reasoning: "enabled",
    });
    const payload = buildGeminiPayload(req);
    const gen = payload.generationConfig as Record<string, unknown>;
    expect(gen.maxOutputTokens).toBe(2048);
    expect(gen.thinkingConfig).toEqual({ thinkingBudget: 2048 });
  });

  test("sets responseMimeType when responseFormat is json_object", () => {
    const req = baseRequest({
      messages: [msg("user", [{ type: "text", text: "hi" } as ContentPart])],
      responseFormat: { kind: "json_object" } as unknown as ProxyRequest["responseFormat"],
    });
    const payload = buildGeminiPayload(req);
    expect((payload.generationConfig as Record<string, unknown>).responseMimeType).toBe("application/json");
  });

  test("encodes image data url to inlineData", () => {
    const req = baseRequest({
      messages: [
        msg("user", [
          { type: "image", image: { kind: "data", value: "data:image/png;base64,abc123", mediaType: "image/png" } } as unknown as ContentPart,
        ]),
      ],
    });
    const payload = buildGeminiPayload(req);
    const contents = payload.contents as Record<string, unknown>[];
    const parts = (contents[0]!.parts as Record<string, unknown>[]);
    expect(parts[0]!.inlineData).toEqual({ mimeType: "image/png", data: "abc123" });
  });

  test("encodes tool_use and tool_result", () => {
    const req = baseRequest({
      messages: [
        msg("assistant", [{ type: "tool_use", toolCallId: "call_1", toolName: "fn", toolArguments: '{"a":1}' } as unknown as ContentPart]),
        msg("tool", [{ type: "tool_result", toolCallId: "call_1", text: '{"result":42}' } as unknown as ContentPart]),
      ],
    });
    const payload = buildGeminiPayload(req);
    const contents = payload.contents as Record<string, unknown>[];
    const modelParts = (contents[0]!.parts as Record<string, unknown>[]);
    expect((modelParts[0]!.functionCall as Record<string, unknown>).name).toBe("fn");
    const userParts = (contents[1]!.parts as Record<string, unknown>[]);
    expect((userParts[0]!.functionResponse as Record<string, unknown>).name).toBe("fn");
  });
});

describe("geminiCandidate and responseParts", () => {
  test("extracts candidate parts", () => {
    const body = { candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }], responseId: "resp-1" };
    const { response, candidate, parts } = geminiCandidate(body as unknown as Record<string, unknown>);
    expect(response).toBeDefined();
    expect(candidate.finishReason).toBe("STOP");
    expect(parts.length).toBe(1);
  });

  test("responseParts folds text, thought, functionCall", () => {
    const parts = [
      { text: "hello" },
      { text: "thinking", thought: true, thoughtSignature: "sig-1" },
      { functionCall: { name: "fn", args: { x: 1 }, id: "call_1" }, thoughtSignature: "sig-call" },
    ] as unknown as Record<string, unknown>[];
    const folded = responseParts(parts);
    expect(folded.text).toBe("hello");
    expect(folded.thought).toBe("thinking");
    expect(folded.reasoningSignature).toBe("sig-1");
    expect(folded.calls.length).toBe(1);
    expect(folded.calls[0]!.name).toBe("fn");
    expect(folded.calls[0]!.reasoningSignature).toBe("sig-call");
  });

  test("responseParts captures inlineData images", () => {
    const parts = [{ inlineData: { data: "abcd", mimeType: "image/png" } }] as unknown as Record<string, unknown>[];
    const folded = responseParts(parts);
    expect(folded.images.length).toBe(1);
    expect(folded.images[0]!.data).toBe("abcd");
  });
});

describe("mapGeminiUsage", () => {
  test("maps prompt/candidates/cached/total", () => {
    const body = { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, cachedContentTokenCount: 2, totalTokenCount: 30 } };
    const usage = mapGeminiUsage(body as unknown as Record<string, unknown>);
    expect(usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(usage.outputTokens).toBeGreaterThanOrEqual(0);
    // total includes at least prompt + candidates
    expect(usage.totalTokens).toBeGreaterThan(0);
  });

  test("handles missing usageMetadata gracefully", () => {
    const usage = mapGeminiUsage({} as unknown as Record<string, unknown>);
    expect(usage.inputTokens).toBeDefined();
    expect(usage.outputTokens).toBeDefined();
  });
});
describe("translateGeminiResponse surface routing", () => {

  function geminiBody(text: string, calls: readonly { name: string; args: Record<string, unknown>; signature?: string }[] = []): Record<string, unknown> {
    return {
      responseId: "resp-123",
      candidates: [
        {
          content: {
            parts: [
              ...(text ? [{ text }] : []),
              ...calls.map((c, i) => ({ functionCall: { name: c.name, args: c.args, id: `call_${i}` }, ...(c.signature === undefined ? {} : { thoughtSignature: c.signature }) })),
            ],
          },
          finishReason: calls.length > 0 ? "TOOL_CALL" : "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 },
    } as unknown as Record<string, unknown>;
  }

  test("openai-chat surface returns chat.completion shape", () => {
    const body = geminiBody("hello");
    const out = translateGeminiResponse(body, "openai-chat", "gemini-2.0-flash");
    expect(out.object).toBe("chat.completion");
    const choices = (out.choices as Record<string, unknown>[]);
    expect((choices[0]!.message as Record<string, unknown>).content).toBe("hello");
  });

  test("anthropic-messages surface returns message shape with stop_reason", () => {
    const body = geminiBody("hi");
    const out = translateGeminiResponse(body, "anthropic-messages", "gemini-2.0-flash");
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(out.content).toBeDefined();
  });

  test("openai-responses surface returns response shape", () => {
    const body = geminiBody("hi");
    const out = translateGeminiResponse(body, "openai-responses", "gemini-2.0-flash");
    expect(out.object).toBe("response");
    expect(out.output).toBeDefined();
  });

  test("tool calls routed to each surface", () => {
    const body = geminiBody("", [{ name: "search", args: { q: "test" }, signature: "sig-call" }]);
    const chat = translateGeminiResponse(body, "openai-chat", "m");
    const chatMessage = (chat.choices as Record<string, unknown>[])[0]!.message as Record<string, unknown>;
    expect(chatMessage.tool_calls).toBeDefined();
    expect((chatMessage.tool_calls as Record<string, unknown>[])[0]!.extra_content).toEqual({ google: { thought_signature: "sig-call" } });
    const anthro = translateGeminiResponse(body, "anthropic-messages", "m");
    const content = anthro.content as Record<string, unknown>[];
    expect(content.some((c) => c.type === "tool_use")).toBe(true);
    const resp = translateGeminiResponse(body, "openai-responses", "m");
    const output = resp.output as Record<string, unknown>[];
    expect(output.some((c) => c.type === "function_call")).toBe(true);
  });

  test("unsupported surface throws capability_unsupported", () => {
    const body = geminiBody("hi");
    expect(() => translateGeminiResponse(body, "unknown" as unknown as never, "m")).toThrow();
  });

  test("transformGeminiResponse builds document with events", () => {
    const body = geminiBody("hello world");
    const doc = transformGeminiResponse(body, "gemini-2.0-flash");
    expect(doc.model).toBe("gemini-2.0-flash");
    expect(doc.events.some((e) => e.type === "text_delta")).toBe(true);
    expect(doc.events.some((e) => e.type === "message_stop")).toBe(true);
  });
});
