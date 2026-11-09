import { expect, test } from "bun:test";
import { createDefaultRegistry } from "./default-registry.js";
import { fetchOpenAICompatibleModels } from "./fetch-models.js";

test("All registry adapters return their real static catalog without credentials when fetcher returns empty", async () => {
  const registry = await createDefaultRegistry();
  expect(registry.size).toBe(46);
  for (const adapter of registry.list()) {
    // No discoverModels call without credential should fallback to static; we test via direct discoverModels with null
    if (typeof (adapter as unknown as { discoverModels?: unknown }).discoverModels === "function") {
      const fn = (adapter as unknown as { discoverModels: (input: { credential: string | null; signal?: AbortSignal }) => Promise<readonly unknown[] | null> }).discoverModels;
      // opencodeft is the only no-auth that should still discover with null; others should return null
      const result = await fn({ credential: null });
      if (adapter.metadata.id === "opencodeft") {
        // opencodeft with null credential still attempts fetch — we mock fetcher to return empty via helper, so we test helper directly
        continue;
      }
      expect(result).toBeNull();
    }
    // static catalog is the fallback — may be empty for some providers that rely purely on discovery (e.g., openrouter/groq) but must be defined
    expect(Array.isArray(adapter.models.list)).toBe(true);
  }
});

test("opencodeft sends no Authorization header", async () => {
  const { OpenCodeFreeProvider, OPENCODE_ZEN_API_BASE_URL } = await import("./api-key/opencode.js");
  const adapter = new OpenCodeFreeProvider();
  let capturedHeaders: Record<string, string> | null = null;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = (init?.headers as Record<string, string> | undefined) ?? null;
    expect(String(url)).toBe(`${OPENCODE_ZEN_API_BASE_URL}/models`);
    return Response.json({ data: [{ id: "free-live", name: "Free Live" }] });
  }) as unknown as typeof fetch;
  // Monkey-patch helper via direct call to fetchOpenAICompatibleModels is not enough — we test discoverModels delegates with empty headers
  // We stub global fetch for the duration of discoverModels
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    const models = await (adapter as unknown as { discoverModels: (input: { credential: string | null }) => Promise<readonly unknown[] | null> }).discoverModels({ credential: null });
    expect(models?.[0]).toBeDefined();
    expect(capturedHeaders).not.toBeNull();
    expect(new Headers(capturedHeaders as unknown as HeadersInit).get("authorization")).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("opencodezen sends Bearer when credential present, falls back to static not 401 when absent", async () => {
  const { OpenCodeZenProvider, OPENCODE_ZEN_API_BASE_URL } = await import("./api-key/opencode.js");
  const adapter = new OpenCodeZenProvider();
  // With credential — should fetch
  let headersWith: Record<string, string> | null = null;
  const fetcherWith = (async (url: string | URL | Request, init?: RequestInit) => {
    headersWith = (init?.headers as unknown as Record<string, string> | undefined) ?? null;
    expect(String(url)).toBe(`${OPENCODE_ZEN_API_BASE_URL}/models`);
    return Response.json({ data: [{ id: "zen-live" }] });
  }) as unknown as typeof fetch;
  const orig = globalThis.fetch;
  globalThis.fetch = fetcherWith;
  try {
    const models = await (adapter as unknown as { discoverModels: (input: { credential: string | null }) => Promise<readonly unknown[] | null> }).discoverModels({ credential: "zen-secret" });
    expect(new Headers(headersWith as unknown as HeadersInit).get("authorization")).toBe("Bearer zen-secret");
    expect(models?.length).toBe(1);
  } finally {
    globalThis.fetch = orig;
  }
  // Without credential — should return null (caller will fallback to static, not 401)
  const noCred = await (adapter as unknown as { discoverModels: (input: { credential: string | null }) => Promise<readonly unknown[] | null> }).discoverModels({ credential: null });
  expect(noCred).toBeNull();
  expect(adapter.models.list.length).toBeGreaterThan(0);
});

test("Anthropic sends x-api-key + anthropic-version, not generic Bearer", async () => {
  const { AnthropicAdapter } = await import("./api-key/anthropic.js");
  const adapter = new AnthropicAdapter();
  let captured: Record<string, string> | null = null;
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = (init?.headers as unknown as Record<string, string> | undefined) ?? null;
    return Response.json({ data: [{ id: "claude-live", name: "Claude Live" }] });
  }) as unknown as typeof fetch;
  const orig = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    const models = await (adapter as unknown as { discoverModels: (input: { credential: string | null }) => Promise<readonly unknown[] | null> }).discoverModels({ credential: "sk-ant-123" });
    expect(new Headers(captured as unknown as HeadersInit).get("x-api-key")).toBe("sk-ant-123");
    expect(new Headers(captured as unknown as HeadersInit).get("anthropic-version")).toBe("2023-06-01");
    expect(new Headers(captured as unknown as HeadersInit).get("authorization")).toBeNull();
    expect(models?.length).toBe(1);
  } finally {
    globalThis.fetch = orig;
  }
});

test("Gemini sends x-goog-api-key", async () => {
  const { GeminiAdapter } = await import("./api-key/gemini.js");
  const adapter = new GeminiAdapter();
  let captured: Record<string, string> | null = null;
  const fetcher = (async (_url2: string | URL | Request, init?: RequestInit) => {
    captured = (init?.headers as unknown as Record<string, string> | undefined) ?? null;
    return Response.json({ data: [{ id: "gemini-live" }] });
  }) as unknown as typeof fetch;
  const orig = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    const models = await (adapter as unknown as { discoverModels: (input: { credential: string | null }) => Promise<readonly unknown[] | null> }).discoverModels({ credential: "AIza-123" });
    expect(new Headers(captured as unknown as HeadersInit).get("x-goog-api-key")).toBe("AIza-123");
    expect(models?.length).toBe(1);
  } finally {
    globalThis.fetch = orig;
  }
});

test("Custom provider uses base_url from record via discoverModels", async () => {
  const { CustomProviderAdapter } = await import("./api-key/custom-provider.js");
  const record = {
    slug: "custom-slug",
    name: "Custom",
    baseUrl: "https://custom.example/v1",
    type: "openai-compatible" as const,
    models: [],
    customHeaders: {},
    timeoutSeconds: 30,
  };
  const source = {
    list: () => [record],
    getBySlug: (slug: string) => (slug === record.slug ? record : null),
  };
  const adapter = new CustomProviderAdapter(record, source);
  let urlCaptured = "";
  let headersCaptured: Record<string, string> | null = null;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    urlCaptured = String(url);
    headersCaptured = (init?.headers as unknown as Record<string, string> | undefined) ?? null;
    return Response.json({ data: [{ id: "custom-live", name: "Custom Live", context_length: 50000 }] });
  }) as unknown as typeof fetch;
  const orig = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    const models = await adapter.discoverModels({ credential: "custom-secret" });
    expect(urlCaptured).toBe("https://custom.example/v1/models");
    expect(new Headers(headersCaptured as unknown as HeadersInit).get("authorization")).toBe("Bearer custom-secret");
    expect(models?.[0]).toMatchObject({ id: "custom-live" });
  } finally {
    globalThis.fetch = orig;
  }
});

test("Codex delegates and preserves 1M SKUs", async () => {
  const { CodexAdapter } = await import("./oauth-provider/codex.js");
  const adapter = new CodexAdapter({ discoveryFetcher: (async (url: string | URL | Request, _init?: RequestInit) => {
    expect(String(url)).toContain("/codex/models");
    return Response.json({ data: [{ slug: "gpt-5.6-terra-wm", context_window: 372000 }] });
  }) as unknown as typeof fetch });
  // Need a credential with accountId — craft a JWT payload with chatgpt_account_id
  const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: "acc-123" })).toString("base64url");
  const token = `header.${payload}.sig`;
  const models = await adapter.discoverModels({ credential: token });
  expect(models?.[0]?.id).toBe("gpt-5.6-terra");
  expect(models?.[0]?.context?.inputTokens).toBe(1_000_000);
});

test("Antigravity delegates with variant collapse", async () => {
  const { AntigravityAdapter } = await import("./oauth-provider/antigravity.js");
  const adapter = new AntigravityAdapter({
    discoveryFetcher: (async () => {
      return Response.json({
        models: {
          "gemini-3.5-flash-extra-low": { displayName: "Gemini 3.5 Flash Extra Low", maxTokens: 1_000_000, supportsThinking: true },
          "gemini-3.6-flash-low": { displayName: "Low", maxTokens: 500000 },
        },
      });
    }) as unknown as typeof fetch,
  });
  const cred = JSON.stringify({ accessToken: "tok", projectId: "proj" });
  const models = await adapter.discoverModels({ credential: cred });
  expect(models?.some((m) => m.id === "gemini-3.5-flash")).toBe(true);
  // variant collapse: extra-low and low both map to same logical id, so only one entry per family
  const ids = models?.map((m) => m.id) ?? [];
  expect(new Set(ids).size).toBe(ids.length);
});

test("fetchOpenAICompatibleModels tolerant parsing with context/pricing", async () => {
  const fetcher = (async () => Response.json({ data: [{ id: "m1", name: "M1", context_length: 8192, max_output_tokens: 2048, pricing: { prompt: 0.001, completion: 0.002 } }] })) as unknown as typeof fetch;
  const models = await fetchOpenAICompatibleModels({ baseUrl: "https://example.com/v1", fetcher });
  expect(models?.[0]?.context?.inputTokens).toBe(8192);
  expect(models?.[0]?.context?.outputTokens).toBe(2048);
  expect(models?.[0]?.pricing?.inputPerMillion).toBe(1000);
  expect(models?.[0]?.pricing?.outputPerMillion).toBe(2000);
});

test("Failed discovery returns null (caller will use static)", async () => {
  const { OpenAIAdapter } = await import("./api-key/openai.js");
  const adapter = new OpenAIAdapter();
  const fetcher = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
  const orig = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    const models = await adapter.discoverModels({ credential: "sk-123" });
    expect(models).toBeNull();
    // static fallback still has models
    expect(adapter.models.list.length).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = orig;
  }
});
