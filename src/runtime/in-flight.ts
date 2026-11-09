// In-flight — bounded process-global counters with coalesced metrics
// Extracted from admission.ts verbatim


// ── In-flight — bounded process-global counters with coalesced metrics ──

const MAX_LISTENERS = 128;

let count = 0;

const providerCounts = new Map<string, number>();

const listeners = new Set<(count: number) => void>();

let notifyScheduled = false;

export function incrementInFlight(): void {
  count += 1;
  scheduleNotify();
}

export function decrementInFlight(): void {
  count = Math.max(0, count - 1);
  scheduleNotify();
}

export function getInFlightCount(): number {
  return count;
}

export function beginProviderInFlight(providerId: string): void {
  providerCounts.set(providerId, (providerCounts.get(providerId) ?? 0) + 1);
  scheduleNotify();
}

export function endProviderInFlight(providerId: string): void {
  const active = providerCounts.get(providerId) ?? 0;
  if (active <= 1) providerCounts.delete(providerId);
  else providerCounts.set(providerId, active - 1);
  scheduleNotify();
}

export function getProviderInFlight(): Array<{ readonly providerId: string; readonly active: number }> {
  return [...providerCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([providerId, active]) => ({ providerId, active }));
}

export function subscribeInFlight(listener: (count: number) => void): () => void {
  if (listeners.size >= MAX_LISTENERS) {
    const oldest = listeners.keys().next();
    if (!oldest.done) listeners.delete(oldest.value as (count: number) => void);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function scheduleNotify(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    for (const listener of listeners) {
      try {
        listener(count);
      } catch {}
    }
  });
}

/** Test-only: reset the shared counter and drop all subscribers between tests. */
export function resetInFlightForTests(): void {
  count = 0;
  providerCounts.clear();
  listeners.clear();
  notifyScheduled = false;
}

// ── Memory — process-wide async GC without pausing live proxy requests ──

const GC_RETRY_DELAY_MS = 1_000;

let gcPending = false;

let gcRetryTimer: ReturnType<typeof setTimeout> | null = null;

export interface GcScheduleResult {
  status: "scheduled" | "deferred" | "already_pending";
  inFlight: number;
}

export function scheduleGlobalGc(): GcScheduleResult {
  const inFlight = getInFlightCount();
  if (gcPending) return { status: "already_pending", inFlight };

  gcPending = true;
  scheduleAttempt();
  return { status: inFlight > 0 ? "deferred" : "scheduled", inFlight };
}

function scheduleAttempt(): void {
  if (getInFlightCount() > 0) {
    gcRetryTimer = setTimeout(scheduleAttempt, GC_RETRY_DELAY_MS);
    gcRetryTimer.unref?.();
    return;
  }

  gcPending = false;
  gcRetryTimer = null;
  Bun.gc(false);
}

/** Cancels a pending idle-GC retry during graceful shutdown or test teardown. */
export function cancelScheduledGc(): void {
  if (gcRetryTimer !== null) clearTimeout(gcRetryTimer);
  gcRetryTimer = null;
  gcPending = false;
}
