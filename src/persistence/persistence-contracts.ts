// Persistence contracts shared by repositories and composition.
import type { LogCategory, LogCategoryFilter, LogLevel } from "../runtime/runtime.js";

export interface PersistenceEnv {
  readonly assetDir: string;
  readonly logRetentionDays: number;
  readonly assetRetentionDays: number;
  readonly maxFlightsPerIp: number;
}

export interface RuntimePersistence {
  readonly env?: PersistenceEnv;
  readonly metadata: {
    sumKeyTokens(keyId: string): { dailyUsed: number; monthlyUsed: number; allTimeUsed: number };
  };
  readonly consoleLogs?: unknown;
  readonly payloads?: unknown;
  readonly telemetry?: unknown;
}

export type ConsoleLogCategory = LogCategory;
export type ConsoleLogCategoryFilter = LogCategoryFilter;

export interface ConsoleLogRow {
  readonly id: number;
  readonly ts: string;
  readonly level: LogLevel;
  readonly scope: string;
  readonly category: LogCategory;
  readonly msg: string;
}

export interface ConsoleLogFilters {
  readonly category?: LogCategoryFilter;
  readonly level?: LogLevel;
  readonly scope?: string;
  readonly limit?: number;
  readonly cursor?: number;
}

export interface ChartBucket {
  readonly t: string;
  readonly requests: number;
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

export interface UsageByRow {
  readonly name: string;
  readonly requests: number;
  readonly input: number;
  readonly output: number;
  readonly cached: number;
  readonly total: number;
  readonly errors: number;
  readonly costUsd: number | null;
}

export interface UsageCacheRow {
  readonly name: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly cacheWriteTokens: number;
  readonly hitRate: number;
}

export interface UsageCacheSummary {
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly cacheWriteTokens: number;
  readonly hitRate: number;
  readonly rows: readonly UsageCacheRow[];
}

export interface ModelTokenTotalsRow {
  readonly model: string;
  readonly provider: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ProviderTodayRow {
  readonly provider: string;
  readonly requests: number;
  readonly input: number;
  readonly cached: number;
  readonly output: number;
  readonly errors: number;
}

export interface IpSummaryRow {
  readonly ip: string;
  readonly requests: number;
  readonly errors: number;
  readonly lastRequestAt: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface UsageSummary {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly errors: number;
  readonly avgDurationMs: number;
}
