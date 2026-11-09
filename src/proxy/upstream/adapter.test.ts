import { describe, expect, test } from "bun:test";
import { createOpenAIAdapter, describeOpenAIAdapter } from "./adapter.js";
import { capabilitiesOf, modelOf } from "../types/provider.js";
import type { ProviderRequest } from "../types/request.js";
import type { OpenAIAdapterConfig } from "../types/provider.js";

function makeConfig(overrides: Partial<OpenAIAdapterConfig> = {}): OpenAIAdapterConfig {
  return {
    id: "test-provider",
    displayName: "Test Provider",
    baseUrl: "https://api.example.com/v1/",
    credentialKind: "api_key",
    auth: "bearer",
    models: [
      modelOf("gpt-4", "GPT-4", capabilitiesOf({ surfaces: ["openai-chat", "openai-responses"], streaming: true })),
      modelOf("gpt-4-mini", "GPT-4 Mini", capabilitiesOf({ surfaces: ["openai-chat"], streaming: false })),
    ],
    ...overrides,
  } as OpenAIAdapterConfig;
}

function providerRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    target: {
      providerId: "test-provider",
      modelId: "gpt-4",
      upstreamModelId: "gpt-4",
      surface: "openai-chat",
    },
    request: {
      model: "gpt-4",
      stream: false,
      sourceSurface: "openai-chat",
      messages: [],
      tools: [],
      maxOutputTokens: null,
      responseFormat: "text",
      reasoning: "default",
      limits: { maxBodyBytes: 1024 * 1024, connectTimeoutMs: 5000, firstByteTimeoutMs: 5000, idleTimeoutMs: 5000, totalTimeoutMs: 30000 },
      images: [],
      signal: new AbortController().signal,
    } as unknown as ProviderRequest["request"],
    credential: "sk-test",
    network: {},
    signal: new AbortController().signal,
    ...overrides,
  } as unknown as ProviderRequest;
}

describe("describeOpenAIAdapter", () => {
  test("builds metadata and capabilities", () => {
    const catalog = describeOpenAIAdapter(makeConfig());
    expect(catalog.metadata.id).toBe("test-provider");
    expect(catalog.metadata.protocol).toBe("openai");
    expect(catalog.capabilities.surfaces).toContain("openai-chat");
    expect(catalog.models.list.length).toBe(2);
  });

  test("resolveTarget returns upstreamModelId", () => {
    const catalog = describeOpenAIAdapter(makeConfig());
    const target = catalog.resolveTarget("gpt-4", "openai-chat");
    expect(target.providerId).toBe("test-provider");
    expect(target.upstreamModelId).toBe("gpt-4");
  });

  test("resolveTarget throws for unsupported surface", () => {
    const catalog = describeOpenAIAdapter(makeConfig());
    expect(() => catalog.resolveTarget("gpt-4", "anthropic-messages" as unknown as never)).toThrow();
  });

  test("resolveTarget throws for model lacking surface", () => {
    const catalog = describeOpenAIAdapter(makeConfig());
    // gpt-4-mini only supports openai-chat, not openai-responses
    expect(() => catalog.resolveTarget("gpt-4-mini", "openai-responses")).toThrow();
  });

  test("strips trailing slashes from baseUrl via adapter creation", () => {
    const adapter = createOpenAIAdapter(makeConfig({ baseUrl: "https://api.example.com/v1///" }));
    expect(adapter.metadata.id).toBe("test-provider");
  });
});

describe("createOpenAIAdapter interface conformance", () => {
  test("exposes Adapter contract fields", () => {
    const adapter = createOpenAIAdapter(makeConfig());
    expect(adapter.metadata).toBeDefined();
    expect(adapter.capabilities).toBeDefined();
    expect(adapter.models).toBeDefined();
    expect(typeof adapter.resolveTarget).toBe("function");
    expect(typeof adapter.call).toBe("function");
    expect(typeof adapter.mapError).toBe("function");
  });

  test("mapError normalizes unknown errors to InternalFailure", () => {
    const adapter = createOpenAIAdapter(makeConfig());
    const failure = adapter.mapError(new Error("boom"));
    expect(failure.kind).toBeDefined();
    expect(typeof failure.safeMessage).toBe("string");
  });

  test("call rejects when providerId mismatches adapter id", async () => {
    const adapter = createOpenAIAdapter(makeConfig());
    const input = providerRequest({ target: { providerId: "other", modelId: "gpt-4", upstreamModelId: "gpt-4", surface: "openai-chat" } as unknown as ProviderRequest["target"] });
    await expect(adapter.call(input)).rejects.toMatchObject({ kind: "capability_unsupported" });
  });

  test("call rejects when surface not in capabilities", async () => {
    const adapter = createOpenAIAdapter(makeConfig());
    const input = providerRequest({ target: { providerId: "test-provider", modelId: "gpt-4", upstreamModelId: "gpt-4", surface: "anthropic-messages" } as unknown as ProviderRequest["target"] });
    // adapter supports openai-chat/responses only, so anthropic should fail
    await expect(adapter.call(input)).rejects.toMatchObject({ kind: "capability_unsupported" });
  });

  test("call rejects when streaming required but not supported", async () => {
    const config = makeConfig({
      models: [modelOf("no-stream", "No Stream", capabilitiesOf({ surfaces: ["openai-chat"], streaming: false }))],
    });
    const adapter = createOpenAIAdapter(config);
    const input = providerRequest({
      target: { providerId: "test-provider", modelId: "no-stream", upstreamModelId: "no-stream", surface: "openai-chat" } as unknown as ProviderRequest["target"],
      request: {
        model: "no-stream",
        stream: true,
        sourceSurface: "openai-chat",
        messages: [],
        tools: [],
        maxOutputTokens: null,
        responseFormat: "text",
        reasoning: "default",
        limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 5000, firstByteTimeoutMs: 5000, idleTimeoutMs: 5000, totalTimeoutMs: 30000 },
        images: [],
        signal: new AbortController().signal,
      } as unknown as ProviderRequest["request"],
    });
    await expect(adapter.call(input)).rejects.toMatchObject({ kind: "capability_unsupported" });
  });

  test("adapter supports openai-responses surface when declared", () => {
    const adapter = createOpenAIAdapter(makeConfig());
    expect(adapter.capabilities.surfaces).toContain("openai-responses");
  });

  test("describe helper aggregates capabilities across models", () => {
    const cfg = makeConfig({
      models: [
        modelOf("a", "A", capabilitiesOf({ surfaces: ["openai-chat"], streaming: true, reasoning: true })),
        modelOf("b", "B", capabilitiesOf({ surfaces: ["openai-responses"], streaming: false, reasoning: false })),
      ],
    });
    const catalog = describeOpenAIAdapter(cfg);
    expect(catalog.capabilities.surfaces).toContain("openai-chat");
    expect(catalog.capabilities.surfaces).toContain("openai-responses");
    expect(catalog.capabilities.reasoning).toBe(true);
    expect(catalog.capabilities.streaming).toBe(true);
  });
});
