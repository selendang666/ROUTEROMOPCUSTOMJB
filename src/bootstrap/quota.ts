import { decryptWithKey, encryptWithKey, resolveEncryptionKey } from "../persistence/crypto.js";
import type { PostgresPool } from "../persistence/pool.js";
import { fetchProviderQuota, type ProviderQuotaResult } from "../providers/quota-fetch/fetch.js";
import type { AccountConfig, CredentialConfigStore, OAuthTokenRecord, QuotaStateRecord, QuotaStateStore, QuotaWindowState } from "../proxy/routing/account.js";
import { createAuthDriverRegistry } from "../auth/driver-registry.js";
import { createDriverAwareOAuthRefresher, QuotaRefreshWorker, TokenRefreshPool } from "../auth/refresher.js";
import { isGeneratedAccountName, parseAccountIdentity } from "../console/services/accounts.js";

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function quotaTokenFromCredential(value: string): OAuthTokenRecord | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken : null;
    if (accessToken === null) return undefined;
    const expiresAtMs = typeof parsed.expiresAtMs === "number"
      ? parsed.expiresAtMs
      : typeof parsed.expiresAt === "string" && Number.isFinite(Date.parse(parsed.expiresAt))
        ? Date.parse(parsed.expiresAt)
        : null;
    const providerAccountId = typeof parsed.providerAccountId === "string" && parsed.providerAccountId.length > 0
      ? parsed.providerAccountId
      : typeof parsed.projectId === "string" && parsed.projectId.length > 0 ? parsed.projectId : null;
    return {
      kind: "oauth",
      accessToken,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
      expiresAtMs,
      providerAccountId,
    };
  } catch {
    return undefined;
  }
}

function decryptCredential(value: string): string {
  try { return decryptWithKey(value, resolveEncryptionKey()); } catch { return value; }
}

function parseQuotaWindows(value: unknown): readonly QuotaWindowState[] {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed) as unknown; } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.kind !== "string" || typeof row.label !== "string") return [];
    const usedPercent = typeof row.usedPercent === "number" ? row.usedPercent : null;
    const remainingPercent = typeof row.remainingPercent === "number" ? row.remainingPercent : null;
    const resetsAt = typeof row.resetsAt === "string" ? row.resetsAt : null;
    const used = typeof row.used === "number" ? row.used : null;
    const limit = typeof row.limit === "number" ? row.limit : null;
    return [{ kind: row.kind, label: row.label, usedPercent, remainingPercent, resetsAt, used, limit }];
  });
}

export interface QuotaRuntime {
  readonly state: QuotaStateStore;
  readonly accounts: CredentialConfigStore;
  readonly tokenRefreshPool: TokenRefreshPool;
  readonly refreshAccountQuota: (accountId: string) => Promise<ProviderQuotaResult>;
  readonly refreshOAuthAccount: (accountId: string) => Promise<OAuthTokenRecord>;
  readonly worker: QuotaRefreshWorker;
  readonly leaseCredential: (accountId: string) => Promise<{ readonly secret: string; readonly release: () => Promise<void> }>;
}

export function createQuotaRuntime(pool: PostgresPool): QuotaRuntime {
const quotaStateFromRow = (row: Record<string, unknown>): QuotaStateRecord => ({
  accountId: String(row.account_id),
  quotaAvailable: row.status === "ready" && row.error === null,
  lastQuotaRefreshAtMs: row.fetched_at === null ? null : new Date(String(row.fetched_at)).getTime(),
  lastQuotaAttemptAtMs: row.last_attempt_at === null ? null : new Date(String(row.last_attempt_at)).getTime(),
  lastQuotaSuccessAtMs: row.last_success_at === null ? null : new Date(String(row.last_success_at)).getTime(),
  quota: {
    source: typeof row.source === "string" ? row.source : "unknown",
    status: row.status === "refreshing" || row.status === "ready" || row.status === "error" ? row.status : "unknown",
    plan: typeof row.plan === "string" ? row.plan : null,
    windows: parseQuotaWindows(row.windows_json),
    fetchedAt: toIso(row.fetched_at),
    lastAttemptAt: toIso(row.last_attempt_at),
    lastSuccessAt: toIso(row.last_success_at),
    error: typeof row.error === "string" ? row.error : null,
  },
});

const quotaState: QuotaStateStore = {
  async get(accountId) {
    const rows = (await pool`SELECT * FROM provider_account_quota WHERE account_id = ${accountId}`) as unknown as Array<Record<string, unknown>>;
    return rows[0] === undefined ? undefined : quotaStateFromRow(rows[0]);
  },
  async set(record) {
    const quota = record.quota;
    await pool`
      INSERT INTO provider_account_quota (
        account_id, source, status, plan, windows_json, fetched_at,
        last_attempt_at, last_success_at, error, updated_at
      ) VALUES (
        ${record.accountId}, ${quota?.source ?? null}, ${quota?.status ?? "unknown"},
        ${quota?.plan ?? null}, ${quota?.windows ?? []}::jsonb,
        ${quota?.fetchedAt ?? null}::timestamptz, ${quota?.lastAttemptAt ?? null}::timestamptz,
        ${quota?.lastSuccessAt ?? null}::timestamptz, ${quota?.error ?? null}, now()
      )
      ON CONFLICT (account_id) DO UPDATE SET
        source = EXCLUDED.source,
        status = EXCLUDED.status,
        plan = EXCLUDED.plan,
        windows_json = EXCLUDED.windows_json,
        fetched_at = EXCLUDED.fetched_at,
        last_attempt_at = EXCLUDED.last_attempt_at,
        last_success_at = EXCLUDED.last_success_at,
        error = EXCLUDED.error,
        updated_at = now()
    `;
  },
  async list() {
    const rows = (await pool`SELECT * FROM provider_account_quota ORDER BY account_id`) as unknown as Array<Record<string, unknown>>;
    return rows.map(quotaStateFromRow);
  },
  async listForAccountIds(accountIds) {
    if (accountIds.length === 0) return [];
    const rows = (await pool`SELECT * FROM provider_account_quota ORDER BY account_id`) as unknown as Array<Record<string, unknown>>;
    const accepted = new Set(accountIds);
    return rows.filter((row) => accepted.has(String(row.account_id))).map(quotaStateFromRow);
  },
};

const quotaAccounts: CredentialConfigStore = {
  async getAccount(id) {
    const rows = (await pool`SELECT id, provider, credential_kind, active, priority FROM provider_accounts WHERE id = ${id}`) as unknown as Array<Record<string, unknown>>;
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: String(row.id),
      providerId: String(row.provider),
      kind: String(row.credential_kind) as AccountConfig["kind"],
      secret: null,
      enabled: row.active === true,
      priority: Number(row.priority ?? 100),
    };
  },
  async listAccounts() {
    const rows = (await pool`SELECT id, provider, credential_kind, active, priority FROM provider_accounts ORDER BY provider, priority`) as unknown as Array<Record<string, unknown>>;
    return rows.map((row): AccountConfig => ({
      id: String(row.id),
      providerId: String(row.provider),
      kind: String(row.credential_kind) as AccountConfig["kind"],
      secret: null,
      enabled: row.active === true,
      priority: Number(row.priority ?? 100),
    }));
  },
};

const refreshAccountQuota = async (accountId: string): Promise<ProviderQuotaResult> => {
  const rows = (await pool`SELECT provider, credential_encrypted FROM provider_accounts WHERE id = ${accountId} AND active = true`) as unknown as Array<{ provider: string; credential_encrypted: string }>;
  const account = rows[0];
  if (account === undefined) throw new Error(`Active provider account "${accountId}" was not found.`);
  const attemptedAt = new Date().toISOString();
  const previous = await quotaState.get(accountId);
  await quotaState.set({
    accountId,
    quotaAvailable: previous?.quotaAvailable ?? false,
    lastQuotaRefreshAtMs: previous?.lastQuotaRefreshAtMs ?? null,
    lastQuotaAttemptAtMs: Date.now(),
    lastQuotaSuccessAtMs: previous?.lastQuotaSuccessAtMs ?? null,
    quota: {
      source: previous?.quota?.source ?? account.provider,
      status: "refreshing",
      plan: previous?.quota?.plan ?? null,
      windows: previous?.quota?.windows ?? [],
      fetchedAt: previous?.quota?.fetchedAt ?? null,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: previous?.quota?.lastSuccessAt ?? null,
      error: null,
    },
  });
  const credential = decryptCredential(account.credential_encrypted);
  const result = await fetchProviderQuota(account.provider, credential, quotaTokenFromCredential(credential));
  const fetchedAt = new Date().toISOString();
  const windows = result.error === null && result.windows.length === 0 && (previous?.quota?.windows.length ?? 0) > 0
    ? previous?.quota?.windows ?? []
    : result.windows;
  await quotaState.set({
    accountId,
    quotaAvailable: result.error === null,
    lastQuotaRefreshAtMs: Date.now(),
    lastQuotaAttemptAtMs: Date.now(),
    lastQuotaSuccessAtMs: result.error === null ? Date.now() : previous?.lastQuotaSuccessAtMs ?? null,
    quota: {
      source: result.source,
      status: result.error === null ? "ready" : "error",
      plan: result.plan,
      windows,
      fetchedAt,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: result.error === null ? fetchedAt : previous?.quota?.lastSuccessAt ?? null,
      error: result.error,
    },
  });
  return result;
};

const tokenStore = {
  async get(accountId: string): Promise<OAuthTokenRecord | undefined> {
    const rows = (await pool`SELECT credential_encrypted FROM provider_accounts WHERE id = ${accountId} AND active = true`) as unknown as Array<{ credential_encrypted: string }>;
    const credential = rows[0] === undefined ? undefined : quotaTokenFromCredential(decryptCredential(rows[0].credential_encrypted));
    return credential;
  },
  async set(accountId: string, token: OAuthTokenRecord): Promise<void> {
    const rows = (await pool`SELECT provider, name, credential_hint, credential_encrypted FROM provider_accounts WHERE id = ${accountId}`) as unknown as Array<{ provider: string; name: string; credential_hint: string | null; credential_encrypted: string }>;
    const current = rows[0] === undefined ? null : decryptCredential(rows[0].credential_encrypted);
    const parsed = current === null ? {} : (() => { try { return JSON.parse(current) as Record<string, unknown>; } catch { return {}; } })();
    const nextCredential = { ...parsed, accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAtMs: token.expiresAtMs, ...(token.providerAccountId ? { providerAccountId: token.providerAccountId, projectId: token.providerAccountId } : {}) };
    const nextIdentity = parseAccountIdentity(JSON.stringify(nextCredential));
    const account = rows[0];
    const nextName = account !== undefined && nextIdentity.name !== null && isGeneratedAccountName(account.name, account.provider) ? nextIdentity.name : account?.name;
    const nextHint = account?.credential_hint || nextIdentity.hint || "";
    const next = encryptWithKey(JSON.stringify(nextCredential), resolveEncryptionKey());
    await pool`UPDATE provider_accounts SET credential_encrypted = ${next}, name = ${nextName ?? accountId}, credential_hint = ${nextHint}, updated_at = now() WHERE id = ${accountId}`;
  },
  async delete(_accountId: string): Promise<void> {},
};
const tokenRefreshPool = new TokenRefreshPool(
  quotaAccounts,
  tokenStore,
  createDriverAwareOAuthRefresher({
    drivers: createAuthDriverRegistry(),
    resolveProvider: async (accountId) => (await quotaAccounts.getAccount(accountId))?.providerId ?? null,
  }),
  {
    resolvePolicy: (account) => {
      if (account.providerId === "codex") return { maxRefreshAgeMs: 8 * 24 * 60 * 60_000 };
      if (account.providerId === "claude-code") return { maxRefreshAgeMs: 7 * 24 * 60 * 60_000 };
      return undefined;
    },
  },
);

const quotaWorker = new QuotaRefreshWorker(
  quotaAccounts,
  quotaState,
  async (accountId) => (await refreshAccountQuota(accountId)).error === null,
  { supportsProvider: (providerId) => new Set(["antigravity", "claude-code", "cline", "codex", "ollama", "zai", "zai-coding-plan", "kimi-code", "github-copilot", "cursor", "devin"]).has(providerId) },
);
tokenRefreshPool.start();
quotaWorker.start();
  return {
    tokenRefreshPool,
    state: quotaState,
    accounts: quotaAccounts,
    refreshAccountQuota,
    refreshOAuthAccount: (accountId) => tokenRefreshPool.forceRefresh(accountId),
    worker: quotaWorker,
    leaseCredential: async (accountId) => {
      const lease = await tokenRefreshPool.lease(accountId);
      return {
        secret: JSON.stringify(lease.token),
        release: async () => { lease.release(); },
      };
    },
  };
}
