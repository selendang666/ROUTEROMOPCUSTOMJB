import type { TelemetryEvent } from "../../../../proxy/types/telemetry.js";
import { isRecord } from "../../../../proxy/validation.js";

import type {
  ConsoleLogInput,
  ConsoleLogPage,
  ConsoleLogQuery,
  ConsoleLogRow,
  ApiKeyUsageTotals,
  BreakdownRow,
  CacheSummary,
  ChartBucket,
  OverviewTotals,
  PayloadArtifact,
  PayloadRecord,
  ProviderAggregate,
  RetentionResult,
  TelemetryQuery,
  TelemetryRow,
  TelemetryStore,
  TopIpRow,
  UsageFilter,
} from "../interface.js";

const CHUNK_SIZE = 500;

function d1FilterClause(filter: UsageFilter, params: unknown[]): string {
  let clause = "";
  if (filter.from) { clause += " AND created_at >= ?"; params.push(filter.from); }
  if (filter.to) { clause += " AND created_at <= ?"; params.push(filter.to); }
  if (filter.provider) { clause += " AND provider = ?"; params.push(filter.provider); }
  if (filter.model) { clause += " AND model = ?"; params.push(filter.model); }
  return clause;
}

interface D1Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface D1StatementResult {
  readonly results: readonly Record<string, unknown>[];
  readonly meta: { readonly changes?: number };
}

function toRow(event: TelemetryEvent): unknown[] {
  const meta = JSON.stringify({
    client: event.clientName ?? "unknown",
    client_source: event.clientSource ?? "unknown",
    usageSource: event.usage?.source ?? null,
    user_agent: event.userAgent ?? null,
    fingerprint: event.fingerprint ?? null,
    method: event.method ?? "POST",
    path: event.path ?? event.endpoint ?? null,
    safe_headers: event.safeHeaders ?? {},
    committed: event.committed,
    dropped: event.dropped ?? false,
    degraded: event.degraded ?? false,
    ...(event.overhead ? { overhead: event.overhead } : {}),
  });
  return [
    event.requestId,
    event.endpoint ?? "proxy",
    event.surface ?? "unknown",
    event.providerId,
    event.model,
    event.statusCode ?? 200,
    event.errorKind,
    event.errorProviderCode ?? null,
    event.errorProviderType ?? null,
    event.errorUpstreamRequestId ?? null,
    event.errorRetryAfterMs ?? null,
    event.clientIp ?? null,
    event.apiKeyId ?? null,
    event.apiKeyPrefix ?? null,
    meta,
    event.usage?.promptTokens ?? null,
    event.usage?.completionTokens ?? null,
    event.usage?.cachedTokens ?? null,
    event.usage?.totalTokens ?? null,
    event.tffbMs ?? null,
    event.tfftMs ?? null,
    event.messageCount ?? null,
    event.toolCount ?? null,
    event.imageCount ?? null,
    event.startedAt ?? null,
    event.finishedAt ?? null,
    event.accountId ?? null,
    event.proxyId ?? null,
    event.reasoningTokens ?? null,
  ];
}

function parseConsoleLogContext(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function resultRows(value: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.results)) return [];
  return value.results.filter(isRecord);
}

function extractBatchPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  // Cloudflare D1 envelope: { result: [{results:[...]}], success:true }
  if (Array.isArray(payload.result)) return payload.result as unknown[];
  if (Array.isArray(payload.results)) return payload.results as unknown[];
  // D1 worker envelope: { results: [{results:[...]}] }
  if (isRecord(payload.data) && Array.isArray(payload.data.result)) return payload.data.result as unknown[];
  return [];
}

export class D1TelemetryStore implements TelemetryStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async execute(statements: readonly D1Statement[]): Promise<readonly D1StatementResult[]> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ batch: statements }),
      });
      if (response.ok) {
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {}
        const raw = extractBatchPayload(payload);
        return raw.map((entry): D1StatementResult => ({
          results: resultRows(entry),
          meta: isRecord(entry) && isRecord(entry.meta) ? { changes: typeof entry.meta.changes === "number" ? entry.meta.changes : undefined } : {},
        }));
      }
      if (attempt >= 3 || response.status < 500) throw new Error(`D1 telemetry write failed HTTP ${response.status}`);
      await Bun.sleep(100 * attempt);
    }
  }

  async writeBatch(events: readonly TelemetryEvent[]): Promise<void> {
    for (let i = 0; i < events.length; i += CHUNK_SIZE) {
      const chunk = events.slice(i, i + CHUNK_SIZE);
      await this.execute(
        chunk.map((event): D1Statement => ({
          sql: "INSERT INTO request_events (trace_id, endpoint, surface, provider, model, status, error_kind, error_provider_code, error_provider_type, error_upstream_request_id, error_retry_after_ms, client_ip, api_key_id, api_key_prefix, meta_json, input_tokens, output_tokens, cached_tokens, total_tokens, tffb_ms, tfft_ms, message_count, tool_count, image_count, started_at, finished_at, account_id, proxy_id, reasoning_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: toRow(event),
        })),
      );
      if (chunk.length === CHUNK_SIZE) await Bun.sleep(0);
    }
  }

  async query(filter: TelemetryQuery): Promise<{ rows: TelemetryRow[]; nextCursor: number | null }> {
    const limit = Math.min(Math.max(filter.limit, 1), 1000);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.cursor !== null && filter.cursor !== undefined) {
      conditions.push("id < ?");
      params.push(filter.cursor);
    }
    if (filter.provider) {
      conditions.push("provider = ?");
      params.push(filter.provider);
    }
    if (filter.model) {
      conditions.push("model = ?");
      params.push(filter.model);
    }
    if (filter.from) {
      conditions.push("created_at >= ?");
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push("created_at <= ?");
      params.push(filter.to);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit + 1);
    const result = await this.execute([{ sql: `SELECT id, trace_id, endpoint, surface, provider, model, status, error_kind, error_provider_code, error_provider_type, error_upstream_request_id, error_retry_after_ms, client_ip, api_key_id, api_key_prefix, meta_json, input_tokens, output_tokens, cached_tokens, total_tokens, tffb_ms, tfft_ms, message_count, tool_count, image_count, started_at, finished_at, created_at, account_id, proxy_id, reasoning_tokens FROM request_events ${where} ORDER BY id DESC LIMIT ?`, params }]);
    const rows = result[0]?.results ?? [];
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const mapped: TelemetryRow[] = slice.map((r) => ({
      id: Number(r.id),
      traceId: String(r.trace_id),
      endpoint: String(r.endpoint),
      surface: String(r.surface),
      provider: r.provider === null || r.provider === undefined ? null : String(r.provider),
      model: String(r.model),
      status: Number(r.status),
      errorKind: r.error_kind === null || r.error_kind === undefined ? null : String(r.error_kind),
      errorProviderCode: r.error_provider_code === null || r.error_provider_code === undefined ? null : String(r.error_provider_code),
      errorProviderType: r.error_provider_type === null || r.error_provider_type === undefined ? null : String(r.error_provider_type),
      errorUpstreamRequestId: r.error_upstream_request_id === null || r.error_upstream_request_id === undefined ? null : String(r.error_upstream_request_id),
      errorRetryAfterMs: r.error_retry_after_ms === null || r.error_retry_after_ms === undefined ? null : Number(r.error_retry_after_ms),
      clientIp: r.client_ip === null || r.client_ip === undefined ? null : String(r.client_ip),
      apiKeyId: r.api_key_id === null || r.api_key_id === undefined ? null : String(r.api_key_id),
      apiKeyPrefix: r.api_key_prefix === null || r.api_key_prefix === undefined ? null : String(r.api_key_prefix),
      metaJson: String(r.meta_json),
      inputTokens: r.input_tokens === null || r.input_tokens === undefined ? null : Number(r.input_tokens),
      outputTokens: r.output_tokens === null || r.output_tokens === undefined ? null : Number(r.output_tokens),
      cachedTokens: r.cached_tokens === null || r.cached_tokens === undefined ? null : Number(r.cached_tokens),
      totalTokens: r.total_tokens === null || r.total_tokens === undefined ? null : Number(r.total_tokens),
      tffbMs: r.tffb_ms === null || r.tffb_ms === undefined ? null : Number(r.tffb_ms),
      tfftMs: r.tfft_ms === null || r.tfft_ms === undefined ? null : Number(r.tfft_ms),
      messageCount: r.message_count === null || r.message_count === undefined ? null : Number(r.message_count),
      toolCount: r.tool_count === null || r.tool_count === undefined ? null : Number(r.tool_count),
      imageCount: r.image_count === null || r.image_count === undefined ? null : Number(r.image_count),
      startedAt: r.started_at === null || r.started_at === undefined ? null : String(r.started_at),
      finishedAt: r.finished_at === null || r.finished_at === undefined ? null : String(r.finished_at),
      createdAt: String(r.created_at),
      accountId: r.account_id === null || r.account_id === undefined ? null : String(r.account_id),
      proxyId: r.proxy_id === null || r.proxy_id === undefined ? null : String(r.proxy_id),
      reasoningTokens: r.reasoning_tokens === null || r.reasoning_tokens === undefined ? null : Number(r.reasoning_tokens),
    }));
    const nextCursor = hasMore ? (mapped[mapped.length - 1]?.id ?? null) : null;
    return { rows: mapped, nextCursor };
  }

  async writeLogs(rows: readonly ConsoleLogInput[]): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      await this.execute(
        chunk.map((row): D1Statement => ({
          sql: "INSERT INTO console_logs (ts, level, scope, msg, context_json) VALUES (?, ?, ?, ?, ?)",
          params: [row.ts ?? new Date().toISOString(), row.level, row.scope, row.msg, row.context === undefined ? null : JSON.stringify(row.context)],
        })),
      );
      if (chunk.length === CHUNK_SIZE) await Bun.sleep(0);
    }
  }

  async queryLogs(filter: ConsoleLogQuery): Promise<ConsoleLogPage> {
    const limit = Math.min(Math.max(filter.limit, 1), 1000);
    const params: unknown[] = [];
    let where = "WHERE 1=1";
    if (filter.afterId !== undefined) {
      where += " AND id > ?";
      params.push(filter.afterId);
    } else if (filter.cursor !== undefined && filter.cursor !== null) {
      where += " AND id < ?";
      params.push(filter.cursor);
    }
    params.push(limit + 1);
    const order = filter.afterId !== undefined ? "ASC" : "DESC";
    const result = await this.execute([{ sql: `SELECT id, ts, level, scope, msg, context_json FROM console_logs ${where} ORDER BY id ${order} LIMIT ?`, params }]);
    const rows = result[0]?.results ?? [];
    const hasMore = rows.length > limit;
    const pageRows = (hasMore ? rows.slice(0, limit) : rows).map((row): ConsoleLogRow => ({ id: Number(row.id), ts: String(row.ts), level: String(row.level), scope: String(row.scope), msg: String(row.msg), context: parseConsoleLogContext(row.context_json) }));
    return { rows: pageRows, nextCursor: hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null };
  }

  async *streamLogs(afterId = 0): AsyncIterable<ConsoleLogRow> {
    let cursor = afterId;
    while (true) {
      const page = await this.queryLogs({ afterId: cursor, limit: CHUNK_SIZE });
      if (page.rows.length === 0) return;
      for (const row of page.rows) {
        cursor = row.id;
        yield row;
      }
      if (page.rows.length < CHUNK_SIZE) return;
      await Bun.sleep(0);
    }
  }

  async clearLogs(): Promise<void> {
    await this.execute([{ sql: "DELETE FROM console_logs", params: [] }]);
  }

  async savePayload(requestId: string, kind: "client_request" | "provider_request" | "provider_response" | "client_response", artifact: PayloadArtifact): Promise<void> {
    const columns: Record<typeof kind, { value: string; meta: string }> = {
      client_request: { value: "client_request", meta: "client_request_meta" },
      provider_request: { value: "provider_request", meta: "provider_request_meta" },
      provider_response: { value: "provider_response", meta: "provider_response_meta" },
      client_response: { value: "client_response", meta: "client_response_meta" },
    };
    const selected = columns[kind];
    const now = new Date().toISOString();
    await this.execute([
      {
        sql: `INSERT INTO request_payloads (request_id, ${selected.value}, ${selected.meta}, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET ${selected.value} = excluded.${selected.value}, ${selected.meta} = excluded.${selected.meta}, updated_at = excluded.updated_at`,
        params: [requestId, artifact.text, JSON.stringify({ truncated: artifact.truncated, originalBytes: artifact.originalBytes, capturedBytes: artifact.capturedBytes }), now, now],
      },
    ]);
  }

  async getPayload(requestId: string): Promise<PayloadRecord | null> {
    const result = await this.execute([
      {
        sql: "SELECT request_id, client_request, provider_request, provider_response, client_response, client_request_meta, provider_request_meta, provider_response_meta, client_response_meta FROM request_payloads WHERE request_id = ? LIMIT 1",
        params: [requestId],
      },
    ]);
    const row = result[0]?.results[0];
    if (row === undefined) return null;
    const artifact = (value: unknown, metaValue: unknown): PayloadArtifact | null => {
      if (typeof value !== "string") return null;
      const meta = isRecord(metaValue) ? metaValue : {};
      return {
        text: value,
        truncated: meta.truncated === true,
        originalBytes: typeof meta.originalBytes === "number" ? meta.originalBytes : value.length,
        capturedBytes: typeof meta.capturedBytes === "number" ? meta.capturedBytes : value.length,
      };
    };
    const parseMeta = (value: unknown): unknown => {
      if (typeof value !== "string") return {};
      try {
        return JSON.parse(value as string) as unknown;
      } catch {
        return {};
      }
    };
    return {
      requestId,
      clientRequest: artifact(row.client_request, parseMeta(row.client_request_meta)),
      providerRequest: artifact(row.provider_request, parseMeta(row.provider_request_meta)),
      providerResponse: artifact(row.provider_response, parseMeta(row.provider_response_meta)),
      clientResponse: artifact(row.client_response, parseMeta(row.client_response_meta)),
    };
  }

  async retain(options?: { logRetentionDays?: number; payloadRetentionDays?: number }): Promise<RetentionResult> {
    const logDays = options?.logRetentionDays ?? 30;
    const payloadDays = options?.payloadRetentionDays ?? 7;
    const eventCutoff = new Date(Date.now() - logDays * 86_400_000).toISOString();
    const payloadCutoff = new Date(Date.now() - payloadDays * 86_400_000).toISOString();
    // D1 does not support multi-chunk yielding across batch; mirror SQLite bounded behavior
    // by issuing up to 8 chunks with yields between, but expose bounded per-tick semantics via single batch of LIMIT 500 per table.
    // For parity, execute bounded deletes in sequence with yields.
    let requestEvents = 0;
    let payloads = 0;
    let consoleLogs = 0;
    let consoleCapped = 0;
    for (let chunk = 0; chunk < 8; chunk++) {
      const results = await this.execute([
        { sql: "DELETE FROM request_events WHERE created_at < ? LIMIT 500", params: [eventCutoff] },
        { sql: "DELETE FROM request_payloads WHERE updated_at < ? LIMIT 500", params: [payloadCutoff] },
        { sql: "DELETE FROM console_logs WHERE ts < ? LIMIT 500", params: [eventCutoff] },
        { sql: "DELETE FROM console_logs WHERE id <= (SELECT id FROM console_logs ORDER BY id DESC LIMIT 1 OFFSET 10000) LIMIT 500", params: [] },
      ]);
      requestEvents += results[0]?.meta.changes ?? 0;
      payloads += results[1]?.meta.changes ?? 0;
      consoleLogs += results[2]?.meta.changes ?? 0;
      consoleCapped += results[3]?.meta.changes ?? 0;
      const didWork = (results[0]?.meta.changes ?? 0) === 500 || (results[1]?.meta.changes ?? 0) === 500 || (results[2]?.meta.changes ?? 0) === 500 || (results[3]?.meta.changes ?? 0) === 500;
      if (!didWork) break;
      await Bun.sleep(0);
    }
    return { requestEvents, payloads, consoleLogs, consoleCapped };
  }

  async getOverviewTotals(): Promise<OverviewTotals> {
    const result = await this.execute([{
      sql: `
        WITH base AS (
          SELECT
            input_tokens,
            cached_tokens,
            output_tokens,
            status,
            CASE
              WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
                THEN (julianday(finished_at) - julianday(started_at)) * 86400000
              ELSE NULL
            END AS durationMs
          FROM request_events
          WHERE datetime(created_at) > datetime('now','-1 day')
        ),
        ordered AS (
          SELECT durationMs, ROW_NUMBER() OVER (ORDER BY durationMs) AS rn, COUNT(*) OVER () AS total
          FROM base
          WHERE durationMs IS NOT NULL
        )
        SELECT
          COUNT(*) as requests,
          COALESCE(SUM(input_tokens),0) as inputTokens,
          COALESCE(SUM(cached_tokens),0) as cachedTokens,
          COALESCE(SUM(output_tokens),0) as outputTokens,
          COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) as errors,
          COALESCE(AVG(durationMs),0) as avgDurationMs,
          COALESCE((SELECT durationMs FROM ordered WHERE rn = CAST(((total * 95) + 99) / 100 AS INT) LIMIT 1), 0) as p95DurationMs
        FROM base
      `,
      params: [],
    }]);
    const row = result[0]?.results[0] ?? {};
    const getNum = (key: string): number => {
      const v = (row as Record<string, unknown>)[key];
      if (typeof v === "number") return v;
      const lower = (row as Record<string, unknown>)[key.toLowerCase()];
      return typeof lower === "number" ? lower : Number(v ?? lower ?? 0);
    };
    const requests = getNum("requests");
    const inputTokens = getNum("inputTokens");
    const cachedTokens = getNum("cachedTokens");
    const outputTokens = getNum("outputTokens");
    const errors = getNum("errors");
    const avgDurationMs = getNum("avgDurationMs");
    const p95DurationMs = getNum("p95DurationMs");
    return { requests, inputTokens, cachedTokens, outputTokens, errors, avgDurationMs, p95DurationMs, totalTokens: inputTokens + outputTokens, estimatedCostUsd: 0 };
  }

  async getProviderAggregates(): Promise<ProviderAggregate[]> {
    const result = await this.execute([{ sql: "SELECT provider as providerId, COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as inputTokens, COALESCE(SUM(cached_tokens),0) as cachedTokens, COALESCE(SUM(output_tokens),0) as outputTokens, COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) as errors FROM request_events WHERE provider IS NOT NULL AND datetime(created_at) > datetime('now','-1 day') GROUP BY provider ORDER BY requests DESC", params: [] }]);
    const rows = result[0]?.results ?? [];
    return rows.map((r) => ({
      providerId: String(r.providerId ?? r.provider ?? "unknown"),
      requests: Number(r.requests ?? 0),
      inputTokens: Number(r.inputTokens ?? r.input_tokens ?? 0),
      cachedTokens: Number(r.cachedTokens ?? r.cached_tokens ?? 0),
      outputTokens: Number(r.outputTokens ?? r.output_tokens ?? 0),
      errors: Number(r.errors ?? 0),
    }));
  }

  async getTopIps(options: { windowSeconds: number; limit: number }): Promise<{ rows: TopIpRow[] }> {
    const windowSeconds = Math.min(3600, Math.max(10, options.windowSeconds));
    const limit = Math.min(50, Math.max(1, options.limit));
    const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();
    const result = await this.execute([{ sql: "SELECT COALESCE(client_ip,'unknown') as ip, COUNT(*) as requests, COUNT(*) * 1.0 / ? as rpm, SUM(CASE WHEN status BETWEEN 200 AND 399 THEN 1 ELSE 0 END) as success, SUM(CASE WHEN status >=400 THEN 1 ELSE 0 END) as errors, COUNT(DISTINCT model) as models, COALESCE(SUM(total_tokens),0) as tokens, COALESCE(SUM(cached_tokens),0) as cached_tokens FROM request_events WHERE datetime(created_at) > datetime(?) GROUP BY client_ip ORDER BY requests DESC LIMIT ?", params: [windowSeconds, cutoff, limit] }]);
    const rows = result[0]?.results ?? [];
    return { rows: rows.map((r) => ({ ip: String(r.ip ?? "unknown"), requests: Number(r.requests ?? 0), rpm: Number(r.rpm ?? 0), success: Number(r.success ?? 0), errors: Number(r.errors ?? 0), models: Number(r.models ?? 0), tokens: Number(r.tokens ?? 0), cached_tokens: Number(r.cached_tokens ?? 0) })) };
  }

  async getApiKeyTotals(apiKeyId: string): Promise<ApiKeyUsageTotals> {
    const result = await this.execute([{
      sql: "SELECT COALESCE(SUM(total_tokens), 0) AS total_tokens, COUNT(*) AS total_requests, COALESCE(SUM(CASE WHEN datetime(created_at) >= datetime('now', 'start of day') THEN total_tokens ELSE 0 END), 0) AS daily_tokens, COALESCE(SUM(CASE WHEN datetime(created_at) >= datetime('now', 'start of month') THEN total_tokens ELSE 0 END), 0) AS monthly_tokens, COALESCE(SUM(CASE WHEN status BETWEEN 200 AND 399 THEN 1 ELSE 0 END), 0) AS success_count, COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS error_count FROM request_events WHERE api_key_id = ?",
      params: [apiKeyId],
    }]);
    const row = result[0]?.results[0] ?? {};
    return {
      totalTokens: Number(row.total_tokens ?? 0),
      totalRequests: Number(row.total_requests ?? 0),
      dailyTokens: Number(row.daily_tokens ?? 0),
      monthlyTokens: Number(row.monthly_tokens ?? 0),
      successCount: Number(row.success_count ?? 0),
      errorCount: Number(row.error_count ?? 0),
    };
  }

  async getUsageSummary(filter: UsageFilter): Promise<OverviewTotals> {
    const params: unknown[] = [];
    const clause = d1FilterClause(filter, params);
    const result = await this.execute([{
      sql: `
        WITH base AS (
          SELECT
            input_tokens,
            cached_tokens,
            output_tokens,
            status,
            error_kind,
            CASE
              WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
                THEN (julianday(finished_at) - julianday(started_at)) * 86400000
              ELSE NULL
            END AS durationMs
          FROM request_events
          WHERE 1=1${clause}
        ),
        ordered AS (
          SELECT durationMs, ROW_NUMBER() OVER (ORDER BY durationMs) AS rn, COUNT(*) OVER () AS total
          FROM base
          WHERE durationMs IS NOT NULL
        )
        SELECT
          COUNT(*) as requests,
          COALESCE(SUM(input_tokens),0) as inputTokens,
          COALESCE(SUM(cached_tokens),0) as cachedTokens,
          COALESCE(SUM(output_tokens),0) as outputTokens,
          COALESCE(SUM(CASE WHEN status >= 400 OR error_kind IS NOT NULL THEN 1 ELSE 0 END),0) as errors,
          COALESCE(AVG(durationMs),0) as avgDurationMs,
          COALESCE((SELECT durationMs FROM ordered WHERE rn = CAST(((total * 95) + 99) / 100 AS INT) LIMIT 1), 0) as p95DurationMs
        FROM base
      `,
      params,
    }]);
    const row = result[0]?.results[0] ?? {};
    const getNum = (key: string): number => {
      const v = (row as Record<string, unknown>)[key];
      if (typeof v === "number") return v;
      const lower = (row as Record<string, unknown>)[key.toLowerCase()];
      return typeof lower === "number" ? lower : Number(v ?? lower ?? 0);
    };
    const requests = getNum("requests");
    const inputTokens = getNum("inputTokens");
    const cachedTokens = getNum("cachedTokens");
    const outputTokens = getNum("outputTokens");
    const errors = getNum("errors");
    const avgDurationMs = getNum("avgDurationMs");
    const p95DurationMs = getNum("p95DurationMs");
    return { requests, inputTokens, cachedTokens, outputTokens, errors, avgDurationMs, p95DurationMs, totalTokens: inputTokens + outputTokens, estimatedCostUsd: 0 };
  }

  async getChartBuckets(filter: UsageFilter): Promise<{ buckets: ChartBucket[] }> {
    const params: unknown[] = [];
    const clause = d1FilterClause(filter, params);
    const result = await this.execute([{ sql: `SELECT substr(created_at,1,13) || ':00:00' as t, COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(cached_tokens),0) as cached, COALESCE(SUM(output_tokens),0) as output FROM request_events WHERE 1=1${clause} GROUP BY substr(created_at,1,13) ORDER BY t ASC`, params }]);
    const rows = result[0]?.results ?? [];
    if (rows.length === 0) {
      const params2: unknown[] = [];
      const clause2 = d1FilterClause(filter, params2);
      const raw = await this.execute([{ sql: `SELECT created_at as t, 1 as requests, COALESCE(input_tokens,0) as input, COALESCE(cached_tokens,0) as cached, COALESCE(output_tokens,0) as output FROM request_events WHERE 1=1${clause2} ORDER BY created_at ASC LIMIT 1000`, params: params2 }]);
      const rawRows = raw[0]?.results ?? [];
      return { buckets: rawRows.map((r) => ({ t: String(r.t), requests: Number(r.requests ?? 1), input: Number((r as Record<string, unknown>).input ?? 0), cached: Number((r as Record<string, unknown>).cached ?? 0), output: Number((r as Record<string, unknown>).output ?? 0) })) };
    }
    return { buckets: rows.map((r) => ({ t: String(r.t), requests: Number(r.requests ?? 0), input: Number((r as Record<string, unknown>).input ?? 0), cached: Number((r as Record<string, unknown>).cached ?? 0), output: Number((r as Record<string, unknown>).output ?? 0) })) };
  }

  async getBreakdown(filter: UsageFilter, dimension: "model" | "provider" | "api_key"): Promise<{ rows: BreakdownRow[] }> {
    const params: unknown[] = [];
    const clause = d1FilterClause(filter, params);
    let sql: string;
    if (dimension === "model") sql = `SELECT model as name, COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output, COALESCE(SUM(cached_tokens),0) as cached, COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) as total, COALESCE(SUM(CASE WHEN status >=400 OR error_kind IS NOT NULL THEN 1 ELSE 0 END),0) as errors FROM request_events WHERE 1=1${clause} GROUP BY model ORDER BY requests DESC`;
    else if (dimension === "provider") sql = `SELECT COALESCE(provider,'unknown') as name, COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output, COALESCE(SUM(cached_tokens),0) as cached, COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) as total, COALESCE(SUM(CASE WHEN status >=400 OR error_kind IS NOT NULL THEN 1 ELSE 0 END),0) as errors FROM request_events WHERE 1=1${clause} GROUP BY provider ORDER BY requests DESC`;
    else sql = `SELECT COALESCE(api_key_id, COALESCE(api_key_prefix,'unknown')) as name, COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output, COALESCE(SUM(cached_tokens),0) as cached, COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) as total, COALESCE(SUM(CASE WHEN status >=400 OR error_kind IS NOT NULL THEN 1 ELSE 0 END),0) as errors FROM request_events WHERE 1=1${clause} GROUP BY COALESCE(api_key_id, api_key_prefix) ORDER BY requests DESC`;
    const result = await this.execute([{ sql, params }]);
    const rows = result[0]?.results ?? [];
    return { rows: rows.map((r) => ({ name: String(r.name ?? "unknown"), requests: Number(r.requests ?? 0), input: Number((r as Record<string, unknown>).input ?? 0), output: Number((r as Record<string, unknown>).output ?? 0), cached: Number((r as Record<string, unknown>).cached ?? 0), total: Number((r as Record<string, unknown>).total ?? 0), errors: Number((r as Record<string, unknown>).errors ?? 0), costUsd: null })) };
  }

  async getCacheSummary(filter: UsageFilter): Promise<CacheSummary> {
    const params: unknown[] = [];
    const clause = d1FilterClause(filter, params);
    const result = await this.execute([{ sql: `SELECT COALESCE(SUM(input_tokens),0) as inputTokens, COALESCE(SUM(cached_tokens),0) as cachedTokens FROM request_events WHERE 1=1${clause}`, params }]);
    const row = result[0]?.results[0] ?? {};
    const inputTokens = Number((row as Record<string, unknown>).inputTokens ?? (row as Record<string, unknown>).input_tokens ?? 0);
    const cachedTokens = Number((row as Record<string, unknown>).cachedTokens ?? (row as Record<string, unknown>).cached_tokens ?? 0);
    const hitRate = inputTokens > 0 ? cachedTokens / inputTokens : 0;
    return { inputTokens, cachedTokens, cacheWriteTokens: 0, hitRate };
  }

  async getTrace(traceId: string): Promise<TelemetryRow | null> {
    const result = await this.execute([{ sql: `SELECT id, trace_id, endpoint, surface, provider, model, status, error_kind, error_provider_code, error_provider_type, error_upstream_request_id, error_retry_after_ms, client_ip, api_key_id, api_key_prefix, meta_json, input_tokens, output_tokens, cached_tokens, total_tokens, tffb_ms, tfft_ms, message_count, tool_count, image_count, started_at, finished_at, created_at, account_id, proxy_id, reasoning_tokens FROM request_events WHERE trace_id = ? LIMIT 1`, params: [traceId] }]);
    const r = result[0]?.results[0];
    if (!r) return null;
    return {
      id: Number(r.id),
      traceId: String(r.trace_id),
      endpoint: String(r.endpoint),
      surface: String(r.surface),
      provider: r.provider === null || r.provider === undefined ? null : String(r.provider),
      model: String(r.model),
      status: Number(r.status),
      errorKind: r.error_kind === null || r.error_kind === undefined ? null : String(r.error_kind),
      errorProviderCode: r.error_provider_code === null || r.error_provider_code === undefined ? null : String(r.error_provider_code),
      errorProviderType: r.error_provider_type === null || r.error_provider_type === undefined ? null : String(r.error_provider_type),
      errorUpstreamRequestId: r.error_upstream_request_id === null || r.error_upstream_request_id === undefined ? null : String(r.error_upstream_request_id),
      errorRetryAfterMs: r.error_retry_after_ms === null || r.error_retry_after_ms === undefined ? null : Number(r.error_retry_after_ms),
      clientIp: r.client_ip === null || r.client_ip === undefined ? null : String(r.client_ip),
      apiKeyId: r.api_key_id === null || r.api_key_id === undefined ? null : String(r.api_key_id),
      apiKeyPrefix: r.api_key_prefix === null || r.api_key_prefix === undefined ? null : String(r.api_key_prefix),
      metaJson: String(r.meta_json),
      inputTokens: r.input_tokens === null || r.input_tokens === undefined ? null : Number(r.input_tokens),
      outputTokens: r.output_tokens === null || r.output_tokens === undefined ? null : Number(r.output_tokens),
      cachedTokens: r.cached_tokens === null || r.cached_tokens === undefined ? null : Number(r.cached_tokens),
      totalTokens: r.total_tokens === null || r.total_tokens === undefined ? null : Number(r.total_tokens),
      tffbMs: r.tffb_ms === null || r.tffb_ms === undefined ? null : Number(r.tffb_ms),
      tfftMs: r.tfft_ms === null || r.tfft_ms === undefined ? null : Number(r.tfft_ms),
      messageCount: r.message_count === null || r.message_count === undefined ? null : Number(r.message_count),
      toolCount: r.tool_count === null || r.tool_count === undefined ? null : Number(r.tool_count),
      imageCount: r.image_count === null || r.image_count === undefined ? null : Number(r.image_count),
      startedAt: r.started_at === null || r.started_at === undefined ? null : String(r.started_at),
      finishedAt: r.finished_at === null || r.finished_at === undefined ? null : String(r.finished_at),
      createdAt: String(r.created_at),
      accountId: r.account_id === null || r.account_id === undefined ? null : String(r.account_id),
      proxyId: r.proxy_id === null || r.proxy_id === undefined ? null : String(r.proxy_id),
      reasoningTokens: r.reasoning_tokens === null || r.reasoning_tokens === undefined ? null : Number(r.reasoning_tokens),
    };
  }

  async getApiKeyTotalsBatch(apiKeyIds: readonly string[]): Promise<Record<string, ApiKeyUsageTotals>> {
    if (apiKeyIds.length === 0) return {};
    const placeholders = apiKeyIds.map(() => "?").join(",");
    const result = await this.execute([{ sql: `SELECT api_key_id as api_key_id, COALESCE(SUM(total_tokens),0) as total_tokens, COUNT(*) as total_requests, COALESCE(SUM(CASE WHEN datetime(created_at) >= datetime('now','start of day') THEN total_tokens ELSE 0 END),0) as daily_tokens, COALESCE(SUM(CASE WHEN datetime(created_at) >= datetime('now','start of month') THEN total_tokens ELSE 0 END),0) as monthly_tokens, COALESCE(SUM(CASE WHEN status BETWEEN 200 AND 399 THEN 1 ELSE 0 END),0) as success_count, COALESCE(SUM(CASE WHEN status >=400 THEN 1 ELSE 0 END),0) as error_count FROM request_events WHERE api_key_id IN (${placeholders}) GROUP BY api_key_id`, params: [...apiKeyIds] }]);
    const rows = result[0]?.results ?? [];
    const map: Record<string, ApiKeyUsageTotals> = {};
    for (const r of rows) {
      const id = String(r.api_key_id);
      map[id] = { totalTokens: Number(r.total_tokens ?? 0), totalRequests: Number(r.total_requests ?? 0), dailyTokens: Number(r.daily_tokens ?? 0), monthlyTokens: Number(r.monthly_tokens ?? 0), successCount: Number(r.success_count ?? 0), errorCount: Number(r.error_count ?? 0) };
    }
    for (const id of apiKeyIds) if (!map[id]) map[id] = { totalTokens: 0, totalRequests: 0, dailyTokens: 0, monthlyTokens: 0, successCount: 0, errorCount: 0 };
    return map;
  }

  close(): void {}
}
