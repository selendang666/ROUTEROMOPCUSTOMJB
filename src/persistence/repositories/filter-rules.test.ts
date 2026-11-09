import { describe, expect, test } from "bun:test";
import { createFilterRuleRepository } from "./filter-rules.js";
import type { DrizzlePG } from "../db.js";

function createMockDb(initialIds: number[] = []): { readonly db: DrizzlePG; readonly store: Map<number, unknown> } {
  const store = new Map<number, unknown>();
  for (const id of initialIds) store.set(id, { id });

  const db = {
    $client: {},
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve([...store.values()].slice(0, 1));
                },
              };
            },
          };
        },
      };
    },
    delete() {
      return {
        where() {
          const deleteId = [...store.keys()][0];
          if (deleteId !== undefined) store.delete(deleteId);
          return Promise.resolve();
        },
      };
    },
  };
  return { db: db as unknown as DrizzlePG, store };
}

describe("filter-rules remove — absent returns false", () => {
  test("remove absent id returns false", async () => {
    const { db } = createMockDb();
    const repo = createFilterRuleRepository(db);
    const result = await repo.remove(999);
    expect(result).toBe(false);
  });

  test("remove existing id returns true and subsequent absent returns false", async () => {
    const { db, store } = createMockDb([42]);
    const repo = createFilterRuleRepository(db);
    expect(store.has(42)).toBe(true);
    const first = await repo.remove(42);
    expect(first).toBe(true);
    expect(store.has(42)).toBe(false);
    const second = await repo.remove(42);
    expect(second).toBe(false);
  });
});
