import { describe, expect, test } from "bun:test";
import { applyFilterRules, validateFilterRuleInput, type FilterRuleConfig } from "./filter-policy.js";
import type { ContentBlock, NormalizedMessage } from "../proxy/types/content.js";
import type { ProxyRequest } from "../proxy/types/request.js";

function req(messages: NormalizedMessage[]): ProxyRequest {
  return { model: "test", messages, tools: [], stream: false } as unknown as ProxyRequest;
}

function userText(text: string): NormalizedMessage {
  return { role: "user", content: [{ type: "text", text } as ContentBlock] };
}

function cfg(rules: FilterRuleConfig["rules"]): FilterRuleConfig {
  return { enabled: true, rules };
}

describe("applyFilterRules — hardening", () => {
  test("empty regex pattern is rejected (no corruption of text)", () => {
    const r = req([userText("hello world")]);
    const out = applyFilterRules(r, cfg([{ pattern: "", replacement: "X", isRegex: true }]));
    const text = (out.messages[0]!.content[0] as Extract<ContentBlock, { type: "text" }>).text;
    expect(text).toBe("hello world");
  });

  test("catastrophic regex (a+)+ is rejected — no ReDoS", () => {
    const start = performance.now();
    const r = req([userText("a".repeat(40) + "!")]);
    const out = applyFilterRules(r, cfg([{ pattern: "(a+)+$", replacement: "X", isRegex: true }]));
    const elapsed = performance.now() - start;
    const text = (out.messages[0]!.content[0] as Extract<ContentBlock, { type: "text" }>).text;
    expect(text).toBe("a".repeat(40) + "!");
    expect(elapsed).toBeLessThan(500);
  });

  test("literal $ in replacement is not treated as backreference", () => {
    const r = req([userText("price is 100")]);
    const out = applyFilterRules(r, cfg([{ pattern: "\\d+", replacement: "$$$&", isRegex: true }]));
    const text = (out.messages[0]!.content[0] as Extract<ContentBlock, { type: "text" }>).text;
    // Replacement is literal: "$$$&" stays verbatim, no dollar-substitution.
    expect(text).toBe("price is $$$&");
  });

  test("valid regex still applies", () => {
    const r = req([userText("secret token here")]);
    const out = applyFilterRules(r, cfg([{ pattern: "secret", replacement: "[REDACTED]", isRegex: true }]));
    const text = (out.messages[0]!.content[0] as Extract<ContentBlock, { type: "text" }>).text;
    expect(text).toBe("[REDACTED] token here");
  });

  test("literal (non-regex) rule replaces all occurrences", () => {
    const r = req([userText("a.b.c")]);
    const out = applyFilterRules(r, cfg([{ pattern: ".", replacement: "-", isRegex: false }]));
    const text = (out.messages[0]!.content[0] as Extract<ContentBlock, { type: "text" }>).text;
    expect(text).toBe("a-b-c");
  });

  test("over-long regex pattern rejected", () => {
    const r = req([userText("hello")]);
    const out = applyFilterRules(r, cfg([{ pattern: "a".repeat(300), replacement: "X", isRegex: true }]));
    const text = (out.messages[0]!.content[0] as Extract<ContentBlock, { type: "text" }>).text;
    expect(text).toBe("hello");
  });
});

describe("applyFilterRules — coverage + flags + PII", () => {
  test("tool_result text is filtered", () => {
    const r = req([{ role: "tool", content: [{ type: "tool_result", toolCallId: "c1", text: "secret leaked" } as ContentBlock] }]);
    const out = applyFilterRules(r, cfg([{ pattern: "secret", replacement: "[X]", isRegex: false }]));
    const block = out.messages[0]!.content[0] as Extract<ContentBlock, { type: "tool_result" }>;
    expect(block.text).toBe("[X] leaked");
  });

  test("case-sensitive flag honored (no i)", () => {
    const r = req([userText("Secret secret")]);
    const out = applyFilterRules(r, cfg([{ pattern: "secret", replacement: "X", isRegex: true, flags: "g" }]));
    const text = (out.messages[0]!.content[0] as Extract<ContentBlock, { type: "text" }>).text;
    expect(text).toBe("Secret X");
  });

  test("PII deny list redacts email + sk- key when enabled", () => {
    const r = req([userText("contact me@example.com key sk-abcdefabcdefabcdef1234")]);
    const out = applyFilterRules(r, { enabled: true, rules: [], piiDenyList: true });
    const text = (out.messages[0]!.content[0] as Extract<ContentBlock, { type: "text" }>).text;
    expect(text).toContain("[REDACTED_EMAIL]");
    expect(text).toContain("[REDACTED_KEY]");
  });
});

describe("validateFilterRuleInput", () => {
  test("rejects empty regex", () => {
    expect(validateFilterRuleInput({ pattern: "", isRegex: true }).ok).toBe(false);
  });
  test("rejects catastrophic regex", () => {
    expect(validateFilterRuleInput({ pattern: "(a+)+$", isRegex: true }).ok).toBe(false);
  });
  test("rejects uncompilable regex", () => {
    expect(validateFilterRuleInput({ pattern: "[unterminated", isRegex: true }).ok).toBe(false);
  });
  test("rejects empty literal", () => {
    expect(validateFilterRuleInput({ pattern: "", isRegex: false }).ok).toBe(false);
  });
  test("accepts valid regex", () => {
    expect(validateFilterRuleInput({ pattern: "\\d+", isRegex: true }).ok).toBe(true);
  });
});
