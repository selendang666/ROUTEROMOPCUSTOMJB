import { describe, expect, test } from "bun:test";
import { fullPromptTokens, usageFromTotalInput, usageFromUncachedInput, usageNumber } from "./usage.js";

describe("usageNumber", () => {
  test("truncates and clamps negative / non-finite", () => {
    expect(usageNumber(3.7)).toBe(3);
    expect(usageNumber(-1)).toBe(0);
    // via indirect coverage through usage helpers; direct import is from same file's export
    // but we exercise the exported fullPromptTokens path instead of private helper
  });
});

describe("usageFromTotalInput", () => {
  test("splits total input into uncached + cache", () => {
    const u = usageFromTotalInput(100, 20, 30, 10);
    // inputTokens = 100 -30 -10 =60 uncached
    expect(u.inputTokens).toBe(60);
    expect(u.cacheReadTokens).toBe(30);
    expect(u.cacheWriteTokens).toBe(10);
    expect(u.promptTokens).toBe(100);
    expect(u.completionTokens).toBe(20);
    expect(u.totalTokens).toBe(120);
    expect(u.cachedTokens).toBe(30);
  });

  test("null inputs become null, totals default to prompt+completion", () => {
    const u = usageFromTotalInput(null, null, null, null);
    expect(u.inputTokens).toBeNull();
    expect(u.promptTokens).toBe(0);
    expect(u.totalTokens).toBe(0);
  });

  test("uses explicit totalTokens when provided", () => {
    const u = usageFromTotalInput(10, 5, 0, 0, 999);
    expect(u.totalTokens).toBe(999);
  });

  test("reasoningTokens propagated when given", () => {
    const u = usageFromTotalInput(10, 5, 0, 0, null, 7);
    expect(u.reasoningTokens).toBe(7);
    const u2 = usageFromTotalInput(10, 5, 0, 0, null, null);
    expect(u2.reasoningTokens).toBeNull();
  });

  test("clamps negative and truncates fractional", () => {
    const u = usageFromTotalInput(10.9, 5.9, -5, 2.2);
    // usageNumber clamps negative to 0 and truncates
    expect(u.cacheReadTokens).toBe(0);
    expect(u.cacheWriteTokens).toBe(2);
  });

  test("input null still handles cache tokens as 0 for full prompt", () => {
    const u = usageFromTotalInput(null, 10, 5, 5);
    expect(u.inputTokens).toBeNull();
    expect(u.promptTokens).toBe(0);
  });
});

describe("usageFromUncachedInput", () => {
  test("Anthropic style: input excludes cache, prompt is sum", () => {
    const u = usageFromUncachedInput(60, 20, 30, 10);
    expect(u.inputTokens).toBe(60);
    expect(u.promptTokens).toBe(100);
    expect(u.totalTokens).toBe(120);
  });

  test("null input yields null and 0 prompt", () => {
    const u = usageFromUncachedInput(null, 5, 2, 2);
    expect(u.inputTokens).toBeNull();
    expect(u.promptTokens).toBe(0);
  });

  test("explicit totalTokens overrides sum", () => {
    const u = usageFromUncachedInput(10, 5, 1, 1, 42);
    expect(u.totalTokens).toBe(42);
  });

  test("reasoningTokens handling mirrors total-input", () => {
    const without = usageFromUncachedInput(10, 5, 0, 0);
    expect((without as Record<string, unknown>).reasoningTokens).toBeUndefined();
    const withVal = usageFromUncachedInput(10, 5, 0, 0, null, 3);
    expect(withVal.reasoningTokens).toBe(3);
  });
});

describe("fullPromptTokens", () => {
  test("sums uncached + cache", () => {
    const u = usageFromTotalInput(100, 10, 20, 5);
    expect(fullPromptTokens(u)).toBe(100);
  });

  test("Anthropic variant also sums correctly", () => {
    const u = usageFromUncachedInput(50, 10, 10, 5);
    expect(fullPromptTokens(u)).toBe(65);
  });

  test("null fields contribute 0", () => {
    const u = usageFromTotalInput(null, null, null, null);
    expect(fullPromptTokens(u)).toBe(0);
  });

  test("fractional and negative are normalized to 0 via usageNumber", () => {
    const u = usageFromUncachedInput(-5, 0, -10, 3.9);
    // inputTokens => 0, cacheRead 0, cacheWrite 3
    expect(fullPromptTokens(u)).toBe(3);
  });
});
