import { describe, expect, test } from "bun:test";
import { repairToolCallRequest } from "./repair.js";
import { sanitizeMalformedToolCalls } from "./repair.js";
import type { ContentPart, NormalizedMessage } from "../types/content.js";
import type { ProxyRequest } from "../types/request.js";

function req(messages: NormalizedMessage[]): ProxyRequest {
  return { model: "test", messages, tools: [], stream: false } as unknown as ProxyRequest;
}

function toolUse(id: string, name: string, args = "{}"): ContentPart {
  return { type: "tool_use", toolCallId: id, toolName: name, toolArguments: args } as ContentPart;
}

function toolResult(id: string, text = "ok"): ContentPart {
  return { type: "tool_result", toolCallId: id, text } as ContentPart;
}

describe("sanitizeMalformedToolCalls", () => {
  test("returns same reference when nothing malformed (idempotent fast-path)", () => {
    const r = req([{ role: "assistant", content: [toolUse("call_1", "search")] }]);
    expect(sanitizeMalformedToolCalls(r)).toBe(r);
  });

  test("drops tool_use with empty name and matching tool_result", () => {
    const r = req([
      { role: "assistant", content: [toolUse("call_1", ""), toolUse("call_2", "search")] },
      { role: "tool", content: [toolResult("call_1"), toolResult("call_2")] },
    ]);
    const out = sanitizeMalformedToolCalls(r);
    const assistant = out.messages[0]!;
    const tool = out.messages[1]!;
    expect(assistant.content.filter((b) => b.type === "tool_use").length).toBe(1);
    expect(assistant.content.some((b) => b.type === "tool_use" && b.toolCallId === "call_2")).toBe(true);
    // orphan result for the dropped call must be removed
    expect(tool.content.some((b) => b.type === "tool_result" && b.toolCallId === "call_1")).toBe(false);
    expect(tool.content.some((b) => b.type === "tool_result" && b.toolCallId === "call_2")).toBe(true);
  });

  test("drops tool_use with empty id", () => {
    const r = req([{ role: "assistant", content: [toolUse("", "search")] }]);
    const out = sanitizeMalformedToolCalls(r);
    expect(out.messages[0]!.content.length).toBe(0);
  });
});

describe("repairToolCallRequest — missing result synthesis", () => {
  test("synthesizes 'No result provided' with isError for unanswered tool_use", () => {
    const r = req([{ role: "assistant", content: [toolUse("call_9", "search")] }]);
    const { request } = repairToolCallRequest(r);
    const synth = request.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result" && b.toolCallId === "call_9") as Extract<ContentPart, { type: "tool_result" }> | undefined;
    expect(synth).toBeDefined();
    expect(synth?.text).toBe("No result provided");
    expect((synth as unknown as { toolResultIsError?: boolean }).toolResultIsError).toBe(true);
  });

  test("does not fabricate ids — preserves valid pairing", () => {
    const r = req([
      { role: "assistant", content: [toolUse("call_a", "search")] },
      { role: "tool", content: [toolResult("call_a", "done")] },
    ]);
    const { request } = repairToolCallRequest(r);
    const ids = request.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_use").map((b) => (b as Extract<ContentPart, { type: "tool_use" }>).toolCallId);
    expect(ids).toEqual(["call_a"]);
  });
});
