import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PostgresPool } from "../../persistence/pool.js";
import { createAccountsService } from "./accounts.js";

// Creating an account encrypts its credential, which resolves the key from
// APP_SECRET; supply a deterministic test value and restore env afterwards.
const TEST_APP_SECRET = "test-app-secret-for-account-quota-tests";
let previousAppSecret: string | undefined;

beforeAll(() => {
  previousAppSecret = Bun.env.APP_SECRET;
  Bun.env.APP_SECRET = TEST_APP_SECRET;
});

afterAll(() => {
  if (previousAppSecret === undefined) delete Bun.env.APP_SECRET;
  else Bun.env.APP_SECRET = previousAppSecret;
});

describe("account quota authority", () => {
  test("uses runtime quota state for list and detail responses", async () => {
    const pool = (async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("FROM provider_accounts")) {
        return [{
          id: "account-1",
          provider: "antigravity",
          name: "Google Antigravity 1",
          credential_kind: "oauth",
          credential_hint: "user@example.com",
          priority: 100,
          active: true,
          quota_status: null,
          quota_source: null,
          quota_plan: null,
          quota_windows: null,
          quota_fetched_at: null,
          quota_last_attempt_at: null,
          quota_last_success_at: null,
          quota_error: null,
        }];
      }
      return [];
    }) as unknown as PostgresPool;
    const runtimeQuota = {
      accountId: "account-1",
      quotaAvailable: true,
      lastQuotaRefreshAtMs: Date.now(),
      quota: {
        source: "antigravity",
        status: "ready" as const,
        plan: "Antigravity",
        windows: [{ kind: "google:quota", label: "Google · Quota", usedPercent: 0, remainingPercent: 100, resetsAt: "2030-01-01T00:00:00.000Z" }],
        fetchedAt: "2030-01-01T00:00:00.000Z",
        lastAttemptAt: "2030-01-01T00:00:00.000Z",
        lastSuccessAt: "2030-01-01T00:00:00.000Z",
        error: null,
      },
    };
    const service = createAccountsService(pool, async () => ({ source: "test", plan: null, windows: [], error: null }), () => {}, undefined, undefined, undefined, async () => runtimeQuota);

    const page = await service.list({ provider: "antigravity" });
    expect(page.items[0]?.quota).toMatchObject({ source: "antigravity", windows: runtimeQuota.quota.windows });
    await expect(service.quota("account-1")).resolves.toEqual({ accountId: "account-1", quota: runtimeQuota.quota, health: null });
  });

  test("parses account identity and refreshes quota during creation", async () => {
    let insertedValues: readonly unknown[] = [];
    let refreshedAccountId: string | null = null;
    const pool = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("").includes("INSERT INTO provider_accounts")) insertedValues = values;
      return [];
    }) as unknown as PostgresPool;
    const service = createAccountsService(
      pool,
      async (accountId) => {
        refreshedAccountId = accountId;
        return { source: "test", plan: null, windows: [], error: null };
      },
    );

    const result = await service.create({
      provider: "antigravity",
      name: "Antigravity 2",
      credentialKind: "oauth",
      credential: JSON.stringify({ accessToken: "access-token", displayName: "Alice", email: "alice@example.com" }),
    });

    expect(result.ok).toBe(true);
    expect(insertedValues[2]).toBe("Alice");
    expect(insertedValues[5]).toBe("alice@example.com");
    expect(refreshedAccountId).toBe(insertedValues[0]);
  });
});
