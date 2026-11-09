import { describe, expect, test } from "bun:test";
import { createObservabilityService } from "./observability.js";
import { createApiKeysServices } from "./api-keys.js";
import { createAccountsService } from "./accounts.js";
import type { TelemetryPipeline } from "../../persistence/telemetry/pipeline.js";
import type { PostgresPool } from "../../persistence/pool.js";
import { initPrivacySnapshot } from "../../runtime/privacy.js";

function poolStub() {
  return (async () => []) as unknown as PostgresPool;
}

function settingsPoolStub(privacyMode: "masked" | "full") {
  return (() => Promise.resolve([{ settings_json: { runtime: { privacyMode } } }])) as unknown as PostgresPool;
}

describe("observability service delegates to store aggregates", () => {
  test("summary delegates to getUsageSummary and preserves period/totals shape", async () => {
    let called: unknown = null;
    const telemetry = {
      getUsageSummary: async (filter: unknown) => { called = filter; return { requests: 10, inputTokens: 100, cachedTokens: 20, outputTokens: 50, errors: 1, avgDurationMs: 123, p95DurationMs: 456, totalTokens: 150, estimatedCostUsd: 0 }; },
      getChartBuckets: async () => ({ buckets: [] }),
      getBreakdown: async () => ({ rows: [] }),
      getCacheSummary: async () => ({ inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, hitRate: 0 }),
      query: async () => ({ rows: [], nextCursor: null }),
      getTrace: async () => null,
      getPayload: async () => null,
      getTopIps: async () => ({ windowSeconds: 60, rows: [] }),
      queryLogs: async () => ({ rows: [], nextCursor: null }),
    } as unknown as TelemetryPipeline;
    const svc = createObservabilityService(poolStub(), telemetry);
    const res = await svc.usage.query(new URL("http://test/usage/summary?period=24h&provider=openai")) as unknown as { period: string; totals: Record<string, unknown> };
    expect(res.period).toBe("24h");
    expect(res.totals).toMatchObject({ requests: 10, inputTokens: 100, partial: false });
    expect(called).toMatchObject({ provider: "openai" });
  });

  test("chart/breakdown/cache delegate to store buckets and keep shape", async () => {
    const telemetry = {
      getUsageSummary: async () => ({ requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, errors: 0, avgDurationMs: 0, p95DurationMs: 0, totalTokens: 0, estimatedCostUsd: 0 }),
      getChartBuckets: async () => ({ buckets: [{ t: "2026-01-01 00:00:00", requests: 2, input: 20, cached: 4, output: 10 }] }),
      getBreakdown: async (_filter: unknown, dim: string) => ({ rows: [{ name: dim === "model" ? "gpt-4o" : "openai", requests: 2, input: 20, output: 10, cached: 4, total: 30, errors: 0, costUsd: null }] }),
      getCacheSummary: async () => ({ inputTokens: 100, cachedTokens: 30, cacheWriteTokens: 0, hitRate: 0.3 }),
      query: async () => ({ rows: [], nextCursor: null }),
      getTrace: async () => null,
      getPayload: async () => null,
      getTopIps: async () => ({ windowSeconds: 60, rows: [] }),
      queryLogs: async () => ({ rows: [], nextCursor: null }),
    } as unknown as TelemetryPipeline;
    const svc = createObservabilityService(poolStub(), telemetry);
    const chart = await svc.usage.query(new URL("http://test/usage/chart")) as unknown as { buckets: unknown[] };
    expect(chart.buckets.length).toBe(1);
    const byModel = await svc.usage.query(new URL("http://test/usage/by-model")) as unknown as { rows: Array<{ name: string }> };
    expect(byModel.rows[0]?.name).toBe("gpt-4o");
    const byProvider = await svc.usage.query(new URL("http://test/usage/by-provider")) as unknown as { rows: Array<{ name: string }> };
    expect(byProvider.rows[0]?.name).toBe("openai");
    const cache = await svc.usage.query(new URL("http://test/usage/cache")) as unknown as { hitRate: number };
    expect(cache.hitRate).toBe(0.3);
  });

  test("detail uses getTrace without paginated scan", async () => {
    let traceId: string | null = null;
    const telemetry = {
      getTrace: async (id: string) => { traceId = id; return { id: 1, traceId: id, endpoint: "/v1/chat", surface: "openai-chat", provider: "openai", model: "gpt-4o", status: 200, errorKind: null, clientIp: "10.0.0.1", apiKeyId: "k1", apiKeyPrefix: "pref", metaJson: "{}", inputTokens: 10, outputTokens: 5, cachedTokens: 2, totalTokens: 15, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), tffbMs: null, tfftMs: null, messageCount: 1, toolCount: 0, imageCount: 0 }; },
      getPayload: async () => null,
      getUsageSummary: async () => ({ requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, errors: 0, avgDurationMs: 0, p95DurationMs: 0, totalTokens: 0, estimatedCostUsd: 0 }),
      getChartBuckets: async () => ({ buckets: [] }),
      getBreakdown: async () => ({ rows: [] }),
      getCacheSummary: async () => ({ inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, hitRate: 0 }),
      query: async () => { throw new Error("should not query paginated"); },
      getTopIps: async () => ({ windowSeconds: 60, rows: [] }),
      queryLogs: async () => ({ rows: [], nextCursor: null }),
    } as unknown as TelemetryPipeline;
    const svc = createObservabilityService(poolStub(), telemetry);
    const row = await svc.usage.detail("trace-123") as unknown as Record<string, unknown> | null;
    expect(traceId).toBe("trace-123");
    expect(row?.traceId).toBe("trace-123");
    expect(row?.requestId).toBe("trace-123");
  });

  test("api-keys batch totals contract: service batches via single call", async () => {
    let batchCalled = false;
    const pool = (async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("FROM api_keys")) return [{ id: "k1", name: "n1", key_prefix: "pref", active: true, rate_limit_rpm: null, daily_token_limit: null, monthly_token_limit: null, one_time_token_limit: null, one_time_tokens_used: null, max_concurrent_requests: null, provider_allowlist: null, model_allowlist: null, model_denylist: null, notes_title: null, notes_subtitle: null, notes_body: null, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }, { id: "k2", name: "n2", key_prefix: "pref2", active: true, rate_limit_rpm: null, daily_token_limit: null, monthly_token_limit: null, one_time_token_limit: null, one_time_tokens_used: null, max_concurrent_requests: null, provider_allowlist: null, model_allowlist: null, model_denylist: null, notes_title: null, notes_subtitle: null, notes_body: null, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }];
      return [];
    }) as unknown as PostgresPool;
    const usage = {
      getApiKeyTotals: async () => { throw new Error("should use batch"); },
      getApiKeyTotalsBatch: async (ids: readonly string[]) => { batchCalled = true; expect(ids.sort()).toEqual(["k1", "k2"]); return { k1: { totalTokens: 10, totalRequests: 1 }, k2: { totalTokens: 20, totalRequests: 2 } }; },
    };
    const svc = createApiKeysServices(pool, { usage: usage as unknown as { getApiKeyTotals: (id: string) => Promise<{ totalTokens: number; totalRequests: number }> } });
    const res = await svc.consoleApiKeys.list();
    expect(batchCalled).toBe(true);
    expect(res.items.find((x) => x.id === "k1")?.totalUsage).toBe(10);
    expect(res.items.find((x) => x.id === "k2")?.totalRequests).toBe(2);
  });

  test("accounts list batches quota reads via listForAccountIds", async () => {
    let batchIds: readonly string[] | null = null;
    const pool = (async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("FROM provider_accounts")) return [
        { id: "a1", provider: "openai", name: "A1", credential_kind: "api_key", credential_hint: "", priority: 100, active: true, quota_source: null, quota_status: null, quota_plan: null, quota_windows: null, quota_fetched_at: null, quota_last_attempt_at: null, quota_last_success_at: null, quota_error: null },
        { id: "a2", provider: "openai", name: "A2", credential_kind: "api_key", credential_hint: "", priority: 101, active: true, quota_source: null, quota_status: null, quota_plan: null, quota_windows: null, quota_fetched_at: null, quota_last_attempt_at: null, quota_last_success_at: null, quota_error: null },
      ];
      return [];
    }) as unknown as PostgresPool;
    const svc = createAccountsService(pool, async () => ({ source: "test", plan: null, windows: [], error: null }), () => {}, undefined, undefined, undefined, undefined, async (ids) => { batchIds = ids; return [{ accountId: "a1", quotaAvailable: true, lastQuotaRefreshAtMs: null, quota: { source: "openai", status: "ready", plan: null, windows: [], fetchedAt: new Date().toISOString(), lastAttemptAt: null, lastSuccessAt: null, error: null } }]; });
    const res = await svc.list({}) as unknown as { items: Array<{ id: string; quota: unknown }> };
    expect(batchIds?.length).toBe(2);
    expect(res.items.find((x) => x.id === "a1")?.quota).toBeDefined();
  });

  test("accounts quotaRefreshBulk parallelizes without sequential amplification", async () => {
    let calls = 0;
    const pool = (async () => []) as unknown as PostgresPool;
    const svc = createAccountsService(pool, async () => { calls += 1; return { source: "test", plan: null, windows: [], error: null }; });
    const res = await svc.quotaRefreshBulk({ accountIds: ["a1", "a2", "a3"] });
    expect(calls).toBe(3);
    expect(res).toMatchObject({ ok: true, data: { queued: 3 } });
  });

  test("detail populates accountId, proxyId, and reasoningTokens from the store row", async () => {
    const telemetry = {
      getTrace: async (id: string) => ({ id: 1, traceId: id, endpoint: "/v1/chat", surface: "openai-chat", provider: "openai", model: "gpt-4o", status: 200, errorKind: null, clientIp: "10.0.0.1", apiKeyId: "k1", apiKeyPrefix: "pref", metaJson: "{}", inputTokens: 10, outputTokens: 5, cachedTokens: 2, totalTokens: 15, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), tffbMs: null, tfftMs: null, messageCount: 1, toolCount: 0, imageCount: 0, accountId: "acc-42", proxyId: "proxy-7", reasoningTokens: 33 }),
      getPayload: async () => null,
      getUsageSummary: async () => ({ requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, errors: 0, avgDurationMs: 0, p95DurationMs: 0, totalTokens: 0, estimatedCostUsd: 0 }),
      getChartBuckets: async () => ({ buckets: [] }),
      getBreakdown: async () => ({ rows: [] }),
      getCacheSummary: async () => ({ inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, hitRate: 0 }),
      query: async () => { throw new Error("should not query paginated"); },
      getTopIps: async () => ({ windowSeconds: 60, rows: [] }),
      queryLogs: async () => ({ rows: [], nextCursor: null }),
    } as unknown as TelemetryPipeline;
    const svc = createObservabilityService(poolStub(), telemetry);
    const row = await svc.usage.detail("trace-acc") as unknown as Record<string, unknown> | null;
    expect(row?.accountId).toBe("acc-42");
    expect(row?.proxyId).toBe("proxy-7");
    expect(row?.reasoningTokens).toBe(33);
  });

  test("logs.query masks context.clientIp when privacyMode is masked and returns raw when full", async () => {
    const telemetry = {
      queryLogs: async () => ({ rows: [{ id: 1, ts: new Date().toISOString(), level: "info", scope: "request", msg: "complete | ...", context: { event: "complete", clientIp: "9.9.9.9" } }], nextCursor: null }),
      getUsageSummary: async () => ({ requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, errors: 0, avgDurationMs: 0, p95DurationMs: 0, totalTokens: 0, estimatedCostUsd: 0 }),
      getChartBuckets: async () => ({ buckets: [] }),
      getBreakdown: async () => ({ rows: [] }),
      getCacheSummary: async () => ({ inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, hitRate: 0 }),
      query: async () => ({ rows: [], nextCursor: null }),
      getTrace: async () => null,
      getPayload: async () => null,
      getTopIps: async () => ({ windowSeconds: 60, rows: [] }),
    } as unknown as TelemetryPipeline;
    const svc = createObservabilityService(poolStub(), telemetry);

    await initPrivacySnapshot(settingsPoolStub("masked"));
    const maskedRows = await svc.logs.query(new URL("http://test/logs")) as unknown as Array<{ context: { clientIp: string } }>;
    expect(maskedRows[0]?.context.clientIp).toBe("9.9.9.*");

    await initPrivacySnapshot(settingsPoolStub("full"));
    const rawRows = await svc.logs.query(new URL("http://test/logs")) as unknown as Array<{ context: { clientIp: string } }>;
    expect(rawRows[0]?.context.clientIp).toBe("9.9.9.9");
  });
});
