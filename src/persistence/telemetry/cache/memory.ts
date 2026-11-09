/**
 * Tiny LRU for dashboard query cache (hot path).
 * No external deps, ~500 keys, O(1) get/set.
 * TTL 5m with ±20% jitter to avoid thundering herd.
 */
function jitteredTtl(ttlMs: number): number {
  // ±20% jitter: multiplier in [0.8, 1.2)
  const factor = 0.8 + Math.random() * 0.4;
  return Math.max(1, Math.round(ttlMs * factor));
}

export class MemoryCache {
  private readonly map = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly maxKeys: number = 500,
    private readonly defaultTtlMs: number = 5 * 60_000,
  ) {}

  get<T>(key: string): T | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    // move to end (MRU)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value as T;
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    const effectiveTtl = jitteredTtl(ttl);
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxKeys) {
      const first = this.map.keys().next().value as string | undefined;
      if (first) this.map.delete(first);
    }
    this.map.set(key, { value, expiresAt: Date.now() + effectiveTtl });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }

  clear(): void {
    this.map.clear();
  }
}
