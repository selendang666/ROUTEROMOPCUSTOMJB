import { describe, expect, test } from "bun:test";
import { QuotaRefreshWorker } from "./refresher.js";
import type { AccountConfig, CredentialConfigStore, QuotaStateRecord, QuotaStateStore } from "../proxy/routing/account.js";

describe("quota refresh worker", () => {
  test("coalesces refreshes and observes failure cooldown", async () => {
    const account: AccountConfig = { id: "account-1", providerId: "provider", kind: "api_key", enabled: true, priority: 1 };
    const accounts: CredentialConfigStore = { listAccounts: async () => [account], getAccount: async () => account };
    const records = new Map<string, QuotaStateRecord>();
    const state: QuotaStateStore = {
      get: async (id) => records.get(id),
      set: async (record) => { records.set(record.accountId, record); },
      list: async () => [...records.values()],
      listForAccountIds: async (ids) => ids.flatMap((id) => { const record = records.get(id); return record === undefined ? [] : [record]; }),
    };
    let now = 1_000;
    let calls = 0;
    const worker = new QuotaRefreshWorker(accounts, state, async () => {
      calls += 1;
      await state.set({ accountId: account.id, quotaAvailable: false, lastQuotaRefreshAtMs: now, lastQuotaAttemptAtMs: now });
      throw new Error("quota unavailable");
    }, { nowMs: () => now, supportsProvider: () => true, intervalMs: 60_000, failureCooldownMs: 60_000 });
    await worker.sweep();
    await worker.sweep();
    expect(calls).toBe(1);
    now += 60_001;
    await worker.sweep();
    expect(calls).toBe(2);
    worker.stop();
  });
});
