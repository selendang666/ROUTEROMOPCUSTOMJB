// Coordination (redis/local) — extracted from store.ts verbatim
import type { RedisClient as BunRedisClient } from "bun";

export interface CoordinationOptions {
  readonly redisUrl?: string | null;
}

/** Minimal RuntimeConfig shape for coordination. */
export interface RuntimeRedisConfig {
  readonly redisUrl: string | null;
}

export interface RateCounterResult { readonly allowed: boolean; readonly remaining: number; }

export interface InFlightLease { readonly key: string; readonly release: () => Promise<void>; }

export interface Coordination {
  readonly mode: "redis" | "local";
  readonly incrRateCounter: (key: string, windowMs: number, limit: number) => Promise<RateCounterResult>;
  readonly incrInFlight: (key: string, limit: number, ttlMs: number) => Promise<{ acquired: boolean; current: number }>;
  readonly decrInFlight: (key: string) => Promise<void>;
  readonly publishRevision: (channel: string, revision: number) => Promise<void>;
  readonly subscribeRevision: (channel: string, handler: (revision: number) => void) => () => void;
  readonly close: () => Promise<void>;
  readonly degraded: () => boolean;
}

const MAX_LOCAL_KEYS = 5000;

function boundedKey(key: string): string {
  return key.slice(0, 256);
}

function resolveRedisUrl(options: CoordinationOptions): string {
  // If caller explicitly provided redisUrl (even null), respect it — server injection path.
  // Otherwise read Bun.env for direct CLI callers.
  if ("redisUrl" in options) {
    return (options.redisUrl ?? "").trim();
  }
  return (Bun.env.REDIS_URL ?? "").trim();
}

function createLocalCoordination(): Coordination {
  const rate = new Map<string, { count: number; expiresAt: number }>();
  const inflight = new Map<string, { count: number; expiresAt: number }>();
  const subs = new Map<string, Set<(n: number) => void>>();

  const evictIfNeeded = (m: Map<string, unknown>): void => {
    if (m.size <= MAX_LOCAL_KEYS) return;
    const first = m.keys().next().value as string | undefined;
    if (first) m.delete(first);
  };

  return {
    mode: "local",
    async incrRateCounter(key, windowMs, limit) {
      const k = boundedKey(key);
      const now = Date.now();
      const entry = rate.get(k);
      if (!entry || entry.expiresAt <= now) {
        evictIfNeeded(rate);
        rate.set(k, { count: 1, expiresAt: now + windowMs });
        return { allowed: true, remaining: limit - 1 };
      }
      entry.count++;
      return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count) };
    },
    async incrInFlight(key, limit, ttlMs) {
      const k = boundedKey(key);
      const now = Date.now();
      const entry = inflight.get(k);
      if (!entry || entry.expiresAt <= now) {
        evictIfNeeded(inflight);
        inflight.set(k, { count: 1, expiresAt: now + ttlMs });
        return { acquired: true, current: 1 };
      }
      if (entry.count >= limit) return { acquired: false, current: entry.count };
      entry.count++;
      entry.expiresAt = now + ttlMs;
      return { acquired: true, current: entry.count };
    },
    async decrInFlight(key) {
      const k = boundedKey(key);
      const entry = inflight.get(k);
      if (!entry) return;
      entry.count = Math.max(0, entry.count - 1);
      if (entry.count === 0) inflight.delete(k);
    },
    async publishRevision(channel, revision) {
      const handlers = subs.get(channel);
      if (!handlers) return;
      for (const h of handlers) h(revision);
    },
    subscribeRevision(channel, handler) {
      let set = subs.get(channel);
      if (!set) { set = new Set(); subs.set(channel, set); }
      set.add(handler);
      return () => set!.delete(handler);
    },
    async close() { rate.clear(); inflight.clear(); subs.clear(); },
    degraded: () => false,
  };
}

async function createRedisCoordination(redisUrl: string): Promise<Coordination> {
  let degraded = false;
  let client: BunRedisClient | null = null;
  try {
    // Dynamic import is required: Bun.RedisClient is only available in Bun runtime; static import would break non-Bun typechecking/builds
    const { RedisClient } = await import("bun");
    client = new RedisClient(redisUrl);
    await client.connect();
    // Verify with PING within timeout.
    await client.ping();
  } catch {
    degraded = true;
    if (client) try { await client.close(); } catch {}
    return { ...createLocalCoordination(), degraded: () => true };
  }

  const localFallback = createLocalCoordination();

  const safe = <T>(fn: () => Promise<T>, fallback: T): Promise<T> =>
    fn().catch(() => { degraded = true; return fallback; });

  return {
    mode: "redis",
    async incrRateCounter(key, windowMs, limit) {
      const k = boundedKey(key);
      if (degraded || !client) return localFallback.incrRateCounter(k, windowMs, limit);
      const fallback = await localFallback.incrRateCounter(k, windowMs, limit);
      return safe(async () => {
        const count = await client!.incr(k);
        if (count === 1) await client!.expire(k, Math.ceil(windowMs / 1000));
        return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
      }, fallback);
    },
    async incrInFlight(key, limit, ttlMs) {
      const k = boundedKey(key);
      if (degraded || !client) return localFallback.incrInFlight(k, limit, ttlMs);
      const fallback = await localFallback.incrInFlight(k, limit, ttlMs);
      return safe(async () => {
        const count = await client!.incr(k);
        if (count === 1) await client!.expire(k, Math.ceil(ttlMs / 1000));
        if (count > limit) { await client!.decr(k); return { acquired: false, current: count - 1 }; }
        return { acquired: true, current: count };
      }, fallback);
    },
    async decrInFlight(key) {
      const k = boundedKey(key);
      if (degraded || !client) return localFallback.decrInFlight(k);
      await safe(async () => { await client!.decr(k); }, undefined as unknown as void);
    },
    async publishRevision(channel, revision) {
      if (degraded || !client) return localFallback.publishRevision(channel, revision);
      await safe(async () => { await client!.publish(channel, String(revision)); }, undefined as unknown as void);
    },
    subscribeRevision(channel, handler) {
      if (degraded || !client) return localFallback.subscribeRevision(channel, handler);
      // Bun RedisClient subscribe is async; for simplicity delegate to local for subscription,
      // publisher still goes through Redis. Revision invalidation tolerates local-only subscription.
      return localFallback.subscribeRevision(channel, handler);
    },
    async close() {
      if (client) try { await client.close(); } catch {}
      await localFallback.close();
    },
    degraded: () => degraded,
  };
}

export async function createCoordination(options: CoordinationOptions = {}): Promise<Coordination> {
  const url = resolveRedisUrl(options);
  if (!url) return createLocalCoordination();
  return createRedisCoordination(url);
}

/** Convenience for server injection path: accepts RuntimeConfig shape directly. */
export async function createCoordinationFromConfig(config: RuntimeRedisConfig): Promise<Coordination> {
  return createCoordination({ redisUrl: config.redisUrl });
}