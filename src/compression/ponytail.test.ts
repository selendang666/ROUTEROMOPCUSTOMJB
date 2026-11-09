import { describe, expect, test } from "bun:test";
import { applyFilterRules, validateFilterRuleInput, type FilterRuleConfig } from "./filter-policy.js";
import { applyPonytail } from "./ponytail.js";
import type { ContentBlock, NormalizedMessage } from "../proxy/types/content.js";
import type { ProxyRequest } from "../proxy/types/request.js";

function req(messages: NormalizedMessage[]): ProxyRequest {
  return { model: "test", messages, tools: [], stream: false } as unknown as ProxyRequest;
}

function userText(text: string): NormalizedMessage {
  return { role: "user", content: [{ type: "text", text } as ContentBlock] };
}

function systemText(text: string): NormalizedMessage {
  return { role: "system", content: [{ type: "text", text } as ContentBlock] };
}

describe("Ponytail cap — max 8 system messages", () => {
  test("does not add ponytail when already at cap", () => {
    const messages = Array.from({ length: 8 }, (_, i) => systemText(`system ${i}`));
    messages.push(userText("hello"));
    const input = req(messages);
    const result = applyPonytail(input, true);
    // should return same reference (no mutation) when at cap
    expect(result.messages.length).toBe(messages.length);
  });

  test("idempotent second call adds only once", () => {
    const input = req([userText("hello")]);
    const first = applyPonytail(input, true);
    const second = applyPonytail(first, true);
    // first added one, second adds none
    expect(first.messages.length).toBe(2);
    expect(second.messages.length).toBe(2);
    expect(second).toBe(first);
  });

  test("disabled flag returns same reference", () => {
    const input = req([userText("hello")]);
    const result = applyPonytail(input, false);
    expect(result).toBe(input);
  });
});

describe("filter cap — max pattern 256 and catastrophic", () => {
  test("validate rejects over-long regex", () => {
    const long = "a".repeat(257);
    const result = validateFilterRuleInput({ pattern: long, isRegex: true });
    expect(result.ok).toBe(false);
  });

  test("validate rejects catastrophic nested quantifier", () => {
    const result = validateFilterRuleInput({ pattern: "(a+)+", isRegex: true });
    expect(result.ok).toBe(false);
  });

  test("validate rejects empty regex", () => {
    const result = validateFilterRuleInput({ pattern: "", isRegex: true });
    expect(result.ok).toBe(false);
  });

  test("malformed resolver records are skipped, valid rule still applies", () => {
    const input = req([userText("hello world foo")]);
    const config: FilterRuleConfig = {
      enabled: true,
      rules: [
        { pattern: "", replacement: "X", isRegex: true }, // malformed empty
        { pattern: "(a+)+", replacement: "X", isRegex: true }, // catastrophic
        { pattern: "a".repeat(300), replacement: "X", isRegex: true }, // over-long
        { pattern: "hello", replacement: "hi", isRegex: false }, // valid literal
        { pattern: "[invalid(", replacement: "X", isRegex: true }, // uncompilable
      ],
    };
    const result = applyFilterRules(input, config);
    expect(result.messages[0]?.content[0]).toEqual({ type: "text", text: "hi world foo" });
  });

  test("empty literal pattern not applied", () => {
    const input = req([userText("hello")]);
    const config: FilterRuleConfig = {
      enabled: true,
      rules: [{ pattern: "", replacement: "X", isRegex: false }],
    };
    const result = applyFilterRules(input, config);
    // literal empty is skipped by filterText check (pattern.length >0)
    expect(result).toBe(input);
  });
});

describe("malformed resolver — compile skips invalid regex gracefully", () => {
  test("invalid regex does not throw and is skipped", () => {
    const input = req([userText("hello")]);
    const config: FilterRuleConfig = {
      enabled: true,
      rules: [
        { pattern: "(", replacement: "X", isRegex: true },
        { pattern: "hello", replacement: "hi", isRegex: false },
      ],
    };
    const result = applyFilterRules(input, config);
    // original behavior: invalid regex skipped, valid literal still replaces
    expect((result.messages[0]?.content[0] as ContentBlock & { text: string }).text).toBe("hi");
  });
});
