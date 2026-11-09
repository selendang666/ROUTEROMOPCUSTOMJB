import { describe, expect, test } from "bun:test";
import { parsePlaygroundRequest } from "./playground.js";

describe("playground request validation", () => {
  test("accepts only the documented streaming shape", () => {
    const result = parsePlaygroundRequest({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      maxTokens: 256,
      reasoningEffort: "low",
      stream: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.maxTokens).toBe(256);
  });

  test("rejects unknown fields and non-streaming requests", () => {
    const result = parsePlaygroundRequest({
      model: "openai/gpt-4o",
      messages: [],
      maxTokens: 256,
      reasoningEffort: "low",
      stream: false,
      token: "must-not-be-accepted",
    });

    expect(result).toMatchObject({ ok: false, code: "invalid_request" });
  });
});
