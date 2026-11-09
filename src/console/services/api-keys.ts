import { createHash } from "node:crypto";
import type { PostgresPool } from "../../persistence/pool.js";
import { decryptWithKey, encryptWithKey, resolveEncryptionKey } from "../../persistence/crypto.js";
import type { PublicDependencies } from "../../api/v1.js";

/** A user-authored quote displayed with an API key. */
export interface ApiKeyQuote {
  readonly quoteBigText: string | null;
  readonly quoteSubText: string | null;
  readonly quoteBody: string | null;
}

/** The console representation of a persisted API key. */
export interface ApiKeyListItem extends ApiKeyQuote {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly active: boolean;
  readonly rateLimitRpm: number | null;
  readonly dailyTokenLimit: number | null;
  readonly monthlyTokenLimit: number | null;
  readonly oneTimeTokenLimit: number | null;
  readonly oneTimeTokensUsed: number;
  readonly maxConcurrentRequests: number | null;
  readonly providerAllowlist: string[] | null;
  readonly modelAllowlist: string[] | null;
  readonly modelDenylist: string[] | null;
  readonly totalUsage: number;
  readonly totalRequests: number;
  readonly lastUsedAt: string | null;
  readonly createdAt: string | null;
  readonly revokedAt: string | null;
}

/** Mutable fields accepted by the API-key patch endpoint. */
export interface ApiKeyPatch {
  readonly name?: string;
  readonly rateLimitRpm?: number | null;
  readonly dailyTokenLimit?: number | null;
  readonly monthlyTokenLimit?: number | null;
  readonly oneTimeTokenLimit?: number | null;
  readonly maxConcurrentRequests?: number | null;
  readonly providerAllowlist?: string[] | null;
  readonly modelAllowlist?: string[] | null;
  readonly modelDenylist?: string[] | null;
  readonly quoteBigText?: string | null;
  readonly quoteSubText?: string | null;
  readonly quoteBody?: string | null;
}

/** Public monitor payload fields shared by the API-key service and share router. */
export interface ShareMonitorData {
  readonly name: string;
  readonly active: boolean;
  readonly apiKey: {
    readonly id: string;
    readonly prefix: string;
    readonly key: string | null;
    readonly active: boolean;
  };
  readonly providerAllowlist: string[] | null;
  readonly modelAllowlist: string[] | null;
  readonly modelDenylist: string[] | null;
  readonly notes: {
    readonly title: string | null;
    readonly subtitle: string | null;
    readonly body: string | null;
  };
  readonly baseUrl: string;
}

/** A cursor-paginated account response. */
export interface AccountPageResult<TItem> {
  readonly items: TItem[];
  readonly nextCursor: string | null;
}

interface ApiKeyUsagePort {
  getApiKeyTotals(apiKeyId: string): Promise<{ readonly totalTokens: number; readonly totalRequests: number }>;
  getApiKeyTotalsBatch?(apiKeyIds: readonly string[]): Promise<Record<string, { readonly totalTokens: number; readonly totalRequests: number }>>;
}

/** Parses a JSON or legacy comma-separated ACL value into its canonical array form. */
export function parseStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  try {
    return parseStringArray(JSON.parse(text) as unknown);
  } catch {
    const items = text.split(",").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : null;
  }
}

/** Serializes a canonical ACL array for JSONB persistence. */
export function serializeStringArray(value: readonly string[] | null): string | null {
  if (value === null) return null;
  const items = parseStringArray(value);
  return items === null ? null : JSON.stringify(items);
}

interface ApiKeyListRow {
  readonly id: string;
  readonly name: string;
  readonly key_prefix: string;
  readonly active: boolean;
  readonly rate_limit_rpm: number | null;
  readonly daily_token_limit: number | null;
  readonly monthly_token_limit: number | null;
  readonly one_time_token_limit: number | null;
  readonly one_time_tokens_used: number | null;
  readonly max_concurrent_requests: number | null;
  readonly provider_allowlist: unknown;
  readonly model_allowlist: unknown;
  readonly model_denylist: unknown;
  readonly notes_title: string | null;
  readonly notes_subtitle: string | null;
  readonly notes_body: string | null;
  readonly last_used_at: unknown;
  readonly created_at: unknown;
  readonly revoked_at: unknown;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Encrypts and removes the retired manually-added plaintext API-key column.
 *
 * @param pool - PostgreSQL authority after schema migrations have completed.
 * @returns Resolves after the legacy column is removed, or immediately when absent.
 */
export async function migrateLegacyApiKeySecrets(pool: PostgresPool): Promise<void> {
  const legacyColumn = (await pool`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'api_keys'
      AND column_name = 'key'
    LIMIT 1
  `) as unknown as Array<{ "?column?": number }>;
  if (legacyColumn.length === 0) return;

  const rows = (await pool`SELECT id, "key" AS legacy_key FROM api_keys WHERE "key" IS NOT NULL AND "key" <> ''`) as unknown as Array<{ id: string; legacy_key: string }>;
  const key = resolveEncryptionKey();
  for (const row of rows) {
    await pool`UPDATE api_keys SET key_encrypted = ${encryptWithKey(row.legacy_key, key)}, "key" = NULL WHERE id = ${row.id}`;
  }
  await (pool as unknown as { unsafe(query: string): Promise<unknown> }).unsafe('ALTER TABLE api_keys DROP COLUMN "key"');
}

/**
 * Public apiKeys port + console apiKeys service — verbatim from bootstrap 455-487 + 885-911.
 * The Map cache and constants are preserved verbatim.
 */
export function createApiKeysServices(pool: PostgresPool, options: { readonly cacheTtlMs?: number; readonly now?: () => number; readonly usage?: ApiKeyUsagePort } = {}): {
  readonly publicApiKeys: PublicDependencies["apiKeys"];
  readonly consoleApiKeys: { list(): Promise<{ readonly items: ApiKeyListItem[] }>; create(body: unknown): Promise<{ ok: boolean; status: number; data?: unknown; message?: string }>; revoke(id: string): Promise<{ ok: boolean; status: number; data: unknown }>; remove(id: string): Promise<{ ok: boolean; status: number; data?: unknown; message?: string }>; update(id: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown }>; share(id: string, options?: { readonly kind?: "monitor" | "setup"; readonly expiresAt?: string | null }): Promise<{ ok: boolean; status: number; data?: unknown; message?: string }>; credential(id: string): Promise<unknown> };
  readonly cache: Map<string, { readonly record: Awaited<ReturnType<PublicDependencies["apiKeys"]["getBySecret"]>>; readonly expiresAt: number }>;
} {
  const apiKeyCache = new Map<string, { readonly record: Awaited<ReturnType<PublicDependencies["apiKeys"]["getBySecret"]>>; readonly expiresAt: number }>();
  const now = options.now ?? Date.now;
  const API_KEY_CACHE_TTL_MS = Math.min(Math.max(Math.floor(options.cacheTtlMs ?? 30_000), 1), 60_000);
  const MAX_API_KEY_CACHE_ENTRIES = 5_000;
  const cacheApiKey = (hash: string, record: NonNullable<Awaited<ReturnType<PublicDependencies["apiKeys"]["getBySecret"]>>>): void => {
    if (apiKeyCache.size >= MAX_API_KEY_CACHE_ENTRIES) {
      const oldest = apiKeyCache.keys().next().value;
      if (typeof oldest === "string") apiKeyCache.delete(oldest);
    }
    apiKeyCache.delete(hash);
    apiKeyCache.set(hash, { record, expiresAt: now() + API_KEY_CACHE_TTL_MS });
  };
  const apiKeys: PublicDependencies["apiKeys"] = {
    async getBySecret(secret: string) {
      const hash = sha256Hex(secret);
      const cached = apiKeyCache.get(hash);
      if (cached !== undefined && cached.expiresAt > now()) {
        apiKeyCache.delete(hash);
        apiKeyCache.set(hash, cached);
        return cached.record;
      }
      if (cached !== undefined) apiKeyCache.delete(hash);
      const rows = (await pool`SELECT id, active, revoked_at FROM api_keys WHERE key_hash = ${hash}`) as unknown as Array<{ id: string; active: boolean; revoked_at: string | null }>;
      const row = rows[0];
      if (!row) return null;
      const record = { id: row.id, active: row.active, revokedAt: toIso(row.revoked_at), scopes: null };
      cacheApiKey(hash, record);
      return record;
    },
    async touch(id: string) {
      await pool`UPDATE api_keys SET last_used_at = now() WHERE id = ${id}`;
    },
  };

  const consoleApiKeys = {
    async list() {
      const rows = (await pool`SELECT id, name, key_prefix, active, rate_limit_rpm, daily_token_limit, monthly_token_limit, one_time_token_limit, one_time_tokens_used, max_concurrent_requests, provider_allowlist, model_allowlist, model_denylist, notes_title, notes_subtitle, notes_body, last_used_at, created_at, revoked_at FROM api_keys ORDER BY created_at`) as unknown as ApiKeyListRow[];
      // Batched totals — single query when port supports it, eliminates N+1 per-row lookups
      let usageMap: Record<string, { readonly totalTokens: number; readonly totalRequests: number }> = {};
      if (rows.length > 0 && options.usage) {
        if (options.usage.getApiKeyTotalsBatch) {
          usageMap = await options.usage.getApiKeyTotalsBatch(rows.map((r) => r.id));
        } else {
          const entries = await Promise.all(rows.map(async (row) => [row.id, await options.usage!.getApiKeyTotals(row.id)] as const));
          for (const [id, totals] of entries) usageMap[id] = totals;
        }
      }
      return {
        items: rows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          keyPrefix: String(row.key_prefix),
          active: row.active === true,
          rateLimitRpm: row.rate_limit_rpm ?? null,
          dailyTokenLimit: row.daily_token_limit ?? null,
          monthlyTokenLimit: row.monthly_token_limit ?? null,
          oneTimeTokenLimit: row.one_time_token_limit ?? null,
          oneTimeTokensUsed: row.one_time_tokens_used ?? 0,
          maxConcurrentRequests: row.max_concurrent_requests ?? null,
          providerAllowlist: parseStringArray(row.provider_allowlist),
          modelAllowlist: parseStringArray(row.model_allowlist),
          modelDenylist: parseStringArray(row.model_denylist),
          quoteBigText: row.notes_title ?? null,
          quoteSubText: row.notes_subtitle ?? null,
          quoteBody: row.notes_body ?? null,
          totalUsage: usageMap[row.id]?.totalTokens ?? 0,
          totalRequests: usageMap[row.id]?.totalRequests ?? 0,
          lastUsedAt: toIso(row.last_used_at),
          createdAt: toIso(row.created_at),
          revokedAt: toIso(row.revoked_at),
        })),
      };
    },
    async create(body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      const id = typeof v.id === "string" ? v.id : crypto.randomUUID();
      const name = String(v.name ?? id);
      const key = String(v.key ?? crypto.randomUUID());
      const hash = sha256Hex(key);
      const prefix = key.slice(0, 8);
      const rateLimitRpm = v.rateLimitRpm !== undefined && v.rateLimitRpm !== null ? Number(v.rateLimitRpm) : null;
      const dailyTokenLimit = v.dailyTokenLimit !== undefined && v.dailyTokenLimit !== null ? Number(v.dailyTokenLimit) : null;
      const monthlyTokenLimit = v.monthlyTokenLimit !== undefined && v.monthlyTokenLimit !== null ? Number(v.monthlyTokenLimit) : null;
      const oneTimeTokenLimit = v.oneTimeTokenLimit !== undefined && v.oneTimeTokenLimit !== null ? Number(v.oneTimeTokenLimit) : null;
      const maxConcurrentRequests = v.maxConcurrentRequests !== undefined && v.maxConcurrentRequests !== null ? Number(v.maxConcurrentRequests) : null;
      const providerAllowlist = serializeStringArray(parseStringArray(v.providerAllowlist));
      const modelAllowlist = serializeStringArray(parseStringArray(v.modelAllowlist));
      const modelDenylist = serializeStringArray(parseStringArray(v.modelDenylist));
      const quoteBigText = typeof v.quoteBigText === "string" && v.quoteBigText.trim() !== "" ? v.quoteBigText.trim() : null;
      const quoteSubText = typeof v.quoteSubText === "string" && v.quoteSubText.trim() !== "" ? v.quoteSubText.trim() : null;
      const quoteBody = typeof v.quoteBody === "string" && v.quoteBody.trim() !== "" ? v.quoteBody.trim() : null;
      const keyEncrypted = encryptWithKey(key, resolveEncryptionKey());
      await pool`INSERT INTO api_keys (id, name, key_hash, key_prefix, key_encrypted, rate_limit_rpm, daily_token_limit, monthly_token_limit, one_time_token_limit, max_concurrent_requests, provider_allowlist, model_allowlist, model_denylist, notes_title, notes_subtitle, notes_body) VALUES (${id}, ${name}, ${hash}, ${prefix}, ${keyEncrypted}, ${rateLimitRpm}, ${dailyTokenLimit}, ${monthlyTokenLimit}, ${oneTimeTokenLimit}, ${maxConcurrentRequests}, ${providerAllowlist}::jsonb, ${modelAllowlist}::jsonb, ${modelDenylist}::jsonb, ${quoteBigText}, ${quoteSubText}, ${quoteBody})`;
      cacheApiKey(hash, { id, active: true, revokedAt: null, scopes: null });
      return { ok: true as const, status: 201 as const, data: { id, key } };
    },
    async revoke(id: string) {
      await pool`UPDATE api_keys SET revoked_at = now(), active = false WHERE id = ${id}`;
      for (const [hash, cached] of apiKeyCache) if (cached.record?.id === id) apiKeyCache.delete(hash);
      return { ok: true as const, status: 200 as const, data: {} };
    },
    async remove(id: string) {
      const rows = (await pool`SELECT active FROM api_keys WHERE id = ${id} LIMIT 1`) as unknown as Array<{ active: boolean }>;
      const row = rows[0];
      if (row === undefined) return { ok: false as const, status: 404 as const, message: `api key ${id} not found` };
      if (row.active) {
        await pool`UPDATE api_keys SET revoked_at = now(), active = false WHERE id = ${id}`;
        for (const [hash, cached] of apiKeyCache) if (cached.record?.id === id) apiKeyCache.delete(hash);
        return { ok: true as const, status: 200 as const, data: { action: "revoked" as const } };
      }
      await pool`DELETE FROM api_keys WHERE id = ${id}`;
      for (const [hash, cached] of apiKeyCache) if (cached.record?.id === id) apiKeyCache.delete(hash);
      return { ok: true as const, status: 200 as const, data: { action: "deleted" as const } };
    },
    async update(id: string, body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      if (v.name !== undefined) await pool`UPDATE api_keys SET name = ${String(v.name)} WHERE id = ${id}`;
      if (v.rateLimitRpm !== undefined) await pool`UPDATE api_keys SET rate_limit_rpm = ${v.rateLimitRpm === null ? null : Number(v.rateLimitRpm)} WHERE id = ${id}`;
      if (v.dailyTokenLimit !== undefined) await pool`UPDATE api_keys SET daily_token_limit = ${v.dailyTokenLimit === null ? null : Number(v.dailyTokenLimit)} WHERE id = ${id}`;
      if (v.monthlyTokenLimit !== undefined) await pool`UPDATE api_keys SET monthly_token_limit = ${v.monthlyTokenLimit === null ? null : Number(v.monthlyTokenLimit)} WHERE id = ${id}`;
      if (v.oneTimeTokenLimit !== undefined) await pool`UPDATE api_keys SET one_time_token_limit = ${v.oneTimeTokenLimit === null ? null : Number(v.oneTimeTokenLimit)} WHERE id = ${id}`;
      if (v.maxConcurrentRequests !== undefined) await pool`UPDATE api_keys SET max_concurrent_requests = ${v.maxConcurrentRequests === null ? null : Number(v.maxConcurrentRequests)} WHERE id = ${id}`;
      if (v.providerAllowlist !== undefined) {
        const val = serializeStringArray(parseStringArray(v.providerAllowlist));
        await pool`UPDATE api_keys SET provider_allowlist = ${val}::jsonb WHERE id = ${id}`;
      }
      if (v.modelAllowlist !== undefined) {
        const val = serializeStringArray(parseStringArray(v.modelAllowlist));
        await pool`UPDATE api_keys SET model_allowlist = ${val}::jsonb WHERE id = ${id}`;
      }
      if (v.modelDenylist !== undefined) {
        const val = serializeStringArray(parseStringArray(v.modelDenylist));
        await pool`UPDATE api_keys SET model_denylist = ${val}::jsonb WHERE id = ${id}`;
      }
      if (v.quoteBigText !== undefined) await pool`UPDATE api_keys SET notes_title = ${v.quoteBigText === null ? null : String(v.quoteBigText).trim() || null} WHERE id = ${id}`;
      if (v.quoteSubText !== undefined) await pool`UPDATE api_keys SET notes_subtitle = ${v.quoteSubText === null ? null : String(v.quoteSubText).trim() || null} WHERE id = ${id}`;
      if (v.quoteBody !== undefined) await pool`UPDATE api_keys SET notes_body = ${v.quoteBody === null ? null : String(v.quoteBody).trim() || null} WHERE id = ${id}`;
      return { ok: true as const, status: 200 as const, data: {} };
    },
    async share(id: string, options: { readonly kind?: "monitor" | "setup"; readonly expiresAt?: string | null } = {}) {
      const rows = (await pool`SELECT id, active, revoked_at FROM api_keys WHERE id = ${id} LIMIT 1`) as unknown as Array<{ id: string; active: boolean; revoked_at: string | null }>;
      if (rows.length === 0) return { ok: false as const, status: 404 as const, message: `api key ${id} not found` };
      if (rows[0]?.active !== true || rows[0].revoked_at !== null) return { ok: false as const, status: 404 as const, message: "api key is unavailable" };
      const kind = options.kind ?? "monitor";
      if (kind !== "monitor" && kind !== "setup") return { ok: false as const, status: 400 as const, message: "invalid share kind" };
      const expiresAt = options.expiresAt ?? null;
      if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) return { ok: false as const, status: 400 as const, message: "invalid share expiry" };
      const token = crypto.randomUUID().replaceAll("-", "");
      const tokenHash = sha256Hex(token);
      const shareId = crypto.randomUUID();
      await pool`INSERT INTO share_links (id, api_key_id, token_hash, kind, active, expires_at) VALUES (${shareId}, ${id}, ${tokenHash}, ${kind}, ${true}, ${expiresAt}::timestamptz)`;
      const base = typeof Bun !== "undefined" && Bun.env.PUBLIC_ORIGIN ? String(Bun.env.PUBLIC_ORIGIN) : "";
      const path = kind === "setup" ? `/share/setup/${token}` : `/share/${token}`;
      const url = base ? `${base.replace(/\/$/, "")}${path}` : path;
      return { ok: true as const, status: 201 as const, data: { id: shareId, url, token } };
    },
    async credential(id: string) {
      const rows = (await pool`SELECT key_encrypted, key_prefix FROM api_keys WHERE id = ${id} LIMIT 1`) as unknown as Array<{ key_encrypted: string | null; key_prefix: string }>;
      const row = rows[0];
      if (!row) return null;
      let key: string | null = null;
      if (row.key_encrypted !== null) {
        try {
          key = decryptWithKey(row.key_encrypted, resolveEncryptionKey());
        } catch {
          key = null;
        }
      }
      return { key, prefix: row.key_prefix };
    },
  };

  return { publicApiKeys: apiKeys, consoleApiKeys, cache: apiKeyCache };
}
