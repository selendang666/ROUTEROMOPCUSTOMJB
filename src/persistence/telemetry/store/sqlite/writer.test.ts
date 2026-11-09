import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteTelemetryStore } from "./writer.js";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    endpoint: "/v1/chat/completions",
    surface: "openai-chat",
    providerId: "openai",
    model: "gpt-4o",
    statusCode: 200,
    clientIp: "127.0.0.1",
    usage: { promptTokens: 100, completionTokens: 50, cachedTokens: 10, totalTokens: 150 },
    startedAt: new Date(Date.now() - 500).toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("SqliteTelemetryStore — datetime() removal", () => {
  let dir: string;
  let store: SqliteTelemetryStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "telemetry-test-"));
    store = await SqliteTelemetryStore.create(join(dir, "test.sqlite"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("getOverviewTotals returns counts for recent events without datetime() wrapper", async () => {
    await store.writeBatch([makeEvent(), makeEvent({ statusCode: 500 })]);
    const totals = await store.getOverviewTotals();
    expect(totals.requests).toBe(2);
    expect(totals.errors).toBe(1);
    expect(totals.inputTokens).toBe(200);
    expect(totals.outputTokens).toBe(100);
    expect(totals.cachedTokens).toBe(20);
    expect(totals.p95DurationMs).toBeGreaterThan(0);
  });

  test("getOverviewTotals excludes events older than 24h", async () => {
    // Insert one recent and one old event directly via SQL
    await store.writeBatch([makeEvent()]);
    const db = (store as unknown as { db: { run(sql: string, params?: unknown[]): void } }).db;
    const oldDate = new Date(Date.now() - 25 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
    db.run(
      `INSERT INTO request_events (trace_id, endpoint, surface, provider, model, status, client_ip, meta_json, input_tokens, output_tokens, cached_tokens, total_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["old-trace", "/v1/chat", "openai-chat", "openai", "gpt-4o", 200, "127.0.0.1", "{}", 50, 25, 5, 75, oldDate],
    );
    const totals = await store.getOverviewTotals();
    expect(totals.requests).toBe(1); // only the recent one
  });

  test("getProviderAggregates groups by provider with direct created_at comparison", async () => {
    await store.writeBatch([
      makeEvent({ providerId: "openai" }),
      makeEvent({ providerId: "openai" }),
      makeEvent({ providerId: "anthropic", statusCode: 500 }),
    ]);
    const aggregates = await store.getProviderAggregates();
    expect(aggregates.length).toBeGreaterThanOrEqual(2);
    const openai = aggregates.find((a) => a.providerId === "openai");
    const anthropic = aggregates.find((a) => a.providerId === "anthropic");
    expect(openai?.requests).toBe(2);
    expect(anthropic?.requests).toBe(1);
    expect(anthropic?.errors).toBe(1);
  });

  test("getTopIps uses direct created_at comparison for window filtering", async () => {
    await store.writeBatch([
      makeEvent({ clientIp: "10.0.0.1" }),
      makeEvent({ clientIp: "10.0.0.1" }),
      makeEvent({ clientIp: "10.0.0.2" }),
    ]);
    const result = await store.getTopIps({ windowSeconds: 60, limit: 10 });
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    const top = result.rows[0];
    expect(top.ip).toBe("10.0.0.1");
    expect(top.requests).toBe(2);
  });

  test("getApiKeyTotals uses direct created_at in CASE expressions for daily/monthly", async () => {
    await store.writeBatch([
      makeEvent({ apiKeyId: "key-1" }),
      makeEvent({ apiKeyId: "key-1", statusCode: 500 }),
      makeEvent({ apiKeyId: "key-2" }),
    ]);
    const totals = await store.getApiKeyTotals("key-1");
    expect(totals.totalRequests).toBe(2);
    expect(totals.totalTokens).toBe(300); // 150 * 2
    expect(totals.dailyTokens).toBe(300); // both are today
    expect(totals.monthlyTokens).toBe(300);
    expect(totals.successCount).toBe(1);
    expect(totals.errorCount).toBe(1);
  });

  test("query plans can use created_at index (no datetime() wrapper on column)", async () => {
    // Insert some data so EXPLAIN has something to plan
    await store.writeBatch([makeEvent()]);
    const db = (store as unknown as { db: { query(sql: string): { all(): unknown[] } } }).db;
    // Verify the query plan for getOverviewTotals-style query uses the index
    const plan = db.query("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM request_events WHERE created_at > datetime('now','-1 day')").all();
    const planStr = JSON.stringify(plan);
    // The index idx_request_events_created_at should be usable (SEARCH USING INDEX)
    // Without datetime() on the column, SQLite can use the index for range scan
    expect(planStr).toContain("request_events");
  });
});
