import { describe, expect, test } from "bun:test";
import { providerExecutionPolicy, providerQuirkPolicy } from "./profiles.js";

describe("provider profiles", () => {
  test("returns stable execution policies for known providers", () => {
    const gemini = providerExecutionPolicy("gemini");
    const codex = providerExecutionPolicy("codex");
    expect(gemini).toBe(providerExecutionPolicy("gemini"));
    expect(codex).toBe(providerExecutionPolicy("codex"));
    expect(gemini).toMatchObject({ retry: { networkAttempts: 1, maxRetryAfterMs: 30000 } });
    expect(gemini).not.toHaveProperty("compact");
    expect(codex).toMatchObject({ nativePassthrough: true, compact: { path: "/codex/responses/compact" } });
  });

  test("returns stable quirk policies for known providers", () => {
    const gemini = providerQuirkPolicy("gemini");
    const claude = providerQuirkPolicy("claude");
    const codex = providerQuirkPolicy("codex");
    expect(gemini).toBe(providerQuirkPolicy("gemini"));
    expect(claude).toBe(providerQuirkPolicy("claude"));
    expect(codex).toBe(providerQuirkPolicy("codex"));
    expect(gemini).toMatchObject({ roles: "gemini-alternating", cache: { historyTtl: "5m" } });
    expect(claude).toMatchObject({ requiredHeaders: { "anthropic-version": "2023-06-01" }, signatures: { mode: "strip-invalid" } });
    expect(codex).toMatchObject({ droppedFields: ["temperature", "top_p", "max_output_tokens", "max_completion_tokens"] });
  });

  test("returns undefined for unknown providers", () => {
    expect(providerExecutionPolicy("unknown-provider")).toBeUndefined();
    expect(providerQuirkPolicy("unknown-provider")).toBeUndefined();
  });
});
