import { describe, expect, test } from "bun:test";
import { decideRetry, recoverCall, selectHedgeWinner } from "./resilience.js";
import { createInternalFailure } from "../errors.js";

describe("resilience (hedge + retry)", () => {
  test("selectHedgeWinner returns first candidate placeholder", async () => {
    const r = await selectHedgeWinner({ candidates: ["a", "b"], hedgeDelayMs: 10, signal: new AbortController().signal, totalDeadlineMs: 1000 });
    expect(r.winner).toBe("a");
    expect(r.loserAborted).toBe(false);
  });

  test("recoverCall respects retryable false", async () => {
    let calls = 0;
    await expect(
      recoverCall({
        attempt: async () => { calls++; throw createInternalFailure({ kind: "invalid_request", safeMessage: "bad", statusCode: 400, retryable: false, routeScope: null }); },
        maxAttempts: 3,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    expect(calls).toBe(1);
  });

  test("decideRetry defaults to no retry", () => {
    expect(decideRetry({})).toEqual({ shouldRetry: false });
    expect(decideRetry(null)).toEqual({ shouldRetry: false });
  });
});
