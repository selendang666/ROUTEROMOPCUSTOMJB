import { describe, expect, test } from "bun:test";
import { createAccountRepository } from "../../persistence/repositories/accounts.js";
import { createDrizzlePG } from "../../persistence/db.js";
import type { PostgresPool } from "../../persistence/pool.js";
import { recoverCall } from "../events/commit.js";

describe("routing reliability", () => {
  test("route snapshot cache is scoped and invalidates immediately", async () => {
    let queries = 0;
    const poolFn = async (strings: TemplateStringsArray) => {
      if (strings.join("").trimStart().startsWith("SELECT")) queries += 1;
      return [];
    };
    const pool = Object.assign(poolFn, {
      unsafe: (query: string) => ({
        async values() {
          if (query.trimStart().toLowerCase().startsWith("select")) queries += 1;
          return [];
        },
      }),
    }) as unknown as PostgresPool;
    const db = createDrizzlePG(pool);
    const first = createAccountRepository(db);
    const second = createAccountRepository(db);
    await first.getRouteSnapshot();
    const afterFirst = queries;
    await first.getRouteSnapshot();
    expect(queries).toBe(afterFirst);
    await second.getRouteSnapshot();
    expect(queries).toBe(afterFirst + 10);
    await second.getRouteSnapshot();
    expect(queries).toBe(afterFirst + 10);
    first.invalidateRouteSnapshot();
    await first.getRouteSnapshot();
    expect(queries).toBe(afterFirst + 20);
    await second.getRouteSnapshot();
    expect(queries).toBe(afterFirst + 20);
  });

  test("coalesces concurrent route snapshot cache misses", async () => {
    let queries = 0;
    const poolFn = async (strings: TemplateStringsArray) => {
      if (strings.join("").trimStart().startsWith("SELECT")) queries += 1;
      await Promise.resolve();
      return [];
    };
    const pool = Object.assign(poolFn, {
      unsafe: (query: string) => ({
        async values() {
          if (query.trimStart().toLowerCase().startsWith("select")) queries += 1;
          await Promise.resolve();
          return [];
        },
      }),
    }) as unknown as PostgresPool;
    const repo = createAccountRepository(createDrizzlePG(pool));

    const [first, second] = await Promise.all([
      repo.getRouteSnapshot(),
      repo.getRouteSnapshot(),
    ]);

    expect(first).toBe(second);
    expect(queries).toBe(10);
  });

  test("non-retryable failures do not invoke another candidate", async () => {
    let attempts = 0;
    await expect(recoverCall({
      maxAttempts: 3,
      signal: new AbortController().signal,
      attempt: async () => {
        attempts += 1;
        throw { kind: "invalid_request", retryable: false, safeMessage: "invalid", statusCode: 400, routeScope: null, retryAt: null };
      },
      mapError: (error) => error as never,
    })).rejects.toMatchObject({ kind: "invalid_request" });
    expect(attempts).toBe(1);
  });
});
