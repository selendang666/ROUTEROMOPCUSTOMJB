import { describe, expect, test } from "bun:test";
import { AbortCoordinator } from "./abort.js";

describe("AbortCoordinator stream timing", () => {
  test("headers do not clear an armed first-body timeout", async () => {
    const caller = new AbortController();
    const coordinator = new AbortCoordinator(caller.signal, { firstByteTimeoutMs: 15 });
    coordinator.markResponseHeadersReceived();
    coordinator.armFirstBodyTimeout();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(coordinator.signal.aborted).toBe(true);
    expect(coordinator.causeOf()).toBe("first_body_timeout");
    coordinator.dispose();
  });

  test("read watchdog is inactive while downstream processes an event", async () => {
    const caller = new AbortController();
    const coordinator = new AbortCoordinator(caller.signal, { idleTimeoutMs: 15 });
    coordinator.beginReadWatchdog();
    coordinator.endReadWatchdog();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(coordinator.signal.aborted).toBe(false);
    coordinator.dispose();
  });
});
