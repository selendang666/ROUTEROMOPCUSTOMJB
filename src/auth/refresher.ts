import { createProviderError } from "../proxy/types/error-types.js";
import type { InternalFailure } from "../proxy/types/error-types.js";
import { mapWithConcurrency } from "../runtime/runtime.js";
import { markOverhead } from "../runtime/overhead.js";
import { assertPublicUrlAtDispatch } from "../proxy/transport/network.js";
import { fingerprintOAuthToken } from "../proxy/routing/account.js";
import type { AccountConfig, CredentialConfigStore, OAuthRefreshResult, OAuthRefresher, OAuthTokenRecord, OAuthTokenStore, QuotaStateStore } from "../proxy/routing/account.js";
import { OAuthDriverError } from "./http-client.js";
import type { TokenSet } from "./contract.js";
import { resolveAuthDriverCapabilities } from "./driver-registry.js";
import type { AuthDriverRegistry } from "./driver-registry.js";
import type { OAuthFetch } from "./http-client.js";

const OAUTH_REFRESH_TIMEOUT_MS = 15_000;

const OAUTH_RESPONSE_MAX_BYTES = 64 * 1024;

const OAUTH_ACCESS_TOKEN_MAX_LENGTH = 32_384;

const OAUTH_MAX_EXPIRES_IN_SECONDS = 10 * 365 * 24 * 60 * 60;

const OAUTH_MAX_ERROR_MESSAGE_LENGTH = 240;

const OAUTH_HTTPS_ONLY: Readonly<Record<string, true>> = { "https:": true };

/**
 * Reads and JSON-parses a response body under a hard byte bound, never
 * calling the unbounded `response.json()`. Returns null for oversized,
 * absent, or malformed bodies.
 */
async function readResponseBody(response: Response, maxBytes: number): Promise<unknown | null> {
  const contentLength = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    return null;
  }
}

/** Strictly narrows an OAuth token response (bounded access token, optional clamped expiry, optional rotated refresh token). */
function parseTokenBody(body: unknown, nowMs: number): { readonly accessToken: string; readonly expiresAtMs: number | null; readonly refreshToken: string | null } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const accessToken = record["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0 || accessToken.length > OAUTH_ACCESS_TOKEN_MAX_LENGTH) return null;
  const expiresIn = record["expires_in"];
  const expiresAtMs = typeof expiresIn === "number" && Number.isFinite(expiresIn)
    ? nowMs + Math.floor(Math.min(Math.max(0, expiresIn), OAUTH_MAX_EXPIRES_IN_SECONDS) * 1000)
    : null;
  const rotated = record["refresh_token"];
  return {
    accessToken,
    expiresAtMs,
    refreshToken:
      typeof rotated === "string" && rotated.length >= 1 && rotated.length <= 8192 ? rotated : null,
  };
}

function failure(statusCode: number, kind: "credential_unavailable" | "provider_unavailable" | "authentication_failed" | "provider_protocol_error" | "network_unavailable", retryable: boolean, safeMessage: string, retryAt: string | null = null): OAuthRefreshResult {
  return { ok: false, error: createProviderError(kind, safeMessage, { retryable, routeScope: "account", statusCode, retryAt }) };
}

function parseRetryAfterHeader(value: string | null, nowMs: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return new Date(nowMs + Number(trimmed) * 1000).toISOString();
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export interface EnvOAuthRefresherOptions {
  /** Resolves the provider id for an account; the env-based path is keyed per provider. */
  readonly resolveProvider: (accountId: string) => Promise<string | null>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchFn?: OAuthFetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly nowMs?: () => number;
  /** DNS lookup for the SSRF guard; tests inject a public address, production uses Bun DNS. */
  readonly lookup?: (hostname: string) => Promise<readonly { readonly address: string }[]>;
}

/**
 * Bounded, env-configured OAuth refresh fallback for providers that have no
 * registered {@link AuthDriver}. Reads
 * `OHMYOMOP_ROUTER_OAUTH_<PROVIDER>_TOKEN_URL/CLIENT_ID/CLIENT_SECRET` from the
 * environment and refreshes with a hard byte bound, a bounded timeout, an
 * HTTPS-only SSRF guard, and strictly narrowed token parsing. This path serves
 * environment-configured providers without a dedicated provider driver.
 */
export function createEnvOAuthRefresher(options: EnvOAuthRefresherOptions): OAuthRefresher {
  const env = options.env ?? process.env;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? OAUTH_REFRESH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? OAUTH_RESPONSE_MAX_BYTES;
  const nowMs = options.nowMs ?? (() => Date.now());

  return {
    async refresh({ accountId, token }) {
      const refreshToken = token?.refreshToken ?? null;
      const providerId = await options.resolveProvider(accountId);
      if (providerId === null || refreshToken === null) {
        return failure(503, "credential_unavailable", true, "OAuth refresh token is unavailable");
      }
      const suffix = providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      const tokenUrl = env[`OHMYOMOP_ROUTER_OAUTH_${suffix}_TOKEN_URL`];
      const clientId = env[`OHMYOMOP_ROUTER_OAUTH_${suffix}_CLIENT_ID`];
      const clientSecret = env[`OHMYOMOP_ROUTER_OAUTH_${suffix}_CLIENT_SECRET`];
      if (!tokenUrl || !clientId || !clientSecret) {
        return failure(503, "credential_unavailable", true, "OAuth refresh configuration is unavailable");
      }
      try {
        await assertPublicUrlAtDispatch(tokenUrl, { label: "OAuth token URL", allowedProtocols: OAUTH_HTTPS_ONLY, lookup: options.lookup });
      } catch {
        return failure(503, "credential_unavailable", false, "OAuth refresh configuration is invalid");
      }
      try {
        const response = await fetchFn(tokenUrl, {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status >= 300 && response.status < 400) {
          return failure(response.status, "provider_protocol_error", false, "OAuth token endpoint returned an unexpected redirect");
        }
        const retryAt = parseRetryAfterHeader(response.headers.get("retry-after"), nowMs());
        if (!response.ok) {
          return failure(response.status || 503, response.status === 401 ? "authentication_failed" : "provider_unavailable", response.status !== 401, "OAuth token refresh failed", retryAt);
        }
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        if (contentType !== "application/json" && !contentType.endsWith("+json")) {
          return failure(502, "provider_protocol_error", false, "OAuth token response had an unexpected content type");
        }
        const body = await readResponseBody(response, maxBytes);
        const record = body === null ? null : parseTokenBody(body, nowMs());
        if (record === null) {
          return failure(502, "provider_protocol_error", false, "OAuth token response was invalid");
        }
        return { ok: true, token: { accessToken: record.accessToken, expiresAtMs: record.expiresAtMs, refreshToken: record.refreshToken ?? refreshToken, kind: "oauth", providerAccountId: token?.providerAccountId ?? null } };
      } catch {
        return failure(503, "network_unavailable", true, "OAuth token refresh network request failed");
      }
    },
  };
}

export interface DriverAwareRefresherOptions {
  readonly drivers: AuthDriverRegistry;
  /** Resolves the provider id for an account so the right driver (or fallback) is used. */
  readonly resolveProvider: (accountId: string) => Promise<string | null>;
  /** Safe bounded fallback used only when no driver handles the provider. */
  readonly fallback?: OAuthRefresher;
}

function tokenRecordFromTokenSet(token: TokenSet, previousRefreshToken: string | null, previousProviderAccountId: string | null = null): OAuthTokenRecord {
  let expiresAtMs: number | null = null;
  if (typeof token.expiresAt === "string" && token.expiresAt.length > 0) {
    const parsed = Date.parse(token.expiresAt);
    if (Number.isFinite(parsed)) expiresAtMs = parsed;
  }
  const accessToken = token.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0 || accessToken.length > OAUTH_ACCESS_TOKEN_MAX_LENGTH) {
    throw new OAuthDriverError("validation", "OAuth driver returned an unusable access token.", 502, false);
  }
  const providerAccountId = token.providerAccountId ?? previousProviderAccountId;
  return { accessToken, expiresAtMs, refreshToken: token.refreshToken ?? previousRefreshToken, kind: "oauth", providerAccountId: providerAccountId ?? null };
}

function driverRefreshFailure(error: unknown): OAuthRefreshResult {
  if (error instanceof OAuthDriverError) {
    let raw = error.message;
    if (raw.length > OAUTH_MAX_ERROR_MESSAGE_LENGTH) raw = `${raw.slice(0, OAUTH_MAX_ERROR_MESSAGE_LENGTH)}…`;
    const normalized = raw.toLowerCase();
    // Token endpoints report revoked, expired, reused, and invalid grants as
    // HTTP 400. These are permanent account failures, not provider outages.
    if (error.status === 400 || error.status === 401 || error.status === 403 || /(invalid_grant|refresh.?token.?reuse|revok|expired)/.test(normalized)) {
      return failure(error.status, "authentication_failed", false, raw, error.retryAt);
    }
    if (error.status === 429) return failure(error.status, "provider_unavailable", true, raw, error.retryAt);
    if (error.status >= 500) return failure(error.status, "provider_unavailable", error.retryable, raw, error.retryAt);
    return failure(error.status >= 400 && error.status < 500 ? error.status : 502, "provider_protocol_error", error.retryable, raw, error.retryAt);
  }
  return failure(503, "provider_unavailable", true, "OAuth token refresh failed");
}

/**
 * Provider-driver-first OAuth refresh. When a driver is registered for the
 * account's provider, its `refresh` drives the refresh (single-flight is left
 * to the central TokenRefreshPool); otherwise the safe bounded env fallback —
 * when present — handles it. A provider with neither a driver nor env
 * configuration resolves to a typed `credential_unavailable` failure, so
 * absence of a driver is the only reason a provider is not OAuth-refreshable.
 */
export function createDriverAwareOAuthRefresher(options: DriverAwareRefresherOptions): OAuthRefresher {
  return {
    async refresh({ accountId, token, account }) {
      const providerId = await options.resolveProvider(accountId);
      if (providerId === null) {
        return failure(503, "credential_unavailable", true, "OAuth account is unavailable");
      }
      const driver = options.drivers.get(providerId);
      const refreshToken = token?.refreshToken ?? null;
      const capabilities = driver === null ? null : resolveAuthDriverCapabilities(driver);
      if (driver !== null && capabilities !== null && capabilities.supportsRefresh) {
        if (refreshToken === null) {
          return failure(503, "credential_unavailable", true, "OAuth refresh token is unavailable");
        }
        try {
          const next = await driver.refresh?.({ providerId, accountId, refreshToken, credential: account?.secret });
          if (next === undefined) return failure(503, "credential_unavailable", false, "OAuth refresh is not supported for this provider");
          return { ok: true, token: tokenRecordFromTokenSet(next, refreshToken, token?.providerAccountId ?? null) };
        } catch (error) {
          return driverRefreshFailure(error);
        }
      }
      if (driver !== null && capabilities?.accessOnly === true) {
        return failure(401, "authentication_failed", false, "OAuth provider requires reauthentication");
      }
      if (driver !== null && capabilities?.supportsRefresh === false) {
        return failure(503, "credential_unavailable", false, "OAuth refresh is not supported for this provider");
      }
      if (options.fallback !== undefined) {
        return options.fallback.refresh({ accountId, token, account });
      }
      return failure(503, "credential_unavailable", true, "OAuth refresh is not configured for this provider");
    },
  };
}

const DEFAULT_REFRESH_LEAD_MS = 5 * 60_000;

const DEFAULT_WORKER_INTERVAL_MS = 60_000;

const DEFAULT_REFRESH_CONCURRENCY = 4;

const DEFAULT_REFRESH_LEASE_MS = 15_000;

const REFRESH_LEASE_WAIT_MS = 50;

const MAX_REFRESH_LEASE_WAIT_MS = 3_000;

export interface TokenRefreshPolicy {
  readonly refreshLeadMs?: number;
  readonly maxRefreshAgeMs?: number;
  readonly minRefreshIntervalMs?: number;
  readonly jitterMs?: number;
}

export interface TokenRefreshPoolOptions {
  readonly safetySkewMs?: number;
  readonly nowMs?: () => number;
  readonly intervalMs?: number;
  readonly concurrency?: number;
  readonly ownerId?: string;
  readonly leaseMs?: number;
  readonly defaultPolicy?: TokenRefreshPolicy;
  readonly resolvePolicy?: (account: AccountConfig) => TokenRefreshPolicy | undefined;
  readonly onRefreshed?: (accountId: string) => void;
  readonly onFailed?: (accountId: string, error: InternalFailure) => void;
}

/** Identifies OAuth failures that permanently invalidate the stored grant. */
export function isOAuthReauthenticationError(error: InternalFailure): boolean {
  const message = error.safeMessage.toLowerCase();
  const permanentMarker = ["invalid_grant", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated", "revoked"].some((marker) => message.includes(marker));
  return permanentMarker || ((error.kind === "authentication_failed" || error.kind === "authorization_denied") && !error.retryable);
}

function createOAuthReauthenticationError(statusCode: number | null = null): InternalFailure { return createProviderError("authentication_failed", "OAuth account invalidated; reauthorization required", {
  retryable: false,
  routeScope: "account",
  statusCode,
}); }

export interface TokenLease {
  readonly leaseId: string;
  readonly token: OAuthTokenRecord;
  release(): boolean;
}

/**
 * Central OAuth token coordinator and proactive refresh scheduler.
 *
 * All request-time, quota-time, manual, and scheduled refreshes share the
 * same account-level single-flight map. This prevents refresh-token rotation
 * races across otherwise independent callers.
 */
export class TokenRefreshPool {
  private readonly safetySkewMs: number;
  private readonly nowMs: () => number;
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly defaultPolicy: TokenRefreshPolicy;
  private readonly resolvePolicy?: (account: AccountConfig) => TokenRefreshPolicy | undefined;
  private readonly onRefreshed?: (accountId: string) => void;
  private readonly onFailed?: (accountId: string, error: InternalFailure) => void;
  private readonly inflight = new Map<string, Promise<OAuthTokenRecord>>();
  private readonly leases = new Map<string, string>();
  private readonly refcounts = new Map<string, number>();
  private readonly refreshWaiters: Array<() => void> = [];
  private activeRefreshes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly accounts: CredentialConfigStore,
    private readonly store: OAuthTokenStore,
    private readonly refresher: OAuthRefresher,
    options: TokenRefreshPoolOptions = {},
  ) {
    this.safetySkewMs = Math.max(0, options.safetySkewMs ?? 30_000);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.intervalMs = Math.max(30_000, options.intervalMs ?? DEFAULT_WORKER_INTERVAL_MS);
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_REFRESH_CONCURRENCY));
    this.ownerId = options.ownerId ?? crypto.randomUUID();
    this.leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_REFRESH_LEASE_MS);
    this.defaultPolicy = options.defaultPolicy ?? { refreshLeadMs: DEFAULT_REFRESH_LEAD_MS };
    this.resolvePolicy = options.resolvePolicy;
    this.onRefreshed = options.onRefreshed;
    this.onFailed = options.onFailed;
  }

  async getToken(accountId: string): Promise<OAuthTokenRecord | undefined> {
    return this.store.get(accountId);
  }

  async ensureFresh(accountId: string): Promise<OAuthTokenRecord> {
    const cached = await this.store.get(accountId);
    this.throwIfReauthenticationRequired(accountId, cached);
    if (cached !== undefined && (this.isFresh(cached) || cached.refreshToken === null)) return cached;
    this.throwIfRefreshDeferred(cached);
    return this.refreshSingleFlight(accountId, cached ?? null);
  }

  /** Forces one refresh while still sharing the same account-level flight. */
  async forceRefresh(accountId: string): Promise<OAuthTokenRecord> {
    const cached = await this.store.get(accountId);
    this.throwIfReauthenticationRequired(accountId, cached);
    if (cached?.refreshToken === null && cached.accessToken.length > 0) return cached;
    this.throwIfRefreshDeferred(cached);
    return this.refreshSingleFlight(accountId, cached ?? null);
  }

  /**
   * Retries an explicit refresh after a previous permanent failure. This is
   * intentionally separate from request-time refreshes so invalid credentials
   * are not retried on every model call.
   */
  async retryReauthentication(accountId: string): Promise<OAuthTokenRecord> {
    const cached = await this.store.get(accountId);
    if (cached?.refreshState === "reauth_required") {
      await this.store.set(accountId, {
        ...cached,
        refreshState: "retrying",
        refreshRetryAtMs: null,
        refreshFailureCount: 0,
      });
    }
    return this.forceRefresh(accountId);
  }

  async lease(accountId: string): Promise<TokenLease> {
    const token = await this.ensureFresh(accountId);
    const leaseId = crypto.randomUUID();
    this.leases.set(leaseId, accountId);
    this.refcounts.set(accountId, (this.refcounts.get(accountId) ?? 0) + 1);
    return { leaseId, token, release: () => this.releaseLease(leaseId) };
  }

  releaseLease(leaseId: string): boolean {
    const accountId = this.leases.get(leaseId);
    if (accountId === undefined) return false;
    this.leases.delete(leaseId);
    const current = this.refcounts.get(accountId) ?? 1;
    if (current <= 1) this.refcounts.delete(accountId);
    else this.refcounts.set(accountId, current - 1);
    return true;
  }

  activeLeaseCount(accountId: string): number {
    return this.refcounts.get(accountId) ?? 0;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error) => {
        console.warn("[TokenRefresh] sweep failed", error instanceof Error ? error.message : "unknown error");
      });
    }, this.intervalMs);
    this.timer.unref?.();
    this.sweep().catch((error) => {
      console.warn("[TokenRefresh] initial sweep failed", error instanceof Error ? error.message : "unknown error");
    });
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const accountList = await this.accounts.listAccounts();
      const candidates = accountList.filter((account) => account.enabled && account.kind === "oauth");
      const due: AccountConfig[] = [];
      for (const account of candidates) {
        const token = await this.store.get(account.id);
        if (token?.refreshState === "reauth_required") {
          this.reportFailure(account.id, createOAuthReauthenticationError(token.lastRefreshStatusCode ?? null));
          continue;
        }
        if (await this.isDue(account)) due.push(account);
      }
      await mapWithConcurrency(due, this.concurrency, async (account) => {
        try {
          await this.forceRefresh(account.id);
        } catch (error) {
          this.reportFailure(account.id, error);
        }
      });
    } finally {
      this.sweeping = false;
    }
  }

  async isDue(account: AccountConfig): Promise<boolean> {
    const token = await this.store.get(account.id);
    if (token === undefined || token.refreshToken === null || token.refreshState === "reauth_required") return false;
    const policy = { ...this.defaultPolicy, ...this.resolvePolicy?.(account) };
    const now = this.nowMs();
    const refreshLeadMs = Math.max(0, policy.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS);
    if (token.expiresAtMs !== null && token.expiresAtMs - now <= refreshLeadMs) return true;
    const lastRefreshAtMs = token.lastRefreshAtMs ?? null;
    const minRefreshIntervalMs = Math.max(0, policy.minRefreshIntervalMs ?? 0);
    if (lastRefreshAtMs !== null && now - lastRefreshAtMs < minRefreshIntervalMs) return false;
    // Fallback: if expiresAtMs is unknown (e.g. Antigravity), use maxRefreshAgeMs with default 50m to avoid expiry
    const maxAge = policy.maxRefreshAgeMs ?? 50 * 60_000;
    const jitterMs = this.calculateJitterMs(account.id, Math.max(0, policy.jitterMs ?? 0));
    return lastRefreshAtMs === null || now - lastRefreshAtMs >= Math.max(0, maxAge) + jitterMs;
  }

  private calculateJitterMs(accountId: string, maximumMs: number): number {
    if (maximumMs <= 0) return 0;
    let hash = 2166136261;
    for (let index = 0; index < accountId.length; index += 1) {
      hash ^= accountId.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % (Math.floor(maximumMs) + 1);
  }

  private async refreshSingleFlight(accountId: string, cached: OAuthTokenRecord | null): Promise<OAuthTokenRecord> {
    const inflight = this.inflight.get(accountId);
    if (inflight !== undefined) return inflight;
    const pending = this.refreshAndStore(accountId, cached);
    this.inflight.set(accountId, pending);
    pending.finally(() => this.inflight.delete(accountId)).catch(() => {});
    return pending;
  }

  private async refreshAndStore(accountId: string, cached: OAuthTokenRecord | null): Promise<OAuthTokenRecord> {
    const stop = markOverhead("router.refresh");
    const releaseRefreshSlot = await this.acquireRefreshSlot();
    try {
    const acquired = await this.acquireRefreshLease(accountId, cached);
    const expected = acquired.token;
    if (!acquired.owned) {
      if (expected !== null) return expected;
      throw createProviderError("provider_unavailable", "OAuth refresh is already in progress", { retryable: true, routeScope: "account" });
    }

      try {
      const current = await this.store.get(accountId);
      if (expected !== null && current !== undefined && this.isDifferentToken(current, expected)) return current;
      const base = current ?? expected;
      const attemptAtMs = this.nowMs();
      if (base !== null) {
        await this.store.set(accountId, {
          ...base,
          lastRefreshAttemptAtMs: attemptAtMs,
          refreshState: "retrying",
        });
      }

      let result: OAuthRefreshResult;
      try {
        const account = await this.accounts.getAccount(accountId);
        result = await this.refresher.refresh({ accountId, token: base, account });
      } catch {
        result = {
          ok: false,
          error: createProviderError("provider_unavailable", "OAuth token refresh failed", { retryable: true, routeScope: "account" }),
        };
      }
      if (!result.ok) {
        await this.recordFailure(accountId, base, result.error, attemptAtMs);
        this.reportFailure(accountId, result.error);
        throw result.error;
      }

      const refreshed: OAuthTokenRecord = {
        ...result.token,
        refreshToken: result.token.refreshToken ?? base?.refreshToken ?? null,
        generation: (base?.generation ?? 0) + 1,
        lastRefreshAtMs: attemptAtMs,
        lastRefreshAttemptAtMs: attemptAtMs,
        lastRefreshErrorKind: null,
        lastRefreshStatusCode: null,
        refreshState: "healthy",
        refreshRetryAtMs: null,
        refreshFailureCount: 0,
      };
      const committed = base !== null && this.store.compareAndSwap !== undefined
        ? await this.store.compareAndSwap({
          accountId,
          expectedGeneration: base.generation ?? 0,
          expectedTokenFingerprint: fingerprintOAuthToken(base),
          token: refreshed,
        })
        : false;
      if (this.store.compareAndSwap !== undefined && base !== null && !committed) {
        const latest = await this.store.get(accountId);
        if (latest !== undefined) return latest;
        throw createProviderError("provider_unavailable", "OAuth token update lost its generation race", { retryable: true, routeScope: "account" });
      }
      if (!committed) await this.store.set(accountId, refreshed);
      this.onRefreshed?.(accountId);
      return refreshed;
    } finally {
      await this.store.releaseRefreshLease?.(accountId, this.ownerId);
    }
    } finally {
      releaseRefreshSlot();
      stop();
  }

  }
  private async acquireRefreshSlot(): Promise<() => void> {
    if (this.activeRefreshes >= this.concurrency) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.refreshWaiters.push(resolve);
      await promise;
    }
    this.activeRefreshes += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRefreshes = Math.max(0, this.activeRefreshes - 1);
      this.refreshWaiters.shift()?.();
    };
  }

  private async acquireRefreshLease(accountId: string, cached: OAuthTokenRecord | null): Promise<{ readonly token: OAuthTokenRecord | null; readonly owned: boolean }> {
    let expected: OAuthTokenRecord | null = cached ?? await this.store.get(accountId) ?? null;
    const acquire = this.store.tryAcquireRefreshLease?.bind(this.store);
    if (acquire === undefined || expected === null || expected.refreshToken === null) return { token: expected, owned: true };
    for (let waitedMs = 0; waitedMs <= MAX_REFRESH_LEASE_WAIT_MS; waitedMs += REFRESH_LEASE_WAIT_MS) {
      const owned = await acquire({
        accountId,
        ownerId: this.ownerId,
        generation: expected.generation ?? 0,
        tokenFingerprint: fingerprintOAuthToken(expected),
        nowMs: this.nowMs(),
        leaseMs: this.leaseMs,
      });
      if (owned) return { token: await this.store.get(accountId) ?? expected, owned: true };
      const latest = await this.store.get(accountId);
      if (latest !== undefined && this.isDifferentToken(latest, expected)) return { token: latest, owned: false };
      if (waitedMs < MAX_REFRESH_LEASE_WAIT_MS) await new Promise<void>((resolve) => setTimeout(resolve, REFRESH_LEASE_WAIT_MS));
    }
    throw createProviderError("provider_unavailable", "OAuth refresh lease is busy", {
      retryable: true,
      routeScope: "account",
      retryAt: new Date(this.nowMs() + REFRESH_LEASE_WAIT_MS).toISOString(),
    });
  }

  private async recordFailure(accountId: string, cached: OAuthTokenRecord | null, error: InternalFailure, atMs: number): Promise<void> {
    const current = cached ?? await this.store.get(accountId);
    if (current === undefined) return;
    const failureCount = (current.refreshFailureCount ?? 0) + 1;
    const requiresReauthentication = this.requiresReauthentication(error);
    const retryAtMs = requiresReauthentication ? null : this.calculateRetryAtMs(error, atMs, failureCount);
    const next: OAuthTokenRecord = {
      ...current,
      lastRefreshAttemptAtMs: atMs,
      lastRefreshErrorKind: error.kind,
      lastRefreshStatusCode: error.statusCode,
      refreshState: requiresReauthentication ? "reauth_required" : "retrying",
      refreshRetryAtMs: retryAtMs,
      refreshFailureCount: failureCount,
    };
    if (this.store.compareAndSwap !== undefined) {
      await this.store.compareAndSwap({
        accountId,
        expectedGeneration: current.generation ?? 0,
        expectedTokenFingerprint: fingerprintOAuthToken(current),
        token: next,
      });
      return;
    }
    await this.store.set(accountId, next);
  }

  private calculateRetryAtMs(error: InternalFailure, atMs: number, failureCount: number): number | null {
    const retryAtMs = error.retryAt === null ? Number.NaN : Date.parse(error.retryAt);
    if (Number.isFinite(retryAtMs)) return retryAtMs;
    if (!error.retryable && error.kind !== "provider_protocol_error") return null;
    return atMs + Math.min(60_000, 1_000 * 2 ** Math.min(failureCount - 1, 6));
  }

  private requiresReauthentication(error: InternalFailure): boolean {
    return isOAuthReauthenticationError(error);
  }

  private throwIfReauthenticationRequired(accountId: string, token: OAuthTokenRecord | undefined): void {
    if (token?.refreshState !== "reauth_required") return;
    const error = createOAuthReauthenticationError(token.lastRefreshStatusCode ?? 401);
    this.reportFailure(accountId, error);
    throw error;
  }

  private throwIfRefreshDeferred(token: OAuthTokenRecord | undefined): void {
    if (token?.refreshState !== "retrying" || token.refreshRetryAtMs === null || token.refreshRetryAtMs === undefined || token.refreshRetryAtMs <= this.nowMs()) return;
    throw createProviderError(token.lastRefreshStatusCode === 429 ? "provider_rate_limited" : "provider_unavailable", "OAuth refresh is waiting for provider retry backoff", {
      retryable: true,
      routeScope: "account",
      statusCode: token.lastRefreshStatusCode ?? 503,
      retryAt: new Date(token.refreshRetryAtMs).toISOString(),
    });
  }

  private isDifferentToken(left: OAuthTokenRecord, right: OAuthTokenRecord): boolean {
    return (left.generation ?? 0) !== (right.generation ?? 0) || fingerprintOAuthToken(left) !== fingerprintOAuthToken(right);
  }

  private isFresh(token: OAuthTokenRecord): boolean {
    return token.expiresAtMs === null || token.expiresAtMs - this.nowMs() > this.safetySkewMs;
  }


  private reportFailure(accountId: string, error: unknown): void {
    if (error !== null && typeof error === "object" && "kind" in error) {
      this.onFailed?.(accountId, error as InternalFailure);
      return;
    }
    this.onFailed?.(accountId, createProviderError("provider_unavailable", "OAuth token refresh failed", { retryable: true, routeScope: "account" }));
  }
}

const DEFAULT_QUOTA_INTERVAL_MS = 5 * 60_000;

const DEFAULT_QUOTA_CONCURRENCY = 3;

const DEFAULT_FAILURE_COOLDOWN_MS = 15 * 60_000;

export interface QuotaRefreshWorkerOptions {
  readonly intervalMs?: number;
  readonly concurrency?: number;
  readonly failureCooldownMs?: number;
  readonly nowMs?: () => number;
  readonly supportsProvider?: (providerId: string) => boolean;
  readonly onRefreshed?: (accountId: string, quotaAvailable: boolean) => void;
  readonly onFailed?: (accountId: string, error: unknown) => void;
}

/** Periodic quota worker; quota refresh is coalesced per account and never overlaps a sweep. */
export class QuotaRefreshWorker {
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private readonly failureCooldownMs: number;
  private readonly nowMs: () => number;
  private readonly supportsProvider: (providerId: string) => boolean;
  private readonly onRefreshed?: (accountId: string, quotaAvailable: boolean) => void;
  private readonly onFailed?: (accountId: string, error: unknown) => void;
  private readonly inflight = new Map<string, Promise<boolean>>();
  private readonly failedUntil = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly accounts: CredentialConfigStore,
    private readonly state: QuotaStateStore,
    private readonly refreshQuota: (accountId: string) => Promise<boolean>,
    options: QuotaRefreshWorkerOptions = {},
  ) {
    this.intervalMs = Math.max(60_000, options.intervalMs ?? DEFAULT_QUOTA_INTERVAL_MS);
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_QUOTA_CONCURRENCY));
    this.failureCooldownMs = Math.max(60_000, options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.supportsProvider = options.supportsProvider ?? (() => true);
    this.onRefreshed = options.onRefreshed;
    this.onFailed = options.onFailed;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error) => console.warn("[QuotaRefresh] sweep failed", error instanceof Error ? error.message : "unknown error"));
    }, this.intervalMs);
    this.timer.unref?.();
    this.sweep().catch((error) => console.warn("[QuotaRefresh] initial sweep failed", error instanceof Error ? error.message : "unknown error"));
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const accounts = (await this.accounts.listAccounts()).filter((account) => account.enabled && this.supportsProvider(account.providerId));
      await mapWithConcurrency(accounts, this.concurrency, async (account) => {
        if (!(await this.isDue(account))) return;
        try {
          const quotaAvailable = await this.refreshSingleFlight(account.id);
          this.failedUntil.delete(account.id);
          this.onRefreshed?.(account.id, quotaAvailable);
        } catch (error) {
          this.failedUntil.set(account.id, this.nowMs() + this.failureCooldownMs);
          this.onFailed?.(account.id, error);
        }
      });
    } finally {
      this.sweeping = false;
    }
  }

  private async isDue(account: AccountConfig): Promise<boolean> {
    const failedUntil = this.failedUntil.get(account.id) ?? 0;
    if (failedUntil > this.nowMs()) return false;
    const record = await this.state.get(account.id);
    const lastRefreshAtMs = record?.lastQuotaRefreshAtMs ?? null;
    return lastRefreshAtMs === null || this.nowMs() - lastRefreshAtMs >= this.intervalMs;
  }

  private async refreshSingleFlight(accountId: string): Promise<boolean> {
    const existing = this.inflight.get(accountId);
    if (existing !== undefined) return existing;
    const pending = this.refreshQuota(accountId);
    this.inflight.set(accountId, pending);
    pending.finally(() => this.inflight.delete(accountId)).catch(() => {});
    return pending;
  }

}
