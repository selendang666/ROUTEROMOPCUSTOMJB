import type { PostgresPool } from "../../persistence/pool.js";
import type { TelemetryPipeline } from "../../persistence/telemetry/pipeline.js";
import type { PayloadRecord, TelemetryRow } from "../../persistence/telemetry/store/interface.js";
import { getPrivacySnapshot, presentClientIp } from "../../runtime/privacy.js";

function parseMetaJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function computeDurationMs(startedAt: string | null | undefined, finishedAt: string | null | undefined): number {
  if (!startedAt || !finishedAt) return 0;
  const toMs = (value: string): number => {
    const normalized = value.includes("T") ? value : value.replace(" ", "T");
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : 0;
  };
  const start = toMs(startedAt);
  const end = toMs(finishedAt);
  if (start === 0 || end === 0) return 0;
  return Math.max(0, end - start);
}

function buildDetailRow(
  row: TelemetryRow,
  payload: PayloadRecord | null,
  privacyMode: "masked" | "full",
): Record<string, unknown> {
  const meta = parseMetaJson(row.metaJson);
  const overheadRaw = meta.overhead as Record<string, unknown> | undefined;
  let overhead: Record<string, unknown> | null = null;
  if (overheadRaw !== null && typeof overheadRaw === "object" && overheadRaw !== undefined) {
    const report = overheadRaw as { elapsedMs?: unknown; marks?: unknown; truncated?: unknown; requestId?: unknown; startedAt?: unknown };
    const marks = Array.isArray(report.marks) ? report.marks : [];
    const totalMs = typeof report.elapsedMs === "number" ? report.elapsedMs : 0;
    overhead = {
      totalMs,
      total: totalMs,
      phases: marks,
      marks,
      truncated: report.truncated === true,
      requestId: typeof report.requestId === "string" ? report.requestId : row.traceId,
      startedAt: typeof report.startedAt === "string" ? report.startedAt : row.startedAt ?? row.createdAt,
    };
  }
  const startedAt = row.startedAt ?? row.createdAt;
  const finishedAt = row.finishedAt ?? row.createdAt;
  const durationMs = computeDurationMs(startedAt, finishedAt);
  const clientIpRaw = row.clientIp;
  const clientIp = presentClientIp(clientIpRaw, privacyMode);
  const clientName = typeof meta.client === "string" ? meta.client : typeof meta.clientName === "string" ? meta.clientName : "unknown";
  const clientSource = typeof meta.client_source === "string" ? meta.client_source : typeof meta.clientSource === "string" ? meta.clientSource : "unknown";
  const requestedModel = typeof meta.requestedModel === "string" ? meta.requestedModel : row.model;
  const mappedModel = typeof meta.mappedModel === "string" ? meta.mappedModel : row.model;
  const upstreamModel = typeof meta.upstreamModel === "string" ? meta.upstreamModel : row.model;
  const wireSurface = typeof meta.wireSurface === "string" ? meta.wireSurface : row.surface;
  const errorMessage = typeof meta.errorMessage === "string" ? meta.errorMessage : row.errorKind ? String(row.errorKind) : null;
  const usageSource = typeof meta.usageSource === "string" ? meta.usageSource : typeof meta.source === "string" ? meta.source : "unknown";
  const payloads = payload
    ? {
        clientRequest: payload.clientRequest,
        providerRequest: payload.providerRequest,
        providerResponse: payload.providerResponse,
        clientResponse: payload.clientResponse,
      }
    : null;
  return {
    requestId: row.traceId,
    traceId: row.traceId,
    id: row.traceId,
    trace_id: row.traceId,
    endpoint: row.endpoint,
    surface: row.surface,
    provider: row.provider,
    providerId: row.provider,
    model: row.model,
    status: row.status,
    statusCode: row.status,
    errorKind: row.errorKind,
    providerCode: row.errorProviderCode,
    providerType: row.errorProviderType,
    upstreamRequestId: row.errorUpstreamRequestId,
    retryAfterMs: row.errorRetryAfterMs,
    clientIp,
    apiKeyId: row.apiKeyId,
    apiKeyPrefix: row.apiKeyPrefix,
    accountId: row.accountId,
    proxyId: row.proxyId,
    startedAt,
    finishedAt,
    createdAt: row.createdAt,
    durationMs,
    tfftMs: row.tfftMs ?? null,
    tffbMs: row.tffbMs ?? null,
    overhead,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedTokens: row.cachedTokens,
    totalTokens: row.totalTokens,
    cacheWriteTokens: null,
    reasoningTokens: row.reasoningTokens,
    usageSource,
    clientName,
    clientSource,
    routing: {
      requestedModel,
      mappedModel,
      upstreamModel,
      wireSurface,
      errorMessage,
    },
    messageCount: row.messageCount ?? 0,
    toolCount: row.toolCount ?? 0,
    imageCount: row.imageCount ?? 0,
    payloads,
    metaJson: row.metaJson,
    mode: "non_stream",
  };
}

/** Console observability backed by typed telemetry aggregates; route shapes preserved. */
export function createObservabilityService(pool: PostgresPool, telemetry: TelemetryPipeline) {
  return {
    logs: {
      async query(url: URL) {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
        const cursorRaw = Number(url.searchParams.get("cursor") ?? "");
        const page = await telemetry.queryLogs({ limit, ...(Number.isInteger(cursorRaw) && cursorRaw > 0 ? { cursor: cursorRaw } : {}) });
        const mode = getPrivacySnapshot().privacyMode;
        return page.rows.map((row) => {
          const contextClientIp = row.context && typeof (row.context as { clientIp?: unknown }).clientIp === "string" ? (row.context as { clientIp: string }).clientIp : null;
          return contextClientIp === null ? row : { ...row, context: { ...row.context, clientIp: presentClientIp(contextClientIp, mode) } };
        });
      },
      async clear() {
        try {
          await telemetry.clearLogs();
          return { ok: true as const, status: 200 as const, data: { cleared: true } };
        } catch (error) {
          return { ok: false as const, status: 500 as const, message: error instanceof Error ? error.message : "failed to clear logs" };
        }
      },
      async stream(request: Request) {
        const url = new URL(request.url);
        const category = url.searchParams.get("category");
        const categoryOf = (scope: string): string => scope === "request" || scope === "system" || scope === "web" ? scope : "system";
        const encode = (event: string, value: unknown): Uint8Array => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
        const withMaskedIp = <T extends { context?: Readonly<Record<string, unknown>> | null }>(row: T): T => {
          const context = row.context;
          const contextClientIp = context && typeof (context as { clientIp?: unknown }).clientIp === "string" ? (context as { clientIp: string }).clientIp : null;
          if (contextClientIp === null) return row;
          return { ...row, context: { ...context, clientIp: presentClientIp(contextClientIp, getPrivacySnapshot().privacyMode) } };
        };
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              const initial = await telemetry.queryLogs({ limit: 200 });
              const lines = initial.rows
                .filter((row) => category === null || category === "all" || categoryOf(row.scope) === category)
                .reverse()
                .map((row) => withMaskedIp({ ...row, category: categoryOf(row.scope) }));
              let lastId = initial.rows[0]?.id ?? 0;
              // Ensure newest first for UI (desc id)
              lines.sort((a, b) => b.id - a.id);
              controller.enqueue(encode("init", { lines, lastId }));
              // Keep-alive poll for live tail (1s) instead of closing after drain
              const signal = (request as unknown as { signal?: AbortSignal }).signal;
              while (!(signal?.aborted)) {
                const page = await telemetry.queryLogs({ afterId: lastId, limit: 100 });
                for (const row of page.rows) {
                  if (category !== null && category !== "all" && categoryOf(row.scope) !== category) { lastId = Math.max(lastId, row.id); continue; }
                  lastId = row.id;
                  controller.enqueue(encode("line", withMaskedIp({ ...row, category: categoryOf(row.scope) })));
                }
                // heartbeat to keep EventSource alive
                controller.enqueue(encode("ping", { ts: new Date().toISOString() }));
                await new Promise<void>((res) => {
                  const t = setTimeout(res, 1000);
                  signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
                });
                if (signal?.aborted) break;
              }
              controller.close();
            } catch {
              try { controller.close(); } catch {}
            }
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" } });
      },
    },
    usage: {
      async query(url: URL) {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
        const cursorRaw = Number(url.searchParams.get("cursor") ?? "");
        let from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const provider = url.searchParams.get("provider");
        const model = url.searchParams.get("model");
        const path = url.pathname;
        const period = url.searchParams.get("period") ?? "24h";
        // Derive `from` from `period` when explicit `from` not supplied
        if (!from && period !== "all") {
          const now = Date.now();
          const msMap: Record<string, number> = { "1h": 60 * 60 * 1000, "24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000, "30d": 30 * 24 * 60 * 60 * 1000 };
          const ms = msMap[period];
          if (ms !== undefined) from = new Date(now - ms).toISOString().slice(0, 19).replace("T", " ");
        }
        const filter = { from: from ?? null, to: to ?? null, provider: provider ?? null, model: model ?? null };

        if (path.endsWith("/usage/summary")) {
          const summary = await telemetry.getUsageSummary(filter);
          return { period, totals: { ...summary, partial: false } };
        }
        if (path.endsWith("/usage/chart")) {
          const chart = await telemetry.getChartBuckets(filter);
          return { buckets: chart.buckets };
        }
        if (path.endsWith("/usage/by-model") || path.endsWith("/usage/by-provider") || path.endsWith("/usage/by-key")) {
          const dimension = path.endsWith("/usage/by-model") ? "model" as const : path.endsWith("/usage/by-provider") ? "provider" as const : "api_key" as const;
          const breakdown = await telemetry.getBreakdown(filter, dimension);
          return { rows: breakdown.rows };
        }
        if (path.endsWith("/usage/cache")) {
          const cache = await telemetry.getCacheSummary(filter);
          return { period, inputTokens: cache.inputTokens, cachedTokens: cache.cachedTokens, cacheWriteTokens: cache.cacheWriteTokens, hitRate: cache.hitRate, rows: [] as unknown[] };
        }
        if (path.endsWith("/usage/requests")) {
          const privacyMode = getPrivacySnapshot().privacyMode;
          const res = await telemetry.query({ limit, cursor: Number.isInteger(cursorRaw) && cursorRaw > 0 ? cursorRaw : null, from: filter.from, to: filter.to, provider: filter.provider, model: filter.model });
          const mapRow = (r: TelemetryRow): Record<string, unknown> => {
            const startedAt = r.startedAt ?? r.createdAt;
            const finishedAt = r.finishedAt ?? r.createdAt;
            const durationMs = computeDurationMs(startedAt, finishedAt);
            const meta = parseMetaJson(r.metaJson);
            const overheadRaw = meta.overhead as Record<string, unknown> | undefined;
            let overhead: Record<string, unknown> | null = null;
            if (overheadRaw && typeof overheadRaw === "object") {
              const report = overheadRaw as { elapsedMs?: unknown; marks?: unknown };
              const marks = Array.isArray(report.marks) ? report.marks : [];
              const totalMs = typeof report.elapsedMs === "number" ? report.elapsedMs : 0;
              overhead = { totalMs, total: totalMs, phases: marks, marks };
            }
            const maskedIp = presentClientIp(r.clientIp, privacyMode);
            return {
              requestId: r.traceId,
              traceId: r.traceId,
              id: r.traceId,
              trace_id: r.traceId,
              endpoint: r.endpoint,
              surface: r.surface,
              apiKeyId: r.apiKeyId,
              apiKeyPrefix: r.apiKeyPrefix,
              clientIp: maskedIp,
              providerId: r.provider,
              provider: r.provider,
              model: r.model,
              statusCode: r.status,
              status: r.status,
              errorKind: r.errorKind,
              mode: "non_stream",
              startedAt,
              finishedAt,
              createdAt: r.createdAt,
              durationMs,
              tfftMs: r.tfftMs ?? null,
              tffbMs: r.tffbMs ?? null,
              overhead,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              cachedTokens: r.cachedTokens,
              totalTokens: r.totalTokens,
              messageCount: r.messageCount ?? 0,
              toolCount: r.toolCount ?? 0,
              imageCount: r.imageCount ?? 0,
              accountId: r.accountId,
              proxyId: r.proxyId,
              reasoningTokens: r.reasoningTokens,
              metaJson: r.metaJson,
            };
          };
          return { items: res.rows.map(mapRow) };
        }
        if (path.includes("/usage/requests/")) {
          const privacyMode = getPrivacySnapshot().privacyMode;
          const res = await telemetry.query({ limit, cursor: Number.isInteger(cursorRaw) && cursorRaw > 0 ? cursorRaw : null, from: filter.from, to: filter.to, provider: filter.provider, model: filter.model });
          // Maintain shape for wildcard requests path while still using filtered query when possible
          const rows = res.rows;
          const mapRow = (r: TelemetryRow): Record<string, unknown> => {
            const startedAt = r.startedAt ?? r.createdAt;
            const finishedAt = r.finishedAt ?? r.createdAt;
            const durationMs = computeDurationMs(startedAt, finishedAt);
            const meta = parseMetaJson(r.metaJson);
            const overheadRaw = meta.overhead as Record<string, unknown> | undefined;
            let overhead: Record<string, unknown> | null = null;
            if (overheadRaw && typeof overheadRaw === "object") {
              const report = overheadRaw as { elapsedMs?: unknown; marks?: unknown };
              const marks = Array.isArray(report.marks) ? report.marks : [];
              const totalMs = typeof report.elapsedMs === "number" ? report.elapsedMs : 0;
              overhead = { totalMs, total: totalMs, phases: marks, marks };
            }
            const maskedIp = presentClientIp(r.clientIp, privacyMode);
            return {
              requestId: r.traceId,
              traceId: r.traceId,
              id: r.traceId,
              trace_id: r.traceId,
              endpoint: r.endpoint,
              surface: r.surface,
              apiKeyId: r.apiKeyId,
              apiKeyPrefix: r.apiKeyPrefix,
              clientIp: maskedIp,
              providerId: r.provider,
              provider: r.provider,
              model: r.model,
              statusCode: r.status,
              status: r.status,
              errorKind: r.errorKind,
              mode: "non_stream",
              startedAt,
              finishedAt,
              createdAt: r.createdAt,
              durationMs,
              tfftMs: r.tfftMs ?? null,
              tffbMs: r.tffbMs ?? null,
              overhead,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              cachedTokens: r.cachedTokens,
              totalTokens: r.totalTokens,
              messageCount: r.messageCount ?? 0,
              toolCount: r.toolCount ?? 0,
              imageCount: r.imageCount ?? 0,
              accountId: r.accountId,
              proxyId: r.proxyId,
              reasoningTokens: r.reasoningTokens,
              metaJson: r.metaJson,
            };
          };
          return rows.map(mapRow);
        }
        // Fallback for plain /usage — keep limit/cursor pagination via query
        const res = await telemetry.query({ limit, cursor: Number.isInteger(cursorRaw) && cursorRaw > 0 ? cursorRaw : null, from: filter.from, to: filter.to, provider: filter.provider, model: filter.model });
        return res.rows;
      },
      async detail(id: string): Promise<Record<string, unknown> | null> {
        const privacyMode = getPrivacySnapshot().privacyMode;
        const found = await telemetry.getTrace(id);
        if (!found) return null;
        let payload: PayloadRecord | null = null;
        try {
          payload = await telemetry.getPayload(id);
        } catch {}
        return buildDetailRow(found, payload, privacyMode);
      },
    },
    ips: {
      async top(url: URL) {
        const windowSeconds = Math.min(3600, Math.max(10, Number(url.searchParams.get("window") ?? 60) || 60));
        const limit = Math.min(50, Math.max(5, Number(url.searchParams.get("limit") ?? 20) || 20));
        const agg = await telemetry.getTopIps({ windowSeconds, limit });
        let degradedProxies: unknown[] = [];
        try {
          degradedProxies = (await pool`
            SELECT p.id AS proxy_id, p.name, p.host, p.port, p.protocol, h.status, h.retry_at, h.sanitized_message
            FROM proxy_health h
            JOIN proxies p ON p.id = h.proxy_id
            WHERE h.status = 'cooling_down' AND h.retry_at > now()
            ORDER BY h.retry_at DESC
            LIMIT 20
          `) as unknown as unknown[];
        } catch {
          degradedProxies = [];
        }
        return { windowSeconds, rows: agg.rows, degradedProxies };
      },
    },
  };
}
