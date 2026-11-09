/**
 * Drizzle PG schema — single-source TS for all 20 PostgreSQL migrations.
 * Mirrors migrations/001_initial through 020_telemetry_aggregates exactly.
 * Column types, indexes, FKs, and uniques preserved for compatibility.
 */
import {
  pgTable,
  text,
  boolean,
  integer,
  bigint,
  bigserial,
  serial,
  jsonb,
  timestamp,
  uuid,
  inet,
  index,
  unique,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// 001 — schema_migrations
// ---------------------------------------------------------------------------
export const schemaMigrations = pgTable("schema_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  checksum: text("checksum").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 001 — settings
// ---------------------------------------------------------------------------
export const settings = pgTable("settings", {
  id: integer("id").primaryKey(),
  passwordHash: text("password_hash"),
  passwordVersion: integer("password_version").notNull().default(1),
  settingsJson: jsonb("settings_json").notNull().default(sql`'{}'::jsonb`),
  initializedAt: timestamp("initialized_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 001 + 013 — api_keys (jsonb allowlists, notes, key_encrypted)
// ---------------------------------------------------------------------------
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    keyHash: text("key_hash").notNull().unique(),
    keyPrefix: text("key_prefix").notNull(),
    keyEncrypted: text("key_encrypted"),
    active: boolean("active").notNull().default(true),
    rateLimitRpm: integer("rate_limit_rpm"),
    dailyTokenLimit: integer("daily_token_limit"),
    monthlyTokenLimit: integer("monthly_token_limit"),
    oneTimeTokenLimit: integer("one_time_token_limit"),
    oneTimeTokensUsed: integer("one_time_tokens_used").notNull().default(0),
    maxConcurrentRequests: integer("max_concurrent_requests"),
    providerAllowlist: jsonb("provider_allowlist"),
    modelAllowlist: jsonb("model_allowlist"),
    modelDenylist: jsonb("model_denylist"),
    notesTitle: text("notes_title"),
    notesSubtitle: text("notes_subtitle"),
    notesBody: text("notes_body"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("idx_api_keys_hash").on(t.keyHash),
    index("idx_api_keys_prefix").on(t.keyPrefix),
    index("idx_api_keys_active").on(t.active),
    index("idx_api_keys_created").on(t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// 001 — provider_accounts
// ---------------------------------------------------------------------------
export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    credentialKind: text("credential_kind").notNull(),
    credentialEncrypted: text("credential_encrypted").notNull(),
    credentialHint: text("credential_hint").notNull().default(""),
    priority: integer("priority").notNull().default(100),
    active: boolean("active").notNull().default(true),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true, mode: "string" }),
    cooldownLevel: integer("cooldown_level").notNull().default(0),
    consecutiveUseCount: integer("consecutive_use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    unique("provider_accounts_provider_name_unique").on(t.provider, t.name),
    index("idx_provider_accounts_provider_priority").on(t.provider, t.priority, t.name, t.id),
    index("idx_provider_accounts_cooldown").on(t.cooldownUntil),
    index("idx_provider_accounts_active").on(t.active, t.provider),
    index("idx_provider_accounts_active_sort").on(t.active, t.provider, t.priority, t.name, t.id),
    index("idx_provider_accounts_updated").on(t.updatedAt),
  ],
);

// ---------------------------------------------------------------------------
// 001 + 019 — provider_account_health
// ---------------------------------------------------------------------------
export const providerAccountHealth = pgTable(
  "provider_account_health",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => providerAccounts.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("healthy"),
    errorKind: text("error_kind"),
    statusCode: integer("status_code"),
    sanitizedMessage: text("sanitized_message"),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }),
    retryAt: timestamp("retry_at", { withTimezone: true, mode: "string" }),
    failureCount: integer("failure_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("idx_provider_account_health_retry").on(t.retryAt)],
);

// ---------------------------------------------------------------------------
// 001 — account_model_locks
// ---------------------------------------------------------------------------
export const accountModelLocks = pgTable(
  "account_model_locks",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => providerAccounts.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    retryAt: timestamp("retry_at", { withTimezone: true, mode: "string" }).notNull(),
    errorKind: text("error_kind"),
    statusCode: integer("status_code"),
    sanitizedMessage: text("sanitized_message"),
    failureCount: integer("failure_count").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.modelId], name: "account_model_locks_pkey" }),
    index("idx_account_model_locks_retry").on(t.retryAt),
  ],
);

// ---------------------------------------------------------------------------
// 001 — oauth_refresh_leases
// ---------------------------------------------------------------------------
export const oauthRefreshLeases = pgTable(
  "oauth_refresh_leases",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => providerAccounts.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    generation: integer("generation").notNull(),
    tokenFingerprint: text("token_fingerprint").notNull(),
    leaseUntilMs: bigint("lease_until_ms", { mode: "number" }).notNull(),
    acquiredAtMs: bigint("acquired_at_ms", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_oauth_refresh_leases_expiry").on(t.leaseUntilMs)],
);

// ---------------------------------------------------------------------------
// 001 + 009 — provider_models
// ---------------------------------------------------------------------------
export const providerModels = pgTable(
  "provider_models",
  {
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    source: text("source").notNull().default("manual"),
    displayName: text("display_name"),
    metadataJson: jsonb("metadata_json").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.modelId], name: "provider_models_pkey" }),
    index("idx_provider_models_enabled").on(t.provider, t.enabled),
    index("idx_provider_models_enabled_sort").on(t.enabled, t.provider, t.modelId),
    index("idx_provider_models_source").on(t.source),
  ],
);

// ---------------------------------------------------------------------------
// 001 — model_aliases
// ---------------------------------------------------------------------------
export const modelAliases = pgTable("model_aliases", {
  alias: text("alias").primaryKey(),
  model: text("model").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 001 — combos
// ---------------------------------------------------------------------------
export const combos = pgTable(
  "combos",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    modelsJson: jsonb("models_json").notNull().default(sql`'[]'::jsonb`),
    strategy: text("strategy").notNull().default("fallback"),
    stickyLimit: integer("sticky_limit").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  () => [],
);

// ---------------------------------------------------------------------------
// 001 + 004 + 019 — custom_providers
// ---------------------------------------------------------------------------
export const customProviders = pgTable(
  "custom_providers",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    baseUrl: text("base_url").notNull(),
    credentialEncrypted: text("credential_encrypted").notNull().default(""),
    timeoutSeconds: integer("timeout_seconds").notNull().default(30),
    modelsJson: jsonb("models_json").notNull().default(sql`'[]'::jsonb`),
    headersJson: jsonb("headers_json").notNull().default(sql`'{}'::jsonb`),
    queryParamsJson: jsonb("query_params_json").notNull().default(sql`'{}'::jsonb`),
    compatibilityProfileJson: jsonb("compatibility_profile_json").notNull().default(sql`'{}'::jsonb`),
    anthropicProfileJson: jsonb("anthropic_profile_json").notNull().default(sql`'{}'::jsonb`),
    surfacesJson: jsonb("surfaces_json").notNull().default(sql`'["openai-chat"]'::jsonb`),
    endpointsJson: jsonb("endpoints_json").notNull().default(sql`'[]'::jsonb`),
    quirksJson: jsonb("quirks_json").notNull().default(sql`'{}'::jsonb`),
    nativePassthrough: boolean("native_passthrough").notNull().default(false),
    compactPath: text("compact_path"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  () => [],
);

// ---------------------------------------------------------------------------
// 001 — proxies
// ---------------------------------------------------------------------------
export const proxies = pgTable(
  "proxies",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    protocol: text("protocol").notNull(),
    isRelay: boolean("is_relay").notNull().default(false),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    username: text("username"),
    passwordEncrypted: text("password_encrypted"),
    priority: integer("priority").notNull().default(100),
    weight: integer("weight").notNull().default(100),
    maxConcurrency: integer("max_concurrency").notNull().default(8),
    active: boolean("active").notNull().default(true),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true, mode: "string" }),
    cooldownLevel: integer("cooldown_level").notNull().default(0),
    consecutiveUseCount: integer("consecutive_use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    lastTestAt: timestamp("last_test_at", { withTimezone: true, mode: "string" }),
    lastTestSuccessAt: timestamp("last_test_success_at", { withTimezone: true, mode: "string" }),
    lastTestSuccessLatencyMs: integer("last_test_success_latency_ms"),
    lastTestErrorAt: timestamp("last_test_error_at", { withTimezone: true, mode: "string" }),
    lastTestError: text("last_test_error"),
    lastTestStatusCode: integer("last_test_status_code"),
  },
  (t) => [
    index("idx_proxies_priority").on(t.priority, t.name, t.id),
    index("idx_proxies_active_sort").on(t.active, t.priority, t.name, t.id),
    index("idx_proxies_cooldown").on(t.cooldownUntil),
  ],
);

// ---------------------------------------------------------------------------
// 001 — proxy_health
// ---------------------------------------------------------------------------
export const proxyHealth = pgTable(
  "proxy_health",
  {
    proxyId: text("proxy_id")
      .primaryKey()
      .references(() => proxies.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("healthy"),
    errorKind: text("error_kind"),
    statusCode: integer("status_code"),
    sanitizedMessage: text("sanitized_message"),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }),
    retryAt: timestamp("retry_at", { withTimezone: true, mode: "string" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("idx_proxy_health_retry").on(t.retryAt)],
);

// ---------------------------------------------------------------------------
// 001 — proxy_settings
// ---------------------------------------------------------------------------
export const proxySettings = pgTable("proxy_settings", {
  id: integer("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  excludedProvidersJson: jsonb("excluded_providers_json").notNull().default(sql`'[]'::jsonb`),
  smartDynamicRouting: boolean("smart_dynamic_routing").notNull().default(false),
  smartDynamicProxyCount: integer("smart_dynamic_proxy_count").notNull().default(2),
  routingPreset: text("routing_preset").notNull().default("auto"),
  targetConcurrent: integer("target_concurrent").notNull().default(0),
  webSearchPreference: text("web_search_preference").notNull().default("auto"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 001 — access_rules
// ---------------------------------------------------------------------------
export const accessRules = pgTable("access_rules", {
  scope: text("scope").primaryKey(),
  mode: text("mode").notNull().default("open"),
  entriesJson: jsonb("entries_json").notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 001 — share_links
// ---------------------------------------------------------------------------
export const shareLinks = pgTable(
  "share_links",
  {
    id: text("id").primaryKey(),
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    kind: text("kind").notNull().default("monitor"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "string" }),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("idx_share_links_api_key").on(t.apiKeyId),
    index("idx_share_links_active").on(t.active, t.kind, t.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// 001 — console_sessions
// ---------------------------------------------------------------------------
export const consoleSessions = pgTable(
  "console_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("idx_console_sessions_token").on(t.tokenHash),
    index("idx_console_sessions_expires").on(t.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// 001 + 017 + 020 — request_events (PG control-plane copy; also mirrored in SQLite)
// Note: created_at added for 020 index compatibility; PG version stores timestamptz, SQLite stores text.
// ---------------------------------------------------------------------------
export const requestEvents = pgTable(
  "request_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    traceId: text("trace_id").notNull(),
    endpoint: text("endpoint").notNull(),
    surface: text("surface").notNull(),
    apiKeyId: text("api_key_id"),
    apiKeyPrefix: text("api_key_prefix"),
    provider: text("provider"),
    model: text("model"),
    status: integer("status").notNull(),
    errorKind: text("error_kind"),
    errorProviderCode: text("error_provider_code"),
    errorProviderType: text("error_provider_type"),
    errorUpstreamRequestId: text("error_upstream_request_id"),
    errorRetryAfterMs: integer("error_retry_after_ms"),
    stream: boolean("stream").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow(),
    durationMs: integer("duration_ms").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedTokens: integer("cached_tokens"),
    totalTokens: integer("total_tokens"),
    usageSource: text("usage_source").notNull().default("unknown"),
    metaJson: jsonb("meta_json").notNull().default(sql`'{}'::jsonb`),
    clientName: text("client_name").notNull().default("unknown"),
    clientSource: text("client_source").notNull().default("unknown"),
    messageCount: integer("message_count").notNull().default(0),
    toolCount: integer("tool_count").notNull().default(0),
    imageCount: integer("image_count").notNull().default(0),
    tfftMs: integer("tfft_ms"),
    tffbMs: integer("tffb_ms"),
    clientIp: text("client_ip"),
    accountId: text("account_id"),
    proxyId: text("proxy_id"),
    reasoningTokens: integer("reasoning_tokens"),
  },
  (t) => [
    index("idx_request_events_started_at").on(t.startedAt),
    index("idx_request_events_status_id").on(t.status, t.id),
    index("idx_request_events_provider_status").on(t.provider, t.status, t.id),
    index("idx_request_events_api_key_started").on(t.apiKeyId, t.startedAt),
    index("idx_request_events_provider_started").on(t.provider, t.startedAt),
    index("idx_request_events_model_started").on(t.model, t.startedAt),
    index("idx_request_events_trace_id").on(t.traceId),
    index("idx_request_events_client_ip").on(t.clientIp, t.startedAt),
    // 020 aggregates
    index("idx_request_events_trace_id_agg").on(t.traceId),
    index("idx_request_events_created_at_agg").on(t.createdAt),
    index("idx_request_events_started_at_agg").on(t.startedAt),
    index("idx_request_events_provider_agg").on(t.provider),
    index("idx_request_events_model_agg").on(t.model),
    index("idx_request_events_api_key_id_agg").on(t.apiKeyId),
    index("idx_request_events_provider_created_agg").on(t.provider, t.createdAt),
    index("idx_request_events_model_created_agg").on(t.model, t.createdAt),
    index("idx_request_events_api_key_created_agg").on(t.apiKeyId, t.createdAt),
    index("idx_request_events_status_created_agg").on(t.status, t.createdAt),
    index("idx_request_events_client_ip_created_agg").on(t.clientIp, t.createdAt),
    index("idx_request_events_provider_code").on(t.errorProviderCode),
    index("idx_request_events_account_id").on(t.accountId),
    index("idx_request_events_proxy_id").on(t.proxyId),
  ],
);

// ---------------------------------------------------------------------------
// 001 + 002 + 020 — console_logs (PG)
// ---------------------------------------------------------------------------
export const consoleLogs = pgTable(
  "console_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    level: text("level").notNull(),
    scope: text("scope").notNull(),
    msg: text("msg").notNull(),
    contextJson: jsonb("context_json"),
  },
  (t) => [
    index("idx_console_logs_ts").on(t.ts),
    index("idx_console_logs_scope_ts").on(t.scope, t.ts),
    index("idx_console_logs_level_ts").on(t.level, t.ts),
    index("idx_console_logs_id_desc_agg").on(t.id),
    index("idx_console_logs_scope_id_agg").on(t.scope, t.id),
    index("idx_console_logs_level_id_agg").on(t.level, t.id),
  ],
);

// ---------------------------------------------------------------------------
// 003 — provider_account_quota
// ---------------------------------------------------------------------------
export const providerAccountQuota = pgTable(
  "provider_account_quota",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => providerAccounts.id, { onDelete: "cascade" }),
    source: text("source"),
    status: text("status").notNull().default("unknown"),
    plan: text("plan"),
    windowsJson: jsonb("windows_json").notNull().default(sql`'[]'::jsonb`),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "string" }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true, mode: "string" }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true, mode: "string" }),
    error: text("error"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("idx_provider_account_quota_status").on(t.status, t.lastAttemptAt)],
);

// ---------------------------------------------------------------------------
// 005 + 018 — cli_tools
// ---------------------------------------------------------------------------
export const cliTools = pgTable("cli_tools", {
  toolId: text("tool_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  allowedApiKeyIds: jsonb("allowed_api_key_ids").notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 005 — cli_mappings
// ---------------------------------------------------------------------------
export const cliMappings = pgTable(
  "cli_mappings",
  {
    toolId: text("tool_id").notNull(),
    slotKey: text("slot_key").notNull(),
    sourceModel: text("source_model").notNull(),
    targetModel: text("target_model").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.toolId, t.slotKey], name: "cli_mappings_pkey" }),
    index("idx_cli_mappings_source").on(t.toolId, t.sourceModel),
  ],
);

// ---------------------------------------------------------------------------
// 006 — filter_rules
// ---------------------------------------------------------------------------
export const filterRules = pgTable(
  "filter_rules",
  {
    id: serial("id").primaryKey(),
    ruleId: text("rule_id").notNull().unique(),
    pattern: text("pattern").notNull(),
    replacement: text("replacement").notNull().default(""),
    isActive: boolean("is_active").notNull().default(true),
    isRegex: boolean("is_regex").notNull().default(true),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("idx_filter_rules_sort").on(t.sortOrder, t.id)],
);

// ---------------------------------------------------------------------------
// 007 — ip_bans (inet)
// ---------------------------------------------------------------------------
export const ipBans = pgTable(
  "ip_bans",
  {
    ip: inet("ip").primaryKey(),
    reason: text("reason").notNull().default("failed_login"),
    failedAttempts: integer("failed_attempts").notNull().default(1),
    banStartedAt: timestamp("ban_started_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    banExpiresAt: timestamp("ban_expires_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [index("idx_ip_bans_expires").on(t.banExpiresAt)],
);

// ---------------------------------------------------------------------------
// 008 — rate_limit_counters (inet)
// ---------------------------------------------------------------------------
export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    ip: inet("ip").notNull(),
    scope: text("scope").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: "string" }).notNull(),
    requestCount: integer("request_count").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.ip, t.scope, t.windowStartedAt], name: "rate_limit_counters_pkey" }),
    index("idx_rate_limit_counters_window").on(t.windowStartedAt),
  ],
);

// ---------------------------------------------------------------------------
// 014 + 015 + 016 — wireguard
// ---------------------------------------------------------------------------
export const wireguardPoolSettings = pgTable("wireguard_pool_settings", {
  id: boolean("id").primaryKey().default(true),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const wireguardTunnels = pgTable(
  "wireguard_tunnels",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    configPath: text("config_path").notNull().unique(),
    proxyId: text("proxy_id").references(() => proxies.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    runtimeStatus: text("runtime_status").notNull().default("stopped"),
    processId: integer("process_id"),
    socksHost: text("socks_host").notNull(),
    socksPort: integer("socks_port").notNull().unique(),
    egressIp: inet("egress_ip"),
    lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true, mode: "string" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("wireguard_tunnels_enabled_status_idx").on(t.enabled, t.runtimeStatus)],
);

// ---------------------------------------------------------------------------
// 024 — buyers (opencode buyer management; additive, no api_keys changes)
// ---------------------------------------------------------------------------
export const buyers = pgTable(
  "buyers",
  {
    id: text("id").primaryKey(),
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "restrict" }),
    subdomain: text("subdomain").notNull().unique(),
    email: text("email").notNull(),
    licenseKey: text("license_key").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_buyers_status").on(t.status),
    index("idx_buyers_expires").on(t.expiresAt),
    index("idx_buyers_api_key").on(t.apiKeyId),
  ],
);
