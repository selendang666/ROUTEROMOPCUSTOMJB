import { createHash } from "node:crypto";
import { createDrizzlePG, type DrizzlePG } from "../db.js";
import { toIso } from "../crypto.js";
import type { ConsoleSessionRow } from "../types.js";
import { consoleSessions, ipBans, rateLimitCounters } from "../schema/pg.js";
import { eq, and, gt, sql } from "drizzle-orm";

export interface IpBanRecord {
  readonly ip: string;
  readonly reason: string;
  readonly failedAttempts: number;
  readonly banStartedAt: string;
  readonly banExpiresAt: string;
}
export interface IpBanRepositoryShape {
  isBanned(ip: string): Promise<boolean>;
  recordFailure(ip: string, opts: { maxFailures: number; banDurationMs: number; reason?: 'failed_login' | 'suspicious_activity' | 'rate_limit_abuse' }): Promise<{ banned: boolean; reason: 'failed_login' | 'suspicious_activity' | 'rate_limit_abuse'; attempt: number } | null>;
  prune(): Promise<number>;
  list(): Promise<readonly IpBanRecord[]>;
  unban(ip: string): Promise<boolean>;
}

function parseIpBanRow(row: Record<string, unknown>): IpBanRecord {
  return {
    ip: String(row.ip ?? ""),
    reason: String(row.reason ?? "failed_login"),
    failedAttempts: Number(row.failed_attempts ?? row.failedAttempts ?? 0),
    banStartedAt: toIso(row.ban_started_at ?? row.banStartedAt)!,
    banExpiresAt: toIso(row.ban_expires_at ?? row.banExpiresAt)!,
  };
}

/** Creates the IP-ban repository over the canonical Drizzle PostgreSQL client. */
export function createIpBanRepository(db: DrizzlePG = createDrizzlePG()): IpBanRepositoryShape {
  return {
    async isBanned(ip: string): Promise<boolean> {
      if (!ip) return false;
      const rows = await db
        .select({ banExpiresAt: ipBans.banExpiresAt })
        .from(ipBans)
        .where(and(eq(ipBans.ip, sql`${ip}::inet` as unknown as string), gt(ipBans.banExpiresAt, sql`now()`)))
        .limit(1);
      return rows.length > 0;
    },
    async recordFailure(ip, opts): Promise<{ banned: boolean; reason: 'failed_login' | 'suspicious_activity' | 'rate_limit_abuse'; attempt: number } | null> {
      if (!ip) return null;
      const { maxFailures, banDurationMs, reason = "failed_login" as const } = opts;
      const first = await db.execute(sql<Record<string, unknown>>`
        INSERT INTO ${ipBans} (ip, reason, failed_attempts, ban_started_at, ban_expires_at)
        VALUES (${ip}::inet, ${reason}::text, 1, now(), 'epoch'::timestamptz)
        ON CONFLICT ON CONSTRAINT ip_bans_pkey DO NOTHING
        RETURNING failed_attempts, ban_expires_at, ban_started_at, reason
      `);
      if (first.length > 0) {
        if (maxFailures <= 1) {
          await db.execute(sql`
            UPDATE ${ipBans} SET
              reason = ${reason}::text,
              ban_started_at = now(),
              ban_expires_at = now() + (${banDurationMs}::text || ' milliseconds')::interval
            WHERE ip = ${ip}::inet
          `);
          return { banned: true, reason, attempt: 1 };
        }
        return { banned: false, reason, attempt: 1 };
      }
      const upsert = await db.execute(sql<Record<string, unknown>>`
        INSERT INTO ${ipBans} (ip, reason, failed_attempts, ban_started_at, ban_expires_at)
        VALUES (${ip}::inet, ${reason}::text, 1, now(), now())
        ON CONFLICT ON CONSTRAINT ip_bans_pkey DO UPDATE SET
          failed_attempts = ip_bans.failed_attempts + 1,
          reason = CASE
            WHEN ip_bans.failed_attempts + 1 >= ${maxFailures}::int THEN ${reason}::text
            ELSE ip_bans.reason
          END,
          ban_started_at = CASE
            WHEN ip_bans.failed_attempts = 0 OR ip_bans.ban_expires_at <= now() THEN now()
            ELSE ip_bans.ban_started_at
          END,
          ban_expires_at = CASE
            WHEN ip_bans.failed_attempts + 1 >= ${maxFailures}::int
              THEN now() + (${banDurationMs}::text || ' milliseconds')::interval
            ELSE ip_bans.ban_expires_at
          END
        RETURNING failed_attempts, ban_expires_at, ban_started_at, reason
      `);
      const row = upsert[0];
      if (!row) return null;
      const attempt = Number(row.failed_attempts);
      const expiresAt = toIso(row.ban_expires_at);
      const expired = expiresAt === null ? true : Date.parse(expiresAt) <= Date.now();
      const banned = attempt >= maxFailures && !expired;
      return { banned, reason: String(row.reason ?? reason) as 'failed_login' | 'suspicious_activity' | 'rate_limit_abuse', attempt };
    },
    async prune(): Promise<number> {
      const result = await db.delete(ipBans).where(sql`${ipBans.banExpiresAt} <= now()`).returning({ ip: ipBans.ip });
      return result.length;
    },
    async list(): Promise<readonly IpBanRecord[]> {
      const rows = await db.select().from(ipBans).where(gt(ipBans.banExpiresAt, sql`now()`)).orderBy(sql`${ipBans.banExpiresAt} DESC`);
      return rows.map((row) => parseIpBanRow(row as unknown as Record<string, unknown>));
    },
    async unban(ip: string): Promise<boolean> {
      const result = await db.delete(ipBans).where(eq(ipBans.ip, sql`${ip}::inet` as unknown as string)).returning({ ip: ipBans.ip });
      return result.length > 0;
    },
  };
}

export interface RateLimitCounter {
  readonly ip: string;
  readonly scope: "open" | "console";
  readonly requestCount: number;
  readonly windowStartedAt: string;
}

export interface RateLimitRepositoryShape {
  touch(ip: string, scope: "open" | "console", limitPerMinute: number): Promise<{ count: number; remaining: number; windowStartedAt: string }>;
  pruneStale(olderThanMs: number): Promise<number>;
}

/** Creates the rate-limit repository while preserving atomic minute-window upserts. */
export function createRateLimitRepository(db: DrizzlePG = createDrizzlePG()): RateLimitRepositoryShape {
  return {
    async touch(ip, scope, limitPerMinute) {
      if (!ip) return { count: 0, remaining: limitPerMinute, windowStartedAt: new Date().toISOString() };
      const rows = await db.execute(sql<Record<string, unknown>>`
        INSERT INTO ${rateLimitCounters} (ip, scope, window_started_at, request_count)
        VALUES (${ip}::inet, ${scope}::text, date_trunc('minute', now()), 1)
        ON CONFLICT (ip, scope, window_started_at) DO UPDATE SET request_count = rate_limit_counters.request_count + 1
        RETURNING request_count, window_started_at
      `);
      const row = rows[0];
      const count = Number(row?.request_count ?? 0);
      const windowStartedAt = toIso(row?.window_started_at) ?? new Date().toISOString();
      const remaining = Math.max(0, limitPerMinute - count);
      return { count, remaining, windowStartedAt };
    },
    async pruneStale(olderThanMs) {
      const result = await db.delete(rateLimitCounters).where(sql`${rateLimitCounters.windowStartedAt} < now() - (${olderThanMs}::text || ' milliseconds')::interval`).returning({ ip: rateLimitCounters.ip });
      return result.length;
    },
  };
}

/** Creates the console-session repository over the canonical Drizzle PostgreSQL client. */
export function createConsoleSessionRepository(db: DrizzlePG = createDrizzlePG()) {
  return {
    async create(input: { id: string; tokenHash: string; data?: Record<string, unknown>; expiresAt?: string | null }) {
      await db.insert(consoleSessions).values({
        id: input.id,
        tokenHash: input.tokenHash,
        data: input.data ?? {},
        expiresAt: input.expiresAt ? (sql`${input.expiresAt}::timestamptz` as unknown as string) : null,
      });
      const rows = await db.select().from(consoleSessions).where(eq(consoleSessions.id, input.id)).limit(1);
      return (rows[0] as unknown as Record<string, unknown> | undefined) ?? null;
    },
    async findByTokenHash(tokenHash: string): Promise<ConsoleSessionRow | null> {
      const rows = await db.select().from(consoleSessions).where(eq(consoleSessions.tokenHash, tokenHash)).limit(1);
      const row = rows[0] as unknown as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.id as string,
        tokenHash: row.tokenHash as string,
        data: (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>,
        createdAt: toIso(row.createdAt ?? row.created_at)!,
        expiresAt: toIso(row.expiresAt ?? row.expires_at),
        revokedAt: toIso(row.revokedAt ?? row.revoked_at),
      };
    },
    async findById(id: string) {
      const rows = await db.select().from(consoleSessions).where(eq(consoleSessions.id, id)).limit(1);
      return (rows[0] as unknown as Record<string, unknown> | undefined) ?? null;
    },
    async verify(request: Request): Promise<{ id: string } | null> {
      const header = request.headers.get("cookie") ?? "";
      const parts = header.split(";");
      let raw: string | null = null;
      for (const part of parts) {
        const [key, ...value] = part.trim().split("=");
        if (key === "ohmyomop_router_console") { raw = decodeURIComponent(value.join("=")); break; }
      }
      if (!raw) return null;
      const tokenHash = createHash("sha256").update(raw).digest("hex");
      const rows = await db
        .select({ id: consoleSessions.id, expiresAt: consoleSessions.expiresAt, revokedAt: consoleSessions.revokedAt })
        .from(consoleSessions)
        .where(eq(consoleSessions.tokenHash, tokenHash))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      if (row.revokedAt !== null) return null;
      if (row.expiresAt !== null && new Date(row.expiresAt).getTime() <= Date.now()) return null;
      return { id: row.id };
    },
    async revokeByTokenHash(tokenHash: string) {
      await db.update(consoleSessions).set({ revokedAt: sql`now()` as unknown as string }).where(eq(consoleSessions.tokenHash, tokenHash));
    },
    async revokeAll() {
      await db.update(consoleSessions).set({ revokedAt: sql`now()` as unknown as string }).where(sql`${consoleSessions.revokedAt} IS NULL`);
    },
    async pruneExpired() {
      const result = await db.delete(consoleSessions).where(sql`${consoleSessions.expiresAt} IS NOT NULL AND ${consoleSessions.expiresAt} < now()`).returning({ id: consoleSessions.id });
      return result.length;
    },
    async list() {
      const rows = await db.select().from(consoleSessions).orderBy(consoleSessions.createdAt);
      return rows as unknown as Array<Record<string, unknown>>;
    },
  };
}
