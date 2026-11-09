// Backup and restore management — Drizzle PostgreSQL edition
import type { PostgresPool } from "./pool.js";
import { getPool } from "./pool.js";
import { CURRENT_BACKUP_VERSION } from "./types.js";
import type { BackupPayload } from "./types.js";
import type { TelemetryPipeline } from "./telemetry/pipeline.js";
import type { TelemetryRow } from "./telemetry/store/interface.js";
export type { BackupPayload };

import { createDrizzlePG, type DrizzlePG } from "./db.js";
import {
  settings as settingsTable,
  apiKeys as apiKeysTable,
  shareLinks as shareLinksTable,
  providerAccounts as providerAccountsTable,
  providerAccountHealth as providerAccountHealthTable,
  accountModelLocks as accountModelLocksTable,
  providerModels as providerModelsTable,
  modelAliases as modelAliasesTable,
  combos as combosTable,
  customProviders as customProvidersTable,
  proxies as proxiesTable,
  proxyHealth as proxyHealthTable,
  proxySettings as proxySettingsTable,
  accessRules as accessRulesTable,
  consoleSessions as consoleSessionsTable,
  cliTools as cliToolsTable,
  cliMappings as cliMappingsTable,
  filterRules as filterRulesTable,
  ipBans as ipBansTable,
} from "./schema/pg.js";

export const BACKUP_APP = "ohmyomop-router" as const;

export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

const MAX_ROWS_PER_TABLE = 100_000;
const BATCH_SIZE = 500;

export const BACKUP_TABLES = [
  "settings",
  "api_keys",
  "share_links",
  "provider_accounts",
  "provider_account_health",
  "account_model_locks",
  "provider_models",
  "model_aliases",
  "combos",
  "custom_providers",
  "proxies",
  "proxy_health",
  "proxy_settings",
  "access_rules",
  "console_sessions",
  "cli_tools",
  "cli_mappings",
  "filter_rules",
  "ip_bans",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

const TABLE_COLUMNS: Record<BackupTable, readonly string[]> = {
  settings: ["id", "password_hash", "password_version", "settings_json", "initialized_at", "updated_at"],
  api_keys: ["id", "name", "key_hash", "key_prefix", "key_encrypted", "active", "rate_limit_rpm", "daily_token_limit", "monthly_token_limit", "one_time_token_limit", "one_time_tokens_used", "max_concurrent_requests", "provider_allowlist", "model_allowlist", "model_denylist", "notes_title", "notes_subtitle", "notes_body", "last_used_at", "created_at", "revoked_at"],
  share_links: ["id", "api_key_id", "token_hash", "kind", "active", "created_at", "expires_at", "used_at", "last_viewed_at"],
  provider_accounts: ["id", "provider", "name", "credential_kind", "credential_encrypted", "credential_hint", "priority", "active", "cooldown_until", "cooldown_level", "consecutive_use_count", "last_used_at", "created_at", "updated_at"],
  provider_account_health: ["account_id", "status", "error_kind", "status_code", "sanitized_message", "occurred_at", "retry_at", "updated_at"],
  account_model_locks: ["account_id", "model_id", "retry_at", "error_kind", "status_code", "sanitized_message", "failure_count", "created_at", "updated_at"],
  provider_models: ["provider", "model_id", "display_name", "enabled", "source", "metadata_json", "created_at", "updated_at"],
  model_aliases: ["alias", "model", "created_at"],
  combos: ["id", "name", "models_json", "strategy", "sticky_limit", "created_at", "updated_at"],
  custom_providers: ["id", "slug", "name", "type", "base_url", "credential_encrypted", "timeout_seconds", "models_json", "headers_json", "query_params_json", "compatibility_profile_json", "anthropic_profile_json", "created_at", "updated_at"],
  proxies: ["id", "name", "protocol", "is_relay", "host", "port", "username", "password_encrypted", "priority", "weight", "max_concurrency", "active", "cooldown_until", "cooldown_level", "consecutive_use_count", "last_used_at", "created_at", "updated_at", "last_test_at", "last_test_success_at", "last_test_success_latency_ms", "last_test_error_at", "last_test_error", "last_test_status_code"],
  proxy_health: ["proxy_id", "status", "error_kind", "status_code", "sanitized_message", "occurred_at", "retry_at", "updated_at"],
  proxy_settings: ["id", "enabled", "excluded_providers_json", "smart_dynamic_routing", "smart_dynamic_proxy_count", "routing_preset", "target_concurrent", "web_search_preference", "updated_at"],
  access_rules: ["scope", "mode", "entries_json", "updated_at"],
  console_sessions: ["id", "token_hash", "data", "created_at", "expires_at", "revoked_at"],
  cli_tools: ["tool_id", "enabled", "updated_at"],
  cli_mappings: ["tool_id", "slot_key", "source_model", "target_model", "enabled", "created_at", "updated_at"],
  filter_rules: ["id", "rule_id", "pattern", "replacement", "is_active", "is_regex", "sort_order", "created_at", "updated_at"],
  ip_bans: ["ip", "reason", "failed_attempts", "ban_started_at", "ban_expires_at"],
};

const tableMap: Record<BackupTable, unknown> = {
  settings: settingsTable,
  api_keys: apiKeysTable,
  share_links: shareLinksTable,
  provider_accounts: providerAccountsTable,
  provider_account_health: providerAccountHealthTable,
  account_model_locks: accountModelLocksTable,
  provider_models: providerModelsTable,
  model_aliases: modelAliasesTable,
  combos: combosTable,
  custom_providers: customProvidersTable,
  proxies: proxiesTable,
  proxy_health: proxyHealthTable,
  proxy_settings: proxySettingsTable,
  access_rules: accessRulesTable,
  console_sessions: consoleSessionsTable,
  cli_tools: cliToolsTable,
  cli_mappings: cliMappingsTable,
  filter_rules: filterRulesTable,
  ip_bans: ipBansTable,
};

const DELETE_ORDER: BackupTable[] = [
  "account_model_locks", "provider_account_health", "provider_accounts",
  "custom_providers", "access_rules", "model_aliases", "combos",
  "proxy_health", "proxies", "proxy_settings",
  "share_links", "console_sessions", "cli_mappings", "cli_tools", "filter_rules", "ip_bans", "api_keys", "provider_models", "settings",
];

const INSERT_ORDER: BackupTable[] = [...DELETE_ORDER].reverse();

type Row = Record<string, unknown>;
type BackupDbInput = PostgresPool | DrizzlePG;

function isDrizzlePG(input: BackupDbInput): input is DrizzlePG {
  return typeof input === "object" && input !== null && "$client" in input;
}

function asDrizzlePG(input: BackupDbInput = getPool()): DrizzlePG {
  return isDrizzlePG(input)
    ? input
    : createDrizzlePG(input as PostgresPool);
}

export type RestoreValidation =
  | { readonly ok: true; readonly tables: Map<BackupTable, Row[]>; readonly history?: ReadonlyArray<TelemetryRow> }
  | { readonly ok: false; readonly error: string };

export interface RestoreResult { readonly restored: Record<string, number>; readonly historyRestored?: number; }

async function fetchTableRows(db: DrizzlePG, table: BackupTable): Promise<Row[]> {
  const tbl = tableMap[table];
  const rows = await (db as unknown as { select: () => { from: (tableRef: unknown) => { limit: (limit: number) => Promise<Row[]> } } })
    .select()
    .from(tbl)
    .limit(MAX_ROWS_PER_TABLE);
  return rows;
}

export async function exportBackup(poolOrDb: BackupDbInput = getPool(), options?: { telemetry?: TelemetryPipeline; includeHistory?: boolean }): Promise<BackupPayload> {
  const db = asDrizzlePG(poolOrDb);
  const tables: Record<string, unknown> = {};
  for (const table of BACKUP_TABLES) {
    const rows = await fetchTableRows(db, table);
    tables[table] = rows;
  }
  const payload: BackupPayload = { app: BACKUP_APP, version: CURRENT_BACKUP_VERSION, exportedAt: new Date().toISOString(), tables } as unknown as BackupPayload;
  if (options?.includeHistory && options.telemetry) {
    const history: TelemetryRow[] = [];
    let cursor: number | null | undefined = undefined;
    do {
      const page = await options.telemetry.query({ limit: 500, ...(cursor ? { cursor } : {}) });
      history.push(...page.rows);
      cursor = page.nextCursor;
      if (history.length > MAX_ROWS_PER_TABLE) break;
    } while (cursor !== null && cursor !== undefined);
    (payload as unknown as { history: unknown }).history = { requestEvents: history };
  }
  return payload;
}

export function exportBackupStream(poolOrDb: BackupDbInput = getPool(), options?: { telemetry?: TelemetryPipeline; includeHistory?: boolean }): Response {
  const db = asDrizzlePG(poolOrDb);
  const encoder = new TextEncoder();
  let totalBytes = 0;
  let oversized = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const emit = (chunk: string): void => {
          const encoded = encoder.encode(chunk);
          totalBytes += encoded.byteLength;
          if (totalBytes > MAX_BACKUP_BYTES) {
            oversized = true;
            controller.error(new Error(`Backup exceeded ${MAX_BACKUP_BYTES} bytes`));
            return;
          }
          controller.enqueue(encoded);
        };

        const prefix = JSON.stringify({
          app: BACKUP_APP,
          version: CURRENT_BACKUP_VERSION,
          exportedAt: new Date().toISOString(),
          tables: {},
        });
        const header = prefix.slice(0, prefix.lastIndexOf('"tables":{') + '"tables":{'.length);
        emit(header);

        let firstTable = true;
        for (const table of BACKUP_TABLES) {
          if (oversized) return;
          if (!firstTable) emit(",");
          firstTable = false;
          emit(JSON.stringify(table) + ":");
          let offset = 0;
          let firstBatch = true;
          emit("[");
          while (true) {
            if (oversized) return;
            const tbl = tableMap[table];
            const rows = await (db as unknown as { select: () => { from: (tableRef: unknown) => { limit: (limit: number) => { offset: (offset: number) => Promise<Row[]> } } } })
              .select()
              .from(tbl)
              .limit(BATCH_SIZE)
              .offset(offset);
            if (rows.length === 0) break;
            const chunk = JSON.stringify(rows);
            if (firstBatch) { emit(chunk.slice(1, -1)); firstBatch = false; } else { emit(","); emit(chunk.slice(1, -1)); }
            offset += rows.length;
            if (rows.length < BATCH_SIZE) break;
          }
          emit("]");
        }

        if (oversized) return;
        if (options?.includeHistory && options.telemetry) {
          emit(',"history":{"requestEvents":');
          let cursor: number | null | undefined = undefined;
          let firstHistoryBatch = true;
          emit("[");
          while (true) {
            if (oversized) return;
            const page = await options.telemetry.query({ limit: 500, ...(cursor ? { cursor } : {}) });
            if (page.rows.length === 0) break;
            const chunk = JSON.stringify(page.rows);
            if (firstHistoryBatch) { emit(chunk.slice(1, -1)); firstHistoryBatch = false; } else { emit(","); emit(chunk.slice(1, -1)); }
            cursor = page.nextCursor;
            if (cursor === null || cursor === undefined) break;
          }
          emit("]"); emit("}");
        }
        emit("}}");
        controller.close();
      } catch (err) { controller.error(err); }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="ohmyomop-router-backup.json"',
      "cache-control": "no-store",
    },
  });
}

function normalizeRows(table: string, value: unknown): Row[] | null {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value as Row[];
  if (table === "settings" || table === "proxy_settings") {
    if (typeof value === "object") return [value as Row];
  }
  return null;
}

function isTelemetryRow(value: unknown): value is TelemetryRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row["traceId"] === "string" || typeof row["trace_id"] === "string" || typeof row["id"] === "number";
}

export function validateRestorePayload(payload: unknown): RestoreValidation {
  if (!payload || typeof payload !== "object" || !("app" in payload) || !("version" in payload) || !("tables" in payload)) {
    return { ok: false, error: "Invalid backup envelope" };
  }
  const p = payload as Record<string, unknown>;
  if (p.app !== BACKUP_APP) return { ok: false, error: `Unknown app: ${String(p.app)}` };
  if (p.version !== CURRENT_BACKUP_VERSION) return { ok: false, error: `Unsupported backup version ${String(p.version)} — expected ${CURRENT_BACKUP_VERSION}. Import is not supported.` };
  const jsonLen = JSON.stringify(payload).length;
  if (jsonLen > MAX_BACKUP_BYTES) return { ok: false, error: `Backup too large: ${jsonLen} bytes` };
  const tablesRaw = p.tables as Record<string, unknown>;
  const out = new Map<BackupTable, Row[]>();
  for (const table of BACKUP_TABLES) {
    const raw = tablesRaw[table];
    if (raw === undefined) { out.set(table, []); continue; }
    const rows = normalizeRows(table, raw);
    if (rows === null) return { ok: false, error: `Invalid rows for table ${table}` };
    if (rows.length > MAX_ROWS_PER_TABLE) return { ok: false, error: `Too many rows for ${table}: ${rows.length}` };
    const allowed = new Set(TABLE_COLUMNS[table]);
    for (const row of rows) {
      for (const col of Object.keys(row)) {
        if (!allowed.has(col)) return { ok: false, error: `Unknown column ${col} in table ${table}` };
      }
    }
    out.set(table, rows);
  }
  for (const key of Object.keys(tablesRaw)) {
    if (!(BACKUP_TABLES as readonly string[]).includes(key)) return { ok: false, error: `Unknown table in backup: ${key}` };
  }
  let history: ReadonlyArray<TelemetryRow> | undefined;
  if ("history" in p && p["history"] !== undefined && p["history"] !== null) {
    const historyRaw = p["history"] as Record<string, unknown>;
    if (typeof historyRaw !== "object" || Array.isArray(historyRaw)) return { ok: false, error: "Invalid history envelope" };
    const eventsRaw = historyRaw["requestEvents"];
    if (eventsRaw !== undefined) {
      if (!Array.isArray(eventsRaw)) return { ok: false, error: "Invalid history.requestEvents" };
      if (eventsRaw.length > MAX_ROWS_PER_TABLE) return { ok: false, error: `Too many history rows: ${eventsRaw.length}` };
      for (const row of eventsRaw) { if (!isTelemetryRow(row)) return { ok: false, error: "Invalid history row" }; }
      history = eventsRaw as TelemetryRow[];
    }
  }
  return { ok: true, tables: out, ...(history ? { history } : {}) };
}

export async function applyRestore(poolOrDb: BackupDbInput, validation: Extract<RestoreValidation, { ok: true }>, options?: { telemetry?: TelemetryPipeline }): Promise<RestoreResult> {
  const tables = (validation as { tables: Map<BackupTable, Row[]> }).tables;
  const history = (validation as { history?: ReadonlyArray<TelemetryRow> }).history;
  const restored: Record<string, number> = {};
  const db = asDrizzlePG(poolOrDb);
  await (db as unknown as { transaction: (callback: (tx: DrizzlePG) => Promise<void>) => Promise<void> }).transaction(async (tx) => {
    for (const table of DELETE_ORDER) {
      await (tx as unknown as { delete: (tableRef: unknown) => Promise<void> }).delete(tableMap[table]);
    }
    for (const table of INSERT_ORDER) {
      const rows = tables.get(table) ?? [];
      if (rows.length === 0) { restored[table] = 0; continue; }
      const tableRef = tableMap[table];
      for (const row of rows) {
        const mapped: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          const camel = key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
          mapped[camel] = value;
          mapped[key] = value;
        }
        await (tx as unknown as { insert: (tableRef: unknown) => { values: (value: unknown) => Promise<void> } }).insert(tableRef).values(mapped);
      }
      restored[table] = rows.length;
    }
  });
  let historyRestored: number | undefined;
  if (history !== undefined && history.length > 0 && options?.telemetry) {
    const BATCH = 500;
    for (let i = 0; i < history.length; i += BATCH) {
      const batch = history.slice(i, i + BATCH);
      for (const row of batch) {
        const event = {
          requestId: String((row as unknown as Record<string, unknown>)["traceId"] ?? (row as unknown as Record<string, unknown>)["trace_id"] ?? (row as unknown as Record<string, unknown>)["requestId"] ?? crypto.randomUUID()),
          endpoint: String((row as unknown as Record<string, unknown>)["endpoint"] ?? "/v1/chat/completions"),
          surface: String((row as unknown as Record<string, unknown>)["surface"] ?? "openai-chat"),
          model: String((row as unknown as Record<string, unknown>)["model"] ?? ""),
          providerId: (row as unknown as Record<string, unknown>)["provider"] !== undefined ? String((row as unknown as Record<string, unknown>)["provider"]) : (row as unknown as Record<string, unknown>)["providerId"] !== undefined ? String((row as unknown as Record<string, unknown>)["providerId"]) : null,
          apiKeyId: (row as unknown as Record<string, unknown>)["apiKeyId"] !== undefined ? String((row as unknown as Record<string, unknown>)["apiKeyId"]) : (row as unknown as Record<string, unknown>)["api_key_id"] !== undefined ? String((row as unknown as Record<string, unknown>)["api_key_id"]) : null,
          apiKeyPrefix: (row as unknown as Record<string, unknown>)["apiKeyPrefix"] !== undefined ? String((row as unknown as Record<string, unknown>)["apiKeyPrefix"]) : (row as unknown as Record<string, unknown>)["api_key_prefix"] !== undefined ? String((row as unknown as Record<string, unknown>)["api_key_prefix"]) : null,
          clientIp: (row as unknown as Record<string, unknown>)["clientIp"] !== undefined ? String((row as unknown as Record<string, unknown>)["clientIp"]) : (row as unknown as Record<string, unknown>)["client_ip"] !== undefined ? String((row as unknown as Record<string, unknown>)["client_ip"]) : null,
          statusCode: typeof (row as unknown as Record<string, unknown>)["status"] === "number" ? (row as unknown as Record<string, unknown>)["status"] as number : typeof (row as unknown as Record<string, unknown>)["statusCode"] === "number" ? (row as unknown as Record<string, unknown>)["statusCode"] as number : null,
          errorKind: (row as unknown as Record<string, unknown>)["errorKind"] !== undefined ? String((row as unknown as Record<string, unknown>)["errorKind"]) : (row as unknown as Record<string, unknown>)["error_kind"] !== undefined ? String((row as unknown as Record<string, unknown>)["error_kind"]) : null,
          durationMs: typeof (row as unknown as Record<string, unknown>)["durationMs"] === "number" ? (row as unknown as Record<string, unknown>)["durationMs"] as number : null,
          usage: (() => {
            const input = (row as unknown as Record<string, unknown>)["inputTokens"] ?? (row as unknown as Record<string, unknown>)["input_tokens"];
            const output = (row as unknown as Record<string, unknown>)["outputTokens"] ?? (row as unknown as Record<string, unknown>)["output_tokens"];
            const cached = (row as unknown as Record<string, unknown>)["cachedTokens"] ?? (row as unknown as Record<string, unknown>)["cached_tokens"];
            const total = (row as unknown as Record<string, unknown>)["totalTokens"] ?? (row as unknown as Record<string, unknown>)["total_tokens"];
            if (typeof input === "number" || typeof output === "number") {
              return { promptTokens: Number(input ?? 0), completionTokens: Number(output ?? 0), totalTokens: Number(total ?? (Number(input ?? 0) + Number(output ?? 0))), cachedTokens: typeof cached === "number" ? Number(cached) : undefined };
            }
            return null;
          })(),
          committed: true,
          tffbMs: typeof (row as unknown as Record<string, unknown>)["tffbMs"] === "number" ? (row as unknown as Record<string, unknown>)["tffbMs"] as number : typeof (row as unknown as Record<string, unknown>)["tffb_ms"] === "number" ? (row as unknown as Record<string, unknown>)["tffb_ms"] as number : null,
          tfftMs: typeof (row as unknown as Record<string, unknown>)["tfftMs"] === "number" ? (row as unknown as Record<string, unknown>)["tfftMs"] as number : typeof (row as unknown as Record<string, unknown>)["tfft_ms"] === "number" ? (row as unknown as Record<string, unknown>)["tfft_ms"] as number : null,
          messageCount: typeof (row as unknown as Record<string, unknown>)["messageCount"] === "number" ? (row as unknown as Record<string, unknown>)["messageCount"] as number : typeof (row as unknown as Record<string, unknown>)["message_count"] === "number" ? (row as unknown as Record<string, unknown>)["message_count"] as number : null,
          toolCount: typeof (row as unknown as Record<string, unknown>)["toolCount"] === "number" ? (row as unknown as Record<string, unknown>)["toolCount"] as number : typeof (row as unknown as Record<string, unknown>)["tool_count"] === "number" ? (row as unknown as Record<string, unknown>)["tool_count"] as number : null,
          imageCount: typeof (row as unknown as Record<string, unknown>)["imageCount"] === "number" ? (row as unknown as Record<string, unknown>)["imageCount"] as number : typeof (row as unknown as Record<string, unknown>)["image_count"] === "number" ? (row as unknown as Record<string, unknown>)["image_count"] as number : null,
          startedAt: typeof (row as unknown as Record<string, unknown>)["startedAt"] === "string" ? (row as unknown as Record<string, unknown>)["startedAt"] as string : typeof (row as unknown as Record<string, unknown>)["started_at"] === "string" ? (row as unknown as Record<string, unknown>)["started_at"] as string : null,
          finishedAt: typeof (row as unknown as Record<string, unknown>)["finishedAt"] === "string" ? (row as unknown as Record<string, unknown>)["finishedAt"] as string : typeof (row as unknown as Record<string, unknown>)["finished_at"] === "string" ? (row as unknown as Record<string, unknown>)["finished_at"] as string : null,
        };
        options.telemetry.enqueue(event as unknown as import("../proxy/types/telemetry.js").TelemetryEvent);
      }
    }
    try { await options.telemetry.flush(); } catch {}
    historyRestored = history.length;
  }
  return { restored, ...(historyRestored !== undefined ? { historyRestored } : {}) };
}
