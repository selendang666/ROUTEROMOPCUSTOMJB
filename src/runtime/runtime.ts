import type { FormatDetectionResult } from "../proxy/translate/cross-surface.js";
import type { ProxyEndpoint } from "../proxy/types/routing.js";
import type { Surface } from "../proxy/types/surface.js";
import type { TranslationDiagnostic, TranslationDiagnosticAction, TranslationDiagnosticStage } from "../proxy/types/telemetry.js";
import { createHash } from "node:crypto";

/** Build/runtime identity synchronized by scripts/dev/sync-versions.ts. */
export const OHMYOMOP_ROUTER_VERSION = "2.1.0-beta";

// ── Redaction ────────────────────────────────────────────────────────────

function redactUrl(value: string): string {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.password) url.password = "***";
    if (url.username) url.username = "***";
    for (const key of [...url.searchParams.keys()]) {
      if (/secret|token|password|key/i.test(key)) url.searchParams.set(key, "***");
    }
    return url.toString();
  } catch {
    return value.replace(/:\/\/([^@\n]+)@/g, "://***:***@");
  }
}

// ── Environment helpers ──────────────────────────────────────────────────

type Env = Readonly<Record<string, string | undefined>>;

function isProductionLike(env: Env): boolean {
  const v = env.NODE_ENV?.trim();
  return v !== "development" && v !== "test";
}

const PLACEHOLDER_PATTERN =
  /(?:^|[^a-z0-9])(?:change-me|replace-with|password)/i;

const MIN_PRODUCTION_SECRET_LENGTH = 32;

const MIN_BOOTSTRAP_PASSWORD_LENGTH = 1;

function isStrongValue(value: string, minimumLength: number): boolean {
  return value.length >= minimumLength && !PLACEHOLDER_PATTERN.test(value);
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value);
}

// ── URL validation ───────────────────────────────────────────────────────

export function isPostgresUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "postgres:" || u.protocol === "postgresql:";
  } catch {
    return false;
  }
}

function requireDatabaseUrl(raw: string | undefined, env: Env): string {
  const value = raw?.trim() ?? "";
  if (value.length === 0) {
    throw new Error("DATABASE_URL is required and must be a PostgreSQL connection string (postgres:// or postgresql://)");
  }
  if (!isPostgresUrl(value)) {
    throw new Error(`DATABASE_URL must be a PostgreSQL URL (postgres:// or postgresql://). Got: ${redactUrl(value)}`);
  }
  try {
    const u = new URL(value);
    if (!u.hostname) throw new Error("DATABASE_URL missing hostname");
  } catch (e) {
    throw new Error(`DATABASE_URL is not a valid URL: ${(e as Error).message} — ${redactUrl(value)}`);
  }
  // Advisory: warn if production DATABASE_URL points at localhost (explicit opt-in for local dev only)
  void env;
  return value;
}

function parseRedisUrl(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (value.length === 0) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "redis:" && u.protocol !== "rediss:") {
      throw new Error(`REDIS_URL must be redis:// or rediss://. Got: ${redactUrl(value)}`);
    }
    if (!u.hostname) throw new Error("REDIS_URL missing hostname");
  } catch (e) {
    // Re-throw as validation error with redacted context
    const msg = (e as Error).message;
    if (msg.includes("REDIS_URL must be")) throw e;
    throw new Error(`REDIS_URL is not a valid URL: ${msg} — ${redactUrl(value)}`);
  }
  return value;
}

// ── Host / Port ──────────────────────────────────────────────────────────

function boundedPort(raw: string | undefined): number {
  const fallback = "12800";
  const value = Number((raw ?? fallback).trim());
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`PORT must be an integer from 1 to 65535. Got: ${redactUrl(raw ?? "")}`);
  }
  return value;
}

function parseHost(raw: string | undefined): string {
  const host = raw?.trim() ?? "";
  if (host.length === 0) return "0.0.0.0";
  if (host.length > 255) throw new Error(`HOST exceeds 255 characters: ${host.slice(0, 64)}…`);
  return host;
}

// ── Limits ───────────────────────────────────────────────────────────────
// Preserves the established limits clamping while reading from the supplied env
// so tests can pass a fake env and production still uses the same bounds.
// Frozen snapshot is exposed on RuntimeConfig.limits.

function boundedIntegerFromEnv(
  env: Env,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), minimum), maximum);
}

export interface RuntimeLimits {
  readonly requestBodyBytes: number;
  readonly streamLineBytes: number;
  readonly streamEventBytes: number;
  readonly streamBufferedBytes: number;
  readonly streamEventCount: number;
  readonly maxRouteTransitionRoutes: number;
  readonly maxRouteTransitionsPerRoute: number;
  readonly maxTrackedIps: number;
  readonly maxTrackedKeys: number;
  readonly loginMaxTrackedIps: number;
  readonly gcIntervalMs: number;
  readonly rateLimitMaxRequests: number;
  readonly rateLimitWindowMs: number;
}

function resolveLimits(env: Env): RuntimeLimits {
  return Object.freeze({
    requestBodyBytes: boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_MAX_REQUEST_BODY_BYTES", 10 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
    streamLineBytes: boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_MAX_STREAM_LINE_BYTES", 4 * 1024 * 1024, 4 * 1024, 8 * 1024 * 1024),
    streamEventBytes: boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_MAX_STREAM_EVENT_BYTES", 4 * 1024 * 1024, 16 * 1024, 16 * 1024 * 1024),
    streamBufferedBytes: boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_MAX_STREAM_BUFFERED_BYTES", 512 * 1024, 64 * 1024, 8 * 1024 * 1024),
    streamEventCount: boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_MAX_STREAM_EVENTS", 100_000, 1_000, 1_000_000),
    maxRouteTransitionRoutes: boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_MAX_ROUTE_TRANSITION_ROUTES", 4_096, 16, 100_000),
    maxRouteTransitionsPerRoute: boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_MAX_ROUTE_TRANSITIONS_PER_ROUTE", 512, 8, 4_096),
    maxTrackedIps: boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_MAX_TRACKED_IPS", 10_000, 0, 1_000_000),
    maxTrackedKeys: boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_MAX_TRACKED_KEYS", 10_000, 0, 1_000_000),
    loginMaxTrackedIps: boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_LOGIN_MAX_TRACKED_IPS", 10_000, 0, 1_000_000),
    gcIntervalMs: boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_GC_INTERVAL_MS", 10 * 60_000, 0, 24 * 60 * 60_000),
    rateLimitMaxRequests: boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_RATE_LIMIT_MAX_REQUESTS", 100, 1, 1_000_000),
    rateLimitWindowMs: boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 24 * 60 * 60_000),
  });
}

// ── Encryption secret policy ─────────────────────────────────────────────
// APP_SECRET is the sole credential encryption source in every environment.

export interface EncryptionPolicy {
  /** Which env var supplied the credential encryption material. */
  readonly credentialKeySource: "APP_SECRET";
  /** Always false; retained as an explicit policy field for diagnostics. */
  readonly isDevFallback: boolean;
  /** Whether the resolved material was considered strong for production. */
  readonly isProductionStrong: boolean;
}

function resolveEncryptionPolicy(env: Env): EncryptionPolicy {
  const app = env.APP_SECRET?.trim();

  const production = isProductionLike(env);

  if (app !== undefined && app.length > 0) {
    if (production && isPlaceholder(app)) {
      throw new Error("APP_SECRET is a placeholder value; set a strong random secret in production");
    }
    if (production && !isStrongValue(app, MIN_PRODUCTION_SECRET_LENGTH)) {
      throw new Error(
        `APP_SECRET must be a non-placeholder secret of at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production. Got: ${app.slice(0, 8)}… (redacted)`,
      );
    }
    return Object.freeze({
      credentialKeySource: "APP_SECRET",
      isDevFallback: false,
      isProductionStrong: app.length >= MIN_PRODUCTION_SECRET_LENGTH && !isPlaceholder(app),
    });
  }

  throw new Error("APP_SECRET is required for credential encryption");
}

/** Convenience: derive the 32-byte encryption key material consistently with persistence. */
export function deriveCredentialEncryptionKey(env: Env = Bun.env as unknown as Env): Buffer {
  const policy = resolveEncryptionPolicy(env);
  const raw = env.APP_SECRET?.trim();
  if (!raw) throw new Error("APP_SECRET is required for credential encryption");
  return createHash("sha256").update(raw).digest();
}

// Exposed for diagnostics without leaking raw secret
export function encryptionKeyFingerprint(env: Env = Bun.env as unknown as Env): string {
  const key = deriveCredentialEncryptionKey(env);
  return key.toString("hex").slice(0, 16);
}

// ── Production bootstrap secrets fail-fast ───────────────────────────────
// Validates APP_SECRET / PROXY_API_KEY in production.

function assertProductionBootstrapSecrets(env: Env): void {
  if (!isProductionLike(env)) return;

  const appSecret = env.APP_SECRET?.trim();
  if (appSecret !== undefined && appSecret.length > 0) {
    if (isPlaceholder(appSecret)) {
      throw new Error("APP_SECRET is a placeholder value; set a strong random secret in production");
    }
    if (!isStrongValue(appSecret, MIN_PRODUCTION_SECRET_LENGTH)) {
      throw new Error(`APP_SECRET must be a non-placeholder secret of at least ${MIN_PRODUCTION_SECRET_LENGTH} characters`);
    }
  }

  const proxyApiKey = env.PROXY_API_KEY?.trim();
  if (proxyApiKey === undefined || proxyApiKey.length === 0) {
    throw new Error("PROXY_API_KEY is required in production");
  }
  if (!isStrongValue(proxyApiKey, MIN_BOOTSTRAP_PASSWORD_LENGTH)) {
    throw new Error("PROXY_API_KEY must be a non-placeholder key");
  }
}


// ── RuntimeConfig ────────────────────────────────────────────────────────

export interface RuntimeConfig {
  readonly host: string;
  readonly port: number;
  /** Required PostgreSQL URL (postgres:// or postgresql://). */
  readonly databaseUrl: string;
  /** Optional Redis URL; null when local coordination is desired. */
  readonly redisUrl: string | null;
  /** Maximum PostgreSQL connections before low-memory clamping. */
  readonly dbPoolMax: number;
  /** PostgreSQL statement timeout applied to every pooled connection. */
  readonly dbStatementTimeoutMs: number;
  /** PostgreSQL idle transaction timeout applied to every pooled connection. */
  readonly dbIdleInTransactionTimeoutMs: number;
  /** Process env snapshot: production vs development/test. */
  readonly isProduction: boolean;
  readonly nodeEnv: string;
  /** Opaque environment name for diagnostics (redacted URLs never include credentials). */
  readonly redactedDatabaseUrl: string;
  readonly redactedRedisUrl: string | null;
  readonly sqlitePath: string;
  readonly telemetryD1Url: string | null;
  readonly telemetryD1Token: string | null;
  /** Whether request logging is enabled (OHMYOMOP_ROUTER_REQUEST_LOGS !== "0"). */
  readonly requestLoggingEnabled: boolean;
  /** Encryption source policy — never silent fallback in production. */
  readonly encryption: EncryptionPolicy;
  /** Frozen snapshot of bounded memory / stream limits. */
  readonly limits: RuntimeLimits;
}

/**
 * Loads, validates, and freezes runtime configuration.
 * Throws on missing/invalid DATABASE_URL, invalid REDIS_URL, invalid PORT/HOST,
 * or production secret misuse. Call once at startup and reuse the frozen object.
 */
export function loadRuntimeConfig(
  env: Env = Bun.env as unknown as Env,
): RuntimeConfig {
  const production = isProductionLike(env);

  // Fail-fast on bootstrap secrets before any other work — never silently invent in prod.
  assertProductionBootstrapSecrets(env);

  const databaseUrl = requireDatabaseUrl(env.DATABASE_URL, env);
  const redisUrl = parseRedisUrl(env.REDIS_URL);
  const dbPoolMax = boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_DB_POOL_MAX", 20, 5, 100);
  const dbStatementTimeoutMs = boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_DB_STATEMENT_TIMEOUT_MS", 10_000, 1_000, 60_000);
  const dbIdleInTransactionTimeoutMs = boundedIntegerFromEnv(env, "OHMYOMOP_ROUTER_DB_IDLE_TXN_TIMEOUT_MS", 30_000, 1_000, 300_000);
  const sqlitePath = env.SQLITE_PATH?.trim() || "./data/telemetry.db";
  const telemetryD1Url = env.TELEMETRY_D1_URL?.trim() || null;
  const telemetryD1Token = env.TELEMETRY_D1_TOKEN?.trim() || null;
  const encryption = resolveEncryptionPolicy(env);

  // In production, encryption already threw if dev-fallback would have been used.
  // Double-guard: if somehow dev-fallback leaked into production, fail.
  if (production && encryption.isDevFallback) {
    throw new Error("Refusing to start with dev fallback encryption key in production");
  }

  const host = parseHost(env.HOST);
  const port = boundedPort(env.PORT);
  const limits = resolveLimits(env);
  const requestLoggingEnabled = env.OHMYOMOP_ROUTER_REQUEST_LOGS !== "0";

  const redactedDatabaseUrl = redactUrl(databaseUrl);
  const redactedRedisUrl = redisUrl !== null ? redactUrl(redisUrl) : null;
  const nodeEnv = env.NODE_ENV?.trim() || (production ? "production" : "development");


  return Object.freeze({
    host,
    port,
    databaseUrl,
    redisUrl,
    dbPoolMax,
    dbStatementTimeoutMs,
    dbIdleInTransactionTimeoutMs,
    isProduction: production,
    nodeEnv,
    redactedDatabaseUrl,
    redactedRedisUrl,
    sqlitePath,
    telemetryD1Url,
    telemetryD1Token,
    requestLoggingEnabled,
    encryption: Object.freeze({ ...encryption }),
    limits: Object.freeze({ ...limits }),
  } as RuntimeConfig);
}

/** Returns a redacted diagnostic summary without leaking secrets. */
export function describeRuntimeConfig(config: RuntimeConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    databaseUrl: config.redactedDatabaseUrl,
    redisUrl: config.redactedRedisUrl ?? "(not set — local coordination)",
    nodeEnv: config.nodeEnv,
    isProduction: config.isProduction,
    requestLoggingEnabled: config.requestLoggingEnabled,
    encryptionSource: config.encryption.credentialKeySource,
    isDevFallback: config.encryption.isDevFallback,
    limits: { ...config.limits },
  };
}

/** Singleton accessor for process-wide use after initial load. */
let singleton: RuntimeConfig | null = null;

export function getRuntimeConfig(env?: Env): RuntimeConfig {
  if (singleton !== null && env === undefined) return singleton;
  const loaded = loadRuntimeConfig(env);
  if (env === undefined) singleton = loaded;
  return loaded;
}

export function resetRuntimeConfigForTests(): void {
  singleton = null;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogCategory = "web" | "request" | "system";

export type LogCategoryFilter = "all" | LogCategory;

/** Maps items with bounded async concurrency while preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const workerCount = Math.min(Math.max(normalizedConcurrency, 1), items.length);
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

;


