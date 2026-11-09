import { describe, expect, test } from "bun:test";
import {
  mapChatUsage,
  mapResponsesUsage,
  translateOpenAIChatResponse,
  translateOpenAIResponsesResponse,
} from "./response.js";

describe("mapChatUsage", () => {
  test("maps prompt and completion tokens", () => {
    const usage = mapChatUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
    expect(usage.promptTokens).toBe(10);
    expect(usage.completionTokens).toBe(20);
    expect(usage.totalTokens).toBe(30);
  });

  test("extracts cached_tokens and reasoning_tokens", () => {
    const usage = mapChatUsage({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      prompt_tokens_details: { cached_tokens: 5 },
      completion_tokens_details: { reasoning_tokens: 3 },
    });
    expect(usage.cachedTokens).toBe(5);
    expect(usage.reasoningTokens).toBe(3);
  });

  test("handles missing optional fields", () => {
    const usage = mapChatUsage({});
    expect(usage.promptTokens).toBe(0);
    expect(usage.completionTokens).toBe(0);
  });
});

describe("mapResponsesUsage", () => {
  test("maps input/output tokens", () => {
    const usage = mapResponsesUsage({ input_tokens: 15, output_tokens: 25, total_tokens: 40 });
    expect(usage.promptTokens).toBe(15);
    expect(usage.completionTokens).toBe(25);
  });

  test("handles missing fields", () => {
    const usage = mapResponsesUsage({});
    expect(usage.promptTokens).toBe(0);
  });
});

describe("translateOpenAIChatResponse", () => {
  test("folds text content and produces message_stop", () => {
    const doc = translateOpenAIChatResponse(
      {
        id: "chatcmpl-123",
        choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
      },
      "gpt-4",
    );
    expect(doc.sourceSurface).toBe("openai-chat");
    expect(doc.model).toBe("gpt-4");
    expect(doc.events.some((e) => e.type === "message_start")).toBe(true);
    expect(doc.events.some((e) => e.type === "text_delta" && e.text === "hello world")).toBe(true);
    expect(doc.events.some((e) => e.type === "message_stop" && e.reason === "completed")).toBe(true);
    expect(doc.events.some((e) => e.type === "usage")).toBe(true);
  });

  test("folds array content", () => {
    const doc = translateOpenAIChatResponse(
      {
        id: "chatcmpl-1",
        choices: [{ message: { content: [{ type: "text", text: "hi" }] }, finish_reason: "stop" }],
      },
      "gpt-4",
    );
    expect(doc.events.some((e) => e.type === "text_delta" && e.text === "hi")).toBe(true);
  });

  test("maps tool_calls to tool_call events", () => {
    const doc = translateOpenAIChatResponse(
      {
        id: "chatcmpl-1",
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "fn", arguments: '{"a":1}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      "gpt-4",
    );
    expect(doc.events.some((e) => e.type === "tool_call_start")).toBe(true);
    expect(doc.events.some((e) => e.type === "tool_call_delta")).toBe(true);
    expect(doc.events.some((e) => e.type === "tool_call_end")).toBe(true);
    const stop = doc.events.find((e) => e.type === "message_stop");
    expect((stop as { reason?: string } | undefined)?.reason).toBe("tool_call");
  });

  test("maps reasoning_content to thinking_delta", () => {
    const doc = translateOpenAIChatResponse(
      {
        id: "chatcmpl-1",
        choices: [{ message: { content: "hi", reasoning_content: "thought" }, finish_reason: "stop" }],
      },
      "gpt-4",
    );
    expect(doc.events.some((e) => e.type === "thinking_delta" && e.text === "thought")).toBe(true);
  });

  test("maps stop reasons", () => {
    const lengthDoc = translateOpenAIChatResponse({ id: "x", choices: [{ message: { content: "hi" }, finish_reason: "length" }] }, "gpt-4");
    expect(lengthDoc.events.find((e) => e.type === "message_stop")).toHaveProperty("reason", "length");
    const filterDoc = translateOpenAIChatResponse({ id: "x", choices: [{ message: { content: "hi" }, finish_reason: "content_filter" }] }, "gpt-4");
    expect(filterDoc.events.find((e) => e.type === "message_stop")).toHaveProperty("reason", "content_filter");
  });

  test("throws when choices is not array", () => {
    expect(() => translateOpenAIChatResponse({ id: "x", choices: "bad" } as unknown as Record<string, unknown>, "gpt-4")).toThrow();
  });

  test("handles missing id by generating one", () => {
    const doc = translateOpenAIChatResponse({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }, "gpt-4");
    expect(doc.events[0]?.type).toBe("message_start");
  });
});

describe("translateOpenAIResponsesResponse", () => {
  test("folds message output to text_delta", () => {
    const doc = translateOpenAIResponsesResponse(
      {
        id: "resp_123",
        output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
        usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
      },
      "gpt-4",
    );
    expect(doc.sourceSurface).toBe("openai-responses");
    expect(doc.events.some((e) => e.type === "text_delta" && e.text === "hello")).toBe(true);
    expect(doc.events.some((e) => e.type === "usage")).toBe(true);
    expect(doc.events.some((e) => e.type === "message_stop")).toBe(true);
  });

  test("folds function_call to tool_call events", () => {
    const doc = translateOpenAIResponsesResponse(
      { id: "resp_1", output: [{ type: "function_call", call_id: "call_1", name: "fn", arguments: '{"x":1}' }] },
      "gpt-4",
    );
    expect(doc.events.some((e) => e.type === "tool_call_start")).toBe(true);
    const stop = doc.events.find((e) => e.type === "message_stop");
    expect((stop as { reason?: string } | undefined)?.reason).toBe("tool_call");
  });

  test("handles reasoning item", () => {
    const doc = translateOpenAIResponsesResponse(
      { id: "resp_1", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "think" }] }] },
      "gpt-4",
    );
    expect(doc.events.some((e) => e.type === "thinking_delta")).toBe(true);
  });

  test("handles web_search_call as native block", () => {
    const doc = translateOpenAIResponsesResponse(
      { id: "resp_1", output: [{ type: "web_search_call", action: { query: "test" } }] },
      "gpt-4",
    );
    expect(doc.events.some((e) => e.type === "native_block_start")).toBe(true);
    expect(doc.events.some((e) => e.type === "native_block_stop")).toBe(true);
  });

  test("fallback to output_text when no text_delta yet", () => {
    const doc = translateOpenAIResponsesResponse({ id: "resp_1", output: [], output_text: "fallback" }, "gpt-4");
    expect(doc.events.some((e) => e.type === "text_delta" && e.text === "fallback")).toBe(true);
  });

  test("maps incomplete_details max_output_tokens to length", () => {
    const doc = translateOpenAIResponsesResponse(
      { id: "resp_1", output: [], incomplete_details: { reason: "max_output_tokens" } },
      "gpt-4",
    );
    expect(doc.events.find((e) => e.type === "message_stop")).toHaveProperty("reason", "length");
  });

  test("throws when output is not array", () => {
    expect(() => translateOpenAIResponsesResponse({ id: "x", output: "bad" } as unknown as Record<string, unknown>, "gpt-4")).toThrow();
  });

  test("handles missing id by generating one", () => {
    const doc = translateOpenAIResponsesResponse({ output: [] }, "gpt-4");
    expect(doc.events[0]?.type).toBe("message_start");
  });
});
