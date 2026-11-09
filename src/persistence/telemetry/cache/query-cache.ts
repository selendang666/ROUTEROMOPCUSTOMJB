import { createHash } from "node:crypto";
import { MemoryCache } from "./memory.js";
import type { RedisTelemetryCache } from "./redis.js";

export function queryCacheKey(filter: Record<string, unknown>): string {
  const raw = JSON.stringify(filter);
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export class QueryCache {
  private readonly memory: MemoryCache;
  constructor(
    private readonly redis: RedisTelemetryCache,
    memoryTtlMs = 5000,
  ) {
    this.memory = new MemoryCache(500, memoryTtlMs);
  }

  async get<T>(key: string): Promise<T | null> {
    const mem = this.memory.get<T>(key);
    if (mem !== null) return mem;
    const remote = await this.redis.cacheGet<T>(key);
    if (remote !== null) this.memory.set(key, remote);
    return remote;
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.memory.set(key, value, Math.min(ttlMs, 5000));
    await this.redis.cacheSet(key, value, ttlMs);
  }

  async invalidate(prefix: string): Promise<void> {
    this.memory.invalidatePrefix(prefix);
    await this.redis.cacheInvalidate(prefix);
  }
}
