import { describe, expect, test } from "bun:test";
import { applyCompatibilityHeaders, applyCompatibilityRequestRules, compatibilityResponseMetadata, compatibilityUrl } from "./compatibility.js";

const profile = {
  query: { alt: "json" },
  headers: { "X-Custom": "value" },
  responseMetadata: ["request-id", "system-fingerprint", "model"],
  rules: [
    { kind: "rename-field", from: "old_name", to: "new_name" },
    { kind: "move-field", from: "nested", to: ["outer", "inner"] },
    { kind: "set-default", field: "temperature", value: 0.2 },
    { kind: "omit-field", field: "remove_me" },
  ],
} as const;

describe("compatibility helpers", () => {
  test("builds a resolved URL with query parameters", () => {
    expect(compatibilityUrl("https://api.example.com/v1/", "/chat/completions", profile)).toBe("https://api.example.com/v1/chat/completions?alt=json");
  });

  test("applies request rules without mutating the source payload", () => {
    const initial = { old_name: "x", nested: { value: 1 }, remove_me: true };
    const result = applyCompatibilityRequestRules(initial, profile.rules);
    expect(result).toMatchObject({ new_name: "x", outer: { inner: { value: 1 } }, temperature: 0.2 });
    expect(result).not.toHaveProperty("old_name");
    expect(result).not.toHaveProperty("remove_me");
    expect(initial).toEqual({ old_name: "x", nested: { value: 1 }, remove_me: true });
  });

  test("filters and normalizes compatibility headers", () => {
    const headers: Record<string, string> = {};
    applyCompatibilityHeaders(headers, profile);
    expect(headers).toEqual({ "x-custom": "value" });
  });

  test("selects requested response metadata fields", () => {
    const metadata = compatibilityResponseMetadata(new Headers({ "x-request-id": "req-1" }), { system_fingerprint: "fp-1", model: "gpt-4.1", service_tier: "standard" }, profile);
    expect(metadata).toEqual({ requestId: "req-1", systemFingerprint: "fp-1", model: "gpt-4.1" });
  });
});
