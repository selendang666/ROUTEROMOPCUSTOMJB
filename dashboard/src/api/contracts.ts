/**
 * Dashboard contract single-source — dashboard ↔ console ↔ persistence.
 * Single owner for cross-boundary types and runtime validators.
 * Dashboard features MUST import these instead of re-declaring inline types.
 */

import { isRecord } from "../lib/helpers.js";

// Local type mirrors of persistence contracts — no direct src import to avoid
// pulling src/ strict build into dashboard tsc scope. Keep in sync via manual mirror.
export type RuntimePersistence = unknown;
export type ConsoleLogRow = { readonly id: number; readonly ts: string; readonly level: string; readonly scope: string; readonly category: string; readonly msg: string };
export type ConsoleLogFilters = unknown;
export type ChartBucket = { readonly t: string; readonly requests: number; readonly input: number; readonly cached: number; readonly output: number };
export type UsageByRow = unknown;
export type UsageCacheRow = unknown;

// ---------------------------------------------------------------------------
// API error envelope (shared with lib/api.ts)
// ---------------------------------------------------------------------------
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly request_id?: string;
  };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
export interface ProviderOverview {
  readonly id: string;
  readonly prefix: string;
  readonly status: "ok" | "warn";
  readonly requestsToday: number;
  readonly input: number;
  readonly cached: number;
  readonly output: number;
  readonly errors: number;
  readonly lastError: string | null;
}

export interface OverviewTotals {
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly errors: number;
  readonly avgDurationMs: number;
  readonly p95DurationMs: number;
  readonly estimatedCostUsd: number;
}

export interface OverviewData {
  readonly totals: OverviewTotals;
  readonly providers: readonly ProviderOverview[];
  readonly registered: readonly string[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validates and normalizes the console overview response shape.
 * @param value - unknown payload from GET /console/api/overview
 * @returns normalized OverviewData or null if shape invalid
 */
export function parseOverviewData(value: unknown): OverviewData | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.registered) ||
    !value.registered.every((item) => typeof item === "string") ||
    !Array.isArray(value.providers) ||
    !isRecord(value.totals)
  )
    return null;
  const totals = value.totals as Record<string, unknown>;
  const totalKeys: (keyof OverviewTotals)[] = ["requests", "inputTokens", "cachedTokens", "outputTokens", "errors"];
  if (!totalKeys.every((key) => isFiniteNumber(totals[key]))) return null;
  const requests = totals["requests"] as number;
  const inputTokens = totals["inputTokens"] as number;
  const cachedTokens = totals["cachedTokens"] as number;
  const outputTokens = totals["outputTokens"] as number;
  const errors = totals["errors"] as number;
  const avgDurationMs = isFiniteNumber(totals["avgDurationMs"]) ? (totals["avgDurationMs"] as number) : 0;
  const p95DurationMs = isFiniteNumber(totals["p95DurationMs"]) ? (totals["p95DurationMs"] as number) : 0;
  const estimatedCostUsd = isFiniteNumber(totals["estimatedCostUsd"]) ? (totals["estimatedCostUsd"] as number) : 0;
  const providers: ProviderOverview[] = [];
  for (const item of value.providers as unknown[]) {
    if (
      !isRecord(item) ||
      typeof item.providerId !== "string" ||
      !isFiniteNumber(item.requests) ||
      !isFiniteNumber(item.inputTokens) ||
      !isFiniteNumber(item.cachedTokens) ||
      !isFiniteNumber(item.outputTokens) ||
      !isFiniteNumber(item.errors)
    )
      return null;
    providers.push({
      id: item.providerId,
      prefix: item.providerId,
      status: (item.errors as number) > 0 ? "warn" : "ok",
      requestsToday: item.requests as number,
      input: item.inputTokens as number,
      cached: item.cachedTokens as number,
      output: item.outputTokens as number,
      errors: item.errors as number,
      lastError: null,
    });
  }
  return {
    totals: { requests, inputTokens, cachedTokens, outputTokens, errors, avgDurationMs, p95DurationMs, estimatedCostUsd },
    providers,
    registered: value.registered as string[],
  };
}

// ---------------------------------------------------------------------------
// Diagnostics / Health
// ---------------------------------------------------------------------------
export interface DiagnosticsData {
  readonly status: string;
  readonly telemetry?: { readonly kind?: string; readonly sqlitePath?: string; readonly d1Url?: string };
  readonly migrations?: { readonly ok: boolean; readonly currentVersion?: number | null };
}

export function parseDiagnostics(value: unknown): DiagnosticsData | null {
  if (!isRecord(value)) return null;
  return value as unknown as DiagnosticsData;
}

// ---------------------------------------------------------------------------
// Filter rules, quota, usage stubs — expand as needed without per-feature inline types
// ---------------------------------------------------------------------------
export interface FilterRuleDto {
  readonly id: number;
  readonly pattern: string;
  readonly replacement: string;
  readonly isRegex: boolean;
  readonly isActive: boolean;
}

export interface QuotaData {
  readonly keys: readonly unknown[];
}

export interface UsageChartPoint {
  readonly t: string;
  readonly requests: number;
}
