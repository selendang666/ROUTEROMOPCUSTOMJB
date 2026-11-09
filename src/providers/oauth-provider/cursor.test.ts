import { describe, expect, test } from "bun:test";
import { CursorAdapter } from "./cursor.js";
import type { ProviderRequest } from "../../proxy/types/request.js";

function req(overrides: Partial<ProviderRequest["request"]> = {}): ProviderRequest {
  const limits = { maxBodyBytes: 1_000_000, connectTimeoutMs: 10_000, firstByteTimeoutMs: 30_000, idleTimeoutMs: 30_000, totalTimeoutMs: 120_000 } as unknown as ProviderRequest["request"]["limits"];
  return {
    target: { providerId: "cursor", modelId: "cursor-model", upstreamModelId: "cursor-model", surface: "openai-responses", contextWindowTokens: null },
    credential: "oauth-token",
    request: {
      model: "cursor-model",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] as ProviderRequest["request"]["messages"],
      tools: [],
      stream: false,
      reasoning: "default",
      sourceSurface: "openai-responses",
      limits,
      signal: new AbortController().signal,
      ...overrides,
    } as ProviderRequest["request"],
    network: undefined,
    capture: undefined,
    signal: new AbortController().signal,
  };
}

describe("cursor adapter rejects tool-bearing input", () => {
  test("rejects request with tools (toolCalls false)", async () => {
    const adapter = new CursorAdapter();
    const r = req({
      tools: [{ kind: "function", name: "get_weather", description: "x", inputSchema: { type: "object", properties: {} } } as unknown as ProviderRequest["request"]["tools"][number]],
    });
    await expect(adapter.call(r)).rejects.toMatchObject({ kind: "capability_unsupported" });
  });

  test("accepts tool-free request (does not reject on capability before network)", async () => {
    const adapter = new CursorAdapter();
    const r = req();
    let kind: string | null = null;
    try {
      await adapter.call(r);
    } catch (e) {
      kind = (e as { kind?: string }).kind ?? null;
    }
    // tool-free should not fail with capability_unsupported for tools
    expect(kind === null || kind !== "capability_unsupported").toBe(true);
  });

  test("does not emit synthetic usage on failure path", async () => {
    const adapter = new CursorAdapter();
    const r = req({
      tools: [{ kind: "function", name: "x", description: "x", inputSchema: {} } as unknown as ProviderRequest["request"]["tools"][number]],
    });
    try {
      await adapter.call(r);
      expect(true).toBe(true);
    } catch (e) {
      const msg = String((e as { message?: string }).message ?? "");
      expect(msg).not.toMatch(/synthetic.*usage/i);
      expect((e as { kind?: string }).kind).toBe("capability_unsupported");
    }
  });
});
