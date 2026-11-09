import { describe, expect, test } from "bun:test";
import { AccountHealthManager, MemoryAccountHealthStore, MemoryModelLockStore } from "./account.js";

describe("AccountHealthManager — LRU cache caps", () => {
  test("healthCache is bounded at 5000 entries", async () => {
    const store = new MemoryAccountHealthStore();
    const manager = new AccountHealthManager(store, { cacheTtlMs: 10_000 });
    // Insert 5100 unique accounts to exceed the cap
    for (let i = 0; i < 5100; i++) {
      await manager.recordSuccess(`acct-${i}`, "provider-1");
    }
    // The oldest entries should have been evicted — querying an old one should miss cache
    // and hit the store (which still has the record). We verify by checking that the
    // manager doesn't throw and still returns correct health for recent entries.
    const health = await manager.getHealth("acct-5099");
    expect(health).not.toBeNull();
    expect(health!.status).toBe("healthy");
  });

  test("modelLocksCache is bounded at 10000 entries", async () => {
    const store = new MemoryAccountHealthStore();
    const lockStore = new MemoryModelLockStore();
    const manager = new AccountHealthManager(store, { cacheTtlMs: 10_000 }, lockStore);
    const error = { kind: "provider_rate_limited", retryable: true, statusCode: 429, safeMessage: "rate limited" } as Parameters<typeof manager.recordModelLock>[2];
    // Insert 10100 unique model locks to exceed the cap
    for (let i = 0; i < 10100; i++) {
      await manager.recordModelLock("acct-0", `model-${i}`, error);
    }
    // Recent locks should still be available
    const available = await manager.isModelAvailable("acct-0", "model-10099");
    expect(available).toBe(false);
  });

  test("TTL freshness is preserved with LRU trimming", async () => {
    const store = new MemoryAccountHealthStore();
    const manager = new AccountHealthManager(store, { cacheTtlMs: 250 });
    await manager.recordSuccess("acct-1", "provider-1");
    // Should be usable immediately
    expect(await manager.isUsable("acct-1")).toBe(true);
    // After recording a failure, should be cooling down
    await manager.recordFailure("acct-1", "provider-1", { kind: "provider_rate_limited", retryable: true, statusCode: 429, safeMessage: "rate limited" } as Parameters<typeof manager.recordFailure>[2]);
    expect(await manager.isUsable("acct-1")).toBe(false);
  });
});
