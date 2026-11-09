import { createHash } from "node:crypto";
import { createDrizzlePG, type DrizzlePG } from "../db.js";
import { shareLinks, apiKeys } from "../schema/pg.js";
import { eq, and, sql } from "drizzle-orm";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface ShareRecord {
  readonly id: string;
  readonly apiKeyId: string;
  readonly tokenHash: string;
  readonly kind: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

/** API-key fields authorized for a valid share-link lookup. */
export interface ShareApiKeyRow {
  readonly id: string;
  readonly name: string;
  readonly key_prefix: string;
  readonly key_encrypted: string | null;
  readonly active: boolean;
  readonly rate_limit_rpm: number | null;
  readonly daily_token_limit: number | null;
  readonly monthly_token_limit: number | null;
  readonly one_time_token_limit: number | null;
  readonly one_time_tokens_used: number;
  readonly max_concurrent_requests: number | null;
  readonly provider_allowlist: unknown;
  readonly model_allowlist: unknown;
  readonly model_denylist: unknown;
  readonly notes_title: string | null;
  readonly notes_subtitle: string | null;
  readonly notes_body: string | null;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly share_created_at: string;
  readonly expires_at: string | null;
}

/** Creates the share-link repository over the canonical Drizzle PostgreSQL client. */
export function createShareRepository(db: DrizzlePG = createDrizzlePG()) {
  return {
    async getByToken(token: string) {
      const hash = sha256Hex(token);
      const rows = await db
        .select({
          id: shareLinks.id,
          api_key_id: shareLinks.apiKeyId,
          token_hash: shareLinks.tokenHash,
          kind: shareLinks.kind,
          active: shareLinks.active,
          created_at: shareLinks.createdAt,
          expires_at: shareLinks.expiresAt,
        })
        .from(shareLinks)
        .where(and(eq(shareLinks.tokenHash, hash), eq(shareLinks.active, true), sql`(${shareLinks.expiresAt} IS NULL OR ${shareLinks.expiresAt} > now())`))
        .limit(1);
      return (rows[0] as unknown as Record<string, unknown> | undefined) ?? null;
    },

    async getApiKeyByShareToken(token: string): Promise<ShareApiKeyRow | null> {
      const hash = sha256Hex(token);
      const rows = await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          key_prefix: apiKeys.keyPrefix,
          key_encrypted: apiKeys.keyEncrypted,
          active: apiKeys.active,
          rate_limit_rpm: apiKeys.rateLimitRpm,
          daily_token_limit: apiKeys.dailyTokenLimit,
          monthly_token_limit: apiKeys.monthlyTokenLimit,
          one_time_token_limit: apiKeys.oneTimeTokenLimit,
          one_time_tokens_used: apiKeys.oneTimeTokensUsed,
          max_concurrent_requests: apiKeys.maxConcurrentRequests,
          provider_allowlist: apiKeys.providerAllowlist,
          model_allowlist: apiKeys.modelAllowlist,
          model_denylist: apiKeys.modelDenylist,
          notes_title: apiKeys.notesTitle,
          notes_subtitle: apiKeys.notesSubtitle,
          notes_body: apiKeys.notesBody,
          created_at: apiKeys.createdAt,
          last_used_at: apiKeys.lastUsedAt,
          share_created_at: shareLinks.createdAt,
          expires_at: shareLinks.expiresAt,
        })
        .from(shareLinks)
        .innerJoin(apiKeys, eq(shareLinks.apiKeyId, apiKeys.id))
        .where(
          and(
            eq(shareLinks.tokenHash, hash),
            eq(shareLinks.kind, "monitor"),
            eq(shareLinks.active, true),
            sql`(${shareLinks.expiresAt} IS NULL OR ${shareLinks.expiresAt} > now())`,
            eq(apiKeys.active, true),
            sql`${apiKeys.revokedAt} IS NULL`,
          ),
        )
        .limit(1);
      return (rows[0] as unknown as ShareApiKeyRow | undefined) ?? null;
    },

    async consumeSetupToken(token: string): Promise<ShareApiKeyRow | null> {
      const hash = sha256Hex(token);
      const rows = await db.execute(sql<ShareApiKeyRow>`
        UPDATE ${shareLinks} AS s
        SET used_at = now(), active = false
        FROM ${apiKeys} AS k
        WHERE s.token_hash = ${hash}
          AND s.kind = 'setup'
          AND s.active = true
          AND s.used_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > now())
          AND k.id = s.api_key_id
          AND k.active = true
          AND k.revoked_at IS NULL
        RETURNING k.id, k.name, k.key_prefix, k.key_encrypted, k.active, k.rate_limit_rpm, k.daily_token_limit, k.monthly_token_limit, k.one_time_token_limit, k.one_time_tokens_used, k.max_concurrent_requests, k.provider_allowlist, k.model_allowlist, k.model_denylist, k.notes_title, k.notes_subtitle, k.notes_body, k.created_at, k.last_used_at, s.created_at AS share_created_at, s.expires_at
      `);
      return (rows[0] as ShareApiKeyRow | undefined) ?? null;
    },

    async touchView(token: string) {
      const hash = sha256Hex(token);
      await db.update(shareLinks).set({ lastViewedAt: sql`now()` as unknown as string }).where(eq(shareLinks.tokenHash, hash));
    },
  };
}
