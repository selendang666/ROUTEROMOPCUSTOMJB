// Persistence API — flat canonical (3 folders: repositories, telemetry, migrations)
// Composition root — not a barrel; defines repository boundary for bootstrap
export { closePool, createPostgresPool, createPostgresPoolFromConfig, getPool, getPostgresUrl, ping, readiness, resetPoolForTests } from "./pool.js";
export type { PoolHealth, PostgresPool, PostgresPoolOptions, RuntimeDatabaseConfig } from "./pool.js";
export { applyRestore, exportBackup, validateRestorePayload, BACKUP_APP, BACKUP_TABLES } from "./backup.js";
export type { BackupTable, RestoreResult, RestoreValidation } from "./backup.js";
export type { TelemetryPipelineOptions, TelemetryPipeline, TelemetryStats } from "./telemetry/pipeline.js";
export { createTelemetryPipeline } from "./telemetry/pipeline.js";
export type { ConsoleLogInput, ConsoleLogPage, ConsoleLogQuery, ConsoleLogRow as TelemetryConsoleLogRow, TelemetryStore, TelemetryQuery, TelemetryRow } from "./telemetry/store/interface.js";
export type { MigrationRecord, MigrationStatus } from "./migrate.js";
export type { SettingsJson, SettingsRow, ApiKeyPublic, ProviderAccountPublic, ProviderAccountRow, ProviderModelRow, AliasRow, ComboRow, ProxyRow, AccessRuleRow, ConsoleSessionRow, AccountHealthRow, ModelLockRow, RouteSnapshot, BackupPayload, IpBanRecord, FilterRuleRecord } from "./types.js";
export type { ChartBucket, UsageByRow, UsageCacheRow, UsageCacheSummary, ModelTokenTotalsRow, ProviderTodayRow, IpSummaryRow, UsageSummary, ConsoleLogRow, ConsoleLogFilters, RuntimePersistence } from "./persistence-contracts.js";
export type { CliMappingRepositoryShape } from "./repositories/cli-tools.js";

import { getPool } from "./pool.js";
import { createSettingsRepository } from "./repositories/settings.js";
import { createApiKeyRepository } from "./repositories/api-keys.js";
import { createAccountRepository, getRouteSnapshot as getRouteSnapshotWithDb } from "./repositories/accounts.js";
import { createProxyRepository } from "./repositories/proxies.js";
import { createRoutingConfigRepository } from "./repositories/routing-config.js";
import { createCliMappingRepository } from "./repositories/cli-tools.js";
import { createConsoleSessionRepository } from "./repositories/security.js";
import { createDrizzlePG, type DrizzlePG } from "./db.js";

export { createSettingsRepository } from "./repositories/settings.js";
export { createApiKeyRepository } from "./repositories/api-keys.js";
export { createAccountRepository } from "./repositories/accounts.js";
export { createProxyRepository } from "./repositories/proxies.js";
export { createRoutingConfigRepository } from "./repositories/routing-config.js";
export { createCliMappingRepository } from "./repositories/cli-tools.js";
export { createIpBanRepository, createRateLimitRepository, createConsoleSessionRepository } from "./repositories/security.js";
export { createFilterRuleRepository } from "./repositories/filter-rules.js";
export { runMigrations, getMigrationStatus } from "./migrate.js";
export { resolveEncryptionKey, encryptWithKey, decryptWithKey, encryptForTesting, decryptForTesting } from "./crypto.js";
export type { ConfigEncryptionOptions } from "./crypto.js";

function isDrizzlePG(input: ReturnType<typeof getPool> | DrizzlePG): input is DrizzlePG {
  return typeof input === "object" && input !== null && "$client" in input;
}

/**
 * Loads the route snapshot through the shared PostgreSQL schema.
 *
 * @param poolOrDb - Bun SQL PostgreSQL pool or an already-created Drizzle client
 * @returns normalized route snapshot used by diagnostics and routing ports
 */
export function getRouteSnapshot(poolOrDb: ReturnType<typeof getPool> | DrizzlePG = getPool()) {
  const db = isDrizzlePG(poolOrDb)
    ? poolOrDb
    : createDrizzlePG(poolOrDb as ReturnType<typeof getPool>);
  return getRouteSnapshotWithDb(db);
}

/**
 * Creates the complete persistence repository boundary for the composition root.
 *
 * @param poolOrDb - Bun SQL PostgreSQL pool or an already-created Drizzle client
 * @param options - repository options, including route-cache invalidation hooks
 * @returns repositories backed by one canonical Drizzle PostgreSQL client
 */
export function createConfigRepositories(poolOrDb: ReturnType<typeof getPool> | DrizzlePG = getPool(), options: Record<string, unknown> = {}) {
  const db = isDrizzlePG(poolOrDb)
    ? poolOrDb
    : createDrizzlePG(poolOrDb as ReturnType<typeof getPool>);
  const rawMutation = options.onRouteMutation;
  const onMutation: (() => void) | undefined = typeof rawMutation === "function" ? () => { rawMutation(); } : undefined;
  const repositoryOptions = { ...options, onMutation } as import("./crypto.js").ConfigEncryptionOptions & { readonly onMutation?: () => void };
  const accounts = createAccountRepository(db, repositoryOptions);
  const routing = createRoutingConfigRepository(db, { onMutation });
  const proxies = createProxyRepository(db, repositoryOptions);
  return {
    settings: createSettingsRepository(db),
    apiKeys: createApiKeyRepository(db),
    accounts,
    proxies,
    models: { list: routing.listModels },
    aliases: { list: routing.listAliases, create: routing.createAlias, remove: routing.removeAlias },
    combos: { list: routing.listCombos, create: routing.createCombo, remove: routing.removeCombo },
    cliModelMappings: createCliMappingRepository(db),
    consoleSessions: createConsoleSessionRepository(db),
    getRouteSnapshot: accounts.getRouteSnapshot,
    invalidateRouteSnapshot: accounts.invalidateRouteSnapshot,
    _encryptionKey: options.encryptionKey ?? null,
  };
}
