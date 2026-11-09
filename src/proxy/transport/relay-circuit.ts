export type RelayCircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface RelayCircuitStateCounts {
  readonly closed: number;
  readonly open: number;
  readonly halfOpen: number;
  readonly total: number;
}

export interface RelayCircuitRelaySnapshot {
  readonly state: RelayCircuitState;
  readonly failureCount: number;
  readonly retryAt: number | null;
}

export interface RelayCircuitSnapshot {
  readonly stateCounts: RelayCircuitStateCounts;
  readonly earliestRetryAt: number | null;
  readonly relays: Readonly<Record<string, RelayCircuitRelaySnapshot>>;
}

export interface RelayCircuitBreakerOptions {
  readonly failureThreshold?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly now?: () => number;
}

interface RelayCircuitEntry {
  state: RelayCircuitState;
  failureCount: number;
  backoffLevel: number;
  retryAt: number | null;
  probeInFlight: boolean;
}

const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_BASE_DELAY_MS = 30_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;

export class RelayCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, RelayCircuitEntry>();

  constructor(options: RelayCircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD));
    this.baseDelayMs = Math.max(1, Math.floor(options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS));
    this.maxDelayMs = Math.max(this.baseDelayMs, Math.floor(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS));
    this.now = options.now ?? Date.now;
  }

  isAvailable(relayId: string): boolean {
    const entry = this.getEntry(relayId);
    if (entry.state === "OPEN") {
      if (entry.retryAt === null || this.now() < entry.retryAt) return false;
      entry.state = "HALF_OPEN";
      entry.probeInFlight = false;
    }
    return entry.state === "CLOSED" || !entry.probeInFlight;
  }

  tryAcquire(relayId: string): boolean {
    if (!this.isAvailable(relayId)) return false;
    const entry = this.getEntry(relayId);
    if (entry.state === "OPEN") return false;
    if (entry.state === "HALF_OPEN") {
      if (entry.probeInFlight) return false;
      entry.probeInFlight = true;
    }
    return true;
  }

  recordSuccess(relayId: string): void {
    const entry = this.getEntry(relayId);
    entry.state = "CLOSED";
    entry.failureCount = 0;
    entry.backoffLevel = 0;
    entry.retryAt = null;
    entry.probeInFlight = false;
  }

  recordFailure(relayId: string): void {
    const entry = this.getEntry(relayId);
    if (entry.state === "OPEN") return;
    if (entry.state === "HALF_OPEN") {
      this.open(entry);
      return;
    }
    entry.failureCount += 1;
    if (entry.failureCount >= this.failureThreshold) this.open(entry);
  }

  success(relayId: string): void {
    this.recordSuccess(relayId);
  }

  failure(relayId: string): void {
    this.recordFailure(relayId);
  }

  state(relayId: string): RelayCircuitState {
    return this.getEntry(relayId).state;
  }

  stateCounts(): RelayCircuitStateCounts {
    let closed = 0;
    let open = 0;
    let halfOpen = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === "CLOSED") closed += 1;
      else if (entry.state === "OPEN") open += 1;
      else halfOpen += 1;
    }
    return { closed, open, halfOpen, total: this.entries.size };
  }

  earliestRetryAt(): number | null {
    let earliest: number | null = null;
    for (const entry of this.entries.values()) {
      if (entry.state !== "OPEN" || entry.retryAt === null) continue;
      if (earliest === null || entry.retryAt < earliest) earliest = entry.retryAt;
    }
    return earliest;
  }

  snapshot(): RelayCircuitSnapshot {
    const relays: Record<string, RelayCircuitRelaySnapshot> = {};
    for (const [relayId, entry] of this.entries) {
      relays[relayId] = {
        state: entry.state,
        failureCount: entry.failureCount,
        retryAt: entry.retryAt,
      };
    }
    return {
      stateCounts: this.stateCounts(),
      earliestRetryAt: this.earliestRetryAt(),
      relays,
    };
  }

  private getEntry(relayId: string): RelayCircuitEntry {
    const existing = this.entries.get(relayId);
    if (existing !== undefined) return existing;
    const entry: RelayCircuitEntry = {
      state: "CLOSED",
      failureCount: 0,
      backoffLevel: 0,
      retryAt: null,
      probeInFlight: false,
    };
    this.entries.set(relayId, entry);
    return entry;
  }

  private open(entry: RelayCircuitEntry): void {
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** entry.backoffLevel);
    entry.state = "OPEN";
    entry.retryAt = this.now() + delay;
    entry.probeInFlight = false;
    entry.backoffLevel += 1;
  }
}
