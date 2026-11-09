import { describe, expect, test } from "bun:test";
import { encryptWithKey, resolveEncryptionKey } from "../persistence/crypto.js";
import type { PostgresPool } from "../persistence/pool.js";
import type { ShareApiKeyRow } from "../persistence/repositories/share.js";
import { ProviderRegistry } from "../providers/registry.js";
import { createShareRouter } from "./share.js";

function createPool(): { pool: PostgresPool; encryptedKey: string; row: ShareApiKeyRow } {
  const encryptedKey = encryptWithKey("sk-share-secret", resolveEncryptionKey());
  const row: ShareApiKeyRow = {
    id: "key-1",
    name: "shared",
    key_prefix: "sk-share-",
    key_encrypted: encryptedKey,
    active: true,
    rate_limit_rpm: null,
    daily_token_limit: null,
    monthly_token_limit: null,
    one_time_token_limit: null,
    one_time_tokens_used: 0,
    max_concurrent_requests: null,
    provider_allowlist: null,
    model_allowlist: null,
    model_denylist: null,
    notes_title: "Title",
    notes_subtitle: "Subtitle",
    notes_body: "Body",
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: null,
    share_created_at: "2026-01-01T00:00:00.000Z",
    expires_at: null,
  };
  const pool = (async (strings: TemplateStringsArray) => {
    const query = strings.join("");
    if (query.includes("FROM share_links s")) return [row];
    if (query.includes("SELECT DISTINCT provider")) return [{ provider: "opencodeft" }];
    if (query.includes("SELECT provider, model_id")) return [{ provider: "opencodeft", model_id: "big-pickle" }];
    return [];
  }) as unknown as PostgresPool;
  return { pool, encryptedKey, row };
}

describe("public share contract", () => {
  test("returns the decrypted key, exact notes, canonical models, origin, and no-store", async () => {
    const previousOrigin = Bun.env.PUBLIC_ORIGIN;
    Bun.env.PUBLIC_ORIGIN = "https://public.example";
    const { pool, row } = createPool();
    const registry = new ProviderRegistry();
    const router = createShareRouter({
      pool,
      registry,
      shareRepository: {
        async getApiKeyByShareToken() { return row; },
        async consumeSetupToken() { return null; },
        async touchView() {},
      },
      usage: {
        async getApiKeyTotals() {
          return { totalTokens: 8, totalRequests: 1, dailyTokens: 8, monthlyTokens: 8, successCount: 1, errorCount: 0 };
        },
      },
    });
    try {
      const response = await router.handle(new Request("http://internal.test/share/token-123456789012345/data"));
      const body = await response.json() as Record<string, unknown>;
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body.baseUrl).toBe("https://public.example");
      expect(body.apiKey).toMatchObject({ key: "sk-share-secret", prefix: "sk-share-" });
      expect(body.notes).toEqual({ title: "Title", subtitle: "Subtitle", body: "Body" });
      expect(body.modelAllowlist).toEqual(["opencodeft/big-pickle"]);
    } finally {
      if (previousOrigin === undefined) delete Bun.env.PUBLIC_ORIGIN;
      else Bun.env.PUBLIC_ORIGIN = previousOrigin;
    }
  });
});
