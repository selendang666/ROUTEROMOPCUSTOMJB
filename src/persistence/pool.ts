// Pool management for PostgreSQL connection
// Extracted from store.ts - verbatim copy

import { SQL } from "bun";

export interface PostgresPoolOptions {
  readonly url?: string;
  /** Alias for server-injected RuntimeConfig.databaseUrl */
  readonly databaseUrl?: string;
  readonly maxConnections?: number;
  readonly idleTimeoutSeconds?: number;
  readonly maxLifetimeSeconds?: number;
  readonly connectionTimeoutSeconds?: number;
  readonly statementTimeoutMs?: number;
  readonly idleInTransactionSessionTimeoutMs?: number;
}

/** Minimal runtime database configuration accepted by persistence. */
export interface RuntimeDatabaseConfig {
  readonly databaseUrl: string;
}

export interface PoolHealth {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

let pool: InstanceType<typeof SQL> | null = null;

let poolUrl: string | null = null;

let closed = false;

function requireDatabaseUrl(url?: string): string {
  // Prefer explicit injection (RuntimeConfig.databaseUrl -> options.url/databaseUrl).
  // Read Bun.env.DATABASE_URL for direct CLI callers; the server injects it.
  const raw = (url ?? Bun.env.DATABASE_URL ?? "").trim();
  if (!raw) throw new Error("DATABASE_URL is required (PostgreSQL) — provide RuntimeConfig.databaseUrl");
  if (!raw.startsWith("postgres://") && !raw.startsWith("postgresql://")) {
    throw new Error("DATABASE_URL must be a PostgreSQL URL (postgres:// or postgresql://)");
  }
  return raw;
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "[redacted]";
  }
}

export function getPostgresUrl(): string {
  // Prefer the active pool URL; fallback only for diagnostics when no pool yet.
  if (poolUrl) return poolUrl;
  return requireDatabaseUrl(undefined);
}

/** Create a pool from explicit runtime database configuration. */
export function createPostgresPoolFromConfig(
  config: RuntimeDatabaseConfig & Omit<PostgresPoolOptions, "url" | "databaseUrl">,
): InstanceType<typeof SQL> {
  return createPostgresPool({ url: config.databaseUrl, ...config });
}

export function createPostgresPool(options: PostgresPoolOptions = {}): InstanceType<typeof SQL> {
  const url = requireDatabaseUrl(options.url ?? options.databaseUrl);
  if (pool !== null && poolUrl === url && !closed) return pool;
  // Close previous pool if URL changed — await old pool close to avoid leaking connections
  if (pool !== null) {
    const oldPool = pool;
    pool = null;
    poolUrl = null;
    // Await old pool close (async IIFE keeps outer function sync for backward compat)
    void (async () => {
      try {
        await oldPool.close();
      } catch {}
    })();
  }
  // Bounded pool — clamp to safe ranges to prevent unbounded resource use.
  // OHMYOMOP_ROUTER_LOW_MEM trims default max 20 -> 10 and caps upper bound at 10 to fit small instances
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(v)));
  const lowMemRaw = Bun.env.OHMYOMOP_ROUTER_LOW_MEM;
  const isLowMem = lowMemRaw === "1" || (typeof lowMemRaw === "string" && lowMemRaw.toLowerCase() === "true");
  const defaultMax = isLowMem ? 10 : (options.maxConnections ?? 20);
  const maxUpper = isLowMem ? 10 : 100;
  const max = clamp(options.maxConnections ?? defaultMax, 1, maxUpper);
  const idleTimeout = clamp(options.idleTimeoutSeconds ?? 30, 1, 300);
  const maxLifetime = clamp(options.maxLifetimeSeconds ?? 1800, 60, 7200);
  const connectionTimeout = clamp(options.connectionTimeoutSeconds ?? 5, 1, 30);

  // Bun.SQL constructor accepts url and pool tuning.
  // Use object form for explicit bounds.
  pool = new SQL({
    url,
    max,
    idleTimeout,
    maxLifetime,
    connectionTimeout,
    connection: {
      statement_timeout: String(options.statementTimeoutMs ?? 10_000),
      idle_in_transaction_session_timeout: String(
        options.idleInTransactionSessionTimeoutMs ?? 30_000,
      ),
    },
    // Fail fast on bad connection strings; TLS is negotiated by URL scheme.
  } as unknown as ConstructorParameters<typeof SQL>[0]);
  poolUrl = url;
  closed = false;
  return pool;
}

export function getPool(): InstanceType<typeof SQL> {
  if (pool !== null && !closed) return pool;
  return createPostgresPool();
}

export async function ping(poolOrUrl?: InstanceType<typeof SQL> | string): Promise<PoolHealth> {
  const target = typeof poolOrUrl === "string"
    ? createPostgresPool({ url: poolOrUrl })
    : (poolOrUrl ?? getPool());
  const start = performance.now();
  try {
    // Parameterized, no interpolation.
    await target`SELECT 1 as ok`;
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (e) {
    return { ok: false, latencyMs: Math.round(performance.now() - start), error: e instanceof Error ? e.message : String(e) };
  }
}

/** Readiness check for the API console without leaking credentials. */
export async function readiness(): Promise<{ postgres: PoolHealth; url: string }> {
  const url = poolUrl ?? "";
  const health = await ping();
  return { postgres: health, url: url ? redactUrl(url) : "[not configured]" };
}

export async function closePool(): Promise<void> {
  if (pool === null) return;
  const p = pool;
  pool = null;
  poolUrl = null;
  closed = true;
  try { await p.close(); } catch {}
}

/** For tests — reset singleton without closing external pool. */
export function resetPoolForTests(): void {
  pool = null;
  poolUrl = null;
  closed = false;
}

// Re-export SQL type for consumers that need to type a pool param.
export type PostgresPool = InstanceType<typeof SQL>;
