import { describe, expect, test } from "bun:test";
import type { PostgresPool } from "../../persistence/pool.js";
import { createApiKeysServices, parseStringArray, serializeStringArray } from "./api-keys.js";

describe("API key cache", () => {
  test("distinguishes active, revoked, and expired records", async () => {
    let nowMs = 1_000;
    let row: { id: string; active: boolean; revoked_at: string | null } = { id: "key-1", active: true, revoked_at: null };
    let queries = 0;
    const pool = (async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("SELECT id, active")) {
        queries += 1;
        return [row];
      }
      return [];
    }) as unknown as PostgresPool;
    const services = createApiKeysServices(pool, { cacheTtlMs: 10, now: () => nowMs });
    expect(await services.publicApiKeys.getBySecret("secret")).toMatchObject({ id: "key-1", active: true });
    row = { id: "key-1", active: false, revoked_at: "2026-01-01T00:00:00.000Z" };
    expect(await services.publicApiKeys.getBySecret("secret")).toMatchObject({ active: true });
    nowMs += 11;
    expect(await services.publicApiKeys.getBySecret("secret")).toMatchObject({ active: false, revokedAt: "2026-01-01T00:00:00.000Z" });
    expect(queries).toBe(2);
  });
});

describe("API-key ACL contracts", () => {
  test("normalizes legacy JSON and comma-separated ACLs to arrays", () => {
    expect(parseStringArray('["one", " two ", 3]')).toEqual(["one", "two"]);
    expect(parseStringArray("one, two, , three")).toEqual(["one", "two", "three"]);
    expect(parseStringArray("")).toBeNull();
    expect(serializeStringArray(["one", " two "])).toBe('["one","two"]');
    expect(serializeStringArray(null)).toBeNull();
  });
});
