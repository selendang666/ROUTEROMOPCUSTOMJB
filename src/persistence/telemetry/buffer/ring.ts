import type { TelemetryEvent } from "../../../proxy/types/telemetry.js";

/**
 * Fixed-capacity ring buffer for telemetry events.
 * O(1) push, bounded memory even under 100k+ burst.
 * Drop-oldest policy preserves recency for dashboards.
 */
export class RingBuffer {
  private readonly buf: Array<TelemetryEvent | null>;
  private head = 0;
  private tail = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array(capacity).fill(null);
  }

  get length(): number {
    return this.size;
  }

  get isFull(): boolean {
    return this.size === this.capacity;
  }

  peekOldest(): TelemetryEvent | null {
    return this.buf[this.head] ?? null;
  }

  push(event: TelemetryEvent): boolean {
    if (this.isFull) return false;
    this.buf[this.tail] = event;
    this.tail = (this.tail + 1) % this.capacity;
    this.size++;
    return true;
  }

  /** Drop oldest to make room, then push. Returns the evicted event when present. */
  pushOrDropOldest(event: TelemetryEvent): TelemetryEvent | null {
    let evicted: TelemetryEvent | null = null;
    if (this.isFull) {
      evicted = this.buf[this.head] ?? null;
      this.buf[this.head] = null;
      this.head = (this.head + 1) % this.capacity;
      this.size--;
    }
    this.push(event);
    return evicted;
  }

  drain(): TelemetryEvent[] {
    if (this.size === 0) return [];
    const out: TelemetryEvent[] = new Array(this.size);
    for (let i = 0; i < this.size; i++) {
      out[i] = this.buf[(this.head + i) % this.capacity]! as TelemetryEvent;
    }
    this.clear();
    return out;
  }

  clear(): void {
    for (let i = 0; i < this.size; i++) this.buf[(this.head + i) % this.capacity] = null;
    this.head = 0;
    this.tail = 0;
    this.size = 0;
  }
}
