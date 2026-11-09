import { apiKeyHash, encryptWithKey, keyPrefix, resolveEncryptionKey, toIso } from "../crypto.js";
import { parseStringArray } from "../../console/services/api-keys.js";
import { createDrizzlePG, type DrizzlePG } from "../db.js";
import { apiKeys } from "../schema/pg.js";
import { eq, and, isNull, sql } from "drizzle-orm";

/**
 * Helper: map Drizzle camelCase row to snake_case Record as legacy callers expect.
 * Keeps API_KEY_COLUMNS shape: id, name, key_prefix, active, ...
 */
function toSnakeRow(row: Record<string, unknown>): Record<string, unknown> {
  // Drizzle returns camelCase keys; map to snake_case for backward compatibility
  // Only map the columns that are actually selected
  const m: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    // Convert camelCase to snake_case (simple)
    const snake = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    m[snake] = v;
    // Also keep camelCase for Drizzle consumers that use it
    m[k] = v;
  }
  return m;
}

export function createApiKeyRepository(db: DrizzlePG = createDrizzlePG()) {
  return {
    async list() {
      const rows = await db.select().from(apiKeys).orderBy(apiKeys.createdAt);
      return rows.map((r) => toSnakeRow(r as unknown as Record<string, unknown>));
    },
    async getById(id: string) {
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
      const row = rows[0];
      return row ? (toSnakeRow(row as unknown as Record<string, unknown>) as Record<string, unknown>) : null;
    },
    async getBySecret(secret: string) {
      const hash = apiKeyHash(secret);
      const rows = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.keyHash, hash), eq(apiKeys.active, true), isNull(apiKeys.revokedAt)))
        .limit(1);
      const row = rows[0];
      return row ? (toSnakeRow(row as unknown as Record<string, unknown>) as Record<string, unknown>) : null;
    },
    async getBySecretForAuth(secret: string): Promise<{ id: string; active: boolean; revokedAt: string | null; scopes: null } | null> {
      const hash = apiKeyHash(secret);
      const rows = await db
        .select({ id: apiKeys.id, active: apiKeys.active, revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, hash))
        .limit(1);
      const row = rows[0] as unknown as { id: string; active: boolean; revokedAt: string | null } | undefined;
      if (!row) return null;
      return { id: row.id, active: Boolean(row.active), revokedAt: toIso(row.revokedAt), scopes: null };
    },
    async create(input: { id: string; name: string; key: string; [k: string]: unknown }) {
      const hash = apiKeyHash(input.key as string);
      const prefix = keyPrefix(input.key as string);
      const active = input.active !== undefined ? Boolean(input.active) : true;
      const encryptedKey = encryptWithKey(String(input.key), resolveEncryptionKey());

      // Build optional fields
      const providerAllowlist = input.providerAllowlist !== undefined ? (() => {
        const arr = parseStringArray(input.providerAllowlist);
        return arr;
      })() : undefined;
      const modelAllowlist = input.modelAllowlist !== undefined ? parseStringArray(input.modelAllowlist) : undefined;
      const modelDenylist = input.modelDenylist !== undefined ? parseStringArray(input.modelDenylist) : undefined;

      const insertValues: Record<string, unknown> = {
        id: input.id,
        name: input.name,
        keyHash: hash,
        keyPrefix: prefix,
        keyEncrypted: encryptedKey,
        active,
      };
      if (input.rateLimitRpm !== undefined) insertValues.rateLimitRpm = input.rateLimitRpm as number | null;
      if (input.dailyTokenLimit !== undefined) insertValues.dailyTokenLimit = input.dailyTokenLimit as number | null;
      if (input.monthlyTokenLimit !== undefined) insertValues.monthlyTokenLimit = input.monthlyTokenLimit as number | null;
      if (input.oneTimeTokenLimit !== undefined) insertValues.oneTimeTokenLimit = input.oneTimeTokenLimit as number | null;
      if (input.maxConcurrentRequests !== undefined) insertValues.maxConcurrentRequests = input.maxConcurrentRequests as number | null;
      if (providerAllowlist !== undefined) insertValues.providerAllowlist = providerAllowlist as unknown as never;
      if (modelAllowlist !== undefined) insertValues.modelAllowlist = modelAllowlist as unknown as never;
      if (modelDenylist !== undefined) insertValues.modelDenylist = modelDenylist as unknown as never;

      // Drizzle insert — jsonb columns accept JS arrays/null directly
      await db.insert(apiKeys).values(insertValues as never);

      const rows = await db
        .select({ id: apiKeys.id, name: apiKeys.name, keyPrefix: apiKeys.keyPrefix, active: apiKeys.active, createdAt: apiKeys.createdAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, input.id))
        .limit(1);
      const row = rows[0] as unknown as Record<string, unknown> | undefined;
      return row ? toSnakeRow(row as Record<string, unknown>) : ({} as Record<string, unknown>);
    },
    async touch(id: string) {
      await db.update(apiKeys).set({ lastUsedAt: sql`now()` as unknown as string }).where(eq(apiKeys.id, id));
    },
    async revoke(id: string) {
      await db.update(apiKeys).set({ revokedAt: sql`now()` as unknown as string, active: false }).where(eq(apiKeys.id, id));
    },
    async consumeOneTimeTokens(id: string, tokens: number) {
      const n = Math.max(0, Math.floor(tokens));
      if (n <= 0) return;
      await db
        .update(apiKeys)
        .set({ oneTimeTokensUsed: sql`COALESCE(${apiKeys.oneTimeTokensUsed}, 0) + ${n}::int` as unknown as number })
        .where(eq(apiKeys.id, id));
    },
    async update(id: string, patch: Record<string, unknown>) {
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.active !== undefined) set.active = Boolean(patch.active);
      if (patch.rateLimitRpm !== undefined) set.rateLimitRpm = patch.rateLimitRpm as number | null;
      if (patch.dailyTokenLimit !== undefined) set.dailyTokenLimit = patch.dailyTokenLimit as number | null;
      if (patch.monthlyTokenLimit !== undefined) set.monthlyTokenLimit = patch.monthlyTokenLimit as number | null;
      if (patch.oneTimeTokenLimit !== undefined) set.oneTimeTokenLimit = patch.oneTimeTokenLimit as number | null;
      if (patch.maxConcurrentRequests !== undefined) set.maxConcurrentRequests = patch.maxConcurrentRequests as number | null;
      if (patch.providerAllowlist !== undefined) set.providerAllowlist = parseStringArray(patch.providerAllowlist) as unknown as never;
      if (patch.modelAllowlist !== undefined) set.modelAllowlist = parseStringArray(patch.modelAllowlist) as unknown as never;
      if (patch.modelDenylist !== undefined) set.modelDenylist = parseStringArray(patch.modelDenylist) as unknown as never;
      // Also support snake_case keys directly (legacy callers)
      if (patch.rate_limit_rpm !== undefined) set.rateLimitRpm = patch.rate_limit_rpm as number | null;
      if (patch.daily_token_limit !== undefined) set.dailyTokenLimit = patch.daily_token_limit as number | null;
      if (patch.monthly_token_limit !== undefined) set.monthlyTokenLimit = patch.monthly_token_limit as number | null;
      if (patch.one_time_token_limit !== undefined) set.oneTimeTokenLimit = patch.one_time_token_limit as number | null;
      if (patch.max_concurrent_requests !== undefined) set.maxConcurrentRequests = patch.max_concurrent_requests as number | null;
      if (patch.provider_allowlist !== undefined) set.providerAllowlist = parseStringArray(patch.provider_allowlist) as unknown as never;
      if (patch.model_allowlist !== undefined) set.modelAllowlist = parseStringArray(patch.model_allowlist) as unknown as never;
      if (patch.model_denylist !== undefined) set.modelDenylist = parseStringArray(patch.model_denylist) as unknown as never;

      if (Object.keys(set).length > 0) {
        await db.update(apiKeys).set(set as never).where(eq(apiKeys.id, id));
      }
      const rows = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
      return (rows[0] as unknown as Record<string, unknown>) ?? null;
    },
  };
}
