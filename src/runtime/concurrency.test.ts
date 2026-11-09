import { describe, expect, test } from "bun:test";
import { ProviderConcurrencyRegistry, providerModelKey } from "./concurrency.js";

describe("ProviderConcurrencyRegistry — idle entry cleanup", () => {
  test("idle entry is removed after last lease release", async () => {
    const registry = new ProviderConcurrencyRegistry({ limit: 2 });
    const lease = await registry.acquire("p1", "m1");
    expect(registry.getMetrics("p1", "m1").active).toBe(1);
    await lease.release();
    // After release, entry should be cleaned up — metrics show 0 active with no stale entry
    expect(registry.getMetrics("p1", "m1").active).toBe(0);
    expect(registry.getMetrics("p1", "m1").waiting).toBe(0);
  });

  test("active entry remains while lease is held", async () => {
    const registry = new ProviderConcurrencyRegistry({ limit: 2 });
    const lease = await registry.acquire("p1", "m1");
    expect(registry.getMetrics("p1", "m1").active).toBe(1);
    // Entry should still exist
    expect(registry.getAllMetrics().some((m) => m.key === providerModelKey("p1", "m1") && m.active === 1)).toBe(true);
    await lease.release();
  });

  test("waiting entry remains while waiters are queued", async () => {
    const registry = new ProviderConcurrencyRegistry({ limit: 1, maxWaiters: 10 });
    const lease1 = await registry.acquire("p1", "m1");
    // Second acquire will queue as waiter
    const pending = registry.acquire("p1", "m1");
    expect(registry.getMetrics("p1", "m1").waiting).toBe(1);
    await lease1.release();
    const lease2 = await pending;
    expect(registry.getMetrics("p1", "m1").active).toBe(1);
    await lease2.release();
    // After both released, entry should be cleaned up
    expect(registry.getMetrics("p1", "m1").active).toBe(0);
  });

  test("multiple keys are independently cleaned", async () => {
    const registry = new ProviderConcurrencyRegistry({ limit: 2 });
    const leaseA = await registry.acquire("p1", "m1");
    const leaseB = await registry.acquire("p2", "m2");
    expect(registry.getAllMetrics().filter((m) => m.active > 0).length).toBe(2);
    await leaseA.release();
    // Only p2 should remain
    expect(registry.getMetrics("p1", "m1").active).toBe(0);
    expect(registry.getMetrics("p2", "m2").active).toBe(1);
    await leaseB.release();
    expect(registry.getMetrics("p2", "m2").active).toBe(0);
  });
});
