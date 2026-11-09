import { createHash } from "node:crypto";
import type { PostgresPool } from "../../persistence/pool.js";
import type { QuotaStateRecord } from "../../proxy/routing/account.js";
import type { ProviderQuotaResult } from "../../providers/quota-fetch/fetch.js";
import { encryptWithKey, resolveEncryptionKey } from "../../persistence/crypto.js";
import type { AccountPageResult } from "./api-keys.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import { extractAccessTokenOrRaw } from "../../auth/contract.js";
import { builtinProviderDefinitions } from "../../providers/registry.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export interface AccountIdentity {
  readonly name: string | null;
  readonly hint: string | null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return objectRecord(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

/** Parses stable account identity fields from credential JSON or JWT claims. */
export function parseAccountIdentity(credential: string): AccountIdentity {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = objectRecord(JSON.parse(credential));
  } catch {
    parsed = null;
  }
  const fields = parsed ?? {};
  const profile = objectRecord(fields.profile) ?? objectRecord(fields.userInfo) ?? {};
  const token = firstString(fields.accessToken, fields.access_token) ?? credential;
  const jwt = jwtPayload(token) ?? {};
  const email = firstString(fields.email, profile.email, jwt.email, jwt.preferred_username);
  const name = firstString(
    fields.displayName,
    fields.name,
    profile.displayName,
    profile.name,
    fields.username,
    fields.login,
    profile.username,
    profile.login,
    jwt.name,
    jwt.preferred_username,
    email?.split("@")[0],
  );
  return { name, hint: email ?? firstString(fields.username, fields.login, profile.username, profile.login) };
}

/** Detects provider-generated account labels that are safe to replace. */
export function isGeneratedAccountName(name: string, provider: string): boolean {
  const normalizedName = name.trim().toLowerCase();
  const labels: Record<string, readonly string[]> = {
    "antigravity": ["antigravity", "google antigravity"],
    "claude-code": ["claude code"],
    "github-copilot": ["github copilot"],
    "openai-codex": ["openai codex"],
  };
  const candidates = [provider.trim().toLowerCase(), ...(labels[provider.trim().toLowerCase()] ?? [])];
  return candidates.some((candidate) => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return normalizedName === candidate || new RegExp(`^${escaped}\\s*[-#]?\\s*\\d+$`).test(normalizedName);
  });
}

interface AccountCursor {
  readonly provider: string;
  readonly priority: number;
  readonly id: string;
}

function serializeAccountCursor(provider: string, priority: number, id: string): string {
  return Buffer.from(JSON.stringify({ provider, priority, id }), "utf8").toString("base64url");
}

function parseAccountCursor(value: string): AccountCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const cursor = parsed as Record<string, unknown>;
    if (typeof cursor.provider !== "string" || typeof cursor.priority !== "number" || !Number.isInteger(cursor.priority) || typeof cursor.id !== "string") return null;
    return { provider: cursor.provider, priority: cursor.priority, id: cursor.id };
  } catch {
    return null;
  }
}

/**
 * Accounts console service — verbatim from bootstrap 767-835.
 * Includes list/create/update/remove/oauthStart/oauthCallback/quotaRefresh.
 */
export function createAccountsService(
  pool: PostgresPool,
  refreshAccountQuota: (accountId: string) => Promise<ProviderQuotaResult>,
  onMutation: () => void = () => {},
  registry?: ProviderRegistry,
  getCredential?: (accountId: string) => Promise<string | null>,
  refreshOAuthAccount?: (accountId: string) => Promise<{ readonly accessToken: string; readonly expiresAtMs: number | null }>,
  getQuotaState?: (accountId: string) => Promise<QuotaStateRecord | undefined>,
  getQuotaStates?: (accountIds: readonly string[]) => Promise<readonly QuotaStateRecord[]>,
): {
  list(input?: { readonly provider?: string | null; readonly limit?: number; readonly cursor?: string | null }): Promise<AccountPageResult<Record<string, unknown>> | { ok: false; status: number; message: string }>;
  create(body: unknown): Promise<{ ok: boolean; status: number; data?: unknown; message?: string }>;
  update(id: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown }>;
  remove(id: string): Promise<{ ok: boolean; status: number; data: unknown }>;
  oauthStart(id: string, body: unknown): Promise<{ ok: boolean; status: number; data?: unknown; code?: string; message?: string }>;
  oauthCallback(req: Request): Promise<{ ok: boolean; status: number; data?: unknown; code?: string; message?: string }>;
  oauthRefresh(body: unknown): Promise<{ ok: boolean; status: number; data?: unknown; message?: string; code?: string }>;
  validateApiKey(id: string): Promise<{ ok: boolean; status: number; data?: unknown; code?: string; message?: string }>;
  quotaRefresh(id: string): Promise<{ ok: boolean; status: number; data?: unknown; message?: string }>;
  quota(id: string): Promise<unknown>;
  batchUpdate(body: unknown): Promise<{ ok: boolean; status: number; data?: unknown; message?: string; code?: string }>;
  batchDelete(body: unknown): Promise<{ ok: boolean; status: number; data?: unknown; message?: string; code?: string }>;
  oauthRefresh(body: unknown): Promise<{ ok: boolean; status: number; data?: unknown; message?: string; code?: string }>;
  quotaRefreshBulk(body: unknown): Promise<{ ok: boolean; status: number; data?: unknown; message?: string; code?: string }>;
} {
  return {
    async list(input = {}) {
      const provider = input.provider?.trim() || null;
      const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 100);
      const cursor = input.cursor === undefined || input.cursor === null ? null : parseAccountCursor(input.cursor);
      if (input.cursor !== undefined && input.cursor !== null && cursor === null) return { ok: false, status: 400, message: "invalid account cursor" };
      const rows = (await pool`
          SELECT
            a.id, a.provider, a.name, a.credential_kind, a.credential_hint, a.priority, a.active,
            q.source AS quota_source, q.status AS quota_status, q.plan AS quota_plan,
            q.windows_json AS quota_windows, q.fetched_at AS quota_fetched_at,
            q.last_attempt_at AS quota_last_attempt_at, q.last_success_at AS quota_last_success_at,
            q.error AS quota_error
          FROM provider_accounts a
          LEFT JOIN provider_account_quota q ON q.account_id = a.id
          WHERE (${provider}::text IS NULL OR a.provider = ${provider})
            AND (${cursor?.provider ?? null}::text IS NULL OR (a.provider, a.priority, a.id) > (${cursor?.provider ?? null}, ${cursor?.priority ?? null}, ${cursor?.id ?? null}))
          ORDER BY a.provider, a.priority, a.id
          LIMIT ${limit + 1}
        `) as unknown as Array<Record<string, unknown>>;
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      // Batch quota read — prefers listForAccountIds batch, falls back to N parallel, avoids N+1 sequential amplification.
      // The SQL join already fetched quota columns; runtime state is overlayed via batch.
      let quotaMap = new Map<string, QuotaStateRecord>();
      if (getQuotaStates !== undefined && page.length > 0) {
        const states = await getQuotaStates(page.map((row) => String(row.id)));
        for (const s of states) quotaMap.set(s.accountId, s);
      } else if (getQuotaState !== undefined && page.length > 0) {
        const states = await Promise.all(page.map((row) => getQuotaState(String(row.id))));
        for (let i = 0; i < page.length; i++) {
          const s = states[i];
          if (s) quotaMap.set(String(page[i]!.id), s);
        }
      }
      const items = page.map((row) => {
        const state = quotaMap.get(String(row.id));
        const quota = state?.quota ?? null;
        return {
        id: String(row.id),
        provider: String(row.provider),
        providerId: String(row.provider),
        name: String(row.name),
        credentialKind: String(row.credential_kind),
        credentialHint: String(row.credential_hint ?? ""),
        priority: Number(row.priority ?? 100),
        active: row.active === true,
        health: null,
        quota: quota !== null
          ? {
              source: quota.source,
              status: quota.status,
              plan: quota.plan,
              windows: quota.windows,
              fetchedAt: quota.fetchedAt,
              lastAttemptAt: quota.lastAttemptAt,
              lastSuccessAt: quota.lastSuccessAt,
              error: quota.error,
            }
          : row.quota_status === null || row.quota_status === undefined
          ? null
          : {
              source: row.quota_source,
              status: row.quota_status,
              plan: row.quota_plan,
              windows: Array.isArray(row.quota_windows) ? row.quota_windows : [],
              fetchedAt: toIso(row.quota_fetched_at),
              lastAttemptAt: toIso(row.quota_last_attempt_at),
              lastSuccessAt: toIso(row.quota_last_success_at),
              error: row.quota_error,
            },
        };
      });
      const last = page[page.length - 1];
      return {
        items,
        nextCursor: hasMore && last !== undefined
          ? serializeAccountCursor(String(last.provider), Number(last.priority), String(last.id))
          : null,
      };
    },
    async create(body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      const id = typeof v.id === "string" && v.id.length > 0 ? v.id : crypto.randomUUID();
      const provider = String(v.provider ?? "");
      const credential = typeof v.credential === "string" ? v.credential : "";
      const identity = parseAccountIdentity(credential);
      const requestedName = typeof v.name === "string" ? v.name.trim() : "";
      const name = identity.name !== null && (requestedName.length === 0 || isGeneratedAccountName(requestedName, provider))
        ? identity.name
        : requestedName || id;
      const kind = typeof v.credentialKind === "string" ? v.credentialKind : "api_key";
      if (provider.length === 0) return { ok: false as const, status: 400 as const, code: "invalid_request" as const, message: "provider is required", data: undefined } as unknown as { ok: boolean; status: number; data: unknown; code?: string; message?: string };
      const definition = builtinProviderDefinitions().find((def: { id: string }) => def.id === provider);
      const defWithKind = definition as unknown as { credentialKinds?: readonly string[]; credentialKind?: string; access?: string } | undefined;
      const allowedKinds: ReadonlyArray<string> = definition !== undefined
        ? defWithKind?.credentialKinds ?? [defWithKind?.credentialKind ?? (defWithKind?.access === "oauth" ? "oauth" : "api_key")]
        : registry?.get(provider) !== undefined
          ? [registry.get(provider)!.metadata.credentialKind, ...(registry.get(provider)!.metadata.credentialKinds ?? [])]
          : ["api_key", "oauth", "none"];
      if (!allowedKinds.includes(kind)) return { ok: false as const, status: 400 as const, code: "invalid_request" as const, message: `credentialKind ${kind} is not supported for provider ${provider}`, data: undefined } as unknown as { ok: boolean; status: number; data: unknown; code?: string; message?: string };
      if (kind === "oauth") {
        const access = (definition as unknown as { access?: string })?.access;
        const isOAuthAccess = access === "oauth";
        const kindSupportsOAuth = allowedKinds.includes("oauth");
        if (!isOAuthAccess && !kindSupportsOAuth) return { ok: false as const, status: 400 as const, code: "invalid_request" as const, message: `provider ${provider} does not support oauth`, data: undefined } as unknown as { ok: boolean; status: number; data: unknown; code?: string; message?: string };
      }
      const key = resolveEncryptionKey();
      const encrypted = encryptWithKey(credential, key);
      const credentialHint = (typeof v.credentialHint === "string" ? v.credentialHint.trim() : "") || identity.hint || "";
      await pool`INSERT INTO provider_accounts (id, provider, name, credential_kind, credential_encrypted, credential_hint) VALUES (${id}, ${provider}, ${name}, ${kind}, ${encrypted}, ${credentialHint})`;
      await refreshAccountQuota(id);
      onMutation();
      return { ok: true, status: 201, data: { id } };
    },
    async update(id: string, body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      if (v.credentialKind !== undefined) return { ok: false as const, status: 400 as const, code: "invalid_request" as const, message: "credentialKind cannot be changed", data: undefined } as unknown as { ok: boolean; status: number; data: unknown };
      if (v.name) await pool`UPDATE provider_accounts SET name = ${String(v.name)}, updated_at = now() WHERE id = ${id}`;
      if (typeof v.active === "boolean") await pool`UPDATE provider_accounts SET active = ${v.active as boolean}, updated_at = now() WHERE id = ${id}`;
      onMutation();
      return { ok: true, status: 200, data: { id } };
    },
    async remove(id: string) {
      await pool`DELETE FROM provider_accounts WHERE id = ${id}`;
      onMutation();
      return { ok: true, status: 200, data: {} };
    },
    async oauthStart(_id: string, _body: unknown) {
      return { ok: false as const, status: 501 as const, code: "capability_unsupported" as const, message: "OAuth start is not configured for this account. Use POST /console/api/providers/:id/oauth/start with a real OAuth driver." };
    },
    async oauthCallback(_req: Request) {
      return { ok: false as const, status: 501 as const, code: "capability_unsupported" as const, message: "OAuth callback is not configured. Complete OAuth via POST /console/api/oauth/sessions/:sessionId/complete." };
    },
    async validateApiKey(id: string) {
      const rows = (await pool`SELECT provider, credential_kind FROM provider_accounts WHERE id = ${id} LIMIT 1`) as unknown as Array<{ provider: string; credential_kind: string }>;
      const account = rows[0];
      if (account === undefined) return { ok: false as const, status: 404 as const, code: "model_not_found" as const, message: "account not found" };
      if (account.credential_kind !== "api_key") return { ok: false as const, status: 400 as const, code: "invalid_request" as const, message: "only API-key accounts can be validated here" };
      if (registry === undefined || getCredential === undefined) return { ok: false as const, status: 501 as const, code: "capability_unsupported" as const, message: "API-key validation is not configured" };
      const stored = await getCredential(id);
      const credential = stored === null ? null : extractAccessTokenOrRaw(stored);
      if (credential === null || credential.length === 0) return { ok: false as const, status: 401 as const, code: "authentication_failed" as const, message: "API-key credential is unavailable" };
      const adapter = registry.get(account.provider);
      const discoverModels = adapter?.discoverModels;
      if (discoverModels === undefined) return { ok: false as const, status: 501 as const, code: "capability_unsupported" as const, message: `API-key validation is not supported for ${account.provider}` };
      try {
        const models = await discoverModels({ credential, signal: undefined });
        if (models === null) return { ok: false as const, status: 502 as const, code: "provider_unavailable" as const, message: `API-key validation failed for ${account.provider}` };
        return { ok: true as const, status: 200 as const, data: { id, provider: account.provider, valid: true, modelCount: models.length } };
      } catch (error) {
        return { ok: false as const, status: 502 as const, code: "provider_unavailable" as const, message: error instanceof Error ? error.message : `API-key validation failed for ${account.provider}` };
      }
    },
    async quotaRefresh(id: string) {
      try {
        const quota = await refreshAccountQuota(id);
        return { ok: quota.error === null, status: quota.error === null ? 200 : 502, data: { id, quota }, message: quota.error ?? undefined };
      } catch (error) {
        return { ok: false, status: 404, message: error instanceof Error ? error.message : "quota refresh failed" };
      }
    },
    async quota(id: string) {
      const state = getQuotaState === undefined ? undefined : await getQuotaState(id);
      if (state?.quota !== undefined && state.quota !== null) {
        return { accountId: id, quota: state.quota, health: null };
      }
      const rows = (await pool`SELECT status, source, plan, windows_json, fetched_at, last_attempt_at, last_success_at, error FROM provider_account_quota WHERE account_id = ${id}`) as unknown as Array<Record<string, unknown>>;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        accountId: id,
        quota: {
          source: row.source ?? null,
          status: row.status ?? "unknown",
          plan: row.plan ?? null,
          windows: Array.isArray(row.windows_json) ? row.windows_json : [],
          fetchedAt: toIso(row.fetched_at),
          lastAttemptAt: toIso(row.last_attempt_at),
          lastSuccessAt: toIso(row.last_success_at),
          error: (row.error as string | null) ?? null,
        },
        health: null,
      };
    },
    async batchUpdate(body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      const ids = Array.isArray(v.ids) ? (v.ids as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 500) : [];
      if (ids.length === 0) return { ok: false, status: 400, message: "ids required" };
      const active = v.active;
      if (typeof active !== "boolean") return { ok: false, status: 400, message: "active boolean required" };
      // optional provider filter is accepted but not required for update
      await pool`UPDATE provider_accounts SET active = ${active}, updated_at = now() WHERE id IN ${pool(ids)}`;
      onMutation();
      return { ok: true, status: 200, data: { updated: ids.length, ids, active } };
    },
    async batchDelete(body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      const ids = Array.isArray(v.ids) ? (v.ids as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 500) : [];
      if (ids.length === 0) return { ok: false, status: 400, message: "ids required" };
      await pool`DELETE FROM provider_accounts WHERE id IN ${pool(ids)}`;
      onMutation();
      return { ok: true, status: 200, data: { deleted: ids.length, ids } };
    },
    async oauthRefresh(body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      const accountId = typeof v.accountId === "string" ? v.accountId : typeof v.id === "string" ? v.id : "";
      if (!accountId) return { ok: false as const, status: 400 as const, code: "invalid_request" as const, message: "accountId required" };
      const rows = (await pool`SELECT credential_kind FROM provider_accounts WHERE id = ${accountId} LIMIT 1`) as unknown as Array<{ credential_kind: string }>;
      if (rows[0] === undefined) return { ok: false as const, status: 404 as const, code: "model_not_found" as const, message: "account not found" };
      if (rows[0].credential_kind !== "oauth") return { ok: false as const, status: 400 as const, code: "invalid_request" as const, message: "only OAuth accounts can be refreshed here" };
      if (refreshOAuthAccount === undefined) return { ok: false as const, status: 501 as const, code: "capability_unsupported" as const, message: "OAuth token refresh is not configured" };
      try {
        const token = await refreshOAuthAccount(accountId);
        onMutation();
        return { ok: true as const, status: 200 as const, data: { accountId, refreshed: true, expiresAtMs: token.expiresAtMs } };
      } catch (error) {
        return { ok: false as const, status: 502 as const, code: "provider_unavailable" as const, message: error instanceof Error ? error.message : "OAuth token refresh failed" };
      }
    },
    async quotaRefreshBulk(body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      const ids = Array.isArray(v.accountIds) ? v.accountIds : Array.isArray(v.ids) ? v.ids : [];
      const list = (ids as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 500);
      if (list.length === 0) return { ok: false, status: 400, message: "accountIds required" };
      // Batched parallel refresh — preserves same response shape while eliminating sequential N+1 amplification
      const results = await Promise.allSettled(list.map((accountId) => refreshAccountQuota(accountId)));
      let queued = results.length;
      let active = 0;
      for (const r of results) if (r.status === "fulfilled" && r.value.error === null) active += 1;
      return { ok: true, status: 200, data: { queued, active, accountIds: list } };
    },
  };
}

export type AccountsService = ReturnType<typeof createAccountsService>;
