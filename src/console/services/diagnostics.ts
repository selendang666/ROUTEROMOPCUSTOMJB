import type { PostgresPool } from "../../persistence/pool.js";
import { ping } from "../../persistence/pool.js";
import { getMigrationStatus } from "../../persistence/migrate.js";
import { getRouteSnapshot } from "../../persistence/persistence-api.js";
import { getRoutePlanCacheStats } from "../../proxy/routing/plan.js";
import { getOverheadSnapshot, overheadPrometheus } from "../../runtime/overhead.js";
import { getSystemMetrics } from "../../runtime/system.js";
import type { TelemetryPipeline } from "../../persistence/telemetry/pipeline.js";

/**
 * Diagnostics + overview services — overview aggregates use typed telemetry operations;
 * route shapes preserved. PostgreSQL remains authority for health/migrations/routing/proxies.
 */
function resolveTelemetryDescriptor(
  telemetry: TelemetryPipeline,
): { kind: "sqlite" | "d1"; sqlitePath?: string; d1Url?: string } {
  try {
    if (telemetry && typeof telemetry === "object" && "describeStore" in telemetry) {
      const maybe = telemetry.describeStore;
      if (typeof maybe === "function") {
        const d = maybe.call(telemetry);
        if (d && typeof d === "object" && "kind" in d && (d.kind === "sqlite" || d.kind === "d1")) return d;
      }
    }
  } catch {}
  return { kind: "sqlite", sqlitePath: "./data/telemetry.db" };
}

export function createDiagnosticsService(
  pool: PostgresPool,
  telemetry: TelemetryPipeline,
  coordination: { readonly mode: "redis" | "local"; readonly degraded: () => boolean },
): {
  diagnostics: { health(): Promise<unknown>; readiness(): Promise<unknown>; overhead(): Promise<unknown>; metrics(): string; systemMetrics(): unknown };
  overview: { get(): Promise<unknown> };
  overheadPrometheus: typeof overheadPrometheus;
  getOverheadSnapshot: typeof getOverheadSnapshot;
} {
  let overviewCache: { value: unknown; expiresAt: number } | null = null;
  let overviewPending: Promise<unknown> | null = null;

  const diagnostics = {
    async health() {
      const h = await ping(pool);
      const telemetryDesc = resolveTelemetryDescriptor(telemetry);
      return {
        status: h.ok ? "healthy" : "degraded",
        postgres: h,
        telemetry: telemetryDesc,
        coordination: { mode: coordination.mode, degraded: coordination.degraded() },
      };
    },
    async readiness() {
      const status = await getMigrationStatus(pool);
      if (!status.ok) return { ok: false, reason: status.error ?? "migration_not_ready" };
      const h = await ping(pool);
      if (!h.ok) return { ok: false, reason: h.error ?? "postgres_unavailable" };
      return { ok: true };
    },
    async overhead() {
      return { overhead: getOverheadSnapshot(), routePlanCache: getRoutePlanCacheStats(), telemetry: telemetry.stats() };
    },
    metrics() {
      return overheadPrometheus();
    },
    systemMetrics() {
      return getSystemMetrics();
    },
  };

  const overview = {
    async get() {
      const now = Date.now();
      if (overviewCache !== null && overviewCache.expiresAt > now) {
        return overviewCache.value;
      }
      if (overviewPending !== null) {
        return await overviewPending;
      }
      const pending = (async () => {
        const [health, models, usageAgg, providersAgg, registeredAgg, degraded] = await Promise.all([
          (async () => {
            const h = await ping(pool);
            return { status: h.ok ? "healthy" : "degraded", postgres: h };
          })(),
          (async () => {
            try {
              return await getRouteSnapshot(pool);
            } catch {
              return { models: [], aliases: [], combos: [] };
            }
          })(),
          (async () => {
            const totals = await telemetry.getOverviewTotals();
            return totals;
          })(),
          (async () => {
            const rows = await telemetry.getProviderAggregates();
            return rows;
          })(),
          (async () => {
            try {
              const rows = (await pool`SELECT DISTINCT provider FROM provider_accounts WHERE provider IS NOT NULL`) as unknown as Array<{ provider: string }>;
              return rows.map((r) => r.provider);
            } catch {
              return [];
            }
          })(),
          (async () => {
            try {
              return (await pool`
                SELECT p.id AS proxy_id, p.name, p.host, p.port, h.status, h.retry_at
                FROM proxy_health h JOIN proxies p ON p.id = h.proxy_id
                WHERE h.status = 'cooling_down' AND h.retry_at > now()
                ORDER BY h.retry_at DESC LIMIT 20
              `) as unknown as unknown[];
            } catch {
              return [];
            }
          })(),
        ]);
        const healthMap = health as Record<string, unknown>;
        return {
          status: healthMap.status ?? "ok",
          health,
          models: (models as Record<string, unknown>).models ?? models,
          totals: usageAgg,
          providers: providersAgg,
          registered: registeredAgg,
          degradedProxies: degraded,
          proxyAuthMode: "unknown",
        };
      })();
      overviewPending = pending;
      try {
        const snapshot = await pending;
        overviewCache = { value: snapshot, expiresAt: Date.now() + 2000 };
        return snapshot;
      } finally {
        if (overviewPending === pending) overviewPending = null;
      }
    },
  };

  return { diagnostics, overview, overheadPrometheus, getOverheadSnapshot };
}
