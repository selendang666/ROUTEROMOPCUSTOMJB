import { expect, test } from "bun:test";
import {
  DEFAULT_ANTIGRAVITY_VERSION,
  AntigravityAdapter,
  antigravityWireModelId,
  getAntigravityUserAgent,
  parseAntigravityCredential,
  parseAntigravityManifestVersion,
} from "./antigravity.js";

test("Antigravity upstream identity never uses Oh My Omop - Router runtime identity", () => {
  const originalVersion = Bun.env.PI_AI_ANTIGRAVITY_VERSION;
  const originalOs = Bun.env.PI_AI_ANTIGRAVITY_OS;
  const originalArch = Bun.env.PI_AI_ANTIGRAVITY_ARCH;
  const originalChangeList = Bun.env.PI_AI_ANTIGRAVITY_CL;
  try {
    Bun.env.PI_AI_ANTIGRAVITY_VERSION = "2.8.1";
    Bun.env.PI_AI_ANTIGRAVITY_OS = "darwin";
    Bun.env.PI_AI_ANTIGRAVITY_ARCH = "arm64";
    Bun.env.PI_AI_ANTIGRAVITY_CL = "963137146";
    expect(getAntigravityUserAgent()).toBe("antigravity/hub/2.8.1 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)");
  } finally {
    Bun.env.PI_AI_ANTIGRAVITY_VERSION = originalVersion;
    Bun.env.PI_AI_ANTIGRAVITY_OS = originalOs;
    Bun.env.PI_AI_ANTIGRAVITY_ARCH = originalArch;
    Bun.env.PI_AI_ANTIGRAVITY_CL = originalChangeList;
  }
});

test("Antigravity manifest parser and Claude thinking cap stay current", () => {
  expect(parseAntigravityManifestVersion("version: 2.8.2\npath: build")).toBe("2.8.2");
  expect(DEFAULT_ANTIGRAVITY_VERSION).toBe("2.9.1");
  expect(new AntigravityAdapter().models.list.some((model) => model.id === "claude-opus-4-6-thinking")).toBe(true);
});
test("maps Gemini 3.7 Flash logical ids to supported wire variants", () => {
  expect(antigravityWireModelId("gemini-3.7-flash")).toBe("gemini-3.7-flash-extra-low");
  expect(antigravityWireModelId("gemini-3.7-flash-medium")).toBe("gemini-3.7-flash-low");
  expect(antigravityWireModelId("gemini-3.7-flash-high")).toBe("gemini-3.7-flash-agent");
});

test("Antigravity accepts persisted providerAccountId as the Cloud Code project", () => {
  expect(parseAntigravityCredential(JSON.stringify({ accessToken: "access", providerAccountId: "project-1" }))).toEqual({
    accessToken: "access",
    projectId: "project-1",
  });
});

test("Antigravity call does not refresh discovery implicitly", async () => {
  const originalFetch = globalThis.fetch;
  let discoveryCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("manifest") || url.includes("version")) {
      return new Response(JSON.stringify({ version: DEFAULT_ANTIGRAVITY_VERSION }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { code: "provider_unavailable", message: "Provider unavailable." } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const adapter = new AntigravityAdapter({
      discoveryFetcher: async () => {
        discoveryCalls += 1;
        return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
      versionFetcher: async () => new Response(JSON.stringify({ version: DEFAULT_ANTIGRAVITY_VERSION }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(
      adapter.call({
        target: adapter.resolveTarget("claude-opus-4-8", "openai-chat"),
        request: {
          model: "claude-opus-4-8",
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          tools: [],
          stream: false,
          responseFormat: { kind: "text" },
          reasoning: "default",
          maxOutputTokens: null,
          sourceSurface: "openai-chat",
          signal: new AbortController().signal,
          limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 5_000, firstByteTimeoutMs: 5_000, idleTimeoutMs: 5_000, totalTimeoutMs: 5_000 },
          images: [],
        } as never,
        credential: JSON.stringify({ accessToken: "access", providerAccountId: "project-1" }),
        network: { proxyId: null, url: null, release: async () => {} },
        signal: new AbortController().signal,
      } as never),
    ).rejects.toBeDefined();
    expect(discoveryCalls).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
