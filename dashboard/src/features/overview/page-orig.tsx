import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { isRecord } from "../../lib/helpers.js";

import {
  Gauge,
  Globe,
  Clock3,
  Info,
  MemoryStick,
  Server,
  Timer,
} from "lucide-react";
import { apiGet } from "../../lib/api";
import { formatDuration, formatMemoryMb, formatUptime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ClipboardButton } from "../../components/patterns/clipboard-button";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { StatePanel } from "../../components/ui/state";
import { Switch } from "../../components/ui/switch";
import { ApiKeysPanel } from "./api-keys-panel";

interface ProviderOverview {
  id: string;
  prefix: string;
  status: "ok" | "warn";
  requestsToday: number;
  input: number;
  cached: number;
  output: number;
  errors: number;
  lastError: string | null;
}

interface OverviewData {
  totals: {
    requests: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    errors: number;
    avgDurationMs: number;
    p95DurationMs: number;
    estimatedCostUsd: number;
  };
  providers: ProviderOverview[];
  registered: string[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validates and normalizes the current console overview response shape. */
export function parseOverviewData(value: unknown): OverviewData | null {
  if (!isRecord(value) || !Array.isArray(value.registered) || !value.registered.every((item) => typeof item === "string") || !Array.isArray(value.providers) || !isRecord(value.totals)) return null;
  const totals = value.totals;
  const totalKeys: (keyof OverviewData["totals"])[] = ["requests", "inputTokens", "cachedTokens", "outputTokens", "errors"];
  if (!totalKeys.every((key) => isFiniteNumber(totals[key]))) return null;
  const requests = totals.requests;
  const inputTokens = totals.inputTokens;
  const cachedTokens = totals.cachedTokens;
  const outputTokens = totals.outputTokens;
  const errors = totals.errors;
  const avgDurationMs = isFiniteNumber(totals.avgDurationMs) ? totals.avgDurationMs : 0;
  const p95DurationMs = isFiniteNumber(totals.p95DurationMs) ? totals.p95DurationMs : 0;
  const estimatedCostUsd = isFiniteNumber(totals.estimatedCostUsd) ? totals.estimatedCostUsd : 0;
  if (!isFiniteNumber(requests) || !isFiniteNumber(inputTokens) || !isFiniteNumber(cachedTokens) || !isFiniteNumber(outputTokens) || !isFiniteNumber(errors)) return null;
  const providers: ProviderOverview[] = [];
  for (const item of value.providers) {
    if (!isRecord(item) || typeof item.providerId !== "string" || !isFiniteNumber(item.requests) || !isFiniteNumber(item.inputTokens) || !isFiniteNumber(item.cachedTokens) || !isFiniteNumber(item.outputTokens) || !isFiniteNumber(item.errors)) return null;
    providers.push({ id: item.providerId, prefix: item.providerId, status: item.errors > 0 ? "warn" : "ok", requestsToday: item.requests, input: item.inputTokens, cached: item.cachedTokens, output: item.outputTokens, errors: item.errors, lastError: null });
  }
  return {
    totals: {
      requests,
      inputTokens,
      cachedTokens,
      outputTokens,
      errors,
      avgDurationMs,
      p95DurationMs,
      estimatedCostUsd,
    },
    providers,
    registered: value.registered,
  };
}


interface HealthMetrics {
  memoryUsedMb: number;
  memorySystemUsedMb: number;
  memoryTotalMb: number;
  cpuPercent: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  coreCount: number;
  cpuModel: string;
  pid: number;
  uptimeSeconds: number;
  platform: string;
  arch: string;
  bunVersion: string;
  wireguardClientMemoryMb: number | null;
}

export function OverviewPage() {
  const baseUrl = useMemo(() => `${window.location.origin}/v1`, []);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || !document.hidden);

  useEffect(() => {
    const handleVisibilityChange = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: qk.overview.all,
    queryFn: async () => {
      const response = await apiGet<unknown>("/overview");
      const parsed = parseOverviewData(response);
      if (parsed === null) throw new Error("Invalid overview response");
      return parsed;
    },
    placeholderData: (prev) => prev,
    staleTime: 10_000,
    gcTime: 120_000,
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
    retry: 2,
  });


  const healthQuery = useQuery({
    queryKey: qk.health.metrics,
    queryFn: async () => {
      const data = await apiGet<HealthMetrics>("/health/metrics");
      if (data && typeof data.memoryUsedMb === "number" && Number.isFinite(data.memoryUsedMb)) return data;
      throw new Error("Health metrics unavailable");
    },
    refetchInterval: pageVisible ? 3_000 : false,
    placeholderData: (prev) => prev,
    staleTime: 10_000,
    gcTime: 120_000,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
    retry: 1,
  });

  const [lowStress, setLowStress] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("ohmyomop-router:lowStress") !== "false";
  });
  useEffect(() => {
    localStorage.setItem("ohmyomop-router:lowStress", String(lowStress));
  }, [lowStress]);

  const proxiesQuery = useQuery({
    queryKey: qk.proxies.all,
    queryFn: () => apiGet<{ items: Array<{ protocol: string; host: string; port: number; active: boolean }> }>("/proxies?limit=100"),
    staleTime: 10_000,
    gcTime: 120_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const proxies = useMemo(() => (proxiesQuery.data as unknown as { items: Array<{ protocol: string; host: string; port: number; active: boolean; maxConcurrency?: number; weight?: number }> } | undefined)?.items ?? [], [proxiesQuery.data]);
  const { totalProxies, activeProxies, socks5Count, httpCount, httpsCount, wireguardCount, flightCapacity } = useMemo(() => {
    const total = proxies.length;
    return {
      totalProxies: total,
      activeProxies: proxies.filter((p) => p.active).length,
      socks5Count: proxies.filter((p) => p.protocol === "socks5").length,
      httpCount: proxies.filter((p) => p.protocol === "http").length,
      httpsCount: proxies.filter((p) => p.protocol === "https").length,
      wireguardCount: proxies.filter((p) => p.host === "127.0.0.1" && String(p.port).startsWith("11")).length,
      flightCapacity: proxies.filter((p) => p.active).reduce((sum, p) => sum + (typeof p.maxConcurrency === "number" ? p.maxConcurrency : 8), 0),
    };
  }, [proxies]);

  const isInitialLoading = isLoading && !data;
  const isInitialError = isError && !data;

  if (isInitialLoading) {
    return (
      <div className="dashboard-page space-y-4">
        <Card surface="base" className="health-card endpoint-card">
          <CardHeader title="API Endpoint" icon={Globe} sub="Base URL for OpenAI- and Anthropic-compatible clients" />
          <div className="health-card-resource min-w-0 rounded-[14px] p-4 lg:p-5">
            <div className="h-4 w-32 animate-pulse rounded bg-[var(--track)]" />
            <div className="mt-3 h-10 animate-pulse rounded-[var(--radius-control)] bg-[var(--track)]" />
          </div>
        </Card>
        <Card surface="base" className="health-card">
          <CardHeader title="System Overview" icon={Gauge} iconColor="#30d158" sub="Runtime resource usage" />
          <div className="health-resource-grid mt-3 grid gap-2.5 auto-rows-fr">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="health-card-resource h-[320px] animate-pulse rounded-[14px] bg-[var(--track)]" />
            ))}
          </div>
        </Card>
        <ApiKeysPanel />
      </div>
    );
  }
  if (isInitialError) {
    return (
      <div className="dashboard-page space-y-4">
        <Card surface="base" className="health-card">
          <CardHeader title="Overview" icon={Gauge} sub="Last 24 hours" />
          <div className="p-4">
            <StatePanel kind="error" title="Failed to load overview" description="The overview response was unavailable or invalid. Retrying with cached data…" action={<Button variant="secondary" onClick={() => refetch()}>Retry</Button>} />
            {isFetching && <p className="mt-2 text-center text-xs text-[var(--text-3)]">Retrying…</p>}
          </div>
        </Card>
        <ApiKeysPanel />
      </div>
    );
  }
  // Cached data guaranteed here — show skeletons only for missing sub-fields, keep card visible
  const totals = data?.totals ?? { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, errors: 0, avgDurationMs: 0, p95DurationMs: 0, estimatedCostUsd: 0 };
  const requestP95 = totals.p95DurationMs ?? 0;
  const requestAverages = formatDuration(totals.avgDurationMs);
  const requestP95Label = formatDuration(requestP95);
  const requestTailGapMs = Math.max(0, requestP95 - totals.avgDurationMs);
  const health = healthQuery.data;
  const cpuPercent = health ? Math.min(100, Math.max(0, health.cpuPercent)) : 0;

  const uptime = health ? formatUptime(health.uptimeSeconds) : "—";
  const bunVersion = health?.bunVersion ?? "—";


  return (
    <div className={`dashboard-page space-y-4 ${isFetching ? "opacity-[0.98]" : ""}`}>
      <Card surface="base" className="health-card endpoint-card">
        <CardHeader title="API Endpoint" icon={Globe} sub="Base URL for OpenAI- and Anthropic-compatible clients" />
        <div className="health-card-resource min-w-0 rounded-[14px] p-4 lg:p-5">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className="min-w-0 truncate text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-3)]">Primary endpoint</span>
            <Badge tone="default">Local</Badge>
          </div>
          <code className="mt-3 block overflow-x-auto rounded-[var(--radius-control)] bg-[var(--kbd-bg)] px-3 py-2.5 font-mono text-[13px] font-semibold text-[var(--text-1)]" title={baseUrl}>{baseUrl}</code>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-[var(--text-2)]">
            <span>OpenAI &amp; Anthropic compatible</span>
            <span className="text-[var(--text-3)]">·</span>
            <span>Copy-ready for clients</span>
            <ClipboardButton value={baseUrl} variant="ghost" size="sm" className="ml-auto h-7 px-2 text-[10px]" />
          </div>
        </div>
      </Card>


      <Card surface="base" className="health-card">
        <CardHeader title="System Overview" icon={Gauge} iconColor="#30d158" sub="Runtime resource usage" />
        <div className="health-resource-grid mt-3 grid gap-2.5 auto-rows-fr">
            <section aria-labelledby="health-ram-title" className="health-card-resource flex h-full min-h-[320px] min-w-0 flex-col rounded-[14px] p-3 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[var(--purple-soft)] text-[var(--purple)]"><MemoryStick size={14} /></span>
                  <div className="min-w-0">
                    <h3 id="health-ram-title" className="whitespace-nowrap text-xs font-bold tracking-tight">RAM usage</h3>
                    <p className="mt-0.5 line-clamp-2 text-[9.5px] leading-[1.25] text-[var(--text-3)]">Bun Runtime · Oh My Omop - Router process</p>
                </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="whitespace-nowrap text-[9px] font-medium text-[var(--text-3)]">Low stress</span>
                  <span className="group relative inline-grid place-items-center" tabIndex={0} aria-label="Low stress info">
                    <Info size={12} className="cursor-help text-[var(--text-3)]" />
                    <span className="pointer-events-none absolute bottom-full right-0 z-10 mb-1 hidden w-48 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-2 text-[10px] leading-snug shadow-lg group-hover:block group-focus-within:block">Caps Bun engine at 20 MB — JS heap is your app, other metrics stay real.</span>
                  </span>
                  <div className="scale-[0.7]">
                    <Switch checked={lowStress} onChange={setLowStress} label="Low stress mode" />
                  </div>
                </div>
              </div>
              {(() => {
                const heapUsed = Number.isFinite(health?.heapUsedMb ?? NaN) ? health!.heapUsedMb : 0;
                const external = Number.isFinite(health?.externalMb ?? NaN) ? health!.externalMb : 0;
                const arrayBuffers = Number.isFinite(health?.arrayBuffersMb ?? NaN) ? health!.arrayBuffersMb : 0;
                const nativeMbRaw = Math.max(0, (Number.isFinite(health?.memoryUsedMb ?? NaN) ? health!.memoryUsedMb : 0) - (Number.isFinite(health?.heapTotalMb ?? NaN) ? health!.heapTotalMb : 0) - external - arrayBuffers);
                const displayNativeForRss = lowStress ? Math.min(20, nativeMbRaw) : nativeMbRaw;
                const rssReal = Number.isFinite(health?.memoryUsedMb ?? NaN) ? health!.memoryUsedMb : 0;
                const displayRss = lowStress ? heapUsed + displayNativeForRss + external + arrayBuffers : rssReal;
                return (
                  <>
                    <div className="overview-card-primary mt-3">
                      <span className="overview-card-primary-value">{health ? formatMemoryMb(displayRss) : "—"}</span>
                      <span className="overview-card-primary-label">RSS</span>
                    </div>
                    <p className="overview-card-summary mt-2">RSS is the whole Oh My Omop - Router process — Bun runtime, native/JIT overhead, JS heap, and buffers combined.</p>
                  </>
                );
              })()}
              <div className="overview-card-footer">
                {health && Number.isFinite(health.memoryUsedMb) && (() => {
                  const heapUsed = Number.isFinite(health.heapUsedMb) ? health.heapUsedMb : 0;
                  const external = Number.isFinite(health.externalMb) ? health.externalMb : 0;
                  const arrayBuffers = Number.isFinite(health.arrayBuffersMb) ? health.arrayBuffersMb : 0;
                  const nativeMb = Math.max(0, (Number.isFinite(health.memoryUsedMb) ? health.memoryUsedMb : 0) - (Number.isFinite(health.heapTotalMb) ? health.heapTotalMb : 0) - (Number.isFinite(health.externalMb) ? health.externalMb : 0) - (Number.isFinite(health.arrayBuffersMb) ? health.arrayBuffersMb : 0));
                  const rssReal = Number.isFinite(health.memoryUsedMb) ? health.memoryUsedMb : 0;
                  const rss = rssReal;
                  const displayNative = lowStress ? Math.min(20, nativeMb) : nativeMb;
                  return (
                    <div className="overview-mini-grid">
                      {([
                        { label: "JS heap", used: heapUsed, bar: Number.isFinite(health.heapTotalMb) ? health.heapTotalMb : 0, color: "#bf5af2" },
                        { label: "Bun runtime", used: displayNative, bar: displayNative, color: "#30d158" },
                        { label: "External", used: external, bar: external, color: "#ff9f0a" },
                        { label: "Array buffers", used: arrayBuffers, bar: arrayBuffers, color: "#0a84ff" },
                      ] as const).map(({ label, used, bar, color }) => (
                        <div key={label} className="overview-mini">
                          <div className="flex items-center justify-between gap-2">
                            <span className="overview-mini-label">{label}</span>
                            <span className="text-[9px] text-[var(--text-3)]">{Number.isFinite(used) ? formatMemoryMb(used) : "—"}</span>
                          </div>
                          <div className="overview-bar mt-2">
                            <div className="overview-bar-fill transition-[width] duration-500" style={{ width: `${Math.min(100, Math.max(0, rss === 0 ? 0 : (bar / rss) * 100))}%`, background: color }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                <div className="overview-bar-rail">
                  <div className="flex items-center justify-between gap-2">
                    <span className="overview-mini-label">WireGuard Client RAM usage</span>
                    <span className="text-[9px] text-[var(--text-3)]">{health?.wireguardClientMemoryMb != null ? formatMemoryMb(health.wireguardClientMemoryMb) : "—"}</span>
                  </div>
                  <div className="overview-bar mt-1.5" role="progressbar" aria-label="WireGuard Client RAM usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={health?.wireguardClientMemoryMb != null && health.memoryUsedMb > 0 ? Math.min(100, (health.wireguardClientMemoryMb / health.memoryUsedMb) * 100) : 0}>
                    <div className="overview-bar-fill overview-bar-fill--green transition-[width] duration-500" style={{ width: `${health?.wireguardClientMemoryMb != null && health.memoryUsedMb > 0 ? Math.min(100, (health.wireguardClientMemoryMb / health.memoryUsedMb) * 100) : 0}%` }} />
                  </div>
                </div>
              </div>
            </section>

            <section aria-labelledby="health-request-title" className="health-card-resource flex h-full min-h-[320px] min-w-0 flex-col rounded-[14px] p-3 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[var(--accent-soft)] text-[var(--accent)]"><Timer size={14} /></span>
                  <div className="min-w-0">
                    <h3 id="health-request-title" className="whitespace-nowrap text-xs font-bold tracking-tight">Request Latency</h3>
                    <p className="mt-0.5 line-clamp-2 text-[9.5px] leading-[1.25] text-[var(--text-3)]">p95 · average · tail gap</p>
                  </div>
                </div>
              </div>
              <div className="overview-card-primary mt-3">
                <span className="overview-card-primary-value">{isFetching && !data ? "…" : requestP95Label}</span>
                <span className="overview-card-primary-label">p95 latency</span>
              </div>
              <p className="overview-card-summary mt-2">Avg {isFetching && !data ? "…" : requestAverages} · tail gap {isFetching && !data ? "…" : formatDuration(requestTailGapMs)}
lower is better · 24h window
Requests {totals.requests.toLocaleString()} · errors {totals.errors.toLocaleString()}</p>
              <div className="overview-card-footer">
                <div className="overview-mini-grid">
                  <div className="overview-mini">
                    <div className="overview-mini-label">Avg</div>
                    <div className="overview-mini-value">{isFetching && !data ? "…" : formatDuration(totals.avgDurationMs)}</div>
                    <div className="overview-mini-caption">per request</div>
                  </div>
                  <div className="overview-mini">
                    <div className="overview-mini-label">Spread</div>
                    <div className="overview-mini-value">{isFetching && !data ? "…" : formatDuration(requestTailGapMs)}</div>
                    <div className="overview-mini-caption">p95 minus avg</div>
                  </div>
                </div>
                <div className="overview-bar-rail">
                  <div className="flex items-center justify-between gap-2">
                    <span className="overview-mini-label">Latency window</span>
                    <span className="text-[9px] text-[var(--text-3)]">24h</span>
                  </div>
                  <div className="overview-bar mt-1.5">
                    <div className="overview-bar-fill overview-bar-fill--accent transition-[width] duration-500" style={{ width: `${Math.min(100, Math.max(0, (requestP95 / Math.max(1, requestP95 + totals.avgDurationMs)) * 100))}%` }} />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[9px] text-[var(--text-3)]">
                    <span>Avg {formatDuration(totals.avgDurationMs)}</span>
                    <span>P95 {requestP95Label}</span>
                  </div>
                </div>
              </div>
            </section>

            <section aria-labelledby="health-proxy-title" className="health-card-resource flex h-full min-h-[320px] min-w-0 flex-col rounded-[14px] p-3 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[var(--orange-soft)] text-[var(--orange)]"><Server size={14} /></span>
                  <div className="min-w-0">
                    <h3 id="health-proxy-title" className="whitespace-nowrap text-xs font-bold tracking-tight">Proxy Pool</h3>
                    <p className="mt-0.5 line-clamp-2 text-[9.5px] leading-[1.25] text-[var(--text-3)]">Socks5 · HTTP · WireGuard</p>
                  </div>
                </div>
              </div>
              <div className="overview-card-primary mt-3">
                <span className="overview-card-primary-value">{totalProxies}</span>
                <span className="overview-card-primary-label">proxies</span>
              </div>
              <p className="overview-card-summary mt-2">Socks5 {socks5Count}/{totalProxies} · WireGuard {wireguardCount} · HTTP/S {httpCount + httpsCount}
pool split across active routes
Active {activeProxies}/{totalProxies} · flight cap {flightCapacity}</p>
              <div className="overview-card-footer">
                <div className="overview-mini-grid">
                  <div className="overview-mini">
                    <div className="overview-mini-label">Socks5</div>
                    <div className="overview-mini-value">{socks5Count} <span className="text-[11px] font-normal text-[var(--text-3)]">/ {totalProxies}</span></div>
                    <div className="overview-mini-caption">{totalProxies ? `${(socks5Count / totalProxies * 100).toFixed(1)}% of pool` : "—"}</div>
                    <div className="overview-bar mt-2">
                      <div className="overview-bar-fill overview-bar-fill--orange transition-[width] duration-500" style={{ width: `${totalProxies ? Math.min(100, (socks5Count / totalProxies) * 100) : 0}%` }} />
                    </div>
                  </div>
                  <div className="overview-mini">
                    <div className="overview-mini-label">Flight Capacity</div>
                    <div className="overview-mini-value">{flightCapacity}</div>
                    <div className="overview-mini-caption">in-flight max</div>
                    <div className="overview-bar mt-2">
                      <div className="overview-bar-fill overview-bar-fill--blue transition-[width] duration-500" style={{ width: `${flightCapacity ? Math.min(100, (flightCapacity / Math.max(flightCapacity, 50)) * 100) : 0}%` }} />
                    </div>
                  </div>
                </div>
                <div className="overview-bar-rail">
                  <div className="overview-bar">
                    <div className="h-full bg-[var(--orange)] transition-[width] duration-500" style={{ width: `${totalProxies ? (socks5Count / totalProxies) * 100 : 0}%` }} />
                    <div className="h-full bg-[#0a84ff] transition-[width] duration-500" style={{ width: `${totalProxies ? ((httpCount + httpsCount) / totalProxies) * 100 : 0}%` }} />
                    <div className="h-full bg-[#bf5af2] transition-[width] duration-500" style={{ width: `${totalProxies ? (wireguardCount / totalProxies) * 100 : 0}%` }} />
                  </div>
                  <div className="mt-1.5 flex justify-between text-[9px] text-[var(--text-3)]">
                    <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-[var(--orange)]" /> Socks5</span>
                    <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-[#0a84ff]" /> HTTP/S</span>
                    <span className="flex items-center gap-1">WireGuard <span className="size-2 rounded-full bg-[#bf5af2]" /></span>
                  </div>
                </div>
              </div>
            </section>
            <section aria-labelledby="health-uptime-title" className="health-card-resource flex h-full min-h-[320px] min-w-0 flex-col rounded-[14px] p-3 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[var(--accent-soft)] text-[var(--accent)]"><Clock3 size={14} /></span>
                  <div className="min-w-0">
                    <h3 id="health-uptime-title" className="whitespace-nowrap text-xs font-bold tracking-tight">Uptime</h3>
                    <p className="mt-0.5 line-clamp-2 text-[9.5px] leading-[1.25] text-[var(--text-3)]">System info · Bun</p>
                  </div>
                </div>
              </div>
              <div className="overview-card-primary mt-3">
                <span className="overview-card-primary-value overview-card-primary-value-sm">{uptime}</span>
                <span className="overview-card-primary-label">uptime</span>
              </div>
              <p className="overview-card-summary mt-2">PID {health?.pid ?? "—"} · {health?.coreCount ?? "—"} cores · Bun {bunVersion}
host runtime snapshot
CPU {health ? `${cpuPercent.toFixed(1)}%` : "—"} · memory {health ? formatMemoryMb(health.memoryTotalMb) : "—"}</p>
              <div className="overview-card-footer">
                <div className="overview-mini-grid">
                  <div className="overview-mini">
                    <div className="overview-mini-label">CPU model</div>
                    <div className="overview-mini-value overview-mini-value-sm font-mono">{health?.cpuModel ?? "—"}</div>
                    <div className="overview-mini-caption">host processor</div>
                  </div>
                  <div className="overview-mini">
                    <div className="overview-mini-label">Memory total</div>
                    <div className="overview-mini-value">{health ? formatMemoryMb(health.memoryTotalMb) : "—"}</div>
                    <div className="overview-mini-caption">total system RAM</div>
                  </div>
                </div>
                <div className="overview-bar-rail">
                  <div className="flex items-center justify-between gap-2">
                    <span className="overview-mini-label">CPU usage</span>
                    <span className="text-[9px] text-[var(--text-3)]">{health ? `${cpuPercent.toFixed(1)}%` : "—"}</span>
                  </div>
                  <div className="overview-bar mt-1.5">
                    <div className="overview-bar-fill overview-bar-fill--orange transition-[width] duration-500" style={{ width: `${cpuPercent}%` }} />
                  </div>
                </div>
              </div>
            </section>
          </div>
      </Card>
      <ApiKeysPanel />

    </div>
  );
}
