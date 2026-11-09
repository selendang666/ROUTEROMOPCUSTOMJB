import { randomBytes } from "node:crypto";
import type { ConsoleServiceResult } from "../../api/guard.js";
import type { PostgresPool } from "../../persistence/pool.js";
import type { ApiKeyListItem } from "./api-keys.js";

/** Free-tier models every buyer key is restricted to (unlimited tokens, fair-use).
 * NOTE (2026-09-24): opencode* free-tier models removed — upstream
 * opencode.ai now rejects free-tier calls outside the genuine OpenCode client
 * ("FreeTierError: can only be used from within OpenCode"), so routing buyers
 * to opencodeft only produces 403 authorization_denied. inferhub stays. */
export const BUYER_FREE_MODELS: readonly string[] = [
  "inferhub/cb/deepseek-v4.1-flash",
  "cb/deepseek-v4.1-flash",
  "deepseek-v4.1-flash",
];

/** Soft abuse guards (tokens stay unlimited). */
export const BUYER_RATE_LIMIT_RPM = 120;
export const BUYER_MAX_CONCURRENT_REQUESTS = 3;

/** Default license duration for a new buyer, in days. */
export const BUYER_DEFAULT_EXPIRES_DAYS = 30;

/** Minimal shape of the console api-keys service used by buyers. */
export interface BuyersApiKeysPort {
  list(): Promise<unknown>;
  create(body: unknown): Promise<ConsoleServiceResult>;
  revoke(id: string): Promise<ConsoleServiceResult>;
  share?(id: string, options?: { readonly kind?: "monitor" | "setup"; readonly expiresAt?: string | null }): Promise<ConsoleServiceResult>;
}

/** A persisted buyer row. */
export interface BuyerRecord {
  readonly id: string;
  readonly apiKeyId: string;
  readonly subdomain: string;
  readonly email: string;
  readonly licenseKey: string;
  readonly expiresAt: string;
  readonly status: string;
  readonly createdAt: string;
}

/** A buyer row joined with its live API-key usage. */
export interface BuyerListItem extends BuyerRecord {
  readonly keyActive: boolean;
  readonly keyPrefix: string | null;
  readonly totalUsage: number;
  readonly totalRequests: number;
  readonly lastUsedAt: string | null;
}

/** Input accepted by the buyer creation endpoint. */
export interface BuyerCreateInput {
  readonly name: string;
  readonly email: string;
  readonly subdomain: string;
  readonly expiresInDays?: number;
}

interface BuyerRow {
  readonly id: string;
  readonly api_key_id: string;
  readonly subdomain: string;
  readonly email: string;
  readonly license_key: string;
  readonly expires_at: unknown;
  readonly status: string;
  readonly created_at: unknown;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,31}$/.test(name);
}

function isValidSubdomain(subdomain: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{1,120}$/.test(subdomain) && !subdomain.includes("..");
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Generates a buyer license key in OC-XXXXXX-XXXXXX form.
 * @returns A random uppercase license key.
 */
export function generateLicenseKey(): string {
  const part = (): string => randomBytes(3).toString("hex").toUpperCase();
  return `OC-${part()}-${part()}`;
}

function fail(status: number, message: string, code = "invalid_request"): ConsoleServiceResult {
  return { ok: false as const, status: status as 400, code, message };
}

function toRecord(row: BuyerRow): BuyerRecord {
  return {
    id: String(row.id),
    apiKeyId: String(row.api_key_id),
    subdomain: String(row.subdomain),
    email: String(row.email),
    licenseKey: String(row.license_key),
    expiresAt: toIso(row.expires_at),
    status: String(row.status),
    createdAt: toIso(row.created_at),
  };
}

function usageById(listResult: unknown): Map<string, ApiKeyListItem> {
  const map = new Map<string, ApiKeyListItem>();
  if (typeof listResult !== "object" || listResult === null) return map;
  const items = (listResult as { readonly items?: unknown }).items;
  if (!Array.isArray(items)) return map;
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as ApiKeyListItem;
    if (typeof row.id === "string") map.set(row.id, row);
  }
  return map;
}

/**
 * Creates the buyer management service. Additive: only touches the new
 * `buyers` table and delegates key lifecycle to the existing api-keys service.
 * @param pool - PostgreSQL authority pool.
 * @param apiKeys - Console api-keys service for key lifecycle + usage totals.
 * @returns Buyer CRUD + revoke/renew/share operations.
 */
export function createBuyersService(pool: PostgresPool, apiKeys: BuyersApiKeysPort): {
  readonly list: () => Promise<{ readonly items: BuyerListItem[] }>;
  readonly get: (id: string) => Promise<BuyerListItem | null>;
  readonly create: (input: BuyerCreateInput) => Promise<ConsoleServiceResult>;
  readonly revoke: (id: string) => Promise<ConsoleServiceResult>;
  readonly renew: (id: string, expiresInDays?: number) => Promise<ConsoleServiceResult>;
  readonly share: (id: string) => Promise<ConsoleServiceResult>;
} {
  async function shareMonitor(apiKeyId: string): Promise<ConsoleServiceResult | null> {
    if (typeof apiKeys.share !== "function") return null;
    return apiKeys.share(apiKeyId, { kind: "monitor" }).catch(() => null);
  }

  async function withUsage(rows: BuyerRow[]): Promise<BuyerListItem[]> {
    const usage = usageById(await apiKeys.list());
    return rows.map((row) => {
      const key = usage.get(String(row.api_key_id));
      return {
        ...toRecord(row),
        keyActive: key?.active === true,
        keyPrefix: typeof key?.keyPrefix === "string" ? key.keyPrefix : null,
        totalUsage: typeof key?.totalUsage === "number" ? key.totalUsage : 0,
        totalRequests: typeof key?.totalRequests === "number" ? key.totalRequests : 0,
        lastUsedAt: typeof key?.lastUsedAt === "string" ? key.lastUsedAt : null,
      };
    });
  }

  return {
    async list() {
      const rows = (await pool`SELECT * FROM buyers ORDER BY created_at`) as unknown as BuyerRow[];
      return { items: await withUsage(rows) };
    },

    async get(id: string) {
      const rows = (await pool`SELECT * FROM buyers WHERE id = ${id} LIMIT 1`) as unknown as BuyerRow[];
      const row = rows[0];
      if (row === undefined) return null;
      return (await withUsage([row]))[0]!;
    },

    async create(input: BuyerCreateInput) {
      const name = String(input.name ?? "").trim().toLowerCase();
      const email = String(input.email ?? "").trim();
      const subdomain = String(input.subdomain ?? "").trim().toLowerCase();
      const days = Number.isFinite(Number(input.expiresInDays)) && Number(input.expiresInDays) > 0
        ? Math.floor(Number(input.expiresInDays))
        : BUYER_DEFAULT_EXPIRES_DAYS;
      if (!isValidName(name)) return fail(400, "name must be 2-32 chars of a-z, 0-9, hyphen");
      if (!isValidEmail(email)) return fail(400, "email is invalid");
      if (!isValidSubdomain(subdomain)) return fail(400, "subdomain is invalid");
      const buyerId = `oc-${name}`;
      const existing = (await pool`SELECT id FROM buyers WHERE id = ${buyerId} OR subdomain = ${subdomain} LIMIT 1`) as unknown as Array<{ id: string }>;
      if (existing.length > 0) return fail(409, "buyer id or subdomain already exists", "conflict");

      const created = await apiKeys.create({
        name: buyerId,
        rateLimitRpm: BUYER_RATE_LIMIT_RPM,
        dailyTokenLimit: null,
        monthlyTokenLimit: null,
        oneTimeTokenLimit: null,
        maxConcurrentRequests: BUYER_MAX_CONCURRENT_REQUESTS,
        providerAllowlist: null,
        modelAllowlist: [...BUYER_FREE_MODELS],
        modelDenylist: null,
        quoteBigText: `buyer:${subdomain}`,
        quoteSubText: email,
        quoteBody: `license managed buyer, fair-use free models`,
      });
      if (!created.ok) return created;
      const keyData = created.data as { id: string; key: string } | undefined;
      if (!keyData || typeof keyData.id !== "string" || typeof keyData.key !== "string") {
        return fail(500, "api key created but response was unreadable", "internal");
      }

      const licenseKey = generateLicenseKey();
      try {
        await pool`INSERT INTO buyers (id, api_key_id, subdomain, email, license_key, expires_at, status)
          VALUES (${buyerId}, ${keyData.id}, ${subdomain}, ${email}, ${licenseKey}, now() + (${days}::text || ' days')::interval, 'active')`;
      } catch (error) {
        await apiKeys.revoke(keyData.id).catch(() => undefined);
        return fail(500, `buyer insert failed, key revoked: ${error instanceof Error ? error.message : String(error)}`, "internal");
      }

      const shared = await shareMonitor(keyData.id);
      const shareData = shared?.ok === true ? (shared.data as { url?: string } | undefined) : undefined;
      return {
        ok: true as const,
        status: 201 as const,
        data: {
          buyer: buyerId,
          apiKeyId: keyData.id,
          apiKey: keyData.key,
          licenseKey,
          expiresInDays: days,
          shareUrl: typeof shareData?.url === "string" ? shareData.url : null,
        },
      };
    },

    async revoke(id: string) {
      const rows = (await pool`SELECT * FROM buyers WHERE id = ${id} LIMIT 1`) as unknown as BuyerRow[];
      const row = rows[0];
      if (row === undefined) return fail(404, `buyer ${id} not found`, "not_found");
      await apiKeys.revoke(String(row.api_key_id)).catch(() => undefined);
      await pool`UPDATE buyers SET status = 'revoked' WHERE id = ${id}`;
      return { ok: true as const, status: 200 as const, data: { id } };
    },

    async renew(id: string, expiresInDays = BUYER_DEFAULT_EXPIRES_DAYS) {
      const rows = (await pool`SELECT * FROM buyers WHERE id = ${id} LIMIT 1`) as unknown as BuyerRow[];
      const row = rows[0];
      if (row === undefined) return fail(404, `buyer ${id} not found`, "not_found");
      const days = Number.isFinite(Number(expiresInDays)) && Number(expiresInDays) > 0
        ? Math.floor(Number(expiresInDays))
        : BUYER_DEFAULT_EXPIRES_DAYS;
      const siblings = (await pool`SELECT name FROM api_keys WHERE name = ${row.id} OR name LIKE ${`${row.id}-r%`}`) as unknown as Array<{ name: string }>;
      const keyName = `${row.id}-r${siblings.length + 1}`;
      const created = await apiKeys.create({
        name: keyName,
        rateLimitRpm: BUYER_RATE_LIMIT_RPM,
        dailyTokenLimit: null,
        monthlyTokenLimit: null,
        oneTimeTokenLimit: null,
        maxConcurrentRequests: BUYER_MAX_CONCURRENT_REQUESTS,
        providerAllowlist: null,
        modelAllowlist: [...BUYER_FREE_MODELS],
        modelDenylist: null,
        quoteBigText: `buyer:${String(row.subdomain)}`,
        quoteSubText: String(row.email),
        quoteBody: `renewal key for ${String(row.id)}`,
      });
      if (!created.ok) return created;
      const keyData = created.data as { id: string; key: string } | undefined;
      if (!keyData || typeof keyData.id !== "string" || typeof keyData.key !== "string") {
        return fail(500, "renewal key created but response was unreadable", "internal");
      }
      await pool`UPDATE buyers SET api_key_id = ${keyData.id}, expires_at = now() + (${days}::text || ' days')::interval, status = 'active' WHERE id = ${id}`;
      await apiKeys.revoke(String(row.api_key_id)).catch(() => undefined);
      const shared = await shareMonitor(keyData.id);
      const shareData = shared?.ok === true ? (shared.data as { url?: string } | undefined) : undefined;
      return {
        ok: true as const,
        status: 201 as const,
        data: {
          buyer: id,
          apiKeyId: keyData.id,
          apiKey: keyData.key,
          expiresInDays: days,
          shareUrl: typeof shareData?.url === "string" ? shareData.url : null,
        },
      };
    },

    async share(id: string) {
      const rows = (await pool`SELECT * FROM buyers WHERE id = ${id} LIMIT 1`) as unknown as BuyerRow[];
      const row = rows[0];
      if (row === undefined) return fail(404, `buyer ${id} not found`, "not_found");
      const shared = await shareMonitor(String(row.api_key_id));
      if (shared === null) return fail(501, "key share not configured", "capability_unsupported");
      return shared;
    },
  };
}
