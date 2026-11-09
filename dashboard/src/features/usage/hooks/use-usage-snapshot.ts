import { useMemo } from "react";
import { qk } from "../../../lib/query-keys";
import { useUsageResource } from "./use-usage-resource";

export type Period = "1h" | "24h" | "7d" | "30d" | "all";
export type Dimension = "model" | "provider" | "key";

export interface Summary {
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  errors: number;
  avgDurationMs: number;
  estimatedCostUsd: number;
  partial: boolean;
}

export interface SummaryResponse {
  period: Period;
  totals: Summary;
}

export interface ChartBucket {
  t: string;
  requests: number;
  input: number;
  cached: number;
  output: number;
}

export interface CacheRow {
  name: string;
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  hitRate: number;
}

export interface CacheSummary {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  hitRate: number;
  rows: CacheRow[];
}

export interface ByRow {
  name: string;
  requests: number;
  input: number;
  output: number;
  cached: number;
  total: number;
  errors: number;
  costUsd: number | null;
}

export interface RequestRow {
  requestId: string;
  endpoint: string;
  surface: string;
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  clientIp?: string | null;
  providerId: string | null;
  model: string | null;
  statusCode: number;
  errorKind: string | null;
  mode: "non_stream" | "stream";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  usageSource: string;
  clientName: string;
  clientSource: string;
  routing: {
    requestedModel: string | null;
    mappedModel: string | null;
    upstreamModel: string | null;
    wireSurface: string | null;
    errorMessage: string | null;
  };
  messageCount: number;
  toolCount: number;
  imageCount: number;
  tfftMs: number | null;
  tffbMs: number | null;
  overhead: {
    totalMs: number;
    total: number;
    phases: Array<{ phase: string; durationMs: number; metadata?: Record<string, string | number | boolean> }>;
    marks: Array<{ phase: string; durationMs: number; metadata?: Record<string, string | number | boolean> }>;
    truncated?: boolean;
    requestId?: string;
    startedAt?: string;
  } | null;
  payloads?: {
    clientRequest: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number } | null;
    providerRequest: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number } | null;
    providerResponse: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number } | null;
    clientResponse: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number } | null;
  } | null;
}

/** Single cached snapshot family — one hook owns all usage queries so children stop re-issuing duplicate by-* fetches. */
export function useUsageSnapshot(period: Period, dimension: Dimension) {
  // Static aggregates: long staleTime, no polling. Live slice (requests) stays polled.
  const summary = useUsageResource<SummaryResponse>(qk.usage.summary(period), `/usage/summary?period=${period}&limit=1000`, {
    staleTime: 5 * 60_000,
  });
  const chart = useUsageResource<{ buckets: ChartBucket[] }>(qk.usage.chart(period), `/usage/chart?period=${period}`, {
    staleTime: 5 * 60_000,
    gcTime: 30_000,
  });
  const by = useUsageResource<{ rows: ByRow[] }>(qk.usage.by(period, dimension), `/usage/by-${dimension}?period=${period}`, {
    staleTime: 5 * 60_000,
  });
  const cache = useUsageResource<CacheSummary & { period: Period }>(qk.usage.cache(period), `/usage/cache?period=${period}`, {
    staleTime: 5 * 60_000,
  });
  const requests = useUsageResource<{ items: RequestRow[] }>(qk.usage.recentRequests, "/usage/requests?limit=100", {
    staleTime: 5_000,
    refetchInterval: 5_000,
  });

  const requestMap = useMemo(() => {
    const map = new Map<string, RequestRow>();
    for (const row of requests.data?.items ?? []) map.set(row.requestId, row);
    return map;
  }, [requests.data?.items]);

  const getCachedRequest = (id: string | null): RequestRow | null => {
    if (id === null) return null;
    return requestMap.get(id) ?? null;
  };

  return { summary, chart, by, cache, requests, requestMap, getCachedRequest };
}
