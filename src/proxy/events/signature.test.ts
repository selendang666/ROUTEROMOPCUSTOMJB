import { describe, expect, test } from "bun:test";
import { validateReasoningSignatures } from "./signature.js";
import type { ProxyRequest } from "../types/request.js";
import type { ContentPart, NormalizedMessage } from "../types/content.js";
import type { ProviderQuirkPolicy } from "../types/provider.js";

function msg(role: NormalizedMessage["role"], content: ContentPart[]): NormalizedMessage {
  return { role, content } as NormalizedMessage;
}

function baseRequest(messages: NormalizedMessage[]): ProxyRequest {
  return {
    model: "claude-test",
    messages,
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    sourceSurface: "anthropic-messages",
    signal: new AbortController().signal,
    limits: { maxBodyBytes: 1024 * 1024, connectTimeoutMs: 5000, firstByteTimeoutMs: 5000, idleTimeoutMs: 5000, totalTimeoutMs: 30000 },
    images: [],
  } as unknown as ProxyRequest;
}

describe("validateReasoningSignatures preserve mode", () => {
  test("undefined policy returns same request identity", () => {
    const req = baseRequest([msg("assistant", [{ type: "text", text: "hi" } as unknown as ContentPart])]);
    const result = validateReasoningSignatures(req, undefined);
    expect(result.request).toBe(req);
    expect(result.changed).toBe(false);
    expect(result.diagnostics.length).toBe(0);
  });

  test("preserve mode returns same request", () => {
    const req = baseRequest([msg("assistant", [{ type: "tool_use", toolCallId: "c1", toolName: "fn", toolArguments: "{}" } as unknown as ContentPart])]);
    const result = validateReasoningSignatures(req, { mode: "preserve" });
    expect(result.request).toBe(req);
    expect(result.changed).toBe(false);
  });

  test("preserve keeps invalid signatures without stripping", () => {
    const req = baseRequest([
      msg("assistant", [{ type: "reasoning", reasoningText: "think", reasoningSignature: "bad\x01sig" } as unknown as ContentPart]),
    ]);
    const result = validateReasoningSignatures(req, { mode: "preserve" });
    expect(result.changed).toBe(false);
    const sig = (result.request.messages[0]!.content[0] as unknown as { reasoningSignature: string }).reasoningSignature;
    expect(sig).toBe("bad\x01sig");
  });
});

describe("strip-invalid", () => {
  test("removes invalid signature and emits diagnostic", () => {
    const req = baseRequest([
      msg("assistant", [{ type: "reasoning", reasoningText: "x", reasoningSignature: "bad\x01sig" } as unknown as ContentPart]),
    ]);
    const result = validateReasoningSignatures(req, { mode: "strip-invalid" });
    expect(result.changed).toBe(true);
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]!.reason).toContain("stripped");
    expect(result.diagnostics[0]!.fieldCategory).toBe("signatures");
    expect(result.diagnostics[0]!.action).toBe("adapted");
    const block = result.request.messages[0]!.content[0] as unknown as Record<string, unknown>;
    expect("reasoningSignature" in block).toBe(false);
  });

  test("removes empty string signature", () => {
    const req = baseRequest([
      msg("assistant", [{ type: "tool_use", toolCallId: "c1", toolName: "fn", toolArguments: "{}", reasoningSignature: "   " } as unknown as ContentPart]),
    ]);
    const result = validateReasoningSignatures(req, { mode: "strip-invalid" });
    expect(result.changed).toBe(true);
  });

  test("removes oversized signature (>4096)", () => {
    const long = "a".repeat(5000);
    const req = baseRequest([msg("assistant", [{ type: "reasoning", reasoningText: "t", reasoningSignature: long } as unknown as ContentPart])]);
    const result = validateReasoningSignatures(req, { mode: "strip-invalid" });
    expect(result.changed).toBe(true);
  });

  test("keeps valid ASCII signature", () => {
    const req = baseRequest([msg("assistant", [{ type: "reasoning", reasoningText: "t", reasoningSignature: "valid-sig_123.ABC" } as unknown as ContentPart])]);
    const result = validateReasoningSignatures(req, { mode: "strip-invalid" });
    expect(result.changed).toBe(false);
    expect(result.diagnostics.length).toBe(0);
    const block = result.request.messages[0]!.content[0] as unknown as { reasoningSignature: string };
    expect(block.reasoningSignature).toBe("valid-sig_123.ABC");
  });

  test("non-assistant messages are untouched", () => {
    const req = baseRequest([
      msg("user", [{ type: "text", text: "hello" } as unknown as ContentPart]),
      msg("assistant", [{ type: "reasoning", reasoningText: "x", reasoningSignature: "bad\x00" } as unknown as ContentPart]),
    ]);
    const result = validateReasoningSignatures(req, { mode: "strip-invalid" });
    expect(result.changed).toBe(true);
    expect((result.request.messages[0]!.content[0] as unknown as { text: string }).text).toBe("hello");
  });

  test("valid ASCII passthrough keeps request when no invalid sigs", () => {
    const req = baseRequest([
      msg("assistant", [{ type: "reasoning", reasoningText: "t", reasoningSignature: "abc_def-123" } as unknown as ContentPart]),
      msg("assistant", [{ type: "tool_use", toolCallId: "c1", toolName: "fn", toolArguments: "{}", reasoningSignature: "sig-ok" } as unknown as ContentPart]),
    ]);
    const result = validateReasoningSignatures(req, { mode: "strip-invalid" });
    expect(result.changed).toBe(false);
  });
});

describe("require mode", () => {
  test("throws capability_unsupported when no placeholder and invalid sig", () => {
    const req = baseRequest([msg("assistant", [{ type: "tool_use", toolCallId: "c1", toolName: "fn", toolArguments: "{}", reasoningSignature: "bad\x01" } as unknown as ContentPart])]);
    expect(() => validateReasoningSignatures(req, { mode: "require" } as ProviderQuirkPolicy["signatures"])).toThrow();
    try {
      validateReasoningSignatures(req, { mode: "require" } as ProviderQuirkPolicy["signatures"]);
    } catch (e) {
      expect((e as { kind: string }).kind).toBe("capability_unsupported");
    }
  });

  test("throws when assistant tool_use lacks signature entirely", () => {
    const req = baseRequest([msg("assistant", [{ type: "tool_use", toolCallId: "c1", toolName: "fn", toolArguments: "{}" } as unknown as ContentPart])]);
    expect(() => validateReasoningSignatures(req, { mode: "require" } as ProviderQuirkPolicy["signatures"])).toThrow();
  });

  test("does not throw when placeholder declared", () => {
    const req = baseRequest([msg("assistant", [{ type: "tool_use", toolCallId: "c1", toolName: "fn", toolArguments: "{}" } as unknown as ContentPart])]);
    const result = validateReasoningSignatures(req, { mode: "require", placeholder: "ph" } as ProviderQuirkPolicy["signatures"]);
    expect(result.changed).toBe(false);
  });

  test("does not throw when valid signatures present", () => {
    const req = baseRequest([msg("assistant", [{ type: "tool_use", toolCallId: "c1", toolName: "fn", toolArguments: "{}", reasoningSignature: "valid123" } as unknown as ContentPart])]);
    const result = validateReasoningSignatures(req, { mode: "require" } as ProviderQuirkPolicy["signatures"]);
    expect(result.changed).toBe(false);
  });
});
