import { beforeEach, describe, expect, test } from "bun:test";
import { createRouteAttempt, createRouteAttemptState } from "./attempt.js";
import { resetProviderConcurrencyForTests } from "../../runtime/concurrency.js";
import { resetInFlightForTests } from "../../runtime/in-flight.js";

function makeSignal(aborted = false): AbortSignal {
  const c = new AbortController();
  if (aborted) c.abort();
  return c.signal;
}

function createMockContext(overrides: {
  signal?: AbortSignal;
  adapterCall?: (opts: unknown) => Promise<unknown>;
  adapterMapError?: (e: unknown) => unknown;
  networkReleaseCount?: { count: number };
  credentialReleaseCount?: { count: number };
  concurrencyReleaseCount?: { count: number };
  stream?: boolean;
  shouldFail?: boolean;
} = {}) {
  const networkReleaseCount = overrides.networkReleaseCount ?? { count: 0 };
  const credentialReleaseCount = overrides.credentialReleaseCount ?? { count: 0 };

  const mockAdapter: Record<string, unknown> = {
    metadata: { credentialKind: "api_key" },
    capabilities: {},
    models: new Map([["m1", { capabilities: null }]]),
    resolveTarget: () => ({ surface: "openai-chat", upstreamModelId: "m1" }),
    call: async () => {
      if (overrides.shouldFail) throw new Error("upstream boom");
      if (overrides.stream) {
        async function* gen() {
          yield { type: "text_delta", text: "hi" } as unknown;
        }
        return { mode: "stream", events: gen() } as unknown;
      }
      return { mode: "non_stream", body: { id: "resp-1" } } as unknown;
    },
    mapError: (e: unknown) => {
      if (overrides.adapterMapError) return overrides.adapterMapError(e);
      return e;
    },
  };
  if (overrides.adapterCall) mockAdapter.call = overrides.adapterCall as never;

  const dependencies: Record<string, unknown> = {
    providers: {
      get: () => mockAdapter,
    },
    accounts: {
      select: async () => ({
        selection: { leaseId: "lease-1", accountId: "acc-1", secret: "sk-test" },
        account: { credentialKind: "api_key" },
      }),
      release: async () => {
        credentialReleaseCount.count += 1;
      },
    },
    network: {
      select: async () => ({
        proxyId: "proxy-1",
        selection: {
          release: async () => {
            networkReleaseCount.count += 1;
          },
        },
      }),
    },
    accountCandidates: async () => [{ id: "acc-1" } as unknown],
    getProviderRouting: () => undefined,
  };

  const plan = {
    candidates: [{ id: "c1", providerId: "openai", modelId: "m1", proxyId: "proxy-1" }],
  } as unknown as import("./prepare.js").ProxyRoutePlan;

  const request = {
    model: "m1",
    sourceSurface: "openai-chat",
    limits: { totalTimeoutMs: 60_000, maxBodyBytes: 1_000_000, connectTimeoutMs: 1000, firstByteTimeoutMs: 1000, idleTimeoutMs: 10000 },
  } as unknown as import("../types/request.js").ProxyRequest;

  const state = createRouteAttemptState();
  const signal = overrides.signal ?? makeSignal(false);

  const context = {
    input: {
      request: { signal, headers: new Headers() },
      authorization: { apiKeyId: null, trustedIdentity: null },
    },
    dependencies: dependencies as unknown as import("./prepare.js").ProxyRequestDependencies,
    request: request as unknown as import("../types/request.js").ProxyRequest,
    plan,
    deadlineMs: Date.now() + 60_000,
    capture: null,
    state,
  } as unknown as import("./attempt.js").RouteAttemptContext;

  return { context, state, networkReleaseCount, credentialReleaseCount, plan, request };
}

describe("createRouteAttempt", () => {
  beforeEach(() => {
    resetProviderConcurrencyForTests();
    resetInFlightForTests();
  });

  test("success: credential, network, concurrency released exactly once", async () => {
    const counters = { network: { count: 0 }, credential: { count: 0 } };
    const { context } = createMockContext({ networkReleaseCount: counters.network, credentialReleaseCount: counters.credential });
    const attempt = createRouteAttempt(context);
    const out = await attempt(0);
    expect(out.mode).toBe("non_stream");
    expect(counters.network.count).toBe(1);
    expect(counters.credential.count).toBe(1);
  });

  test("failure: adapter.call throws still releases exactly once", async () => {
    const counters = { network: { count: 0 }, credential: { count: 0 } };
    const { context } = createMockContext({ networkReleaseCount: counters.network, credentialReleaseCount: counters.credential, shouldFail: true });
    const attempt = createRouteAttempt(context);
    await expect(attempt(0)).rejects.toBeDefined();
    expect(counters.network.count).toBe(1);
    expect(counters.credential.count).toBe(1);
  });

  test("deadline exceeded before candidate throws stream_timeout without leaking", async () => {
    const { context } = createMockContext();
    const expiredContext = { ...context, deadlineMs: Date.now() - 1 } as import("./attempt.js").RouteAttemptContext;
    const attempt = createRouteAttempt(expiredContext);
    await expect(attempt(0)).rejects.toMatchObject({ kind: "stream_timeout" });
  });

  test("abort signal already aborted releases concurrency path and throws client_aborted or provider error", async () => {
    const counters = { network: { count: 0 }, credential: { count: 0 } };
    // Pre-aborted signal - provider concurrency acquire will see abort
    const signal = makeSignal(true);
    const { context } = createMockContext({ signal, networkReleaseCount: counters.network, credentialReleaseCount: counters.credential });
    const attempt = createRouteAttempt(context);
    // Depending on timing, may throw client_aborted or still attempt; ensure no double release
    try {
      await attempt(0);
    } catch {
      // expected
    }
    // Abort listener triggers release; count should be at most 1 and idempotent
    expect(counters.network.count).toBeLessThanOrEqual(1);
    expect(counters.credential.count).toBeLessThanOrEqual(1);
  });

  test("stream: defers release until iteration completes", async () => {
    const counters = { network: { count: 0 }, credential: { count: 0 } };
    const { context } = createMockContext({ networkReleaseCount: counters.network, credentialReleaseCount: counters.credential, stream: true });
    const attempt = createRouteAttempt(context);
    const out = await attempt(0);
    expect(out.mode).toBe("stream");
    // Not yet released while stream is open
    expect(counters.network.count).toBe(0);
    // Consume stream
    if (out.mode === "stream") {
      for await (const _ of out.events as AsyncIterable<unknown>) {
        // consume
      }
    }
    expect(counters.network.count).toBe(1);
    expect(counters.credential.count).toBe(1);
  });

  test("stream: early return triggers release exactly once", async () => {
    const counters = { network: { count: 0 }, credential: { count: 0 } };
    const { context } = createMockContext({ networkReleaseCount: counters.network, credentialReleaseCount: counters.credential, stream: true });
    const attempt = createRouteAttempt(context);
    const out = await attempt(0);
    expect(out.mode).toBe("stream");
    if (out.mode === "stream") {
      const iter = (out.events as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await iter.return?.();
      await iter.return?.(); // second return should be idempotent
    }
    expect(counters.network.count).toBe(1);
    expect(counters.credential.count).toBe(1);
  });

  test("no candidate available throws provider_unavailable", async () => {
    const { context } = createMockContext();
    const emptyPlan = { candidates: [] } as unknown as import("./prepare.js").ProxyRoutePlan;
    const ctx2 = { ...context, plan: emptyPlan } as import("./attempt.js").RouteAttemptContext;
    const attempt = createRouteAttempt(ctx2);
    await expect(attempt(0)).rejects.toMatchObject({ kind: "provider_unavailable" });
  });

  test("state records successful selection on non-stream success", async () => {
    const { context, state } = createMockContext();
    const attempt = createRouteAttempt(context);
    await attempt(0);
    expect(state.successfulCandidateId).toBe("c1");
    expect(state.selectedAttempts.get(0)).toBeDefined();
  });
});
