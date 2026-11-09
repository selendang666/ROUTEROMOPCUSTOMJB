import { describe, expect, test } from "bun:test";
import { loadKeyAuthorization } from "./proxy-port.js";
import type { PostgresPool } from "../persistence/pool.js";

function mockPool(rows: Array<Record<string, unknown>>): PostgresPool {
  const pool = (async () => rows) as unknown as PostgresPool;
  return pool;
}

describe("loadKeyAuthorization", () => {
  test("returns empty context for keyless traffic", async () => {
    expect(await loadKeyAuthorization(mockPool([]), null)).toEqual({});
  });

  test("returns empty context when the key row is missing", async () => {
    expect(await loadKeyAuthorization(mockPool([]), "nope")).toEqual({});
  });

  test("returns empty context for revoked keys", async () => {
    const pool = mockPool([{ id: "k1", active: true, revoked_at: "2026-01-01T00:00:00.000Z" }]);
    expect(await loadKeyAuthorization(pool, "k1")).toEqual({});
  });

  test("loads limits and allowlists for active keys", async () => {
    const pool = mockPool([{
      id: "k1",
      name: "oc-test",
      key_prefix: "cart_test",
      active: true,
      rate_limit_rpm: 120,
      daily_token_limit: null,
      monthly_token_limit: null,
      one_time_token_limit: null,
      one_time_tokens_used: 0,
      max_concurrent_requests: 3,
      provider_allowlist: null,
      model_allowlist: JSON.stringify(["deepseek-v4-flash"]),
      model_denylist: null,
      revoked_at: null,
    }]);
    const ctx = await loadKeyAuthorization(pool, "k1");
    expect(ctx.apiKey?.id).toBe("k1");
    expect(ctx.apiKey?.rateLimitRpm).toBe(120);
    expect(ctx.apiKey?.maxConcurrentRequests).toBe(3);
    expect(ctx.modelAllowlist).toEqual(["deepseek-v4-flash"]);
    expect(ctx.providerAllowlist).toBeNull();
  });

  test("falls back to empty context on pool errors", async () => {
    const pool = (() => { throw new Error("db down"); }) as unknown as PostgresPool;
    expect(await loadKeyAuthorization(pool, "k1")).toEqual({});
  });
});
