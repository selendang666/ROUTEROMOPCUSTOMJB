import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createTelemetryPipeline } from "./pipeline.js";
import { SqliteTelemetryStore } from "./store/sqlite/writer.js";
import { D1TelemetryStore } from "./store/d1/writer.js";
import type { TelemetryEvent } from "../../proxy/types/telemetry.js";

const evt = (id: string, clientIp = "1.1.1.1"): TelemetryEvent => ({
  requestId: id,
  endpoint: "/v1/chat/completions",
  surface: "openai-chat",
  model: "test-model",
  providerId: "prov",
  statusCode: 200,
  errorKind: null,
  durationMs: 5,
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0 },
  clientIp,
  committed: true,
});

describe("partial chunk failure does not duplicate committed chunks", () => {
  test("D1 progressive commit preserves first chunk", async () => {
    const originalFetch = globalThis.fetch;
    let batchCalls = 0;
    // First execute (first 500) succeeds, second fails
    globalThis.fetch = (async (_url, init) => {
      batchCalls++;
      const body = JSON.parse(String((init as Record<string, unknown>).body)) as { batch: unknown[] };
      // D1 execute may be called multiple times per pipeline chunk due to internal retries (3 attempts on 500).
      // For this test, succeed the first pipeline chunk (500 rows => 1 execute) and fail the second chunk (100 rows => 3 attempts)
      // Detect by batch size: pipeline chunks are 500 then 100.
      const isFirstChunk = (body.batch as unknown[]).length === 500;
      if (isFirstChunk) {
        // success envelope: array of results matching batch length
        const results = (body.batch as unknown[]).map(() => ({ results: [], meta: { changes: 1 } }));
        return new Response(JSON.stringify(results), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    try {
      const pipeline = await createTelemetryPipeline({ d1Url: "https://telemetry.test", d1Token: "token", maxRecords: 700, flushIntervalMs: 60_000 });
      for (let i = 0; i < 600; i++) pipeline.enqueue(evt(`p-${i}`));
      expect(pipeline.stats().pending).toBe(600);
      await pipeline.flush();
      const stats = pipeline.stats();
      // First 500 committed, 100 requeued to retry
      expect(stats.retrying).toBe(100);
      expect(stats.writeFailures).toBe(1);
      expect(stats.pending).toBe(0);
      expect(stats.dropped).toBe(0);
      // Next flush should only attempt 100, succeed
      batchCalls = 0;
      globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String((init as Record<string, unknown>).body)) as { batch: unknown[] };
        expect(body.batch.length).toBe(100);
        const results = (body.batch as unknown[]).map(() => ({ results: [], meta: { changes: 1 } }));
        return new Response(JSON.stringify(results), { status: 200 });
      }) as typeof fetch;
      await pipeline.flush();
      expect(pipeline.stats().retrying).toBe(0);
      expect(pipeline.stats().flushCount).toBe(1);
      await pipeline.shutdown();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("permanent failure and shutdown reports unsent", () => {
  test("failed batches stay in retry and shutdown is durable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    try {
      const pipeline = await createTelemetryPipeline({ d1Url: "https://telemetry.test", d1Token: "token", maxRecords: 10, flushIntervalMs: 60_000 });
      pipeline.enqueue(evt("a"));
      pipeline.enqueue(evt("b"));
      await pipeline.flush();
      expect(pipeline.stats().writeFailures).toBe(1);
      expect(pipeline.stats().retrying).toBe(2);
      expect(pipeline.stats().lastFailureAt).not.toBeNull();
      // enqueue more while degraded
      pipeline.enqueue(evt("c"));
      expect(pipeline.stats().pending).toBe(1);
      await pipeline.shutdown();
      // after shutdown with permanent failures, unsent remains in retrying
      expect(pipeline.stats().retrying).toBeGreaterThan(0);
      expect(pipeline.stats().writeFailures).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("concurrent enqueue during flush", () => {
  test("enqueue while flush in progress is not lost", async () => {
    const originalFetch = globalThis.fetch;
    let release: (() => void) | null = null;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      // only first call gates on release, subsequent calls succeed immediately
      if (calls === 1) {
      return new Promise<Response>((resolve) => {
        release = () => resolve(new Response(JSON.stringify([{ results: [], meta: { changes: 1 } }]), { status: 200, headers: { "content-type": "application/json" } }));
      });
      }
      return Promise.resolve(new Response(JSON.stringify([{ results: [], meta: { changes: 1 } }]), { status: 200, headers: { "content-type": "application/json" } }));
    }) as typeof fetch;
    try {
      const pipeline = await createTelemetryPipeline({ d1Url: "https://telemetry.test", d1Token: "token", flushIntervalMs: 60_000 });
      pipeline.enqueue(evt("one"));
      const flushing = pipeline.flush();
      // concurrent enqueue while fetch pending
      pipeline.enqueue(evt("two"));
      pipeline.enqueue(evt("three"));
      release?.();
      await flushing;
      // two/three should be pending for next flush
      expect(pipeline.stats().pending).toBe(2);
      expect(calls).toBe(1);
      // subsequent shutdown should flush remaining 2 without hanging
      globalThis.fetch = (async () => new Response(JSON.stringify([{ results: [], meta: { changes: 1 } }]), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
      await pipeline.flush();
      await pipeline.shutdown();
      expect(pipeline.stats().flushCount).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("log and payload durability", () => {
  test("writeLogs failure requeues to bounded retry and payload failure likewise", async () => {
    const originalFetch = globalThis.fetch;
    let logCalls = 0;
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String((init as Record<string, unknown>).body)) as { batch: Array<{ sql: string }> };
      const hasLog = body.batch.some((s) => s.sql.includes("console_logs"));
      const hasPayload = body.batch.some((s) => s.sql.includes("request_payloads"));
      if (hasLog) {
        logCalls++;
        // fail all 3 D1 retry attempts for first log batch
        if (logCalls <= 3) return new Response(null, { status: 500 });
      }
      if (hasPayload) {
        // fail payload once (needs 3 attempts to truly fail, but we fail first batch's payload writes)
        // only fail after logs have been attempted
        if (logCalls >= 3) return new Response(null, { status: 500 });
      }
      const results = body.batch.map(() => ({ results: [], meta: { changes: 1 } }));
      return new Response(JSON.stringify(results), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const pipeline = await createTelemetryPipeline({ d1Url: "https://telemetry.test", d1Token: "token", flushIntervalMs: 60_000 });
      await pipeline.writeLogs([{ level: "info", scope: "request", msg: " hello " }]);
      // writeLogs failed, should be in retrying
      expect(pipeline.stats().retrying).toBeGreaterThanOrEqual(1);
      expect(pipeline.stats().writeFailures).toBeGreaterThanOrEqual(1);
      // payload failure
      await pipeline.savePayload("trace-log", "client_request", { text: "hi", truncated: false, originalBytes: 2, capturedBytes: 2 });
      expect(pipeline.stats().retrying).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("D1 envelope and retention options parity", () => {
  test("D1 parses Cloudflare envelope {result: [...]} and respects retain options", async () => {
    const originalFetch = globalThis.fetch;
    const seen: unknown[] = [];
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String((init as Record<string, unknown>).body)) as { batch: Array<{ sql: string; params: unknown[] }> };
      seen.push(...body.batch.map((s) => s.sql));
      // Cloudflare envelope
      const payload = { result: body.batch.map(() => ({ results: [{ id: 1, ts: "2026-01-01T00:00:00Z", level: "info", scope: "request", msg: "hi" }], meta: { changes: 2 } })), success: true };
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
    try {
      const store = new D1TelemetryStore("https://telemetry.test", "token");
      const page = await store.queryLogs({ limit: 1 });
      expect(page.rows[0]?.msg).toBe("hi");
      const res = await store.retain({ logRetentionDays: 5, payloadRetentionDays: 2 });
      expect(res.requestEvents).toBeGreaterThanOrEqual(0);
      // ensure delete statements executed (at least 4)
      expect(seen.some((s) => String(s).includes("DELETE FROM request_events"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("D1 query pagination matches SQLite nextCursor semantics", async () => {
    const originalFetch = globalThis.fetch;
    // Mock D1 that returns limit+1 rows to test pagination
    globalThis.fetch = (async () => {
      const results = [{ id: 3, trace_id: "a", endpoint: "/v1", surface: "openai", provider: "p", model: "m", status: 200, error_kind: null, client_ip: "1.1.1.1", meta_json: "{}", input_tokens: 1, output_tokens: 1, cached_tokens: 0, total_tokens: 2, created_at: "2026-01-01T00:00:00Z" }, { id: 2, trace_id: "b", endpoint: "/v1", surface: "openai", provider: "p", model: "m", status: 200, error_kind: null, client_ip: "1.1.1.2", meta_json: "{}", input_tokens: 1, output_tokens: 1, cached_tokens: 0, total_tokens: 2, created_at: "2026-01-01T00:00:00Z" }, { id: 1, trace_id: "c", endpoint: "/v1", surface: "openai", provider: "p", model: "m", status: 200, error_kind: null, client_ip: "1.1.1.3", meta_json: "{}", input_tokens: 1, output_tokens: 1, cached_tokens: 0, total_tokens: 2, created_at: "2026-01-01T00:00:00Z" }];
      return new Response(JSON.stringify([{ results, meta: {} }]), { status: 200 });
    }) as typeof fetch;
    try {
      const store = new D1TelemetryStore("https://telemetry.test", "token");
      const page = await store.query({ limit: 2 });
      expect(page.rows).toHaveLength(2);
      expect(page.nextCursor).toBe(2);
      expect(page.rows[0]!.id).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("cursor pagination via SQLite", () => {
  test("sqlite queryLogs cursor pagination returns correct nextCursor", async () => {
    const path = `./data/test-cursor-${crypto.randomUUID()}.db`;
    const store = await SqliteTelemetryStore.create(path);
    try {
      for (let i = 0; i < 5; i++) await store.writeLogs([{ level: "info", scope: "request", msg: `m${i}` }]);
      const first = await store.queryLogs({ limit: 2 });
      expect(first.rows).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await store.queryLogs({ limit: 2, cursor: first.nextCursor });
      expect(second.rows).toHaveLength(2);
      expect(second.rows[0]!.id).toBeLessThan(first.rows[1]!.id);
    } finally {
      store.close();
      await rm(path, { force: true });
      await rm(`${path}-wal`, { force: true });
      await rm(`${path}-shm`, { force: true });
    }
  });
});

describe("nonzero aggregates from SQLite without PostgreSQL", () => {
  test("sqlite aggregates return nonzero after events", async () => {
    const path = `./data/test-agg-${crypto.randomUUID()}.db`;
    const store = await SqliteTelemetryStore.create(path);
    try {
      await store.writeBatch([evt("agg-1"), evt("agg-2")]);
      const totals = await store.getOverviewTotals();
      expect(totals.requests).toBe(2);
      expect(totals.inputTokens).toBe(20);
      const providers = await store.getProviderAggregates();
      expect(providers.length).toBe(1);
      expect(providers[0]!.requests).toBe(2);
      const top = await store.getTopIps({ windowSeconds: 60, limit: 5 });
      expect(top.rows.length).toBeGreaterThan(0);
      expect(top.rows[0]!.requests).toBe(2);
    } finally {
      store.close();
      await rm(path, { force: true });
      await rm(`${path}-wal`, { force: true });
      await rm(`${path}-shm`, { force: true });
    }
  });

  test("D1 aggregates return nonzero without postgres", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String((init as Record<string, unknown>).body)) as { batch: Array<{ sql: string }> };
      const sql = body.batch[0]!.sql;
      if (sql.includes("COUNT(*) as requests") && sql.includes("GROUP BY provider")) {
        return new Response(JSON.stringify([{ results: [{ providerId: "prov", requests: 2, inputTokens: 20, cachedTokens: 0, outputTokens: 10, errors: 0 }], meta: {} }]), { status: 200 });
      }
      if (sql.includes("COUNT(*) as requests") && sql.includes("GROUP BY client_ip")) {
        return new Response(JSON.stringify([{ results: [{ ip: "1.1.1.1", requests: 2, rpm: 2, success: 2, errors: 0, models: 1, tokens: 30, cached_tokens: 0 }], meta: {} }]), { status: 200 });
      }
      if (sql.includes("COUNT(*) as requests")) {
        return new Response(JSON.stringify([{ results: [{ requests: 2, inputTokens: 20, cachedTokens: 0, outputTokens: 10, errors: 0 }], meta: {} }]), { status: 200 });
      }
      return new Response(JSON.stringify([{ results: [], meta: {} }]), { status: 200 });
    }) as typeof fetch;
    try {
      const store = new D1TelemetryStore("https://telemetry.test", "token");
      const totals = await store.getOverviewTotals();
      expect(totals.requests).toBe(2);
      const providers = await store.getProviderAggregates();
      expect(providers[0]!.requests).toBe(2);
      const top = await store.getTopIps({ windowSeconds: 60, limit: 5 });
      expect(top.rows[0]!.requests).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
