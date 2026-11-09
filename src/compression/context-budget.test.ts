import { describe, expect, test } from "bun:test";
import { evaluateContextBudget } from "./context-budget.js";

describe("evaluateContextBudget", () => {
  test("returns null ratio when context window is unavailable", () => {
    expect(evaluateContextBudget(100, null, 0.8)).toEqual({ shouldWarn: false, shouldEmergency: false, ratio: null });
    expect(evaluateContextBudget(100, 0, 0.8)).toEqual({ shouldWarn: false, shouldEmergency: false, ratio: null });
  });

  test("warns and enters emergency mode at the expected ratios", () => {
    expect(evaluateContextBudget(70, 100, 0.8)).toEqual({ shouldWarn: false, shouldEmergency: false, ratio: 0.7 });
    expect(evaluateContextBudget(80, 100, 0.8)).toEqual({ shouldWarn: true, shouldEmergency: false, ratio: 0.8 });
    expect(evaluateContextBudget(95, 100, 0.8)).toEqual({ shouldWarn: true, shouldEmergency: true, ratio: 0.95 });
  });
});
