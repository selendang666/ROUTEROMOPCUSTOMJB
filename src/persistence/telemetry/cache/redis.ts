/**
 * Redis telemetry adapters — esensi yang diminta:
 * 1. Write-behind list (LPUSH/BRPOP) untuk buffer antar-instance
 * 2. Read cache TTL 15s untuk dashboard
 * 3. Degraded -> fallback in-memory
 *
 * Default LPUSH/BRPOP (simple). XADD stream optional via env switch later.
 */
export interface RedisTelemetryCache {
  cacheGet<T>(key: string): Promise<T | null>;
  cacheSet(key: string, value: unknown, ttlMs: number): Promise<void>;
  cacheInvalidate(prefix: string): Promise<void>;
  streamPush?(payload: string): Promise<void>;
  close(): Promise<void>;
  degraded(): boolean;
}

class NoopCache implements RedisTelemetryCache {
  async cacheGet(): Promise<null> {
    return null;
  }
  async cacheSet(): Promise<void> {}
  async cacheInvalidate(): Promise<void> {}
  async close(): Promise<void> {}
  degraded(): boolean {
    return false;
  }
}

/** RedisClient extended with setex — Bun's type surface may not declare it yet. */
interface RedisClientWithSetex {
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  lpush(key: string, value: string): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  close(): void | Promise<void>;
  ping(): Promise<string>;
}

class RedisCache implements RedisTelemetryCache {
  private client: RedisClientWithSetex | null = null;
  private bad = false;
  private readonly keyPrefix: string;
  constructor(
    client: RedisClientWithSetex,
    keyPrefix = "ohmyomop-router:telemetry:cache:",
  ) {
    this.client = client;
    this.keyPrefix = keyPrefix;
  }

  async cacheGet<T>(key: string): Promise<T | null> {
    if (this.bad || !this.client) return null;
    try {
      const raw = await this.client.get(this.keyPrefix + key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      this.bad = true;
      return null;
    }
  }

  async cacheSet(key: string, value: unknown, ttlMs: number): Promise<void> {
    if (this.bad || !this.client) return;
    try {
      const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
      await this.client.setex(this.keyPrefix + key, ttlSec, JSON.stringify(value));
    } catch {
      this.bad = true;
    }
  }

  async cacheInvalidate(prefix: string): Promise<void> {
    if (this.bad || !this.client) return;
    try {
      const pattern = this.keyPrefix + prefix + "*";
      let cursor = "0";
      const keys: string[] = [];
      type ScanClient = { scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]> };
      const scanClient = this.client as unknown as ScanClient;
      const clientRef = this.client;
      do {
        const [nextCursor, batch] = await scanClient.scan(cursor, "MATCH", pattern, "COUNT", 100);
        if (batch.length > 0) keys.push(...batch);
        cursor = nextCursor;
      } while (cursor !== "0");
      if (keys.length === 0) return;
      // Pipelined DEL: prefer Redis pipeline if available, else parallel deletes via Promise.all
      const pipelined = clientRef as unknown as {
        pipeline?: () => { del(key: string): unknown; exec(): Promise<unknown> };
        del(key: string): Promise<unknown>;
      };
      const pipeline = pipelined.pipeline?.();
      if (pipeline && typeof pipeline.exec === "function") {
        for (const k of keys) pipeline.del(k);
        await pipeline.exec();
      } else {
        await Promise.all(keys.map((k) => clientRef.del(k)));
      }
    } catch {
      this.bad = true;
    }
  }

  async streamPush(payload: string): Promise<void> {
    if (this.bad || !this.client) return;
    try {
      await this.client.lpush("ohmyomop-router:telemetry:stream", payload);
      // cap stream length to avoid unbounded growth (LPUSH + LTRIM)
      await this.client.ltrim("ohmyomop-router:telemetry:stream", 0, 9999);
    } catch {
      this.bad = true;
    }
  }

  async close(): Promise<void> {
    if (this.client) try { await this.client.close(); } catch {}
    this.client = null;
  }

  degraded(): boolean {
    return this.bad;
  }
}

export async function createRedisTelemetryCache(redisUrl: string | null | undefined): Promise<RedisTelemetryCache> {
  const url = (redisUrl ?? "").trim();
  if (!url) return new NoopCache();
  try {
    const { RedisClient } = await import("bun");
    const client = new RedisClient(url);
    await client.connect();
    await client.ping();
    return new RedisCache(client);
  } catch {
    return new NoopCache();
  }
}
