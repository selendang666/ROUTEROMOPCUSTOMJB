import { describe, expect, test } from "bun:test";
import { detectClientFormat } from "./cross-surface.js";

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe("detectClientFormat — client identity (preserves existing aliases)", () => {
  test("x-client-name explicit header maps to claude-code", () => {
    const result = detectClientFormat("/v1/messages", "anthropic-messages", headers({ "x-client-name": "claude" }), {});
    expect(result.profile.name).toBe("claude-code");
    expect(result.profile.source).toBe("header");
  });

  test("x-client-name codex → codex/openai-responses", () => {
    const result = detectClientFormat("/v1/responses", "openai-responses", headers({ "x-client-name": "codex" }), {});
    expect(result.profile.name).toBe("codex");
  });

  test("user-agent gemini-cli detected", () => {
    const result = detectClientFormat("/v1/chat/completions", "openai-chat", headers({ "user-agent": "gemini-cli/1.2.3" }), {});
    expect(result.profile.name).toBe("gemini-cli");
  });

  test("unknown client falls back to same-protocol-only passthrough, never native", () => {
    const result = detectClientFormat("/v1/chat/completions", "openai-chat", headers({ "user-agent": "some-random-agent" }), {});
    expect(result.profile.name).toBe("unknown");
    expect(result.profile.passthrough).toBe("never");
  });

  test("opencode alias resolves", () => {
    const result = detectClientFormat("/v1/chat/completions", "openai-chat", headers({ "x-client-name": "opencode" }), {});
    expect(result.profile.name).toBe("opencode");
  });
});
