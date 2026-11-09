/**
 * Sole owner of credential eligibility, health status, cooldowns,
 * quota state, model locks, and account recovery state.
 * No HTTP, no provider payloads, no SQL — uses injected ports.
 * Batch reads via persistence/config.ts getRouteSnapshot (no N+1).
 */

import type { ApplicationErrorKind } from "../types/error-types.js";
import type { CooldownKind, CredentialKind, ProviderFailureCode, RouteStatus } from "../types/surface.js";
import type { RouteTarget } from "../types/routing.js";
import type { AccountCandidate as CanonicalAccountCandidate, RouteHealth as CanonicalRouteHealth, ModelLockRecord as CanonicalModelLockRecord } from "../types/routing.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Injected persistence ports (no SQL leak) — simple batch-aware
// ---------------------------------------------------------------------------

export interface SimpleAccountHealthRecord {
  readonly status: RouteStatus;
  readonly cooldownUntil: string | null;
  readonly consecutiveFailures: number;
  readonly updatedAt: string;
}

export interface AccountQuotaRecord {
  readonly remainingTokens: number | null;
  readonly resetAt: string | null;
  readonly exceeded: boolean;
}

export interface SimpleModelLockRecord {
  readonly lockedUntil: string | null;
  readonly reason: string | null;
}

// Canonical re-exports for callers that expect canonical domain types from the account module.
export type { CanonicalAccountCandidate as AccountCandidateCanonical, CanonicalRouteHealth as RouteHealthCanonical, CanonicalModelLockRecord as ModelLockRecordCanonical };

export interface AccountEligibilityPorts {
  getHealth(accountId: string): Promise<SimpleAccountHealthRecord | null>;
  getQuota(accountId: string): Promise<AccountQuotaRecord | null>;
  getModelLock(accountId: string, modelId: string): Promise<SimpleModelLockRecord | null>;
  setHealth(accountId: string, patch: Partial<SimpleAccountHealthRecord>): Promise<void>;
  setModelLock(accountId: string, modelId: string, lock: SimpleModelLockRecord): Promise<void>;
}

export interface AccountRow {
  readonly accountId: string;
  readonly providerId: string;
  readonly credentialKind: CredentialKind;
  readonly active: boolean;
}

// ---------------------------------------------------------------------------
// Rich credential health persistence ports — moved from router accounts
// ---------------------------------------------------------------------------

export interface AccountHealthRecord {
  readonly accountId: string;
  readonly providerId: string;
  readonly status: RouteStatus;
  readonly statusCode: number | null;
  readonly failureKind: ApplicationErrorKind | null;
  readonly safeMessage: string | null;
  readonly occurredAt: string | null;
  readonly retryAt: string | null;
  readonly disabledUntilMs: number | null;
  readonly failureCount: number;
  readonly generation: number;
}

export interface AccountHealthStore {
  get(accountId: string): Promise<AccountHealthRecord | undefined>;
  set(record: AccountHealthRecord): Promise<void>;
  list(): Promise<readonly AccountHealthRecord[]>;
  listForAccountIds(accountIds: readonly string[]): Promise<readonly AccountHealthRecord[]>;
}

export class MemoryAccountHealthStore implements AccountHealthStore {
  private readonly records = new Map<string, AccountHealthRecord>();
  async get(accountId: string): Promise<AccountHealthRecord | undefined> { return this.records.get(accountId); }
  async set(record: AccountHealthRecord): Promise<void> { this.records.set(record.accountId, record); }
  async list(): Promise<readonly AccountHealthRecord[]> { return [...this.records.values()]; }
  async listForAccountIds(accountIds: readonly string[]): Promise<readonly AccountHealthRecord[]> {
    if (accountIds.length === 0) return [];
    const idSet = new Set(accountIds);
    return [...this.records.values()].filter((r) => idSet.has(r.accountId));
  }
}

export interface ModelLockRecord {
  readonly accountId: string;
  readonly modelId: string;
  readonly retryAt: string;
  readonly errorKind: ApplicationErrorKind | null;
  readonly statusCode: number | null;
  readonly safeMessage: string | null;
  readonly failureCount: number;
}

export interface ModelLockStore {
  get(accountId: string, modelId: string): Promise<ModelLockRecord | undefined>;
  set(record: ModelLockRecord): Promise<void>;
  delete(accountId: string, modelId: string): Promise<void>;
  listForAccount(accountId: string): Promise<readonly ModelLockRecord[]>;
  listExpired(nowMs: number): Promise<readonly ModelLockRecord[]>;
  listForAccountIds(accountIds: readonly string[]): Promise<readonly ModelLockRecord[]>;
}

export class MemoryModelLockStore implements ModelLockStore {
  private readonly records = new Map<string, ModelLockRecord>();
  async get(accountId: string, modelId: string): Promise<ModelLockRecord | undefined> { return this.records.get(`${accountId}:${modelId}`); }
  async set(record: ModelLockRecord): Promise<void> { this.records.set(`${record.accountId}:${record.modelId}`, record); }
  async delete(accountId: string, modelId: string): Promise<void> { this.records.delete(`${accountId}:${modelId}`); }
  async listForAccount(accountId: string): Promise<readonly ModelLockRecord[]> { return [...this.records.values()].filter((r) => r.accountId === accountId); }
  async listExpired(nowMs: number): Promise<readonly ModelLockRecord[]> { return [...this.records.values()].filter((r) => Date.parse(r.retryAt) <= nowMs); }
  async listForAccountIds(accountIds: readonly string[]): Promise<readonly ModelLockRecord[]> {
    if (accountIds.length === 0) return [];
    const s = new Set(accountIds);
    return [...this.records.values()].filter((r) => s.has(r.accountId));
  }
}

// Quota state — full shape matching router accounts
export interface QuotaWindowState {
  readonly kind: string;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetsAt: string | null;
  readonly used?: number | null;
  readonly limit?: number | null;
}
export interface QuotaSnapshotState {
  readonly source: string;
  readonly status: "unknown" | "refreshing" | "ready" | "error";
  readonly plan: string | null;
  readonly windows: readonly QuotaWindowState[];
  readonly fetchedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly error: string | null;
}
export interface QuotaStateRecord {
  readonly accountId: string;
  readonly quotaAvailable: boolean;
  readonly lastQuotaRefreshAtMs: number | null;
  readonly lastQuotaAttemptAtMs?: number | null;
  readonly lastQuotaSuccessAtMs?: number | null;
  readonly quota?: QuotaSnapshotState | null;
}
export interface QuotaStateStore {
  get(accountId: string): Promise<QuotaStateRecord | undefined>;
  set(record: QuotaStateRecord): Promise<void>;
  list(): Promise<readonly QuotaStateRecord[]>;
  listForAccountIds(accountIds: readonly string[]): Promise<readonly QuotaStateRecord[]>;
}
export class MemoryQuotaStateStore implements QuotaStateStore {
  private readonly records = new Map<string, QuotaStateRecord>();
  async get(accountId: string): Promise<QuotaStateRecord | undefined> { return this.records.get(accountId); }
  async set(record: QuotaStateRecord): Promise<void> { this.records.set(record.accountId, record); }
  async list(): Promise<readonly QuotaStateRecord[]> { return [...this.records.values()]; }
  async listForAccountIds(accountIds: readonly string[]): Promise<readonly QuotaStateRecord[]> {
    if (accountIds.length === 0) return [];
    const idSet = new Set(accountIds);
    return [...this.records.values()].filter((r) => idSet.has(r.accountId));
  }
}

// OAuth token records — no HTTP here, full shape
export interface OAuthTokenRecord {
  readonly accessToken: string;
  readonly expiresAtMs: number | null;
  readonly refreshToken: string | null;
  readonly kind: "oauth";
  /** Cloud Code Assist project id for Antigravity (preserved across refreshes). */
  readonly providerAccountId?: string | null;
  readonly generation?: number;
  readonly lastRefreshAtMs?: number | null;
  readonly lastRefreshAttemptAtMs?: number | null;
  readonly lastRefreshErrorKind?: ApplicationErrorKind | null;
  readonly lastRefreshStatusCode?: number | null;
  readonly refreshState?: "healthy" | "retrying" | "reauth_required";
  readonly refreshRetryAtMs?: number | null;
  readonly refreshFailureCount?: number;
}
export function fingerprintOAuthToken(token: OAuthTokenRecord | null): string {
  const value = token?.refreshToken ?? token?.accessToken ?? "";
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash.toString(16).padStart(8, "0");
}
export interface OAuthTokenStore {
  get(accountId: string): Promise<OAuthTokenRecord | undefined>;
  set(accountId: string, token: OAuthTokenRecord): Promise<void>;
  delete(accountId: string): Promise<void>;
  tryAcquireRefreshLease?(input: { readonly accountId: string; readonly ownerId: string; readonly generation: number; readonly tokenFingerprint: string; readonly nowMs: number; readonly leaseMs: number }): Promise<boolean>;
  releaseRefreshLease?(accountId: string, ownerId: string): Promise<void>;
  compareAndSwap?(input: { readonly accountId: string; readonly expectedGeneration: number; readonly expectedTokenFingerprint: string; readonly token: OAuthTokenRecord }): Promise<boolean>;
}
export class MemoryOAuthTokenStore implements OAuthTokenStore {
  private readonly tokens = new Map<string, OAuthTokenRecord>();
  private readonly leases = new Map<string, { readonly ownerId: string; readonly generation: number; readonly tokenFingerprint: string; readonly leaseUntilMs: number }>();
  async get(accountId: string): Promise<OAuthTokenRecord | undefined> { return this.tokens.get(accountId); }
  async set(accountId: string, token: OAuthTokenRecord): Promise<void> { this.tokens.set(accountId, token); }
  async delete(accountId: string): Promise<void> { this.tokens.delete(accountId); this.leases.delete(accountId); }
  async tryAcquireRefreshLease(input: { readonly accountId: string; readonly ownerId: string; readonly generation: number; readonly tokenFingerprint: string; readonly nowMs: number; readonly leaseMs: number }): Promise<boolean> {
    const existing = this.leases.get(input.accountId);
    if (existing !== undefined && existing.leaseUntilMs > input.nowMs && existing.ownerId !== input.ownerId) return false;
    this.leases.set(input.accountId, { ownerId: input.ownerId, generation: input.generation, tokenFingerprint: input.tokenFingerprint, leaseUntilMs: input.nowMs + input.leaseMs });
    return true;
  }
  async releaseRefreshLease(accountId: string, ownerId: string): Promise<void> {
    if (this.leases.get(accountId)?.ownerId === ownerId) this.leases.delete(accountId);
  }
  async compareAndSwap(input: { readonly accountId: string; readonly expectedGeneration: number; readonly expectedTokenFingerprint: string; readonly token: OAuthTokenRecord }): Promise<boolean> {
    const current = this.tokens.get(input.accountId);
    if (current === undefined || (current.generation ?? 0) !== input.expectedGeneration || fingerprintOAuthToken(current) !== input.expectedTokenFingerprint) return false;
    this.tokens.set(input.accountId, input.token);
    return true;
  }
}

// Credential config
export interface AccountConfig {
  readonly id: string;
  readonly providerId: string;
  readonly kind: CredentialKind;
  readonly secret: string | null;
  readonly enabled: boolean;
  readonly priority: number;
}
export interface CredentialConfigStore {
  getAccount(id: string): Promise<AccountConfig | undefined>;
  listAccounts(): Promise<readonly AccountConfig[]>;
}
export interface CredentialConfigCacheOptions {
  readonly nowMs?: () => number;
  readonly ttlMs?: number;
  readonly readRevision?: () => number;
}
export function createCachedCredentialConfigStore(
  store: CredentialConfigStore,
  options: CredentialConfigCacheOptions = {},
): CredentialConfigStore {
  const nowMs = options.nowMs ?? (() => Date.now());
  const ttlMs = Math.max(0, options.ttlMs ?? 250);
  const readRevision = options.readRevision ?? (() => 0);
  let cacheRevision = readRevision();
  const accounts = new Map<string, { readonly value: AccountConfig | undefined; readonly expiresAtMs: number }>();
  let listCache: { readonly value: readonly AccountConfig[]; readonly expiresAtMs: number } | undefined;
  const invalidateIfRevisionChanged = (): void => {
    const revision = readRevision();
    if (revision === cacheRevision) return;
    cacheRevision = revision;
    accounts.clear();
    listCache = undefined;
  };
  return {
    async getAccount(id) {
      invalidateIfRevisionChanged();
      const now = nowMs();
      const cached = accounts.get(id);
      if (cached !== undefined && cached.expiresAtMs > now) return cached.value;
      const value = await store.getAccount(id);
      accounts.set(id, { value, expiresAtMs: now + ttlMs });
      return value;
    },
    async listAccounts() {
      invalidateIfRevisionChanged();
      const now = nowMs();
      if (listCache !== undefined && listCache.expiresAtMs > now) return listCache.value;
      const value = await store.listAccounts();
      listCache = { value, expiresAtMs: now + ttlMs };
      for (const account of value) accounts.set(account.id, { value: account, expiresAtMs: now + ttlMs });
      return value;
    },
  };
}

// OAuth refresher contracts — no fetch
export type OAuthRefreshResult =
  | { readonly ok: true; readonly token: OAuthTokenRecord }
  | { readonly ok: false; readonly error: import("../types/error-types.js").InternalFailure };
export interface OAuthRefresher {
  refresh(input: { readonly accountId: string; readonly token: OAuthTokenRecord | null; readonly account?: AccountConfig }): Promise<OAuthRefreshResult>;
}
export const OAUTH_SAFETY_SKEW_MS = 30_000;
export const QUOTA_SWEEP_COOLDOWN_MS = 15 * 60_000;

// Eligibility helpers — deterministic
export function isAccountEligibleCandidate(candidate: CanonicalAccountCandidate, nowMs: number, modelId?: string): boolean {
  if ((candidate as unknown as { healthy?: boolean }).healthy === false) return false;
  if ((candidate as unknown as { enabled?: boolean }).enabled === false) return false;
  if ((candidate as unknown as { quotaAvailable?: boolean | null }).quotaAvailable === false) return false;
  const health = (candidate as unknown as { health?: CanonicalRouteHealth | null }).health;
  if (health?.status === "disabled") return false;
  if (health?.status === "cooling_down" && health.retryAt !== null) {
    const retryAt = Date.parse(health.retryAt);
    if (!Number.isFinite(retryAt) || nowMs < retryAt) return false;
  }
  if (modelId !== undefined) {
    const locks = (candidate as unknown as { modelLocks?: ReadonlyMap<string, CanonicalModelLockRecord> | null }).modelLocks;
    if (locks instanceof Map) {
      const lock = locks.get(modelId);
      if (lock !== undefined && lock.retryAt !== null && Date.parse(lock.retryAt) > nowMs) return false;
    }
  }
  return true;
}

// Lightweight AccountHealthManager moved from router — uses batch ports above, no HTTP
export interface AccountHealthOptions {
  readonly nowMs?: () => number;
  readonly cacheTtlMs?: number;
}
const MAX_HEALTH_CACHE = 5000;
const MAX_MODEL_LOCKS_CACHE = 10000;

export class AccountHealthManager {
  private readonly nowMs: () => number;
  private readonly cacheTtlMs: number;
  private readonly healthCache = new Map<string, { readonly record: AccountHealthRecord | undefined; readonly expiresAtMs: number }>();
  private readonly modelLocksCache = new Map<string, { readonly records: readonly ModelLockRecord[]; readonly expiresAtMs: number }>();
  constructor(
    private readonly store: AccountHealthStore,
    options: AccountHealthOptions = {},
    private readonly modelLockStore: ModelLockStore | null = null,
  ) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 250);
  }
  private trimCaches(): void {
    if (this.healthCache.size > MAX_HEALTH_CACHE) {
      const excess = this.healthCache.size - MAX_HEALTH_CACHE;
      const keys = this.healthCache.keys();
      for (let i = 0; i < excess; i++) {
        const { value: key, done } = keys.next();
        if (done) break;
        this.healthCache.delete(key);
      }
    }
    if (this.modelLocksCache.size > MAX_MODEL_LOCKS_CACHE) {
      const excess = this.modelLocksCache.size - MAX_MODEL_LOCKS_CACHE;
      const keys = this.modelLocksCache.keys();
      for (let i = 0; i < excess; i++) {
        const { value: key, done } = keys.next();
        if (done) break;
        this.modelLocksCache.delete(key);
      }
    }
  }

  private async readHealthRecord(accountId: string, nowMs: number): Promise<AccountHealthRecord | undefined> {
    const cached = this.healthCache.get(accountId);
    if (cached !== undefined && cached.expiresAtMs > nowMs) return cached.record;
    const record = await this.store.get(accountId);
    this.healthCache.set(accountId, { record, expiresAtMs: nowMs + this.cacheTtlMs });
    this.trimCaches();
    return record;
  }
  private async readModelLocks(accountId: string, nowMs: number): Promise<readonly ModelLockRecord[]> {
    if (this.modelLockStore === null) return [];
    const cached = this.modelLocksCache.get(accountId);
    if (cached !== undefined && cached.expiresAtMs > nowMs) return cached.records;
    const records = await this.modelLockStore.listForAccount(accountId);
    this.modelLocksCache.set(accountId, { records, expiresAtMs: nowMs + this.cacheTtlMs });
    this.trimCaches();
    return records;
  }
  async recordFailure(accountId: string, providerId: string, error: import("../types/error-types.js").InternalFailure): Promise<AccountHealthRecord | null> {
    if (!error.retryable) return null;
    const now = this.nowMs();
    const previous = await this.readHealthRecord(accountId, now);
    const failureCount = Math.min(255, (previous?.failureCount ?? 0) + 1);
    // Simplified cooldown 30s transient
    const delayMs = 30_000;
    const disabledUntilMs = now + delayMs;
    const record: AccountHealthRecord = {
      accountId, providerId, status: "cooling_down", statusCode: error.statusCode ?? null, failureKind: error.kind ?? null,
      safeMessage: error.safeMessage ?? null, occurredAt: new Date(now).toISOString(), retryAt: new Date(disabledUntilMs).toISOString(),
      disabledUntilMs, failureCount, generation: (previous?.generation ?? 0) + 1,
    };
    await this.store.set(record);
    this.healthCache.set(accountId, { record, expiresAtMs: now + this.cacheTtlMs });
    this.trimCaches();
    return record;
  }
  async recordSuccess(accountId: string, providerId: string): Promise<AccountHealthRecord> {
    const now = this.nowMs();
    const previous = await this.readHealthRecord(accountId, now);
    const record: AccountHealthRecord = {
      accountId, providerId, status: "healthy", statusCode: null, failureKind: null, safeMessage: null,
      occurredAt: null, retryAt: null, disabledUntilMs: null, failureCount: 0, generation: (previous?.generation ?? 0) + 1,
    };
    await this.store.set(record);
    this.healthCache.set(accountId, { record, expiresAtMs: now + this.cacheTtlMs });
    this.trimCaches();
    return record;
  }
  async getHealth(accountId: string): Promise<CanonicalRouteHealth | null> {
    const record = await this.readHealthRecord(accountId, this.nowMs());
    if (record === undefined) return null;
    return { status: record.status, retryAt: record.retryAt, statusCode: record.statusCode } as unknown as CanonicalRouteHealth;
  }
  async isUsable(accountId: string, nowMs: number = this.nowMs()): Promise<boolean> {
    const record = await this.readHealthRecord(accountId, nowMs);
    if (record === undefined) return true;
    if (record.status === "disabled") return false;
    if (record.disabledUntilMs !== null && record.disabledUntilMs > nowMs) return false;
    if (record.retryAt !== null && Date.parse(record.retryAt) > nowMs) return false;
    return true;
  }
  async list(): Promise<readonly AccountHealthRecord[]> { return this.store.list(); }
  async clearModelLock(accountId: string, modelId: string): Promise<void> {
    if (this.modelLockStore === null) return;
    await this.modelLockStore.delete(accountId, modelId);
    const now = this.nowMs();
    const cached = this.modelLocksCache.get(accountId);
    if (cached !== undefined && cached.expiresAtMs > now) this.modelLocksCache.set(accountId, { records: cached.records.filter((r) => r.modelId !== modelId), expiresAtMs: cached.expiresAtMs });
    this.trimCaches();
  }
  async isModelAvailable(accountId: string, modelId: string, nowMs: number = this.nowMs()): Promise<boolean> {
    const lock = (await this.readModelLocks(accountId, nowMs)).find((r) => r.modelId === modelId);
    return lock === undefined || Date.parse(lock.retryAt) <= nowMs;
  }
  async recordPermanentFailure(accountId: string, providerId: string, error: import("../types/error-types.js").InternalFailure): Promise<AccountHealthRecord | null> {
    const now = this.nowMs();
    const previous = await this.readHealthRecord(accountId, now);
    const record: AccountHealthRecord = {
      accountId, providerId, status: "disabled", statusCode: error.statusCode ?? null, failureKind: error.kind ?? null,
      safeMessage: error.safeMessage ?? null, occurredAt: new Date(now).toISOString(), retryAt: null, disabledUntilMs: null,
      failureCount: Math.min(255, (previous?.failureCount ?? 0) + 1), generation: (previous?.generation ?? 0) + 1,
    };
    await this.store.set(record);
    this.healthCache.set(accountId, { record, expiresAtMs: now + this.cacheTtlMs });
    this.trimCaches();
    return record;
  }
  async recordModelLock(accountId: string, modelId: string, error: import("../types/error-types.js").InternalFailure): Promise<ModelLockRecord | null> {
    if (this.modelLockStore === null || !error.retryable) return null;
    const now = this.nowMs();
    const previous = (await this.readModelLocks(accountId, now)).find((r) => r.modelId === modelId);
    const failureCount = Math.min(255, (previous?.failureCount ?? 0) + 1);
    const delayMs = 30_000;
    const record: ModelLockRecord = {
      accountId, modelId, retryAt: new Date(now + delayMs).toISOString(), errorKind: error.kind ?? null, statusCode: error.statusCode ?? null, safeMessage: error.safeMessage ?? null, failureCount,
    };
    await this.modelLockStore.set(record);
    const current = (await this.readModelLocks(accountId, now)).filter((r) => r.modelId !== modelId);
    this.modelLocksCache.set(accountId, { records: [...current, record], expiresAtMs: now + this.cacheTtlMs });
    this.trimCaches();
    return record;
  }
  async listModelLocksForAccount(accountId: string): Promise<readonly ModelLockRecord[]> { return this.readModelLocks(accountId, this.nowMs()); }
  async getHealthBatch(accountIds: readonly string[]): Promise<Map<string, CanonicalRouteHealth>> {
    if (accountIds.length === 0) return new Map();
    const now = this.nowMs();
    const result = new Map<string, CanonicalRouteHealth>();
    const records = await Promise.all(accountIds.map(async (id) => ({ id, record: await this.readHealthRecord(id, now) })));
    for (const { id, record: rec } of records) {
      if (rec !== undefined) result.set(id, { status: rec.status, retryAt: rec.retryAt, statusCode: rec.statusCode } as unknown as CanonicalRouteHealth);
    }
    return result;
  }
  async listModelLocksForAccounts(accountIds: readonly string[]): Promise<Map<string, readonly ModelLockRecord[]>> {
    if (this.modelLockStore === null || accountIds.length === 0) return new Map();
    const map = new Map<string, readonly ModelLockRecord[]>();
    const records = await Promise.all(accountIds.map(async (id) => ({ id, records: await this.readModelLocks(id, this.nowMs()) })));
    for (const entry of records) map.set(entry.id, entry.records);
    return map;
  }
}

// ---------------------------------------------------------------------------
// Cooldown classification — permanent / transient / quota
// ---------------------------------------------------------------------------

const PERMANENT_CODES = new Set<ProviderFailureCode>([
  "auth_invalidated",
  "content_blocked",
  "tool_schema_rejected",
  "optional_parameter_rejected",
]);

const QUOTA_CODES = new Set<ProviderFailureCode>([
  "usage_limit",
  "rate_limit_transient",
]);

export function classifyCooldown(kind: ApplicationErrorKind, failureCode?: ProviderFailureCode): CooldownKind {
  if (failureCode && PERMANENT_CODES.has(failureCode)) return "permanent";
  if (failureCode && QUOTA_CODES.has(failureCode)) return "quota";
  if (kind === "quota_exceeded" || kind === "provider_rate_limited") return "quota";
  if (kind === "authentication_failed") return "permanent";
  return "transient";
}

export function cooldownDurationMs(kind: CooldownKind): number {
  if (kind === "permanent") return 24 * 60 * 60 * 1000;
  if (kind === "quota") return 60 * 1000;
  return 30 * 1000;
}

// ---------------------------------------------------------------------------
// Bounded in-memory health/cooldown cache (local fallback when Redis absent)
// ---------------------------------------------------------------------------

const MAX_TRACKED_ACCOUNTS = 5000;
const MAX_TRACKED_LOCKS = 10000;

interface HealthEntry {
  status: RouteStatus;
  cooldownUntilMs: number | null;
  consecutiveFailures: number;
}

export class AccountManager {
  private readonly health = new Map<string, HealthEntry>();
  private readonly locks = new Map<string, number | null>();

  constructor(private readonly ports: AccountEligibilityPorts | null) {}

  private evictIfNeeded(): void {
    if (this.health.size > MAX_TRACKED_ACCOUNTS) {
      const toDelete = this.health.size - MAX_TRACKED_ACCOUNTS;
      const keys = [...this.health.keys()].slice(0, toDelete);
      for (const k of keys) this.health.delete(k);
    }
    if (this.locks.size > MAX_TRACKED_LOCKS) {
      const toDelete = this.locks.size - MAX_TRACKED_LOCKS;
      const keys = [...this.locks.keys()].slice(0, toDelete);
      for (const k of keys) this.locks.delete(k);
    }
  }

  isHealthy(accountId: string, nowMs: number): boolean {
    const h = this.health.get(accountId);
    if (!h) return true;
    if (h.status === "disabled") return false;
    if (h.cooldownUntilMs !== null && h.cooldownUntilMs > nowMs) return false;
    return true;
  }

  isModelLocked(accountId: string, modelId: string, nowMs: number): boolean {
    const key = `${accountId}:${modelId}`;
    const until = this.locks.get(key);
    if (until === undefined || until === null) return false;
    return until > nowMs;
  }

  isEligible(accountId: string, target: RouteTarget, nowMs: number): boolean {
    if (!this.isHealthy(accountId, nowMs)) return false;
    if (this.isModelLocked(accountId, target.modelId, nowMs)) return false;
    return true;
  }

  async hydrate(accountId: string): Promise<void> {
    if (!this.ports) return;
    const [h, q] = await Promise.all([this.ports.getHealth(accountId), this.ports.getQuota(accountId)]);
    if (h) {
      this.health.set(accountId, {
        status: h.status,
        cooldownUntilMs: h.cooldownUntil ? Date.parse(h.cooldownUntil) : null,
        consecutiveFailures: h.consecutiveFailures,
      });
    }
    if (q?.exceeded) {
      const until = q.resetAt ? Date.parse(q.resetAt) : Date.now() + 60_000;
      const cur = this.health.get(accountId);
      this.health.set(accountId, {
        status: "cooling_down",
        cooldownUntilMs: Number.isFinite(until) ? until : Date.now() + 60_000,
        consecutiveFailures: cur?.consecutiveFailures ?? 0,
      });
    }
    this.evictIfNeeded();
  }

  async recordSuccess(accountId: string): Promise<void> {
    this.health.set(accountId, { status: "healthy", cooldownUntilMs: null, consecutiveFailures: 0 });
    if (this.ports) await this.ports.setHealth(accountId, { status: "healthy", cooldownUntil: null, consecutiveFailures: 0, updatedAt: new Date().toISOString() });
    this.evictIfNeeded();
  }

  async recordFailure(accountId: string, kind: ApplicationErrorKind, failureCode?: ProviderFailureCode, modelId?: string): Promise<void> {
    const cooldownKind = classifyCooldown(kind, failureCode);
    const duration = cooldownDurationMs(cooldownKind);
    const untilMs = Date.now() + duration;
    const status: RouteStatus = cooldownKind === "permanent" ? "error" : "cooling_down";
    if (modelId && cooldownKind !== "permanent") {
      const key = `${accountId}:${modelId}`;
      this.locks.set(key, untilMs);
      if (this.ports) await this.ports.setModelLock(accountId, modelId, { lockedUntil: new Date(untilMs).toISOString(), reason: failureCode ?? kind });
    } else {
      const prev = this.health.get(accountId);
      this.health.set(accountId, { status, cooldownUntilMs: untilMs, consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1 });
      if (this.ports) await this.ports.setHealth(accountId, { status, cooldownUntil: new Date(untilMs).toISOString(), consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1, updatedAt: new Date().toISOString() });
    }
    this.evictIfNeeded();
  }

  async clearModelLock(accountId: string, modelId: string): Promise<void> {
    this.locks.delete(`${accountId}:${modelId}`);
    if (this.ports) await this.ports.setModelLock(accountId, modelId, { lockedUntil: null, reason: null });
  }

  eligibleAccounts(rows: readonly AccountRow[], target: RouteTarget, nowMs = Date.now()): readonly AccountRow[] {
    return rows.filter((r) => r.active && r.providerId === target.providerId && this.isEligible(r.accountId, target, nowMs));
  }

  createEligibilityPredicate(nowMs = Date.now()): (accountId: string, target: RouteTarget) => boolean {
    return (accountId, target) => this.isEligible(accountId, target, nowMs);
  }
}

export function createAccountManager(ports: AccountEligibilityPorts | null = null): AccountManager {
  return new AccountManager(ports);
}

// Quota coordinator stub — batch-aware via persistence snapshot
export interface QuotaCoordinatorStore {
  getQuota(accountId: string): AccountQuotaRecord | null | Promise<AccountQuotaRecord | null>;
  setQuota?(accountId: string, quota: AccountQuotaRecord): void | Promise<void>;
  get?(accountId: string): QuotaStateRecord | undefined | Promise<QuotaStateRecord | undefined>;
  set?(record: QuotaStateRecord): void | Promise<void>;
}

export interface QuotaCoordinatorOptions {
  readonly cooldownDurationMs?: number;
  readonly fetchQuota?: (accountId: string) => Promise<AccountQuotaRecord | null>;
  readonly nowMs?: () => number;
}

export class QuotaCoordinator {
  private readonly lastRefreshAt = new Map<string, number>();

  constructor(private readonly store: QuotaCoordinatorStore | null = null, private readonly options: QuotaCoordinatorOptions = {}) {}

  async isQuotaAvailable(accountId: string): Promise<boolean> {
    const quota = await this.readQuota(accountId);
    if (quota === null) return true;
    return !quota.exceeded && (quota.remainingTokens === null || quota.remainingTokens > 0);
  }

  async refreshQuota(accountId: string): Promise<boolean> {
    const nowMs = this.options.nowMs?.() ?? Date.now();
    const cooldownMs = this.options.cooldownDurationMs ?? cooldownDurationMs("quota");
    const lastRefreshAt = this.lastRefreshAt.get(accountId) ?? null;
    if (lastRefreshAt !== null && nowMs - lastRefreshAt < cooldownMs) return this.isQuotaAvailable(accountId);
    this.lastRefreshAt.set(accountId, nowMs);
    const quota = this.options.fetchQuota === undefined ? await this.readQuota(accountId) : await this.options.fetchQuota(accountId);
    if (quota === null) return false;
    await this.writeQuota(accountId, quota, nowMs);
    return !quota.exceeded && (quota.remainingTokens === null || quota.remainingTokens > 0);
  }

  private async readQuota(accountId: string): Promise<AccountQuotaRecord | null> {
    if (this.store === null) return null;
    const snapshot = await this.store.getQuota(accountId);
    if (snapshot !== null) return snapshot;
    if (this.store.get === undefined) return null;
    const record = await this.store.get(accountId);
    if (record === undefined) return null;
    if (record.quota !== null && record.quota !== undefined) {
      return {
        remainingTokens: record.quota.status === "ready" ? null : 0,
        resetAt: record.quota.lastSuccessAt,
        exceeded: !record.quotaAvailable,
      };
    }
    return {
      remainingTokens: record.quotaAvailable ? null : 0,
      resetAt: null,
      exceeded: !record.quotaAvailable,
    };
  }

  private async writeQuota(accountId: string, quota: AccountQuotaRecord, nowMs: number): Promise<void> {
    if (this.store === null) return;
    if (this.store.setQuota !== undefined) {
      await this.store.setQuota(accountId, quota);
      return;
    }
    if (this.store.set === undefined) return;
    await this.store.set({
      accountId,
      quotaAvailable: !quota.exceeded && (quota.remainingTokens === null || quota.remainingTokens > 0),
      lastQuotaRefreshAtMs: nowMs,
      lastQuotaAttemptAtMs: nowMs,
      lastQuotaSuccessAtMs: nowMs,
      quota: {
        source: "quota-coordinator",
        status: "ready",
        plan: null,
        windows: [],
        fetchedAt: new Date(nowMs).toISOString(),
        lastAttemptAt: new Date(nowMs).toISOString(),
        lastSuccessAt: new Date(nowMs).toISOString(),
        error: null,
      },
    });
  }
}

// Minimal credential selector — compatible with router's CredentialSelector surface
export type CredentialSelection = { readonly accountId: string; readonly kind: CredentialKind; readonly leaseId: string; readonly secret: string };
export interface CredentialSelectionResult { readonly selection: CredentialSelection; readonly account: import("../types/routing.js").AccountCandidate; readonly reason: string; }
export type CredentialSelectionReason = "preferred" | "healthy" | "sole" | "fallback" | "usage_headroom";
export interface SelectCredentialInput {
  readonly providerId: string;
  readonly candidates: readonly import("../types/routing.js").AccountCandidate[];
  readonly strategy?: string;
  readonly affinityKey?: string | null;
  readonly stickyLimit?: number;
  readonly modelId?: string;
  readonly preferredAccountId?: string | null;
  readonly nowMs?: number;
  readonly usageSnapshots?: unknown;
  readonly usageSnapshotProvider?: unknown;
  readonly usageSnapshotTimeoutMs?: number;
  readonly usageSnapshotTtlMs?: number;
}

export interface CredentialSelectorDependencies {
  readonly getCredential: (accountId: string) => Promise<string | null>;
  readonly leaseCredential?: (accountId: string) => Promise<{ readonly secret: string; readonly release: () => Promise<void> }>;
  readonly refreshCredential?: (accountId: string) => Promise<OAuthTokenRecord>;
  readonly accountManager?: AccountManager;
}

export class CredentialSelector {
  private readonly leases = new Map<string, string>();
  private readonly leaseReleases = new Map<string, () => Promise<void>>();
  private readonly roundRobin = new Map<string, number>();

  constructor(private readonly dependencies: CredentialSelectorDependencies) {}

  async select(input: SelectCredentialInput): Promise<CredentialSelectionResult | null> {
    const nowMs = input.nowMs ?? Date.now();
    const candidates = input.candidates
      .filter((candidate) => candidate.providerId === input.providerId && candidate.enabled && candidate.healthy && candidate.quotaAvailable)
      .filter((candidate) => input.modelId === undefined || candidate.modelLocks?.get(input.modelId) === undefined)
      .sort((left, right) => left.priority - right.priority || left.accountId.localeCompare(right.accountId));
    if (candidates.length === 0) return null;
    const preferred = input.preferredAccountId === null || input.preferredAccountId === undefined
      ? candidates
      : [...candidates.filter((candidate) => candidate.accountId === input.preferredAccountId), ...candidates.filter((candidate) => candidate.accountId !== input.preferredAccountId)];
    const offset = input.strategy === "round-robin"
      ? (this.roundRobin.get(input.providerId) ?? 0) % preferred.length
      : 0;
    const ordered = offset === 0 ? preferred : [...preferred.slice(offset), ...preferred.slice(0, offset)];
    for (const candidate of ordered) {
      if (this.dependencies.accountManager !== undefined && !this.dependencies.accountManager.isEligible(candidate.accountId, { providerId: candidate.providerId, modelId: input.modelId ?? "", surface: "openai-chat" } as unknown as import("../types/routing.js").RouteTarget, nowMs)) continue;
      const oauthLease = candidate.credentialKind === "oauth" && this.dependencies.leaseCredential !== undefined
        ? await this.dependencies.leaseCredential(candidate.accountId)
        : null;
      const secret = oauthLease?.secret ?? await this.dependencies.getCredential(candidate.accountId);
      if (secret === null || secret.length === 0) continue;
      const leaseId = crypto.randomUUID();
      this.leases.set(leaseId, candidate.accountId);
      if (oauthLease !== null) this.leaseReleases.set(leaseId, oauthLease.release);
      if (input.strategy === "round-robin") this.roundRobin.set(input.providerId, (preferred.indexOf(candidate) + 1) % preferred.length);
      this.trackSelection(candidate.accountId);
      return {
        selection: { accountId: candidate.accountId, kind: candidate.credentialKind, leaseId, secret },
        account: candidate,
        reason: input.preferredAccountId === candidate.accountId ? "preferred" : candidates.length === 1 ? "sole" : "healthy",
      };
    }
    return null;
  }

  async release(leaseId: string): Promise<void> {
    const accountId = this.leases.get(leaseId);
    if (accountId === undefined) return;
    this.leases.delete(leaseId);
    const releaseCredential = this.leaseReleases.get(leaseId);
    this.leaseReleases.delete(leaseId);
    if (releaseCredential !== undefined) await releaseCredential();
    this.trackRelease(accountId);
  }

  async forceRefresh(accountId: string): Promise<OAuthTokenRecord> {
    if (this.dependencies.refreshCredential === undefined) throw credentialUnavailableError(accountId);
    return this.dependencies.refreshCredential(accountId);
  }

  trackSelection(_accountId: string): void {}
  trackRelease(_accountId: string): void {}
}

export function credentialUnavailableError(providerId: string, retryAt: string | null = null): import("../types/error-types.js").InternalFailure {
  return { kind: "credential_unavailable", message: `No credentials available for ${providerId}`, safeMessage: `No credentials available for ${providerId}`, retryable: false, routeScope: "account", statusCode: 401, retryAt } as unknown as import("../types/error-types.js").InternalFailure;
}

// Re-export eligibility helper used by route
export function isAccountEligible(candidate: CanonicalAccountCandidate, nowMs: number, modelId?: string): boolean {
  return isAccountEligibleCandidate(candidate, nowMs, modelId);
}

// Re-export for compatibility
export type QuotaWindowStateRecord = QuotaStateRecord;
