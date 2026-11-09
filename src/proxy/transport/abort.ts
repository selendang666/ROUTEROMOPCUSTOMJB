// Timeout / abort coordination — extracted from fetch.ts verbatim
export type AbortCause = "caller" | "connect_timeout" | "first_body_timeout" | "total_timeout" | "idle_timeout" | "stream_limit";

export interface AbortCoordinatorOptions {
  readonly connectTimeoutMs?: number;
  readonly firstByteTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

/**
 * Combines a caller AbortSignal with optional connect/first-byte/total/idle
 * timers. Every abort is attributed to a cause so callers can map it to a
 * typed error (client_aborted vs network_unavailable vs stream_timeout).
 */
export class AbortCoordinator {
  readonly signal: AbortSignal;
  private readonly controller: AbortController;
  private cause: AbortCause = "caller";
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private firstByteTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly firstByteTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly cleanups: Array<() => void> = [];
  private disposed = false;
  private readWatchdogActive = false;

  constructor(caller: AbortSignal, options: AbortCoordinatorOptions = {}) {
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.firstByteTimeoutMs = options.firstByteTimeoutMs ?? 0;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
    const onCallerAbort = () => this.fail("caller");
    if (caller.aborted) {
      onCallerAbort();
    } else {
      caller.addEventListener("abort", onCallerAbort, { once: true });
      this.cleanups.push(() => caller.removeEventListener("abort", onCallerAbort));
    }
    if ((options.connectTimeoutMs ?? 0) > 0) {
      this.connectTimer = setTimeout(() => this.fail("connect_timeout"), options.connectTimeoutMs);
    }
    if ((options.totalTimeoutMs ?? 0) > 0) {
      this.totalTimer = setTimeout(() => this.fail("total_timeout"), options.totalTimeoutMs);
    }
  }

  armFirstBodyTimeout(timeoutMs = this.firstByteTimeoutMs, onTimeout?: () => void): void {
    this.clearTimer("firstByte");
    if (timeoutMs > 0 && !this.controller.signal.aborted && !this.disposed) {
      this.firstByteTimer = setTimeout(() => {
        this.fail("first_body_timeout");
        onTimeout?.();
      }, timeoutMs);
    }
  }

  markResponseHeadersReceived(): void {
    this.clearTimer("connect");
  }

  markBodyByteReceived(): void {
    this.clearTimer("firstByte");
  }

  beginReadWatchdog(timeoutMs = this.idleTimeoutMs): void {
    this.readWatchdogActive = true;
    this.clearTimer("idle");
    if (timeoutMs > 0 && !this.controller.signal.aborted && !this.disposed) {
      this.idleTimer = setTimeout(() => this.fail("idle_timeout"), timeoutMs);
    }
  }

  endReadWatchdog(): void {
    this.readWatchdogActive = false;
    this.clearTimer("idle");
  }

  resetIdle(): void {
    if (this.readWatchdogActive) this.beginReadWatchdog();
  }

  abort(cause: AbortCause): void {
    this.fail(cause);
  }

  onAbort(callback: () => void): () => void {
    if (this.controller.signal.aborted) {
      callback();
      return () => {};
    }
    if (this.disposed) return () => {};
    let unsubscribed = false;
    const unsubscribe = (): void => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.controller.signal.removeEventListener("abort", callback);
    };
    this.controller.signal.addEventListener("abort", callback, { once: true });
    this.cleanups.push(unsubscribe);
    return unsubscribe;
  }

  causeOf(): AbortCause {
    return this.cause;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearAllTimers();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
  }

  private fail(cause: AbortCause): void {
    if (this.disposed || this.controller.signal.aborted) return;
    this.cause = cause;
    this.clearAllTimers();
    this.controller.abort();
  }

  private clearAllTimers(): void {
    this.clearTimer("connect");
    this.clearTimer("firstByte");
    this.clearTimer("total");
    this.clearTimer("idle");
  }

  private clearTimer(which: "connect" | "firstByte" | "total" | "idle"): void {
    const key = which === "connect" ? "connectTimer" : which === "firstByte" ? "firstByteTimer" : which === "total" ? "totalTimer" : "idleTimer";
    const timer = this[key];
    if (timer !== null) {
      clearTimeout(timer);
      this[key] = null;
    }
  }
}
