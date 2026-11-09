import { describe, expect, test } from "bun:test";
import { incrementInFlight, resetInFlightForTests, subscribeInFlight } from "./in-flight.js";

describe("in-flight listener exception isolation", () => {
  test("throwing listener does not prevent other listeners", async () => {
    resetInFlightForTests();
    let secondCalled = false;
    let secondValue = -1;
    subscribeInFlight(() => {
      throw new Error("boom");
    });
    subscribeInFlight((count) => {
      secondCalled = true;
      secondValue = count;
    });
    incrementInFlight();
    // flush coalesced microtask
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    // second listener should have been called despite first throwing
    expect(secondCalled).toBe(true);
    expect(secondValue).toBe(1);
    resetInFlightForTests();
  });

  test("multiple increments coalesce but listener still isolated", async () => {
    resetInFlightForTests();
    const calls: number[] = [];
    subscribeInFlight(() => { throw new Error("first fails"); });
    subscribeInFlight((c) => calls.push(c));
    incrementInFlight();
    incrementInFlight();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(calls.length).toBe(1);
    // count should be 2 at notification time (coalesced)
    expect(calls[0]).toBe(2);
    resetInFlightForTests();
  });
});
