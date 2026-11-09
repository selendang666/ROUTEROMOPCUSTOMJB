/**
 * Shared ~1s time tick for components that need to re-render periodically to
 * refresh relative timestamps (TimeAgo). Instead of each instance running its
 * own setInterval — one timer per row in a high-traffic dashboard — all
 * subscribers share a single timeout scheduler that sleeps when the tab is
 * hidden or there are no subscribers.
 *
 * `useSyncExternalStore` is the idiomatic React 18 binding: each TimeAgo
 * subscribes to the shared store and reads the tick counter as its snapshot,
 * so they all re-render in lockstep when the tick advances.
 */

let tickCount = 0;
const subscribers = new Set<() => void>();
let timeoutId: number | null = null;
let lastFire = 0;

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

function schedule(): void {
  if (timeoutId !== null) return;
  if (subscribers.size === 0) return;
  if (typeof document !== "undefined" && document.hidden) return;
  const now = Date.now();
  const elapsed = now - lastFire;
  const delay = elapsed >= 1000 ? 0 : 1000 - elapsed;
  timeoutId = window.setTimeout(() => {
    timeoutId = null;
    if (subscribers.size === 0) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const fired = Date.now();
    if (fired - lastFire >= 1000) {
      tickCount += 1;
      lastFire = fired;
      notify();
    }
    schedule();
  }, delay);
}

function onVisibilityChange(): void {
  if (typeof document !== "undefined" && document.hidden) {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    return;
  }
  if (subscribers.size > 0 && timeoutId === null) {
    lastFire = Date.now();
    schedule();
  }
}

let visibilityAttached = false;

function attachVisibilityListener(): void {
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", onVisibilityChange);
}

function detachVisibilityListener(): void {
  if (typeof document === "undefined") return;
  document.removeEventListener("visibilitychange", onVisibilityChange);
}

function start(): void {
  if (timeoutId !== null) return;
  lastFire = Date.now();
  schedule();
  if (!visibilityAttached && typeof document !== "undefined") {
    attachVisibilityListener();
    visibilityAttached = true;
  }
}

function stop(): void {
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
  if (visibilityAttached) {
    detachVisibilityListener();
    visibilityAttached = false;
  }
}

/** useSyncExternalStore subscribe: starts the loop lazily, stops on last unsubscribe. */
export function subscribeTimeTick(callback: () => void): () => void {
  subscribers.add(callback);
  if (subscribers.size === 1) start();
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) stop();
  };
}

/** useSyncExternalStore getSnapshot: returns the shared tick counter. */
export function getTimeTick(): number {
  return tickCount;
}
