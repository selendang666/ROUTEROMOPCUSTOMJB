import { describe, expect, test } from "bun:test";
import { CredentialSelector } from "./account.js";

describe("CredentialSelector", () => {
  test("selects healthy credentials and releases leases exactly once", async () => {
    const released: string[] = [];
    const selector = new CredentialSelector({
      getCredential: async (accountId) => accountId === "account-1" ? "secret-1" : null,
    });
    const result = await selector.select({
      providerId: "provider",
      modelId: "model",
      candidates: [{
        id: "account-1",
        accountId: "account-1",
        providerId: "provider",
        credentialKind: "api_key",
        healthy: true,
        health: null,
        enabled: true,
        quotaAvailable: true,
        modelLocks: null,
        priority: 1,
      }],
    });
    expect(result?.selection.secret).toBe("secret-1");
    expect(result?.selection.leaseId).toBeString();
    const leaseId = result?.selection.leaseId;
    if (leaseId !== undefined) {
      await selector.release(leaseId);
      released.push(leaseId);
      await selector.release(leaseId);
    }
    expect(released).toHaveLength(1);
  });

  test("skips unhealthy and locked candidates", async () => {
    const selector = new CredentialSelector({ getCredential: async () => "secret" });
    const result = await selector.select({
      providerId: "provider",
      modelId: "model",
      candidates: [{
        id: "locked",
        accountId: "locked",
        providerId: "provider",
        credentialKind: "api_key",
        healthy: true,
        health: null,
        enabled: true,
        quotaAvailable: true,
        modelLocks: new Map([["model", { accountId: "locked", modelId: "model", retryAt: new Date(Date.now() + 60_000).toISOString() }]]),
        priority: 1,
      }, {
        id: "disabled",
        accountId: "disabled",
        providerId: "provider",
        credentialKind: "api_key",
        healthy: false,
        health: null,
        enabled: false,
        quotaAvailable: true,
        modelLocks: null,
        priority: 2,
      }],
    });
    expect(result).toBeNull();
  });

  test("leases OAuth credentials and releases the token lease", async () => {
    let released = 0;
    const selector = new CredentialSelector({
      getCredential: async () => null,
      leaseCredential: async () => ({ secret: "{\"accessToken\":\"token\"}", release: async () => { released += 1; } }),
    });
    const result = await selector.select({
      providerId: "oauth-provider",
      modelId: "model",
      candidates: [{
        id: "oauth-account",
        accountId: "oauth-account",
        providerId: "oauth-provider",
        credentialKind: "oauth",
        healthy: true,
        health: null,
        enabled: true,
        quotaAvailable: true,
        modelLocks: null,
        priority: 1,
      }],
    });
    expect(result?.selection.secret).toContain("accessToken");
    await selector.release(result?.selection.leaseId ?? "");
    expect(released).toBe(1);
  });
});
