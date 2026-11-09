import type { TelemetryEvent, TelemetryPort } from "../../proxy/types/telemetry.js";
import { sanitizeMessage } from "../../proxy/types/error-types.js";
import { markOverhead } from "../../runtime/overhead.js";
import { RingBuffer } from "./buffer/ring.js";
import { SqliteTelemetryStore } from "./store/sqlite/writer.js";
import { D1TelemetryStore } from "./store/d1/writer.js";
import type { TelemetryStore } from "./store/interface.js";
import type { ApiKeyUsageTotals, BreakdownRow, CacheSummary, ChartBucket, ConsoleLogInput, ConsoleLogPage, ConsoleLogQuery, ConsoleLogRow, OverviewTotals, PayloadArtifact, PayloadRecord, ProviderAggregate, RetentionResult, TelemetryQuery, TelemetryRow, TopIpRow, UsageFilter } from "./store/interface.js";
import { createRedisTelemetryCache, type RedisTelemetryCache } from "./cache/redis.js";
import { QueryCache, queryCacheKey } from "./cache/query-cache.js";

export interface TelemetryPipelineOptions {
  readonly maxRecords?: number;
  readonly maxBytes?: number;
  readonly flushIntervalMs?: number;
  readonly sqlitePath?: string;
  readonly d1Url?: string;
  readonly d1Token?: string;
  readonly redisUrl?: string | null;
  readonly logRetentionDays?: number;
  readonly payloadRetentionDays?: number;
  readonly retentionIntervalMs?: number;
}

export interface TelemetryStats {
  readonly pending: number;
  readonly pendingBytes: number;
  readonly flushCount: number;
  readonly dropped: number;
  readonly degraded: boolean;
  readonly writeFailures: number;
  readonly retrying: number;
  readonly lastFailureAt: string | null;
}

const DEFAULT_MAX_RECORDS = 5000;
const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const EAGER_FLUSH_RECORDS = 100;
const EAGER_FLUSH_BYTES = 256 * 1024;
const CHUNK_SIZE = 500;
const LOG_RETRY_CAP = 2000;
const PAYLOAD_RETRY_CAP = 1000;

function telemetryEventBytes(event: TelemetryEvent): number {
  let bytes = 160 + event.requestId.length + event.model.length + (event.providerId?.length ?? 0) + (event.errorKind?.length ?? 0);
  if (event.usage !== null) bytes += 96 + (event.usage.source?.length ?? 0);
  if (event.overhead !== undefined) {
    bytes += 96 + event.overhead.requestId.length;
    for (const mark of event.overhead.marks) bytes += 48 + mark.phase.length;
  }
  if (event.safeHeaders) bytes += Object.keys(event.safeHeaders).length * 64;
  return bytes;
}

export interface TelemetryPipeline {
  enqueue(event: TelemetryEvent): { enqueued: boolean; dropped: boolean; degraded: boolean; accepted: boolean };
  asPort(): TelemetryPort;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  stats(): TelemetryStats;
  query(filter: TelemetryQuery): Promise<{ rows: TelemetryRow[]; nextCursor: number | null }>;
  savePayload(requestId: string, kind: "client_request" | "provider_request" | "provider_response" | "client_response", artifact: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number }): Promise<void>;
  getPayload(requestId: string): Promise<PayloadRecord | null>;
  retain(): Promise<{ requestEvents: number; payloads: number; consoleLogs: number; consoleCapped: number }>;
  writeLogs(rows: readonly ConsoleLogInput[]): Promise<void>;
  queryLogs(filter: ConsoleLogQuery): Promise<ConsoleLogPage>;
  streamLogs(afterId?: number): AsyncIterable<ConsoleLogRow>;
  clearLogs(): Promise<void>;
  getOverviewTotals(): Promise<OverviewTotals>;
  getProviderAggregates(): Promise<ProviderAggregate[]>;
  getTopIps(options: { windowSeconds: number; limit: number }): Promise<{ windowSeconds: number; rows: TopIpRow[] }>;
  getApiKeyTotals(apiKeyId: string): Promise<ApiKeyUsageTotals>;
  getUsageSummary(filter: UsageFilter): Promise<OverviewTotals>;
  getChartBuckets(filter: UsageFilter): Promise<{ buckets: ChartBucket[] }>;
  getBreakdown(filter: UsageFilter, dimension: "model" | "provider" | "api_key"): Promise<{ rows: BreakdownRow[] }>;
  getCacheSummary(filter: UsageFilter): Promise<CacheSummary>;
  getTrace(traceId: string): Promise<TelemetryRow | null>;
  getApiKeyTotalsBatch(apiKeyIds: readonly string[]): Promise<Record<string, ApiKeyUsageTotals>>;
  describeStore(): TelemetryStoreDescriptor;
}

export interface TelemetryStoreDescriptor {
  readonly kind: "sqlite" | "d1";
  readonly sqlitePath?: string;
  readonly d1Url?: string;
}

async function createStore(opts: TelemetryPipelineOptions): Promise<TelemetryStore> {
  if (opts.d1Url && opts.d1Token) return new D1TelemetryStore(opts.d1Url, opts.d1Token);
  const path = opts.sqlitePath ?? "./data/telemetry.db";
  return await SqliteTelemetryStore.create(path);
}

export async function createTelemetryPipeline(options: TelemetryPipelineOptions = {}): Promise<TelemetryPipeline> {
  const store = await createStore(options);
  return createTelemetryPipelineSync(store, options);
}

function createTelemetryPipelineSync(store: TelemetryStore, options: TelemetryPipelineOptions): TelemetryPipeline {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const logRetentionDays = options.logRetentionDays ?? 30;
  const payloadRetentionDays = options.payloadRetentionDays ?? 7;
  const retentionIntervalMs = options.retentionIntervalMs ?? 60 * 60 * 1000;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

  const ring = new RingBuffer(maxRecords);
  const retryRing = new RingBuffer(maxRecords);
  let queueBytes = 0;
  let retryBytes = 0;
  let flushCount = 0;
  let dropped = 0;
  let flushPromise: Promise<void> | null = null;
  let degraded = false;
  let writeFailures = 0;
  let lastFailureAt: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  let redis: RedisTelemetryCache = { cacheGet: async () => null, cacheSet: async () => {}, cacheInvalidate: async () => {}, close: async () => {}, degraded: () => false } as RedisTelemetryCache;
  let queryCache: QueryCache | null = null;
  void createRedisTelemetryCache(options.redisUrl ?? null).then((c) => {
    redis = c;
    queryCache = new QueryCache(redis);
  });

  let retentionTimer: ReturnType<typeof setInterval> | null = null;
  const ensureRetentionTimer = (): void => {
    if (retentionTimer !== null || !store.retain) return;
    retentionTimer = setInterval(() => {
      void store.retain!({ logRetentionDays, payloadRetentionDays }).catch(() => {});
    }, retentionIntervalMs);
    const t = retentionTimer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  };

  // Durable bounded buffers for logs/payloads
  let logRetryQueue: ConsoleLogInput[] = [];
  let payloadRetryQueue: Array<{ requestId: string; kind: "client_request" | "provider_request" | "provider_response" | "client_response"; artifact: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number } }> = [];
  let logFlushPromise: Promise<void> | null = null;
  let payloadFlushPromise: Promise<void> | null = null;
  const activeLogWrites = new Set<Promise<void>>();
  const activePayloadWrites = new Set<Promise<void>>();

  const requeueEvents = (batch: readonly TelemetryEvent[], fromIndex: number): void => {
    for (let i = fromIndex; i < batch.length; i++) {
      const event = batch[i]!;
      const evicted = retryRing.pushOrDropOldest(event);
      if (evicted !== null) {
        retryBytes = Math.max(0, retryBytes - telemetryEventBytes(evicted));
        dropped++;
      }
      retryBytes += telemetryEventBytes(event);
    }
  };

  // flushEventsChunked is inlined into flush to preserve committed on partial failure

  const flushLogsInternal = async (): Promise<void> => {
    if (logFlushPromise !== null) return logFlushPromise;
    // if no retry queued, no work
    if (logRetryQueue.length === 0) return;
    logFlushPromise = (async () => {
      const batch = [...logRetryQueue];
      logRetryQueue = [];
      let committed = 0;
      try {
        for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
          const chunk = batch.slice(i, i + CHUNK_SIZE);
          await store.writeLogs(chunk);
          committed += chunk.length;
          if (chunk.length === CHUNK_SIZE) await Bun.sleep(0);
        }
      } catch {
        writeFailures++;
        lastFailureAt = new Date().toISOString();
        degraded = true;
        const failed = batch.slice(committed);
        for (const row of failed) {
          if (logRetryQueue.length >= LOG_RETRY_CAP) {
            logRetryQueue.shift();
            dropped++;
          }
          logRetryQueue.push(row);
        }
        // also re-add any new enqueued while we were flushing? already in logRetryQueue
      }
    })().finally(() => {
      logFlushPromise = null;
    });
    return logFlushPromise;
  };

  const flushPayloadsInternal = async (): Promise<void> => {
    if (payloadFlushPromise !== null) return payloadFlushPromise;
    if (payloadRetryQueue.length === 0) return;
    payloadFlushPromise = (async () => {
      const batch = [...payloadRetryQueue];
      payloadRetryQueue = [];
      let committed = 0;
      try {
        for (const entry of batch) {
          await store.savePayload(entry.requestId, entry.kind, entry.artifact);
          committed++;
          // yield per chunk of 500
          if (committed % CHUNK_SIZE === 0) await Bun.sleep(0);
        }
      } catch {
        writeFailures++;
        lastFailureAt = new Date().toISOString();
        degraded = true;
        const failed = batch.slice(committed);
        for (const entry of failed) {
          if (payloadRetryQueue.length >= PAYLOAD_RETRY_CAP) {
            payloadRetryQueue.shift();
            dropped++;
          }
          payloadRetryQueue.push(entry);
        }
      }
    })().finally(() => {
      payloadFlushPromise = null;
    });
    return payloadFlushPromise;
  };

  const flush = (): Promise<void> => {
    if (flushPromise !== null) return flushPromise;
    flushPromise = (async () => {
      // drain both rings atomically
      const retryBatch = retryRing.drain();
      if (retryBatch.length > 0) retryBytes = 0;
      const mainBatch = ring.drain();
      if (mainBatch.length > 0) queueBytes = 0;
      const combined = retryBatch.length > 0 || mainBatch.length > 0 ? [...retryBatch, ...mainBatch] : [];
      if (combined.length > 0) {
        let committed = 0;
        try {
          for (let i = 0; i < combined.length; i += CHUNK_SIZE) {
            const chunk = combined.slice(i, i + CHUNK_SIZE);
            await store.writeBatch(chunk);
            committed += chunk.length;
            if (redis.streamPush) {
              for (const ev of chunk) void redis.streamPush(JSON.stringify({ trace_id: ev.requestId, model: ev.model, provider: ev.providerId }));
            }
            if (chunk.length === CHUNK_SIZE) await Bun.sleep(0);
          }
          if (combined.length > 0) await queryCache?.invalidate("telemetry:");
          flushCount++;
          degraded = redis.degraded();
        } catch {
          writeFailures++;
          lastFailureAt = new Date().toISOString();
          requeueEvents(combined, committed);
          degraded = true;
        }
      }
      // also attempt log/payload retries if any, bounded and not blocking event success
      if (logRetryQueue.length > 0) await flushLogsInternal().catch(() => {});
      if (payloadRetryQueue.length > 0) await flushPayloadsInternal().catch(() => {});
    })().finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  };

  const ensureTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
    ensureRetentionTimer();
  };

  const enqueueInternal = (event: TelemetryEvent): { enqueued: boolean; dropped: boolean; degraded: boolean; accepted: boolean } => {
    const stop = markOverhead("telemetry.enqueue");
    ensureTimer();
    const size = telemetryEventBytes(event);
    if (size > maxBytes) {
      dropped++;
      degraded = true;
      stop();
      return { enqueued: false, dropped: true, degraded: true, accepted: false };
    }
    const wouldExceedBytes = queueBytes + retryBytes + size > maxBytes;
    if (ring.isFull || wouldExceedBytes) {
      if (ring.isFull) {
        const oldest = ring.peekOldest();
        const projectedBytes = queueBytes - (oldest === null ? 0 : telemetryEventBytes(oldest)) + size;
        // check combined bytes limit with retry
        if (projectedBytes + retryBytes > maxBytes) {
          dropped++;
          degraded = true;
          stop();
          return { enqueued: false, dropped: true, degraded: true, accepted: false };
        }
        const evicted = ring.pushOrDropOldest(event);
        if (evicted !== null) {
          queueBytes = Math.max(0, queueBytes - telemetryEventBytes(evicted));
          dropped++;
        }
        degraded = true;
        queueBytes += size;
        stop();
        return { enqueued: true, dropped: true, degraded: true, accepted: true };
      }
      dropped++;
      degraded = true;
      stop();
      return { enqueued: false, dropped: true, degraded: true, accepted: false };
    }
    ring.push(event);
    queueBytes += size;
    if (ring.length + retryRing.length >= Math.min(maxRecords, EAGER_FLUSH_RECORDS) || queueBytes + retryBytes >= Math.min(maxBytes, EAGER_FLUSH_BYTES)) {
      queueMicrotask(() => {
        void flush();
      });
    }
    stop();
    const curDegraded = degraded || redis.degraded();
    return { enqueued: true, dropped: false, degraded: curDegraded, accepted: true };
  };

  const storeApi: TelemetryPipeline = {
    enqueue(event: TelemetryEvent): { enqueued: boolean; dropped: boolean; degraded: boolean; accepted: boolean } {
      return enqueueInternal(event);
    },
    asPort(): TelemetryPort {
      return {
        enqueue: (event: TelemetryEvent) => {
          const r = enqueueInternal(event);
          return { enqueued: r.enqueued, dropped: r.dropped, degraded: r.degraded };
        },
      };
    },
    flush(): Promise<void> {
      return flush();
    },
    shutdown(): Promise<void> {
      if (timer !== null) clearInterval(timer as unknown as NodeJS.Timeout);
      timer = null;
      if (retentionTimer !== null) clearInterval(retentionTimer as unknown as NodeJS.Timeout);
      retentionTimer = null;
      return (async () => {
        const awaitActiveWrites = async (): Promise<void> => {
          while (activeLogWrites.size > 0 || activePayloadWrites.size > 0) {
            await Promise.all([...activeLogWrites, ...activePayloadWrites]);
          }
        };
        await awaitActiveWrites();
        // await active flush
        if (flushPromise !== null) await flushPromise;
        await flush();
        await awaitActiveWrites();
        await flush();
        // bounded degraded retries for events/logs/payloads
        for (let attempt = 0; attempt < 3 && (ring.length > 0 || retryRing.length > 0 || logRetryQueue.length > 0 || payloadRetryQueue.length > 0); attempt++) {
          await flush();
          if (flushPromise !== null) await flushPromise;
        }
        // report unsent explicitly via stats pending/retrying; caller can inspect stats()
        store.close();
        void redis.close();
      })();
    },
    stats(): TelemetryStats {
      return { pending: ring.length, pendingBytes: queueBytes + retryBytes, flushCount, dropped, degraded: degraded || redis.degraded(), writeFailures, retrying: retryRing.length + logRetryQueue.length + payloadRetryQueue.length, lastFailureAt };
    },
    async query(filter: TelemetryQuery): Promise<{ rows: TelemetryRow[]; nextCursor: number | null }> {
      const key = "telemetry:" + queryCacheKey({
        limit: filter.limit,
        cursor: filter.cursor ?? null,
        from: filter.from ?? null,
        to: filter.to ?? null,
        provider: filter.provider ?? null,
        model: filter.model ?? null,
      });
      const cached = await queryCache?.get<{ rows: TelemetryRow[]; nextCursor: number | null }>(key);
      if (cached) return cached;
      const res = await store.query({ limit: filter.limit, cursor: filter.cursor ?? null, provider: filter.provider ?? null, model: filter.model ?? null, from: filter.from ?? null, to: filter.to ?? null });
      await queryCache?.set(key, res, 15000);
      return res;
    },
    async savePayload(requestId: string, kind: "client_request" | "provider_request" | "provider_response" | "client_response", artifact: PayloadArtifact): Promise<void> {
      const sanitized = { text: artifact.text, truncated: artifact.truncated, originalBytes: artifact.originalBytes, capturedBytes: artifact.capturedBytes };
      const operation = (async (): Promise<void> => {
        try {
          await store.savePayload(requestId, kind, sanitized);
        } catch {
          writeFailures++;
          lastFailureAt = new Date().toISOString();
          degraded = true;
          if (payloadRetryQueue.length >= PAYLOAD_RETRY_CAP) {
            payloadRetryQueue.shift();
            dropped++;
          }
          payloadRetryQueue.push({ requestId, kind, artifact: sanitized });
        }
      })();
      activePayloadWrites.add(operation);
      try {
        await operation;
      } finally {
        activePayloadWrites.delete(operation);
      }
    },
    getPayload(requestId: string): Promise<PayloadRecord | null> {
      return store.getPayload(requestId);
    },
    retain(): Promise<RetentionResult> {
      return store.retain({ logRetentionDays, payloadRetentionDays });
    },
    async writeLogs(rows: readonly ConsoleLogInput[]): Promise<void> {
      // context_json carries typed lifecycle metadata already scrubbed at construction time (request-log-format.ts);
      // only the flat msg text runs through the regex-based sanitizer.
      const sanitized = rows.map((row): ConsoleLogInput => ({ ...row, msg: sanitizeMessage(row.msg), context: row.context }));
      const operation = (async (): Promise<void> => {
        try {
          await store.writeLogs(sanitized);
        } catch {
          writeFailures++;
          lastFailureAt = new Date().toISOString();
          degraded = true;
          for (const row of sanitized) {
            if (logRetryQueue.length >= LOG_RETRY_CAP) {
              logRetryQueue.shift();
              dropped++;
            }
            logRetryQueue.push(row);
          }
        }
      })();
      activeLogWrites.add(operation);
      try {
        await operation;
      } finally {
        activeLogWrites.delete(operation);
      }
    },
    queryLogs(filter: ConsoleLogQuery): Promise<ConsoleLogPage> {
      return store.queryLogs(filter);
    },
    streamLogs(afterId?: number): AsyncIterable<ConsoleLogRow> {
      return store.streamLogs(afterId);
    },
    async clearLogs(): Promise<void> {
      await store.clearLogs();
      logRetryQueue = [];
      await queryCache?.invalidate("telemetry:");
    },
    async getOverviewTotals() {
      return store.getOverviewTotals();
    },
    async getProviderAggregates() {
      return store.getProviderAggregates();
    },
    async getTopIps(options: { windowSeconds: number; limit: number }) {
      const res = await store.getTopIps(options);
      return { windowSeconds: options.windowSeconds, rows: res.rows };
    },
    getApiKeyTotals(apiKeyId: string): Promise<ApiKeyUsageTotals> {
      return store.getApiKeyTotals(apiKeyId);
    },
    getUsageSummary(filter: UsageFilter): Promise<OverviewTotals> {
      return store.getUsageSummary(filter);
    },
    getChartBuckets(filter: UsageFilter): Promise<{ buckets: ChartBucket[] }> {
      return store.getChartBuckets(filter);
    },
    getBreakdown(filter: UsageFilter, dimension: "model" | "provider" | "api_key"): Promise<{ rows: BreakdownRow[] }> {
      return store.getBreakdown(filter, dimension);
    },
    getCacheSummary(filter: UsageFilter): Promise<CacheSummary> {
      return store.getCacheSummary(filter);
    },
    getTrace(traceId: string): Promise<TelemetryRow | null> {
      return store.getTrace(traceId);
    },
    getApiKeyTotalsBatch(apiKeyIds: readonly string[]): Promise<Record<string, ApiKeyUsageTotals>> {
      return store.getApiKeyTotalsBatch(apiKeyIds);
    },
    describeStore(): TelemetryStoreDescriptor {
      const hasD1 = Boolean(options.d1Url && options.d1Token);
      if (hasD1) return { kind: "d1", d1Url: options.d1Url! };
      return { kind: "sqlite", sqlitePath: options.sqlitePath ?? "./data/telemetry.db" };
    },
  };

  return storeApi;
}
