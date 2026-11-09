import { createPostgresPool, ping, closePool } from "../persistence/pool.js";
import { runMigrations, getMigrationStatus } from "../persistence/migrate.js";
import { createCoordination } from "../persistence/coordination.js";
import { createTelemetryPipeline } from "../persistence/telemetry/pipeline.js";
import { createConfigRepositories } from "../persistence/persistence-api.js";
import { createIpBanRepository, createRateLimitRepository } from "../persistence/repositories/security.js";
import { createDrizzlePG } from "../persistence/db.js";
import { createCliToolsPort } from "../console/cli-tools/tooling-api.js";
import type { RuntimeConfig } from "../runtime/runtime.js";
import { createQuotaRuntime } from "./quota.js";
import { createPublicPorts } from "./public-ports.js";
import { createConsoleServices } from "./console-wiring.js";
import { migrateLegacyApiKeySecrets } from "../console/services/api-keys.js";
import { clientIpForBan } from "../api/guard.js";
import type { PersistencePorts } from "./application.js";
import { createDefaultRegistry } from "../providers/default-registry.js";
import { initPrivacySnapshot } from "../runtime/privacy.js";
import { initPersonaSnapshot, startPersonaSnapshotRefresh } from "../persona/snapshot.js";

// ── Real PostgreSQL-backed persistence factory ───────────────────────────────


export async function createPostgresPersistence(config: RuntimeConfig): Promise<PersistencePorts> {
  // Single Bun.SQL authority — validates postgres:// scheme.
  const pool = createPostgresPool({
    url: config.databaseUrl,
    maxConnections: config.dbPoolMax,
    statementTimeoutMs: config.dbStatementTimeoutMs,
    idleInTransactionSessionTimeoutMs: config.dbIdleInTransactionTimeoutMs,
  });

  // P0: Parallelize persistence — ping+migrations, telemetry (async mkdir), and coordination (redis)
  // run concurrently via Promise.all to avoid sequential startup blocking. Telemetry dir
  // creation is async (fs/promises mkdir) and starts in background while postgres migrates.
  const telemetryPromise = createTelemetryPipeline({
    sqlitePath: config.sqlitePath,
    d1Url: config.telemetryD1Url ?? undefined,
    d1Token: config.telemetryD1Token ?? undefined,
    redisUrl: config.redisUrl,
  });
  const coordinationPromise = createCoordination({ redisUrl: config.redisUrl });
  const migrationsPromise = (async () => {
    const health = await ping(pool);
    if (!health.ok) throw new Error(`postgres not ready: ${health.error ?? "ping failed"}`);
    await runMigrations(pool);
    await migrateLegacyApiKeySecrets(pool);
  })();

  const [, telemetry, coordination, registry] = await Promise.all([
    migrationsPromise,
    telemetryPromise,
    coordinationPromise,
    createDefaultRegistry(),
  ]);

  const quotaRuntime = createQuotaRuntime(pool);
  const publicPorts = createPublicPorts(pool, registry, telemetry);
  const apiKeys = publicPorts.apiKeys;
  const models = publicPorts.models;

  const db = createDrizzlePG(pool);
  const ipBanRepo = createIpBanRepository(db);
  ipBanRepo.prune().catch(() => undefined);
  const rateLimitRepo = createRateLimitRepository(db);
  rateLimitRepo.pruneStale(5 * 60 * 1000).catch(() => undefined);
  let repositories: ReturnType<typeof createConfigRepositories>;
  const onRouteMutation = (): void => {
    repositories.invalidateRouteSnapshot();
    publicPorts.invalidateModelCache();
    void coordination.publishRevision("ohmyomop-router:routes", Date.now()).catch(() => {});
  };
  repositories = createConfigRepositories(db, { onRouteMutation });
  await initPrivacySnapshot(pool);
  await initPersonaSnapshot(pool);
  const stopPersonaRefresh = startPersonaSnapshotRefresh(pool);
  const consoleServices = createConsoleServices({
    pool,
    telemetry,
    coordination: { mode: coordination.mode, degraded: coordination.degraded },
    quota: quotaRuntime,
    consoleApiKeys: publicPorts.consoleApiKeys,
    cliTools: createCliToolsPort(repositories.cliModelMappings),
    ipBan: ipBanRepo,
    rateLimit: rateLimitRepo,
    clientIpForBan,
    onRouteMutation,
    getAccountCredential: repositories.accounts.getCredential,
    registry,
  });

  const readiness = async (): Promise<{ ok: boolean; reason?: string }> => {
    const status = await getMigrationStatus(pool);
    if (!status.ok) return { ok: false, reason: status.error ?? "migration_pending" };
    const h = await ping(pool);
    if (!h.ok) return { ok: false, reason: h.error ?? "postgres_unavailable" };
    return { ok: true };
  };

  const close = async (): Promise<void> => {
    stopPersonaRefresh();
    quotaRuntime.tokenRefreshPool.stop();
    quotaRuntime.worker.stop();
    try { await telemetry.shutdown(); } catch {}
    try { await coordination.close(); } catch {}
    try { await closePool(); } catch {}
  };

  // Adapter: coordination kind reflects real Redis vs local fallback
  const coordinationPort: PersistencePorts["coordination"] = {
    get kind() { return coordination.mode as "redis" | "local"; },
    degraded: () => coordination.degraded(),
    close: () => coordination.close(),
  };

  return {
    pool,
    telemetry,
    close,
    readiness,
    apiKeys,
    models,
    ipBan: ipBanRepo,
    rateLimit: rateLimitRepo,
    console: consoleServices,
    coordination: coordinationPort,
    routeRepositories: { ...repositories, leaseCredential: quotaRuntime.leaseCredential },
    registry,
  };
}

