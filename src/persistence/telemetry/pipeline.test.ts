import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createTelemetryPipeline } from "./pipeline.js";
import { createTunedDatabase } from "./store/sqlite/connection.js";
import { retainTelemetryData } from "./retention.js";
import type { TelemetryEvent } from "../../proxy/types/telemetry.js";

const event = (id: string): TelemetryEvent => ({
  requestId: id,
  endpoint: "/v1/chat/completions",
  surface: "openai-chat",
  model: "test-model",
  providerId: "test-provider",
  statusCode: 200,
  errorKind: null,
  durationMs: 1,
  usage: null,
  committed: true,
});

describe("telemetry pipeline reliability", () => {
  test("concurrent flush and shutdown share the active write", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let release: (() => void) | null = null;
    globalThis.fetch = (() => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        release = () => resolve(new Response(null, { status: 200 }));
      });
    }) as typeof fetch;
    try {
      const pipeline = await createTelemetryPipeline({ d1Url: "https://telemetry.test", d1Token: "token", flushIntervalMs: 60_000 });
      pipeline.enqueue(event("one"));
      const first = pipeline.flush();
      const second = pipeline.flush();
      const shutdown = pipeline.shutdown();
      await Bun.sleep(5);
      expect(calls).toBe(1);
      release?.();
      await Promise.all([first, second, shutdown]);
      expect(pipeline.stats().flushCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("failed writes requeue events and count only evicted records", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    try {
      const pipeline = await createTelemetryPipeline({ d1Url: "https://telemetry.test", d1Token: "token", maxRecords: 2, flushIntervalMs: 60_000 });
      pipeline.enqueue(event("one"));
      pipeline.enqueue(event("two"));
      pipeline.enqueue(event("three"));
      expect(pipeline.stats().dropped).toBe(1);
      await pipeline.flush();
      const stats = pipeline.stats();
      expect(stats.writeFailures).toBe(1);
      expect(stats.retrying).toBe(2);
      expect(stats.dropped).toBe(1);
      await pipeline.shutdown();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("evicted byte accounting resets after a successful flush", async () => {
    const originalFetch = globalThis.fetch;
    const batchSizes: number[] = [];
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { batch: unknown[] };
      batchSizes.push(body.batch.length);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const pipeline = await createTelemetryPipeline({ d1Url: "https://telemetry.test", d1Token: "token", maxRecords: 2, maxBytes: 10_000, flushIntervalMs: 60_000 });
      pipeline.enqueue(event("one"));
      pipeline.enqueue(event("two"));
      pipeline.enqueue(event("three"));
      await pipeline.flush();
      pipeline.enqueue(event("four"));
      await pipeline.flush();
      expect(batchSizes).toEqual([2, 1]);
      await pipeline.shutdown();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("SQLite telemetry configuration", () => {
  test("uses bounded file-backed cache settings", async () => {
    const path = `./data/test-telemetry-${crypto.randomUUID()}.db`;
    const db = await createTunedDatabase(path);
    try {
      expect(db.query("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
      expect(db.query("PRAGMA synchronous").get()).toMatchObject({ synchronous: 1 });
      expect(db.query("PRAGMA temp_store").get()).toMatchObject({ temp_store: 1 });
      expect(db.query("PRAGMA wal_autocheckpoint").get()).toMatchObject({ wal_autocheckpoint: 1000 });
      expect(db.query("PRAGMA journal_size_limit").get()).toMatchObject({ journal_size_limit: 67108864 });
      expect(db.query("PRAGMA cache_size").get()).toMatchObject({ cache_size: -32768 });
    } finally {
      db.close();
      await rm(path, { force: true });
      await rm(`${path}-wal`, { force: true });
      await rm(`${path}-shm`, { force: true });
    }
  });
});

describe("API-key telemetry contracts", () => {
  test("keeps per-key success, error, and token totals in SQLite", async () => {
    const path = `./data/test-api-key-telemetry-${crypto.randomUUID()}.db`;
    const pipeline = await createTelemetryPipeline({ sqlitePath: path, flushIntervalMs: 60_000 });
    try {
      pipeline.enqueue({
        ...event("api-key-success"),
        apiKeyId: "key-1",
        apiKeyPrefix: "cth_test",
        usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
      });
      pipeline.enqueue({
        ...event("api-key-error"),
        apiKeyId: "key-1",
        apiKeyPrefix: "cth_test",
        statusCode: 500,
        errorKind: "provider_unavailable",
        usage: { promptTokens: 2, completionTokens: 0, totalTokens: 2 },
      });
      await pipeline.flush();
      expect(await pipeline.getApiKeyTotals("key-1")).toEqual({
        totalTokens: 10,
        totalRequests: 2,
        dailyTokens: 10,
        monthlyTokens: 10,
        successCount: 1,
        errorCount: 1,
      });
      const rows = await pipeline.query({ limit: 10 });
      expect(rows.rows.every((row) => row.apiKeyId === "key-1" && row.apiKeyPrefix === "cth_test")).toBe(true);
    } finally {
      await pipeline.shutdown();
      await rm(path, { force: true });
      await rm(`${path}-wal`, { force: true });
      await rm(`${path}-shm`, { force: true });
    }
  });
});

describe("bounded telemetry retention", () => {
  test("retention yields after bounded delete chunks", async () => {
    let runs = 0;
    const db = {
      run() {
        runs += 1;
        return { changes: 500 };
      },
      query() {
        return { get: () => ({ id: 1 }) };
      },
    } as unknown as Parameters<typeof retainTelemetryData>[0];
    const result = await retainTelemetryData(db);
    expect(result.requestEvents).toBe(4000);
    expect(runs).toBe(32);
  });
});
