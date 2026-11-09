import { describe, expect, test } from "bun:test";
import { RelayCircuitBreaker } from "./relay-circuit.js";

describe("RelayCircuitBreaker", () => {
  test("opens after two failures and exposes the earliest retry", () => {
    let now = 0;
    const circuit = new RelayCircuitBreaker({ now: () => now });
    circuit.recordFailure("relay-a");
    expect(circuit.state("relay-a")).toBe("CLOSED");
    circuit.recordFailure("relay-a");
    expect(circuit.state("relay-a")).toBe("OPEN");
    expect(circuit.earliestRetryAt()).toBe(30_000);
    expect(circuit.snapshot().stateCounts).toEqual({ closed: 0, open: 1, halfOpen: 0, total: 1 });
    now = 30_000;
  });

  test("allows one half-open probe and doubles backoff after probe failure", () => {
    let now = 0;
    const circuit = new RelayCircuitBreaker({ now: () => now });
    circuit.recordFailure("relay-a");
    circuit.recordFailure("relay-a");
    now = 30_000;
    expect(circuit.isAvailable("relay-a")).toBe(true);
    expect(circuit.state("relay-a")).toBe("HALF_OPEN");
    expect(circuit.tryAcquire("relay-a")).toBe(true);
    expect(circuit.tryAcquire("relay-a")).toBe(false);
    circuit.recordFailure("relay-a");
    expect(circuit.state("relay-a")).toBe("OPEN");
    expect(circuit.earliestRetryAt()).toBe(90_000);
  });

  test("success closes and resets the circuit", () => {
    let now = 0;
    const circuit = new RelayCircuitBreaker({ now: () => now });
    circuit.recordFailure("relay-a");
    circuit.recordFailure("relay-a");
    now = 30_000;
    expect(circuit.tryAcquire("relay-a")).toBe(true);
    circuit.recordSuccess("relay-a");
    expect(circuit.state("relay-a")).toBe("CLOSED");
    expect(circuit.earliestRetryAt()).toBeNull();
    expect(circuit.snapshot().relays["relay-a"]?.failureCount).toBe(0);
  });
});
