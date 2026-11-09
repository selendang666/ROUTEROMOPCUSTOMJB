import { decryptWithKey, resolveEncryptionKey } from "../../persistence/crypto.js";
import type { PostgresPool } from "../../persistence/pool.js";
import type { OAuthTokenRecord } from "../../proxy/routing/account.js";

function decryptCredential(value: string): string {
  try { return decryptWithKey(value, resolveEncryptionKey()); } catch { return value; }
}

function quotaTokenFromCredential(value: string): OAuthTokenRecord | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken : null;
    if (accessToken === null) return undefined;
    const providerAccountId = typeof parsed.providerAccountId === "string" && parsed.providerAccountId.length > 0
      ? parsed.providerAccountId
      : typeof parsed.projectId === "string" && parsed.projectId.length > 0 ? parsed.projectId : null;
    return {
      kind: "oauth",
      accessToken,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
      expiresAtMs: typeof parsed.expiresAtMs === "number" ? parsed.expiresAtMs : null,
      providerAccountId,
    };
  } catch {
    return undefined;
  }
}

/**
 * OAuth credential helpers — extracted verbatim from bootstrap 152-177.
 * Used by quota-worker and account services; exposed as console oauth-store per spec.
 */

export { decryptCredential, quotaTokenFromCredential };

export interface OAuthCredentialService {
  decryptCredential(value: string): string;
  quotaTokenFromCredential(value: string): OAuthTokenRecord | undefined;
  getCredential(accountId: string): Promise<string | null>;
}

export function createOAuthStoreService(pool: PostgresPool): OAuthCredentialService {
  return {
    decryptCredential,
    quotaTokenFromCredential,
    async getCredential(accountId: string) {
      const rows = (await pool`SELECT credential_encrypted FROM provider_accounts WHERE id = ${accountId}`) as unknown as Array<{ credential_encrypted: string }>;
      const row = rows[0];
      if (!row) return null;
      return decryptCredential(row.credential_encrypted);
    },
  };
}
