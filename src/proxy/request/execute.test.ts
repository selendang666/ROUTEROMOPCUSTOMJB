import { describe, expect, test } from "bun:test";
import { createInternalFailure } from "../errors.js";
import { CredentialSelector } from "../routing/account.js";
import { NetworkSelector } from "../transport/network.js";
import { executeProxyRequest } from "./execute.js";
import { recoverCall } from "./resilience.js";
import { ApiKeyAdmission } from "../../runtime/key.js";

describe("executeProxyRequest retry boundaries via recoverCall", () => {
  test("does not invoke a second candidate after a non-retryable error", async () => {
    const calls: string[] = [];
    const attempt = async (index: number) => {
      const id = index === 0 ? "p1" : "p2";
      calls.push(id);
      throw createInternalFailure({ kind: "invalid_request", safeMessage: "bad", statusCode: 400, retryable: false, routeScope: null });
    };
    await expect(
      recoverCall({
        attempt,
        maxAttempts: 2,
        signal: new AbortController().signal,
        mapError: (e) => e as unknown as import("../types/error-types.js").InternalFailure,
      }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    expect(calls).toHaveLength(1);
  });

  test("total deadline prevents a second retry attempt", async () => {
    const calls: string[] = [];
    const attempt = async (index: number) => {
      calls.push(`p${index + 1}`);
      // exceed deadline by sleeping longer than remaining time
      await Bun.sleep(15);
      throw createInternalFailure({ kind: "provider_unavailable", safeMessage: "down", statusCode: 503, retryable: true, routeScope: "provider" });
    };
    const controller = new AbortController();
    // Use a short deadline via signal abort after 5ms
    setTimeout(() => controller.abort(), 5);
    await expect(
      recoverCall({
        attempt,
        maxAttempts: 2,
        signal: controller.signal,
        mapError: (e) => e as unknown as import("../types/error-types.js").InternalFailure,
      }),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
  });

  test("failed requests still log estimated input and zero output tokens", async () => {
    const logs: Array<{ event: string; inputTokens: number | null; outputTokens: number | null }> = [];
    const telemetryFinishes: Array<{ usage?: { promptTokens: number; completionTokens: number; totalTokens: number; inputTokens?: number | null; outputTokens?: number | null; source?: string } | null }> = [];
    const model = {
      id: "resolve-model",
      displayName: "Resolve Model",
      capabilities: {
        surfaces: ["openai-chat"],
        streaming: true,
        reasoning: false,
        toolCalls: false,
        images: false,
        pdf: false,
        video: false,
        explicitCache: false,
      },
    };
    const adapter = {
      metadata: { id: "stub", displayName: "Stub", protocol: "openai", credentialKind: "api_key" },
      capabilities: {
        surfaces: ["openai-chat"],
        streaming: true,
        reasoning: false,
        toolCalls: false,
        images: false,
        pdf: false,
        video: false,
        explicitCache: false,
      },
      models: {
        list: [model],
        get: (modelId: string) => (modelId === model.id ? model : null),
      },
      resolveTarget: () => ({ providerId: "stub", modelId: model.id, surface: "openai-chat" as const }),
      call: async () => {
        throw createInternalFailure({ kind: "provider_protocol_error", safeMessage: "bad response", statusCode: 502, retryable: false, routeScope: "provider" });
      },
      mapError: (error: unknown) => error as never,
    };
    const request = {
      requestId: "req-1",
      endpoint: "/v1/chat/completions" as const,
      surface: "openai-chat" as const,
      headers: new Headers(),
      body: {
        model: model.id,
        messages: [{ role: "user", content: "hello ".repeat(64) }],
      },
      signal: new AbortController().signal,
      clientIp: null,
    };
    const apiKey = {
      id: "key-1",
      name: "Test Key",
      keyPrefix: "sk-test",
      active: true,
      rateLimitRpm: null,
      dailyTokenLimit: null,
      monthlyTokenLimit: null,
      oneTimeTokenLimit: null,
      oneTimeTokensUsed: 0,
      maxConcurrentRequests: null,
      providerAllowlist: null,
      modelAllowlist: null,
      modelDenylist: null,
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    const plan = {
      candidates: [
        {
          id: "candidate-1",
          providerId: "stub",
          modelId: model.id,
          accountId: "acc-1",
          proxyId: null,
          priority: 1,
          target: { providerId: "stub", modelId: model.id, surface: "openai-chat" as const },
        },
      ],
      diagnostics: [],
      snapshotRevision: 1,
      requestedModel: model.id,
      mappedModel: model.id,
      sourceSurface: "openai-chat" as const,
    };
    const response = await executeProxyRequest(
      {
        request,
        authorization: { apiKeyId: apiKey.id, trustedIdentity: null, apiKey },
      } as never,
      {
        requestLimits: {
          maxBodyBytes: 1_048_576,
          connectTimeoutMs: 30_000,
          firstByteTimeoutMs: 60_000,
          idleTimeoutMs: 60_000,
          totalTimeoutMs: 600_000,
        },
        admission: new ApiKeyAdmission({ consumeOneTimeTokens: () => {} }),
        providers: { get: (providerId: string) => (providerId === "stub" ? (adapter as never) : undefined) },
        accounts: new CredentialSelector({ getCredential: async (accountId: string) => (accountId === "acc-1" ? "secret" : null) }),
        network: new NetworkSelector(),
        resolveRoutes: async () => plan as never,
        accountCandidates: async () => [
          {
            id: "acc-1",
            accountId: "acc-1",
            providerId: "stub",
            credentialKind: "api_key",
            healthy: true,
            health: null,
            enabled: true,
            quotaAvailable: true,
            modelLocks: null,
            priority: 1,
          },
        ] as never,
        telemetry: {
          start() {
            return {
              recordFirstByte() {},
              recordFirstToken() {},
              async finish(payload: unknown) {
                telemetryFinishes.push(payload as { usage?: { promptTokens: number; completionTokens: number; totalTokens: number; inputTokens?: number | null; outputTokens?: number | null; source?: string } | null });
              },
            };
          },
        } as never,
        onRequestLog: (event) => {
          if (event.event === "failed") logs.push(event);
        },
      } as never,
    );

    expect(response.status).toBe(502);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.inputTokens).toBeGreaterThan(0);
    expect(logs[0]?.outputTokens).toBe(0);
    expect(telemetryFinishes).toHaveLength(1);
    expect(telemetryFinishes[0]?.usage?.promptTokens).toBeGreaterThan(0);
    expect(telemetryFinishes[0]?.usage?.completionTokens).toBe(0);
  });

  test("non-stream failures record first byte before capture settles", async () => {
    let firstByteRecorded = false;
    const model = {
      id: "resolve-model",
      displayName: "Resolve Model",
      capabilities: {
        surfaces: ["openai-chat"],
        streaming: true,
        reasoning: false,
        toolCalls: false,
        images: false,
        pdf: false,
        video: false,
        explicitCache: false,
      },
    };
    const adapter = {
      metadata: { id: "stub", displayName: "Stub", protocol: "openai", credentialKind: "api_key" },
      capabilities: {
        surfaces: ["openai-chat"],
        streaming: true,
        reasoning: false,
        toolCalls: false,
        images: false,
        pdf: false,
        video: false,
        explicitCache: false,
      },
      models: {
        list: [model],
        get: (modelId: string) => (modelId === model.id ? model : null),
      },
      resolveTarget: () => ({ providerId: "stub", modelId: model.id, surface: "openai-chat" as const }),
      call: async () => ({
        mode: "non_stream" as const,
        body: { id: "resp-1", ok: true },
        usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6, source: "provider" as const },
      }),
      mapError: (error: unknown) => error as never,
    };
    const request = {
      requestId: "req-2",
      endpoint: "/v1/chat/completions" as const,
      surface: "openai-chat" as const,
      headers: new Headers(),
      body: {
        model: model.id,
        messages: [{ role: "user", content: "hello ".repeat(64) }],
      },
      signal: new AbortController().signal,
      clientIp: null,
    };
    const plan = {
      candidates: [
        {
          id: "candidate-1",
          providerId: "stub",
          modelId: model.id,
          accountId: "acc-1",
          proxyId: null,
          priority: 1,
          target: { providerId: "stub", modelId: model.id, surface: "openai-chat" as const },
        },
      ],
      diagnostics: [],
      snapshotRevision: 1,
      requestedModel: model.id,
      mappedModel: model.id,
      sourceSurface: "openai-chat" as const,
    };
    await expect(
      executeProxyRequest(
        {
          request,
          authorization: {
            apiKeyId: "key-1",
            trustedIdentity: null,
            apiKey: {
              id: "key-1",
              name: "Test Key",
              keyPrefix: "sk-test",
              active: true,
              rateLimitRpm: null,
              dailyTokenLimit: null,
              monthlyTokenLimit: null,
              oneTimeTokenLimit: null,
              oneTimeTokensUsed: 0,
              maxConcurrentRequests: null,
              providerAllowlist: null,
              modelAllowlist: null,
              modelDenylist: null,
              lastUsedAt: null,
              createdAt: new Date().toISOString(),
              revokedAt: null,
            },
          },
        } as never,
        {
        requestLimits: {
          maxBodyBytes: 1_048_576,
          connectTimeoutMs: 30_000,
          firstByteTimeoutMs: 60_000,
          idleTimeoutMs: 60_000,
          totalTimeoutMs: 600_000,
        },
        admission: new ApiKeyAdmission({ consumeOneTimeTokens: () => {} }),
        providers: { get: (providerId: string) => (providerId === "stub" ? (adapter as never) : undefined) },
        accounts: new CredentialSelector({ getCredential: async (accountId: string) => (accountId === "acc-1" ? "secret" : null) }),
        network: new NetworkSelector(),
        resolveRoutes: async () => plan as never,
        accountCandidates: async () => [
          {
            id: "acc-1",
            accountId: "acc-1",
            providerId: "stub",
            credentialKind: "api_key",
            healthy: true,
            health: null,
            enabled: true,
            quotaAvailable: true,
            modelLocks: null,
            priority: 1,
          },
        ] as never,
        telemetry: {
          start() {
            return {
              recordFirstByte() {
                firstByteRecorded = true;
              },
              async finish() {
                expect(firstByteRecorded).toBe(true);
              },
            };
          },
        } as never,
        createPayloadCapture: () => ({
          save(_requestId, kind) {
            if (kind === "client_response") {
              throw new Error("capture failed");
            }
          },
        }),
        onRequestLog: () => {},
        } as never,
      ),
    ).rejects.toThrow("capture failed");
    expect(firstByteRecorded).toBe(true);
  });

  test("client_aborted failures emit exactly one aborted event, never failed", async () => {
    const events: Array<{ event: string }> = [];
    const model = {
      id: "resolve-model",
      displayName: "Resolve Model",
      capabilities: {
        surfaces: ["openai-chat"],
        streaming: true,
        reasoning: false,
        toolCalls: false,
        images: false,
        pdf: false,
        video: false,
        explicitCache: false,
      },
    };
    const adapter = {
      metadata: { id: "stub", displayName: "Stub", protocol: "openai", credentialKind: "api_key" },
      capabilities: {
        surfaces: ["openai-chat"],
        streaming: true,
        reasoning: false,
        toolCalls: false,
        images: false,
        pdf: false,
        video: false,
        explicitCache: false,
      },
      models: {
        list: [model],
        get: (modelId: string) => (modelId === model.id ? model : null),
      },
      resolveTarget: () => ({ providerId: "stub", modelId: model.id, surface: "openai-chat" as const }),
      call: async () => {
        throw createInternalFailure({ kind: "client_aborted", safeMessage: "aborted by client", statusCode: null, retryable: false, routeScope: null });
      },
      mapError: (error: unknown) => error as never,
    };
    const request = {
      requestId: "req-aborted",
      endpoint: "/v1/chat/completions" as const,
      surface: "openai-chat" as const,
      headers: new Headers(),
      body: { model: model.id, messages: [{ role: "user", content: "hello" }] },
      signal: new AbortController().signal,
      clientIp: null,
    };
    const plan = {
      candidates: [
        { id: "candidate-1", providerId: "stub", modelId: model.id, accountId: "acc-1", proxyId: null, priority: 1, target: { providerId: "stub", modelId: model.id, surface: "openai-chat" as const } },
      ],
      diagnostics: [],
      snapshotRevision: 1,
      requestedModel: model.id,
      mappedModel: model.id,
      sourceSurface: "openai-chat" as const,
    };
    const response = await executeProxyRequest(
      {
        request,
        authorization: {
          apiKeyId: "key-1",
          trustedIdentity: null,
          apiKey: {
            id: "key-1",
            name: "Test Key",
            keyPrefix: "sk-test",
            active: true,
            rateLimitRpm: null,
            dailyTokenLimit: null,
            monthlyTokenLimit: null,
            oneTimeTokenLimit: null,
            oneTimeTokensUsed: 0,
            maxConcurrentRequests: null,
            providerAllowlist: null,
            modelAllowlist: null,
            modelDenylist: null,
            lastUsedAt: null,
            createdAt: new Date().toISOString(),
            revokedAt: null,
          },
        },
      } as never,
      {
        requestLimits: {
          maxBodyBytes: 1_048_576,
          connectTimeoutMs: 30_000,
          firstByteTimeoutMs: 60_000,
          idleTimeoutMs: 60_000,
          totalTimeoutMs: 600_000,
        },
        admission: new ApiKeyAdmission({ consumeOneTimeTokens: () => {} }),
        providers: { get: (providerId: string) => (providerId === "stub" ? (adapter as never) : undefined) },
        accounts: new CredentialSelector({ getCredential: async (accountId: string) => (accountId === "acc-1" ? "secret" : null) }),
        network: new NetworkSelector(),
        resolveRoutes: async () => plan as never,
        accountCandidates: async () => [
          { id: "acc-1", accountId: "acc-1", providerId: "stub", credentialKind: "api_key", healthy: true, health: null, enabled: true, quotaAvailable: true, modelLocks: null, priority: 1 },
        ] as never,
        telemetry: { start() { return { recordFirstByte() {}, recordFirstToken() {}, async finish() {} }; } } as never,
        onRequestLog: (event) => { events.push(event as unknown as { event: string }); },
      } as never,
    );
    expect(response.status).toBeDefined();
    expect(events.filter((e) => e.event === "aborted")).toHaveLength(1);
    expect(events.some((e) => e.event === "failed")).toBe(false);
    expect(events.some((e) => e.event === "complete")).toBe(false);
  });

  test("retryable provider_unavailable with a replacement candidate emits a switch event before the terminal complete", async () => {
    const events: Array<{ event: string; switch?: { fromCandidateId: string; reason: string } }> = [];
    const model = {
      id: "resolve-model",
      displayName: "Resolve Model",
      capabilities: {
        surfaces: ["openai-chat"],
        streaming: true,
        reasoning: false,
        toolCalls: false,
        images: false,
        pdf: false,
        video: false,
        explicitCache: false,
      },
    };
    let callCount = 0;
    const adapter = {
      metadata: { id: "stub", displayName: "Stub", protocol: "openai", credentialKind: "api_key" },
      capabilities: {
        surfaces: ["openai-chat"],
        streaming: true,
        reasoning: false,
        toolCalls: false,
        images: false,
        pdf: false,
        video: false,
        explicitCache: false,
      },
      models: {
        list: [model],
        get: (modelId: string) => (modelId === model.id ? model : null),
      },
      resolveTarget: () => ({ providerId: "stub", modelId: model.id, surface: "openai-chat" as const }),
      call: async () => {
        callCount += 1;
        if (callCount === 1) {
          throw createInternalFailure({ kind: "provider_unavailable", safeMessage: "temporarily down", statusCode: 503, retryable: true, routeScope: null });
        }
        return { mode: "non_stream" as const, body: { id: "resp-1", ok: true }, usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6, source: "provider" as const } };
      },
      mapError: (error: unknown) => error as never,
    };
    const request = {
      requestId: "req-switch",
      endpoint: "/v1/chat/completions" as const,
      surface: "openai-chat" as const,
      headers: new Headers(),
      body: { model: model.id, messages: [{ role: "user", content: "hello" }] },
      signal: new AbortController().signal,
      clientIp: null,
    };
    const plan = {
      candidates: [
        { id: "candidate-1", providerId: "stub", modelId: model.id, accountId: "acc-1", proxyId: null, priority: 1, target: { providerId: "stub", modelId: model.id, surface: "openai-chat" as const } },
        { id: "candidate-2", providerId: "stub", modelId: model.id, accountId: "acc-1", proxyId: null, priority: 2, target: { providerId: "stub", modelId: model.id, surface: "openai-chat" as const } },
      ],
      diagnostics: [],
      snapshotRevision: 1,
      requestedModel: model.id,
      mappedModel: model.id,
      sourceSurface: "openai-chat" as const,
    };
    const response = await executeProxyRequest(
      {
        request,
        authorization: {
          apiKeyId: "key-1",
          trustedIdentity: null,
          apiKey: {
            id: "key-1",
            name: "Test Key",
            keyPrefix: "sk-test",
            active: true,
            rateLimitRpm: null,
            dailyTokenLimit: null,
            monthlyTokenLimit: null,
            oneTimeTokenLimit: null,
            oneTimeTokensUsed: 0,
            maxConcurrentRequests: null,
            providerAllowlist: null,
            modelAllowlist: null,
            modelDenylist: null,
            lastUsedAt: null,
            createdAt: new Date().toISOString(),
            revokedAt: null,
          },
        },
      } as never,
      {
        requestLimits: {
          maxBodyBytes: 1_048_576,
          connectTimeoutMs: 30_000,
          firstByteTimeoutMs: 60_000,
          idleTimeoutMs: 60_000,
          totalTimeoutMs: 600_000,
        },
        maxAttempts: 2,
        admission: new ApiKeyAdmission({ consumeOneTimeTokens: () => {} }),
        providers: { get: (providerId: string) => (providerId === "stub" ? (adapter as never) : undefined) },
        accounts: new CredentialSelector({ getCredential: async (accountId: string) => (accountId === "acc-1" ? "secret" : null) }),
        network: new NetworkSelector(),
        resolveRoutes: async () => plan as never,
        accountCandidates: async () => [
          { id: "acc-1", accountId: "acc-1", providerId: "stub", credentialKind: "api_key", healthy: true, health: null, enabled: true, quotaAvailable: true, modelLocks: null, priority: 1 },
        ] as never,
        telemetry: { start() { return { recordFirstByte() {}, recordFirstToken() {}, async finish() {} }; } } as never,
        onRequestLog: (event) => { events.push(event as unknown as { event: string; switch?: { fromCandidateId: string; reason: string } }); },
      } as never,
    );
    expect(response.status).toBe(200);
    const switchIndex = events.findIndex((e) => e.event === "switch");
    const completeIndex = events.findIndex((e) => e.event === "complete");
    expect(switchIndex).toBeGreaterThanOrEqual(0);
    expect(completeIndex).toBeGreaterThan(switchIndex);
    expect(events[switchIndex]?.switch?.fromCandidateId).toBe("candidate-1");
    expect(events[switchIndex]?.switch?.reason).toBe("provider_unavailable");
  });

  test("successful terminal event carries the leased attempt's accountId and proxyId", async () => {
    let terminalEvent: { accountId: string | null; proxyId: string | null; event: string } | null = null;
    const model = {
      id: "resolve-model",
      displayName: "Resolve Model",
      capabilities: {
        surfaces: ["openai-chat"],
        streaming: true,
        reasoning: false,
        toolCalls: false,
        images: false,
        pdf: false,
        video: false,
        explicitCache: false,
      },
    };
    const adapter = {
      metadata: { id: "stub", displayName: "Stub", protocol: "openai", credentialKind: "api_key" },
      capabilities: {
        surfaces: ["openai-chat"],
        streaming: true,
        reasoning: false,
        toolCalls: false,
        images: false,
        pdf: false,
        video: false,
        explicitCache: false,
      },
      models: {
        list: [model],
        get: (modelId: string) => (modelId === model.id ? model : null),
      },
      resolveTarget: () => ({ providerId: "stub", modelId: model.id, surface: "openai-chat" as const }),
      call: async () => ({ mode: "non_stream" as const, body: { id: "resp-1", ok: true }, usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6, source: "provider" as const } }),
      mapError: (error: unknown) => error as never,
    };
    const request = {
      requestId: "req-selection",
      endpoint: "/v1/chat/completions" as const,
      surface: "openai-chat" as const,
      headers: new Headers(),
      body: { model: model.id, messages: [{ role: "user", content: "hello" }] },
      signal: new AbortController().signal,
      clientIp: null,
    };
    const plan = {
      candidates: [
        { id: "candidate-1", providerId: "stub", modelId: model.id, accountId: "acc-1", proxyId: null, priority: 1, target: { providerId: "stub", modelId: model.id, surface: "openai-chat" as const } },
      ],
      diagnostics: [],
      snapshotRevision: 1,
      requestedModel: model.id,
      mappedModel: model.id,
      sourceSurface: "openai-chat" as const,
    };
    const response = await executeProxyRequest(
      {
        request,
        authorization: {
          apiKeyId: "key-1",
          trustedIdentity: null,
          apiKey: {
            id: "key-1",
            name: "Test Key",
            keyPrefix: "sk-test",
            active: true,
            rateLimitRpm: null,
            dailyTokenLimit: null,
            monthlyTokenLimit: null,
            oneTimeTokenLimit: null,
            oneTimeTokensUsed: 0,
            maxConcurrentRequests: null,
            providerAllowlist: null,
            modelAllowlist: null,
            modelDenylist: null,
            lastUsedAt: null,
            createdAt: new Date().toISOString(),
            revokedAt: null,
          },
        },
      } as never,
      {
        requestLimits: {
          maxBodyBytes: 1_048_576,
          connectTimeoutMs: 30_000,
          firstByteTimeoutMs: 60_000,
          idleTimeoutMs: 60_000,
          totalTimeoutMs: 600_000,
        },
        admission: new ApiKeyAdmission({ consumeOneTimeTokens: () => {} }),
        providers: { get: (providerId: string) => (providerId === "stub" ? (adapter as never) : undefined) },
        accounts: new CredentialSelector({ getCredential: async (accountId: string) => (accountId === "acc-1" ? "secret" : null) }),
        network: new NetworkSelector(),
        resolveRoutes: async () => plan as never,
        accountCandidates: async () => [
          { id: "acc-1", accountId: "acc-1", providerId: "stub", credentialKind: "api_key", healthy: true, health: null, enabled: true, quotaAvailable: true, modelLocks: null, priority: 1 },
        ] as never,
        telemetry: { start() { return { recordFirstByte() {}, recordFirstToken() {}, async finish() {} }; } } as never,
        onRequestLog: (event) => {
          if (event.event === "complete") terminalEvent = event as unknown as { accountId: string | null; proxyId: string | null; event: string };
        },
      } as never,
    );
    expect(response.status).toBe(200);
    expect(terminalEvent).not.toBeNull();
    expect(terminalEvent?.accountId).toBe("acc-1");
    expect(terminalEvent?.proxyId ?? null).toBeNull();
  });

  test("client abort during streaming emits an aborted terminal event", async () => {
    const events: Array<{ event: string; errorKind: string | null; status: number | null }> = [];
    const controller = new AbortController();
    const model = {
      id: "resolve-model",
      displayName: "Resolve Model",
      capabilities: {
        surfaces: ["openai-chat"],
        streaming: true,
        reasoning: false,
        toolCalls: false,
        images: false,
        pdf: false,
        video: false,
        explicitCache: false,
      },
    };
    const adapter = {
      metadata: { id: "stub", displayName: "Stub", protocol: "openai", credentialKind: "api_key" },
      capabilities: {
        surfaces: ["openai-chat"],
        streaming: true,
        reasoning: false,
        toolCalls: false,
        images: false,
        pdf: false,
        video: false,
        explicitCache: false,
      },
      models: {
        list: [model],
        get: (modelId: string) => (modelId === model.id ? model : null),
      },
      resolveTarget: () => ({ providerId: "stub", modelId: model.id, surface: "openai-chat" as const }),
      call: async () => ({
        mode: "stream" as const,
        events: (async function* () {
          yield { type: "text_delta", text: "hello" };
          await Bun.sleep(1);
        })(),
      }),
      mapError: (error: unknown) => error as never,
    };
    const request = {
      requestId: "req-stream-aborted",
      endpoint: "/v1/chat/completions" as const,
      surface: "openai-chat" as const,
      headers: new Headers(),
      body: { model: model.id, messages: [{ role: "user", content: "hello" }], stream: true },
      signal: controller.signal,
      clientIp: null,
    };
    const plan = {
      candidates: [
        { id: "candidate-1", providerId: "stub", modelId: model.id, accountId: "acc-1", proxyId: null, priority: 1, target: { providerId: "stub", modelId: model.id, surface: "openai-chat" as const } },
      ],
      diagnostics: [],
      snapshotRevision: 1,
      requestedModel: model.id,
      mappedModel: model.id,
      sourceSurface: "openai-chat" as const,
    };
    const response = await executeProxyRequest(
      {
        request,
        authorization: {
          apiKeyId: "key-1",
          trustedIdentity: null,
          apiKey: {
            id: "key-1",
            name: "Test Key",
            keyPrefix: "sk-test",
            active: true,
            rateLimitRpm: null,
            dailyTokenLimit: null,
            monthlyTokenLimit: null,
            oneTimeTokenLimit: null,
            oneTimeTokensUsed: 0,
            maxConcurrentRequests: null,
            providerAllowlist: null,
            modelAllowlist: null,
            modelDenylist: null,
            lastUsedAt: null,
            createdAt: new Date().toISOString(),
            revokedAt: null,
          },
        },
      } as never,
      {
        requestLimits: {
          maxBodyBytes: 1_048_576,
          connectTimeoutMs: 30_000,
          firstByteTimeoutMs: 60_000,
          idleTimeoutMs: 60_000,
          totalTimeoutMs: 600_000,
        },
        providers: { get: (providerId: string) => (providerId === "stub" ? (adapter as never) : undefined) },
        accounts: new CredentialSelector({ getCredential: async (accountId: string) => (accountId === "acc-1" ? "secret" : null) }),
        network: new NetworkSelector(),
        resolveRoutes: async () => plan as never,
        accountCandidates: async () => [
          { id: "acc-1", accountId: "acc-1", providerId: "stub", credentialKind: "api_key", healthy: true, health: null, enabled: true, quotaAvailable: true, modelLocks: null, priority: 1 },
        ] as never,
        telemetry: { start() { return { recordFirstByte() {}, recordFirstToken() {}, async finish() {} }; } } as never,
        onRequestLog: (event) => {
          if (event.event === "aborted" || event.event === "failed" || event.event === "complete") {
            events.push({ event: event.event, errorKind: event.errorKind, status: event.status });
          }
        },
      } as never,
    );

    expect(response.body.mode).toBe("stream");
    const iterator = response.body.events[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await iterator.next();
    expect(events).toEqual([{ event: "aborted", errorKind: "client_aborted", status: 499 }]);
  });
});
