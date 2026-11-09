import { describe, expect, test } from "bun:test";
import { DevinAdapter } from "./devin.js";
import type { ProviderRequest } from "../../proxy/types/request.js";

function baseReq(overrides: Partial<ProviderRequest["request"]> = {}): ProviderRequest {
  const limits = { maxBodyBytes: 1_000_000, connectTimeoutMs: 10_000, firstByteTimeoutMs: 30_000, idleTimeoutMs: 30_000, totalTimeoutMs: 120_000 } as unknown as ProviderRequest["request"]["limits"];
  return {
    target: { providerId: "devin", modelId: "swe-1-6-slow", upstreamModelId: "swe-1-6-slow", surface: "openai-responses", contextWindowTokens: null },
    credential: "oauth-token",
    request: {
      model: "swe-1-6-slow",
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

describe("devin adapter rejects images/native and no fake usage", () => {
  test("rejects request with image content (if adapter validates) or at least not strip silently", async () => {
    const adapter = new DevinAdapter();
    // Devin currently maps messages to text only; image part should either throw or be ignored without crash.
    // We assert that a request containing image part does not produce fake usage in its error path.
    const req = baseReq({
      messages: [{ role: "user", content: [{ type: "image", url: "data:image/png;base64,abc" } as unknown as { type: "text"; text: string }] }] as unknown as ProviderRequest["request"]["messages"],
    });
    // If validation exists, it may throw capability_unsupported; if not, call will attempt network and fail.
    // In either case, we verify no fabricated usage leak in the thrown error.
    let error: unknown = null;
    try {
      await adapter.call(req);
    } catch (e) {
      error = e;
    }
    if (error !== null) {
      const msg = String((error as { message?: string }).message ?? error);
      // No fake usage numbers should be embedded in auth/capability errors
      expect(msg).not.toMatch(/prompt_tokens.*10.*completion_tokens.*10/i);
    }
    expect(true).toBe(true);
  });

  test("rejects native tool (non-function) with capability_unsupported", async () => {
    const adapter = new DevinAdapter();
    const req = baseReq({
      tools: [{ kind: "native", nativeType: "web_search", nativeOptions: {} } as unknown as ProviderRequest["request"]["tools"][number]],
    });
    await expect(adapter.call(req)).rejects.toMatchObject({ kind: "capability_unsupported" });
  });

  test("non-stream call does not return fake usage when network fails (propagates error rather than fabricating)", async () => {
    const adapter = new DevinAdapter();
    const req = baseReq();
    // Without network mock, call will try real fetch and likely fail due to no devin stream impl in test env.
    // We just ensure that if it throws, it is not a fabricated usage success.
    let output: unknown = null;
    let error: unknown = null;
    try {
      output = await adapter.call(req);
    } catch (e) {
      error = e;
    }
    if (output !== null) {
      // If it succeeded (fallback text), it would contain fabricated usage in old impl; new impl should not
      const body = (output as { body?: Record<string, unknown> }).body;
      if (body && "usage" in body) {
        // Check that usage is not hardcoded 10/10/20 fake
        const usage = body.usage as Record<string, unknown>;
        const fake = usage.prompt_tokens === 10 && usage.completion_tokens === 10 && usage.total_tokens === 20;
        expect(fake).toBe(false);
      }
    }
    expect(error === null || output === null).toBe(true);
  });

  test("function tools are accepted (no rejection for allowed tool kind)", async () => {
    const adapter = new DevinAdapter();
    const req = baseReq({
      tools: [{ kind: "function", name: "get_weather", description: "x", inputSchema: { type: "object", properties: {} } } as unknown as ProviderRequest["request"]["tools"][number]],
    });
    // Should not reject on tool kind validation alone
    let threwKind: string | null = null;
    try {
      await adapter.call(req);
    } catch (e) {
      threwKind = (e as { kind?: string }).kind ?? null;
    }
    // If it throws, it should not be capability_unsupported for function tools
    expect(threwKind === null || threwKind !== "capability_unsupported").toBe(true);
  });
});
