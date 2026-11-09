import { describe, expect, test } from "bun:test";
import { parseModelReasoningSuffix } from "./detection.js";

describe("parseModelReasoningSuffix (merged from reasoning.ts)", () => {
  test("strips known suffix and returns effort", () => {
    expect(parseModelReasoningSuffix("gpt-4o (high)")).toEqual({
      cleanModel: "gpt-4o",
      effort: "high",
      diagnostic: expect.objectContaining({ action: "adapted" }),
    });
  });

  test("case-insensitive and trims", () => {
    expect(parseModelReasoningSuffix("  model (XHigh)  ").effort).toBe("xhigh");
    expect(parseModelReasoningSuffix("model (XHigh)  ").cleanModel).toBe("model");
  });

  test("unknown parentheses stays as model", () => {
    const r = parseModelReasoningSuffix("my-model (custom)");
    expect(r.effort).toBeNull();
    expect(r.cleanModel).toBe("my-model (custom)");
    expect(r.diagnostic).toBeUndefined();
  });

  test("no suffix returns null effort", () => {
    expect(parseModelReasoningSuffix("claude-3.5-sonnet").effort).toBeNull();
  });

  test("all canonical efforts", () => {
    for (const e of ["xhigh", "high", "medium", "low", "minimal", "none"] as const) {
      expect(parseModelReasoningSuffix(`m (${e})`).effort).toBe(e);
    }
  });
});
