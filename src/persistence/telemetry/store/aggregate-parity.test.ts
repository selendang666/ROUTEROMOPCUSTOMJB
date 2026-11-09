import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteTelemetryStore } from "./sqlite/writer.js";
import { D1TelemetryStore } from "./d1/writer.js";

function ev(overrides: Record<string, unknown> = {}) {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    endpoint: "/v1/chat/completions",
    surface: "openai-chat",
    providerId: "openai",
    model: "gpt-4o",
    statusCode: 200,
    clientIp: "127.0.0.1",
    usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 2, totalTokens: 15 },
    startedAt: new Date(Date.now() - 1000).toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("TelemetryStore aggregate parity — SQLite vs D1 shapes", () => {
  test("getUsageSummary matches JS aggregation on same fixtures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agg-sum-"));
    const store = await SqliteTelemetryStore.create(join(dir, "t.db"));
    try {
      await store.writeBatch([ev(), ev({ statusCode: 500, providerId: "anthropic", model: "claude-3" }), ev({ providerId: "openai", model: "gpt-4o-mini" })]);
      const summary = await store.getUsageSummary({});
      expect(summary.requests).toBe(3);
      expect(summary.errors).toBe(1);
      expect(summary.inputTokens).toBe(30);
      expect(summary.outputTokens).toBe(15);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("getChartBuckets and getBreakdown produce deterministic rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agg-break-"));
    const store = await SqliteTelemetryStore.create(join(dir, "t.db"));
    try {
      await store.writeBatch([
        ev({ providerId: "openai", model: "gpt-4o" }),
        ev({ providerId: "openai", model: "gpt-4o" }),
        ev({ providerId: "anthropic", model: "claude-3" }),
      ]);
      const byProvider = await store.getBreakdown({}, "provider");
      expect(byProvider.rows.find((r) => r.name === "openai")?.requests).toBe(2);
      const byModel = await store.getBreakdown({}, "model");
      expect(byModel.rows.find((r) => r.name === "gpt-4o")?.requests).toBe(2);
      const chart = await store.getChartBuckets({});
      expect(chart.buckets.length).toBeGreaterThanOrEqual(1);
      expect(chart.buckets[0]?.requests).toBeGreaterThanOrEqual(1);
      const cache = await store.getCacheSummary({});
      expect(cache.inputTokens).toBe(30);
      expect(cache.cachedTokens).toBe(6);
      expect(cache.hitRate).toBeCloseTo(0.2, 2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("getTrace returns single row without scan and getApiKeyTotalsBatch is batched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agg-trace-"));
    const store = await SqliteTelemetryStore.create(join(dir, "t.db"));
    try {
      const id = "trace-batch-1";
      await store.writeBatch([ev({ requestId: id, apiKeyId: "key-1" }), ev({ requestId: "other", apiKeyId: "key-1" }), ev({ requestId: "x", apiKeyId: "key-2" })]);
      const row = await store.getTrace(id);
      expect(row?.traceId).toBe(id);
      expect(await store.getTrace("missing")).toBeNull();
      const batch = await store.getApiKeyTotalsBatch(["key-1", "key-2", "missing"]);
      expect(batch["key-1"]?.totalRequests).toBe(2);
      expect(batch["key-2"]?.totalRequests).toBe(1);
      expect(batch["missing"]?.totalRequests).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("D1 getUsageSummary / getBreakdown / getTrace parity via mocked fetch", async () => {
    const originalFetch = globalThis.fetch;
    let lastSql = "";
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { batch: Array<{ sql: string }> };
      lastSql = body.batch[0]?.sql ?? "";
      const sql = lastSql;
      let results: unknown[] = [];
      if (sql.includes("COUNT(*) as requests") && sql.includes("inputTokens")) {
        results = [{ requests: 5, inputTokens: 50, cachedTokens: 10, outputTokens: 25, errors: 1, avgDurationMs: 12, p95DurationMs: 18 }];
      } else if (sql.includes("GROUP BY model") || sql.includes("GROUP BY provider") || sql.includes("GROUP BY COALESCE(api_key")) {
        results = [{ name: "openai", requests: 3, input: 30, output: 15, cached: 6, total: 45, errors: 0 }];
      } else if (sql.includes("substr(created_at") ) {
        results = [{ t: "2026-01-01 00:00:00", requests: 2, input: 20, cached: 4, output: 10 }];
      } else if (sql.includes("SUM(input_tokens)") && sql.includes("cachedTokens") === false) {
        results = [{ input_tokens: 50, cached_tokens: 10 }];
      } else if (sql.includes("SELECT id, trace_id")) {
        results = [{ id: 1, trace_id: "trace-1", endpoint: "/v1/chat", surface: "openai-chat", provider: "openai", model: "gpt-4o", status: 200, error_kind: null, client_ip: "127.0.0.1", api_key_id: "k1", api_key_prefix: "pref", meta_json: "{}", input_tokens: 10, output_tokens: 5, cached_tokens: 2, total_tokens: 15, tffb_ms: null, tfft_ms: null, message_count: 1, tool_count: 0, image_count: 0, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), created_at: new Date().toISOString() }];
      } else if (sql.includes("api_key_id IN")) {
        results = [{ api_key_id: "k1", total_tokens: 30, total_requests: 2, daily_tokens: 30, monthly_tokens: 30, success_count: 2, error_count: 0 }];
      } else if (sql.includes("COALESCE(SUM(input_tokens)")) {
        results = [{ inputTokens: 50, cachedTokens: 10 }];
      }
      const payload = body.batch.map(() => ({ results, meta: {} }));
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const store = new D1TelemetryStore("https://d1.test", "token");
      const summary = await store.getUsageSummary({});
      expect(summary.requests).toBe(5);
      const buckets = await store.getChartBuckets({});
      expect(buckets.buckets.length).toBeGreaterThanOrEqual(1);
      const breakdown = await store.getBreakdown({}, "model");
      expect(breakdown.rows[0]?.name).toBe("openai");
      const trace = await store.getTrace("trace-1");
      expect(trace?.traceId).toBe("trace-1");
      const batch = await store.getApiKeyTotalsBatch(["k1", "missing"]);
      expect(batch["k1"]?.totalRequests).toBe(2);
      expect(batch["missing"]?.totalRequests).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("filtered summary respects provider/model/window via SQL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agg-filter-"));
    const store = await SqliteTelemetryStore.create(join(dir, "t.db"));
    try {
      await store.writeBatch([
        ev({ providerId: "openai", model: "gpt-4o" }),
        ev({ providerId: "anthropic", model: "claude-3" }),
      ]);
      const filtered = await store.getUsageSummary({ provider: "openai" });
      expect(filtered.requests).toBe(1);
      const byModel = await store.getBreakdown({ provider: "openai" }, "model");
      expect(byModel.rows.every((r) => r.name === "gpt-4o")).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
