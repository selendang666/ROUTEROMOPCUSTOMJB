import { describe, test, expect } from "bun:test";
import { ApiKeyAdmission } from "./key.js";

describe("ApiKeyAdmission commit promise rejection", () => {
  test("await/catch token-admission commit promises: rejected consume does not throw", () => {
    const repo = {
      consumeOneTimeTokens: (_id: string, _tokens: number): Promise<void> => Promise.reject(new Error("db down")),
    };
    const admission = new ApiKeyAdmission(repo);
    const key = {
      id: "k1",
      oneTimeTokenLimit: 100,
      oneTimeTokensUsed: 0,
      dailyTokenLimit: null,
      monthlyTokenLimit: null,
      rateLimitRpm: null,
      maxConcurrentRequests: null,
    } as unknown as Parameters<ApiKeyAdmission["acquire"]>[0];

    const lease = admission.acquire(key, 10);
    expect(() => lease.commit({ inputTokens: 5, outputTokens: 5 })).not.toThrow();
    // lease should be settled, acquiring again should work
    const lease2 = admission.acquire(key, 5);
    expect(lease2).toBeDefined();
    lease2.release();
  });

  test("synchronous throw in consume is caught", () => {
    const repo = {
      consumeOneTimeTokens: () => {
        throw new Error("sync fail");
      },
    };
    const admission = new ApiKeyAdmission(repo);
    const key = {
      id: "k2",
      oneTimeTokenLimit: 100,
      oneTimeTokensUsed: 0,
      dailyTokenLimit: null,
      monthlyTokenLimit: null,
      rateLimitRpm: null,
      maxConcurrentRequests: null,
    } as unknown as Parameters<ApiKeyAdmission["acquire"]>[0];
    const lease = admission.acquire(key, 10);
    expect(() => lease.commit({ inputTokens: 5, outputTokens: 5 })).not.toThrow();
  });

  test("release with null actual does not call consume", () => {
    let called = false;
    const repo = {
      consumeOneTimeTokens: () => {
        called = true;
      },
    };
    const admission = new ApiKeyAdmission(repo);
    const key = {
      id: "k3",
      oneTimeTokenLimit: 100,
      oneTimeTokensUsed: 0,
      dailyTokenLimit: null,
      monthlyTokenLimit: null,
      rateLimitRpm: null,
      maxConcurrentRequests: null,
    } as unknown as Parameters<ApiKeyAdmission["acquire"]>[0];
    const lease = admission.acquire(key, 10);
    lease.release();
    expect(called).toBe(false);
  });
});
