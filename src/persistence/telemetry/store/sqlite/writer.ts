import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { TelemetryEvent } from "../../../../proxy/types/telemetry.js";
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
  TelemetryQuery,
  TelemetryRow,
  TelemetryStore,
  TopIpRow,
  UsageFilter,
} from "../interface.js";
import { createTunedDatabase } from "./connection.js";
import { ensureTelemetrySchema } from "./schema.js";
import { retainTelemetryData } from "../../retention.js";

const CHUNK_SIZE = 500;

function buildFilterClause(filter: UsageFilter, params: unknown[]): string {
  let clause = "";
  if (filter.from) {
    clause += " AND created_at >= ?";
    params.push(filter.from);
  }
  if (filter.to) {
    clause += " AND created_at <= ?";
    params.push(filter.to);
  }
  if (filter.provider) {
    clause += " AND provider = ?";
    params.push(filter.provider);
  }
  if (filter.model) {
    clause += " AND model = ?";
    params.push(filter.model);
  }
  return clause;
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

function mapTelemetryRow(r: Record<string, unknown>): TelemetryRow {
  return {
    id: r.id as number,
    traceId: r.trace_id as string,
    endpoint: r.endpoint as string,
    surface: r.surface as string,
    provider: (r.provider as string | null) ?? null,
    model: r.model as string,
    status: r.status as number,
    errorKind: (r.error_kind as string | null) ?? null,
    errorProviderCode: (r.error_provider_code as string | null) ?? null,
    errorProviderType: (r.error_provider_type as string | null) ?? null,
    errorUpstreamRequestId: (r.error_upstream_request_id as string | null) ?? null,
    errorRetryAfterMs: (r.error_retry_after_ms as number | null) ?? null,
    clientIp: (r.client_ip as string | null) ?? null,
    apiKeyId: (r.api_key_id as string | null) ?? null,
    apiKeyPrefix: (r.api_key_prefix as string | null) ?? null,
    metaJson: r.meta_json as string,
    inputTokens: (r.input_tokens as number | null) ?? null,
    outputTokens: (r.output_tokens as number | null) ?? null,
    cachedTokens: (r.cached_tokens as number | null) ?? null,
    totalTokens: (r.total_tokens as number | null) ?? null,
    tffbMs: (r.tffb_ms as number | null) ?? null,
    tfftMs: (r.tfft_ms as number | null) ?? null,
    messageCount: (r.message_count as number | null) ?? null,
    toolCount: (r.tool_count as number | null) ?? null,
    imageCount: (r.image_count as number | null) ?? null,
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
    createdAt: r.created_at as string,
    accountId: (r.account_id as string | null) ?? null,
    proxyId: (r.proxy_id as string | null) ?? null,
    reasoningTokens: (r.reasoning_tokens as number | null) ?? null,
  };
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

export class SqliteTelemetryStore implements TelemetryStore {
  private db!: Database;
  private insertStmt!: { run(...args: unknown[]): unknown; finalize(): void };
  private readonly ready: Promise<void>;

  constructor(path: string) {
    this.ready = (async () => {
      const db = await createTunedDatabase(path);
      ensureTelemetrySchema(db);
      this.db = db;
      this.insertStmt = db.prepare(
        `INSERT INTO request_events (trace_id, endpoint, surface, provider, model, status, error_kind, error_provider_code, error_provider_type, error_upstream_request_id, error_retry_after_ms, client_ip, api_key_id, api_key_prefix, meta_json, input_tokens, output_tokens, cached_tokens, total_tokens, tffb_ms, tfft_ms, message_count, tool_count, image_count, started_at, finished_at, account_id, proxy_id, reasoning_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ) as unknown as { run(...args: unknown[]): unknown; finalize(): void };
    })();
  }

  /** Async factory that ensures directory + schema are ready before first use; preferred for startup parallelization. */
  static async create(path: string): Promise<SqliteTelemetryStore> {
    const store = new SqliteTelemetryStore(path);
    await store.ready;
    return store;
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  async writeBatch(events: readonly TelemetryEvent[]): Promise<void> {
    await this.ensureReady();
    if (events.length === 0) return;
    for (let i = 0; i < events.length; i += CHUNK_SIZE) {
      const chunk = events.slice(i, i + CHUNK_SIZE);
      const tx = this.db.transaction((batch: readonly TelemetryEvent[]) => {
        for (const ev of batch) {
          const row = toRow(ev);
          (this.insertStmt as unknown as { run(...a: unknown[]): unknown }).run(...row);
        }
      });
      tx(chunk);
      if (chunk.length === CHUNK_SIZE) await Bun.sleep(0);
    }
  }

  async query(filter: TelemetryQuery): Promise<{ rows: TelemetryRow[]; nextCursor: number | null }> {
    await this.ensureReady();
    const limit = Math.min(Math.max(filter.limit, 1), 1000);
    const params: SQLQueryBindings[] = [];
    let where = "WHERE 1=1";
    if (filter.cursor !== null && filter.cursor !== undefined) {
      where += " AND id < ?";
      params.push(filter.cursor);
    }
    if (filter.provider) {
      where += " AND provider = ?";
      params.push(filter.provider);
    }
    if (filter.from) {
      where += " AND created_at >= ?";
      params.push(filter.from);
    }
    if (filter.to) {
      where += " AND created_at <= ?";
      params.push(filter.to);
    }
    if (filter.model) {
      where += " AND model = ?";
      params.push(filter.model);
    }
    params.push(limit + 1);
    const rows = (this.db.query(`SELECT id, trace_id, endpoint, surface, provider, model, status, error_kind, error_provider_code, error_provider_type, error_upstream_request_id, error_retry_after_ms, client_ip, api_key_id, api_key_prefix, meta_json, input_tokens, output_tokens, cached_tokens, total_tokens, tffb_ms, tfft_ms, message_count, tool_count, image_count, started_at, finished_at, created_at, account_id, proxy_id, reasoning_tokens FROM request_events ${where} ORDER BY id DESC LIMIT ?`) as unknown as { all(...a: unknown[]): unknown[] }).all(...params) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const mapped: TelemetryRow[] = slice.map((r) => ({
      id: r.id as number,
      traceId: r.trace_id as string,
      endpoint: r.endpoint as string,
      surface: r.surface as string,
      provider: (r.provider as string | null) ?? null,
      model: r.model as string,
      status: r.status as number,
      errorKind: (r.error_kind as string | null) ?? null,
      errorProviderCode: (r.error_provider_code as string | null) ?? null,
      errorProviderType: (r.error_provider_type as string | null) ?? null,
      errorUpstreamRequestId: (r.error_upstream_request_id as string | null) ?? null,
      errorRetryAfterMs: (r.error_retry_after_ms as number | null) ?? null,
      clientIp: (r.client_ip as string | null) ?? null,
      apiKeyId: (r.api_key_id as string | null) ?? null,
      apiKeyPrefix: (r.api_key_prefix as string | null) ?? null,
      metaJson: r.meta_json as string,
      inputTokens: (r.input_tokens as number | null) ?? null,
      outputTokens: (r.output_tokens as number | null) ?? null,
      cachedTokens: (r.cached_tokens as number | null) ?? null,
      totalTokens: (r.total_tokens as number | null) ?? null,
      tffbMs: (r.tffb_ms as number | null) ?? null,
      tfftMs: (r.tfft_ms as number | null) ?? null,
      messageCount: (r.message_count as number | null) ?? null,
      toolCount: (r.tool_count as number | null) ?? null,
      imageCount: (r.image_count as number | null) ?? null,
      startedAt: (r.started_at as string | null) ?? null,
      finishedAt: (r.finished_at as string | null) ?? null,
      createdAt: r.created_at as string,
      accountId: (r.account_id as string | null) ?? null,
      proxyId: (r.proxy_id as string | null) ?? null,
      reasoningTokens: (r.reasoning_tokens as number | null) ?? null,
    }));
    const nextCursor = hasMore ? (mapped[mapped.length - 1]?.id ?? null) : null;
    return { rows: mapped, nextCursor };
  }

  async writeLogs(rows: readonly ConsoleLogInput[]): Promise<void> {
    await this.ensureReady();
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const tx = this.db.transaction((batch: readonly ConsoleLogInput[]) => {
        for (const row of batch) {
          this.db.run("INSERT INTO console_logs (ts, level, scope, msg, context_json) VALUES (?, ?, ?, ?, ?)", [row.ts ?? new Date().toISOString(), row.level, row.scope, row.msg, row.context === undefined ? null : JSON.stringify(row.context)]);
        }
      });
      tx(chunk);
      if (chunk.length === CHUNK_SIZE) await Bun.sleep(0);
    }
  }

  async queryLogs(filter: ConsoleLogQuery): Promise<ConsoleLogPage> {
    await this.ensureReady();
    const limit = Math.min(Math.max(filter.limit, 1), 1000);
    const params: SQLQueryBindings[] = [];
    let where = "WHERE 1=1";
    if (filter.afterId !== undefined) {
      where += " AND id > ?";
      params.push(filter.afterId);
    } else if (filter.cursor !== undefined && filter.cursor !== null) {
      where += " AND id < ?";
      params.push(filter.cursor);
    }
    params.push(limit + 1);
    const rows = (this.db.query(`SELECT id, ts, level, scope, msg, context_json FROM console_logs ${where} ORDER BY id ${filter.afterId !== undefined ? "ASC" : "DESC"} LIMIT ?`) as unknown as { all(...args: unknown[]): unknown[] }).all(...params) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const pageRows = (hasMore ? rows.slice(0, limit) : rows).map((row): ConsoleLogRow => ({
      id: Number(row.id),
      ts: String(row.ts),
      level: String(row.level),
      scope: String(row.scope),
      msg: String(row.msg),
      context: parseConsoleLogContext(row.context_json),
    }));
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
    await this.ensureReady();
    this.db.run("DELETE FROM console_logs");
  }

  async savePayload(requestId: string, kind: "client_request" | "provider_request" | "provider_response" | "client_response", artifact: PayloadArtifact): Promise<void> {
    await this.ensureReady();
    const cols: Record<string, string> = {
      client_request: "client_request",
      provider_request: "provider_request",
      provider_response: "provider_response",
      client_response: "client_response",
    };
    const metaCols: Record<string, string> = {
      client_request: "client_request_meta",
      provider_request: "provider_request_meta",
      provider_response: "provider_response_meta",
      client_response: "client_response_meta",
    };
    const col = cols[kind];
    const metaCol = metaCols[kind];
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const meta = JSON.stringify({ truncated: artifact.truncated, originalBytes: artifact.originalBytes, capturedBytes: artifact.capturedBytes });
    const sql = `INSERT INTO request_payloads (request_id, ${col}, ${metaCol}, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET ${col} = excluded.${col}, ${metaCol} = excluded.${metaCol}, updated_at = excluded.updated_at`;
    this.db.run(sql, [requestId, artifact.text, meta, now, now]);
  }

  async getPayload(requestId: string): Promise<PayloadRecord | null> {
    await this.ensureReady();
    const row = this.db.query("SELECT * FROM request_payloads WHERE request_id = ?").get(requestId) as Record<string, unknown> | null;
    if (!row) return null;
    const parse = (valueCol: string, metaCol: string): PayloadArtifact | null => {
      const text = typeof row[valueCol] === "string" ? (row[valueCol] as string) : null;
      if (text === null) return null;
      let meta: Partial<PayloadArtifact> = {};
      try {
        meta = JSON.parse(String(row[metaCol] ?? "{}")) as Partial<PayloadArtifact>;
      } catch {}
      return { text, truncated: meta.truncated === true, originalBytes: typeof meta.originalBytes === "number" ? meta.originalBytes : text.length, capturedBytes: typeof meta.capturedBytes === "number" ? meta.capturedBytes : text.length };
    };
    return {
      requestId,
      clientRequest: parse("client_request", "client_request_meta"),
      providerRequest: parse("provider_request", "provider_request_meta"),
      providerResponse: parse("provider_response", "provider_response_meta"),
      clientResponse: parse("client_response", "client_response_meta"),
    };
  }

  async retain(options?: { logRetentionDays?: number; payloadRetentionDays?: number }): Promise<{ requestEvents: number; payloads: number; consoleLogs: number; consoleCapped: number }> {
    await this.ensureReady();
    return retainTelemetryData(this.db, options);
  }

  async getOverviewTotals(): Promise<OverviewTotals> {
    await this.ensureReady();
    // 24h window uses created_at for telemetry durability; fallback to current time
    const rows = this.db.query(`
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
        WHERE created_at > datetime('now','-1 day')
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
    `).all() as Array<Record<string, unknown>>;
    const r = rows[0] ?? {};
    const requests = Number(r.requests ?? 0);
    const inputTokens = Number((r as Record<string, unknown>).inputTokens ?? (r as Record<string, unknown>).input_tokens ?? 0);
    const cachedTokens = Number((r as Record<string, unknown>).cachedTokens ?? (r as Record<string, unknown>).cached_tokens ?? 0);
    const outputTokens = Number((r as Record<string, unknown>).outputTokens ?? (r as Record<string, unknown>).output_tokens ?? 0);
    const errors = Number((r as Record<string, unknown>).errors ?? 0);
    const avgDurationMs = Number((r as Record<string, unknown>).avgDurationMs ?? (r as Record<string, unknown>).avg_duration_ms ?? 0);
    const p95DurationMs = Number((r as Record<string, unknown>).p95DurationMs ?? (r as Record<string, unknown>).p95_duration_ms ?? 0);
    return { requests, inputTokens, cachedTokens, outputTokens, errors, avgDurationMs, p95DurationMs, totalTokens: inputTokens + outputTokens, estimatedCostUsd: 0 };
  }

  async getProviderAggregates(): Promise<ProviderAggregate[]> {
    await this.ensureReady();
    const rows = this.db.query(`SELECT provider as providerId, COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as inputTokens, COALESCE(SUM(cached_tokens),0) as cachedTokens, COALESCE(SUM(output_tokens),0) as outputTokens, COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) as errors FROM request_events WHERE provider IS NOT NULL AND created_at > datetime('now','-1 day') GROUP BY provider ORDER BY requests DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      providerId: String(r.providerId ?? r.provider ?? "unknown"),
      requests: Number(r.requests ?? 0),
      inputTokens: Number((r as Record<string, unknown>).inputTokens ?? (r as Record<string, unknown>).input_tokens ?? 0),
      cachedTokens: Number((r as Record<string, unknown>).cachedTokens ?? (r as Record<string, unknown>).cached_tokens ?? 0),
      outputTokens: Number((r as Record<string, unknown>).outputTokens ?? (r as Record<string, unknown>).output_tokens ?? 0),
      errors: Number((r as Record<string, unknown>).errors ?? 0),
    }));
  }

  async getTopIps(options: { windowSeconds: number; limit: number }): Promise<{ rows: TopIpRow[] }> {
    await this.ensureReady();
    const windowSeconds = Math.min(3600, Math.max(10, options.windowSeconds));
    const limit = Math.min(50, Math.max(1, options.limit));
    // Use created_at for window since telemetry finished_at may be null & SQLite datetime
    const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString().slice(0, 19).replace("T", " ");
    const rows = this.db.query(`SELECT COALESCE(client_ip,'unknown') as ip, COUNT(*) as requests, COUNT(*) * 1.0 / ? as rpm, SUM(CASE WHEN status BETWEEN 200 AND 399 THEN 1 ELSE 0 END) as success, SUM(CASE WHEN status >=400 THEN 1 ELSE 0 END) as errors, COUNT(DISTINCT model) as models, COALESCE(SUM(total_tokens),0) as tokens, COALESCE(SUM(cached_tokens),0) as cached_tokens FROM request_events WHERE created_at > datetime(?) GROUP BY client_ip ORDER BY requests DESC LIMIT ?`).all(windowSeconds, cutoff, limit) as Array<Record<string, unknown>>;
    return {
      rows: rows.map((r) => ({
        ip: String(r.ip ?? "unknown"),
        requests: Number(r.requests ?? 0),
        rpm: Number(r.rpm ?? 0),
        success: Number(r.success ?? 0),
        errors: Number(r.errors ?? 0),
        models: Number(r.models ?? 0),
        tokens: Number(r.tokens ?? 0),
        cached_tokens: Number(r.cached_tokens ?? 0),
      })),
    };
  }

  async getApiKeyTotals(apiKeyId: string): Promise<ApiKeyUsageTotals> {
    await this.ensureReady();
    const row = (this.db.query(`
      SELECT
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COUNT(*) AS total_requests,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', 'start of day') THEN total_tokens ELSE 0 END), 0) AS daily_tokens,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', 'start of month') THEN total_tokens ELSE 0 END), 0) AS monthly_tokens,
        COALESCE(SUM(CASE WHEN status BETWEEN 200 AND 399 THEN 1 ELSE 0 END), 0) AS success_count,
        COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS error_count
      FROM request_events
      WHERE api_key_id = ?
    `).get(apiKeyId) ?? {}) as Record<string, unknown>;
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
    await this.ensureReady();
    const params: SQLQueryBindings[] = [];
    const clause = buildFilterClause(filter, params);
    const row = (this.db.query(`
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
    `).get(...params) ?? {}) as Record<string, unknown>;
    const requests = Number(row.requests ?? 0);
    const inputTokens = Number((row as Record<string, unknown>).inputTokens ?? (row as Record<string, unknown>).input_tokens ?? 0);
    const cachedTokens = Number((row as Record<string, unknown>).cachedTokens ?? (row as Record<string, unknown>).cached_tokens ?? 0);
    const outputTokens = Number((row as Record<string, unknown>).outputTokens ?? (row as Record<string, unknown>).output_tokens ?? 0);
    const errors = Number((row as Record<string, unknown>).errors ?? 0);
    const avgDurationMs = Number((row as Record<string, unknown>).avgDurationMs ?? (row as Record<string, unknown>).avg_duration_ms ?? 0);
    const p95DurationMs = Number((row as Record<string, unknown>).p95DurationMs ?? (row as Record<string, unknown>).p95_duration_ms ?? 0);
    return { requests, inputTokens, cachedTokens, outputTokens, errors, avgDurationMs, p95DurationMs, totalTokens: inputTokens + outputTokens, estimatedCostUsd: 0 };
  }

  async getChartBuckets(filter: UsageFilter): Promise<{ buckets: ChartBucket[] }> {
    await this.ensureReady();
    const params: SQLQueryBindings[] = [];
    const clause = buildFilterClause(filter, params);
    // Bucket by hour using created_at hour truncation to keep bounded result while preserving JS-equivalent per-bucket totals
    const rows = this.db.query(`SELECT substr(created_at,1,13) || ':00:00' as t, COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(cached_tokens),0) as cached, COALESCE(SUM(output_tokens),0) as output FROM request_events WHERE 1=1${clause} GROUP BY substr(created_at,1,13) ORDER BY t ASC`).all(...params) as Array<Record<string, unknown>>;
    if (rows.length > 0 && rows.length < 200) {
      return { buckets: rows.map((r) => ({ t: String(r.t), requests: Number(r.requests ?? 0), input: Number((r as Record<string, unknown>).input ?? 0), cached: Number((r as Record<string, unknown>).cached ?? 0), output: Number((r as Record<string, unknown>).output ?? 0) })) };
    }
    // For sparse data (< grouping useful) fall back to per-event buckets to keep shape identical to legacy path
    const raw = this.db.query(`SELECT created_at as t, 1 as requests, COALESCE(input_tokens,0) as input, COALESCE(cached_tokens,0) as cached, COALESCE(output_tokens,0) as output FROM request_events WHERE 1=1${clause} ORDER BY created_at ASC LIMIT 1000`).all(...params) as Array<Record<string, unknown>>;
    if (rows.length === 0 || raw.length < rows.length * 2) {
      // Use grouped when it compresses sufficiently, otherwise per-event for fidelity
      if (raw.length <= 500) return { buckets: raw.map((r) => ({ t: String(r.t), requests: Number(r.requests ?? 1), input: Number(r.input ?? 0), cached: Number(r.cached ?? 0), output: Number(r.output ?? 0) })) };
    }
    return { buckets: rows.map((r) => ({ t: String(r.t), requests: Number(r.requests ?? 0), input: Number((r as Record<string, unknown>).input ?? 0), cached: Number((r as Record<string, unknown>).cached ?? 0), output: Number((r as Record<string, unknown>).output ?? 0) })) };
  }

  async getBreakdown(filter: UsageFilter, dimension: "model" | "provider" | "api_key"): Promise<{ rows: BreakdownRow[] }> {
    await this.ensureReady();
    const params: SQLQueryBindings[] = [];
    const clause = buildFilterClause(filter, params);
    let sql: string;
    if (dimension === "model") {
      sql = `SELECT model as name, COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output, COALESCE(SUM(cached_tokens),0) as cached, COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) as total, COALESCE(SUM(CASE WHEN status >=400 OR error_kind IS NOT NULL THEN 1 ELSE 0 END),0) as errors FROM request_events WHERE 1=1${clause} GROUP BY model ORDER BY requests DESC`;
    } else if (dimension === "provider") {
      sql = `SELECT COALESCE(provider,'unknown') as name, COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output, COALESCE(SUM(cached_tokens),0) as cached, COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) as total, COALESCE(SUM(CASE WHEN status >=400 OR error_kind IS NOT NULL THEN 1 ELSE 0 END),0) as errors FROM request_events WHERE 1=1${clause} GROUP BY provider ORDER BY requests DESC`;
    } else {
      sql = `SELECT COALESCE(api_key_id, COALESCE(api_key_prefix,'unknown')) as name, COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output, COALESCE(SUM(cached_tokens),0) as cached, COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) as total, COALESCE(SUM(CASE WHEN status >=400 OR error_kind IS NOT NULL THEN 1 ELSE 0 END),0) as errors FROM request_events WHERE 1=1${clause} GROUP BY COALESCE(api_key_id, api_key_prefix) ORDER BY requests DESC`;
    }
    const rows = this.db.query(sql).all(...params) as Array<Record<string, unknown>>;
    return { rows: rows.map((r) => ({ name: String(r.name ?? "unknown"), requests: Number(r.requests ?? 0), input: Number(r.input ?? 0), output: Number(r.output ?? 0), cached: Number(r.cached ?? 0), total: Number(r.total ?? 0), errors: Number(r.errors ?? 0), costUsd: null })) };
  }

  async getCacheSummary(filter: UsageFilter): Promise<CacheSummary> {
    await this.ensureReady();
    const params: SQLQueryBindings[] = [];
    const clause = buildFilterClause(filter, params);
    const row = (this.db.query(`SELECT COALESCE(SUM(input_tokens),0) as inputTokens, COALESCE(SUM(cached_tokens),0) as cachedTokens FROM request_events WHERE 1=1${clause}`).get(...params) ?? {}) as Record<string, unknown>;
    const inputTokens = Number((row as Record<string, unknown>).inputTokens ?? (row as Record<string, unknown>).input_tokens ?? 0);
    const cachedTokens = Number((row as Record<string, unknown>).cachedTokens ?? (row as Record<string, unknown>).cached_tokens ?? 0);
    const hitRate = inputTokens > 0 ? cachedTokens / inputTokens : 0;
    return { inputTokens, cachedTokens, cacheWriteTokens: 0, hitRate };
  }

  async getTrace(traceId: string): Promise<TelemetryRow | null> {
    await this.ensureReady();
    const row = this.db.query(`SELECT id, trace_id, endpoint, surface, provider, model, status, error_kind, error_provider_code, error_provider_type, error_upstream_request_id, error_retry_after_ms, client_ip, api_key_id, api_key_prefix, meta_json, input_tokens, output_tokens, cached_tokens, total_tokens, tffb_ms, tfft_ms, message_count, tool_count, image_count, started_at, finished_at, created_at, account_id, proxy_id, reasoning_tokens FROM request_events WHERE trace_id = ? LIMIT 1`).get(traceId) as Record<string, unknown> | null | undefined;
    if (!row) return null;
    return mapTelemetryRow(row);
  }

  async getApiKeyTotalsBatch(apiKeyIds: readonly string[]): Promise<Record<string, ApiKeyUsageTotals>> {
    await this.ensureReady();
    if (apiKeyIds.length === 0) return {};
    const placeholders = apiKeyIds.map(() => "?").join(",");
    const rows = this.db.query(`SELECT api_key_id as api_key_id, COALESCE(SUM(total_tokens),0) as total_tokens, COUNT(*) as total_requests, COALESCE(SUM(CASE WHEN created_at >= datetime('now','start of day') THEN total_tokens ELSE 0 END),0) as daily_tokens, COALESCE(SUM(CASE WHEN created_at >= datetime('now','start of month') THEN total_tokens ELSE 0 END),0) as monthly_tokens, COALESCE(SUM(CASE WHEN status BETWEEN 200 AND 399 THEN 1 ELSE 0 END),0) as success_count, COALESCE(SUM(CASE WHEN status >=400 THEN 1 ELSE 0 END),0) as error_count FROM request_events WHERE api_key_id IN (${placeholders}) GROUP BY api_key_id`).all(...apiKeyIds) as Array<Record<string, unknown>>;
    const map: Record<string, ApiKeyUsageTotals> = {};
    for (const r of rows) {
      const id = String(r.api_key_id);
      map[id] = {
        totalTokens: Number(r.total_tokens ?? 0),
        totalRequests: Number(r.total_requests ?? 0),
        dailyTokens: Number(r.daily_tokens ?? 0),
        monthlyTokens: Number(r.monthly_tokens ?? 0),
        successCount: Number(r.success_count ?? 0),
        errorCount: Number(r.error_count ?? 0),
      };
    }
    // Ensure every requested id has an entry (zero-filled) for stable batch contract
    for (const id of apiKeyIds) if (!map[id]) map[id] = { totalTokens: 0, totalRequests: 0, dailyTokens: 0, monthlyTokens: 0, successCount: 0, errorCount: 0 };
    return map;
  }

  close(): void {
    try {
      this.insertStmt?.finalize();
    } catch {}
    try {
      (this.db as Database | undefined)?.close();
    } catch {}
  }
}
