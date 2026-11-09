import type { TelemetryEvent } from "../../../proxy/types/telemetry.js";

export interface ConsoleLogInput {
  readonly level: string;
  readonly scope: string;
  readonly msg: string;
  readonly ts?: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface ConsoleLogRow {
  readonly id: number;
  readonly ts: string;
  readonly level: string;
  readonly scope: string;
  readonly msg: string;
  readonly context: Readonly<Record<string, unknown>> | null;
}

export interface ConsoleLogQuery {
  readonly limit: number;
  readonly afterId?: number;
  readonly cursor?: number | null;
}

export interface ConsoleLogPage {
  readonly rows: ConsoleLogRow[];
  readonly nextCursor: number | null;
}

export interface RetentionResult {
  readonly requestEvents: number;
  readonly payloads: number;
  readonly consoleLogs: number;
  readonly consoleCapped: number;
}

export interface TelemetryQuery {
  readonly limit: number;
  readonly cursor?: number | null;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
}

export interface TelemetryRow {
  readonly id: number;
  readonly traceId: string;
  readonly endpoint: string;
  readonly surface: string;
  readonly provider: string | null;
  readonly model: string;
  readonly status: number;
  readonly errorKind: string | null;
  readonly errorProviderCode: string | null;
  readonly errorProviderType: string | null;
  readonly errorUpstreamRequestId: string | null;
  readonly errorRetryAfterMs: number | null;
  readonly clientIp: string | null;
  readonly apiKeyId: string | null;
  readonly apiKeyPrefix: string | null;
  readonly metaJson: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly totalTokens: number | null;
  readonly createdAt: string;
  readonly tffbMs?: number | null;
  readonly tfftMs?: number | null;
  readonly messageCount?: number | null;
  readonly toolCount?: number | null;
  readonly imageCount?: number | null;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly accountId: string | null;
  readonly proxyId: string | null;
  readonly reasoningTokens: number | null;
}

export interface PayloadArtifact {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly capturedBytes: number;
}

export interface PayloadRecord {
  readonly requestId: string;
  readonly clientRequest: PayloadArtifact | null;
  readonly providerRequest: PayloadArtifact | null;
  readonly providerResponse: PayloadArtifact | null;
  readonly clientResponse: PayloadArtifact | null;
}

export interface OverviewTotals {
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly errors: number;
  readonly avgDurationMs: number;
  readonly p95DurationMs: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
}

export interface ProviderAggregate {
  readonly providerId: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly errors: number;
}

export interface TopIpRow {
  readonly ip: string;
  readonly requests: number;
  readonly rpm: number;
  readonly success: number;
  readonly errors: number;
  readonly models: number;
  readonly tokens: number;
  readonly cached_tokens: number;
}

/** Aggregate usage for one API key using the telemetry store's timestamp semantics. */
export interface ApiKeyUsageTotals {
  readonly totalTokens: number;
  readonly totalRequests: number;
  readonly dailyTokens: number;
  readonly monthlyTokens: number;
  readonly successCount: number;
  readonly errorCount: number;
}

export interface UsageFilter {
  readonly from?: string | null;
  readonly to?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
}

export interface ChartBucket {
  readonly t: string;
  readonly requests: number;
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

export interface BreakdownRow {
  readonly name: string;
  readonly requests: number;
  readonly input: number;
  readonly output: number;
  readonly cached: number;
  readonly total: number;
  readonly errors: number;
  readonly costUsd: number | null;
}

export interface CacheSummary {
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly cacheWriteTokens: number;
  readonly hitRate: number;
}

export interface TelemetryStore {
  writeBatch(events: readonly TelemetryEvent[]): Promise<void>;
  writeLogs(rows: readonly ConsoleLogInput[]): Promise<void>;
  queryLogs(filter: ConsoleLogQuery): Promise<ConsoleLogPage>;
  streamLogs(afterId?: number): AsyncIterable<ConsoleLogRow>;
  clearLogs(): Promise<void>;
  savePayload(requestId: string, kind: "client_request" | "provider_request" | "provider_response" | "client_response", artifact: PayloadArtifact): Promise<void>;
  getPayload(requestId: string): Promise<PayloadRecord | null>;
  retain(options?: { logRetentionDays?: number; payloadRetentionDays?: number }): Promise<RetentionResult>;
  close(): void;
  query(filter: TelemetryQuery): Promise<{ rows: TelemetryRow[]; nextCursor: number | null }>;
  getOverviewTotals(): Promise<OverviewTotals>;
  getProviderAggregates(): Promise<ProviderAggregate[]>;
  getTopIps(options: { windowSeconds: number; limit: number }): Promise<{ rows: TopIpRow[] }>;
  getApiKeyTotals(apiKeyId: string): Promise<ApiKeyUsageTotals>;
  /** Filtered aggregates for dashboard usage snapshot — push grouping into the store layer. */
  getUsageSummary(filter: UsageFilter): Promise<OverviewTotals>;
  getChartBuckets(filter: UsageFilter): Promise<{ buckets: ChartBucket[] }>;
  getBreakdown(filter: UsageFilter, dimension: "model" | "provider" | "api_key"): Promise<{ rows: BreakdownRow[] }>;
  getCacheSummary(filter: UsageFilter): Promise<CacheSummary>;
  getTrace(traceId: string): Promise<TelemetryRow | null>;
  getApiKeyTotalsBatch(apiKeyIds: readonly string[]): Promise<Record<string, ApiKeyUsageTotals>>;
}
