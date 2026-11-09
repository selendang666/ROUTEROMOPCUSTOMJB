// Encryption and crypto helpers
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { RuntimeConfig } from "../runtime/runtime.js";

// ── Production fail-fast encryption policy ─────────────────────────────────
export const MIN_PRODUCTION_SECRET_LENGTH = 32;

const PLACEHOLDER_PATTERN =
  /^(?:change-me|replace-with|replace_me|password|secret|default|example)(?:[-_].*)?$/i;

function isProductionFromEnvOrConfig(runtimeConfig?: Pick<RuntimeConfig, "isProduction">): boolean {
  if (runtimeConfig?.isProduction !== undefined) return runtimeConfig.isProduction;
  const v = Bun.env.NODE_ENV?.trim();
  return v !== "development" && v !== "test";
}

export function isStrongValue(value: string, minimumLength: number): boolean {
  return value.length >= minimumLength && !PLACEHOLDER_PATTERN.test(value);
}

export interface ConfigEncryptionOptions {
  readonly encryptionKey?: Buffer;
  readonly runtimeConfig?: Pick<RuntimeConfig, "encryption" | "isProduction">;
}

export function resolveEncryptionKey(options?: ConfigEncryptionOptions): Buffer {
  // Explicit injection path — server provides derived key from RuntimeConfig (preferred)
  if (options?.encryptionKey) {
    if (options.runtimeConfig?.isProduction) {
      if (options.runtimeConfig.encryption.isDevFallback) {
        throw new Error(
          "Missing APP_SECRET in production: set APP_SECRET to a strong random value. Refusing to use dev fallback.",
        );
      }
    }
    return options.encryptionKey;
  }

  // RuntimeConfig-provided policy without explicit key — derive only from APP_SECRET.
  if (options?.runtimeConfig) {
    if (options.runtimeConfig.isProduction && options.runtimeConfig.encryption.isDevFallback) {
      throw new Error(
        "Missing APP_SECRET in production: set APP_SECRET to a strong random value. Refusing to use dev fallback.",
      );
    }
    // Policy is non-fallback but we still need raw material — fall through to env-derived path
    // which will re-derive from the same env that produced the policy (consistent with runtime/config).
  }

  const isProduction = isProductionFromEnvOrConfig(options?.runtimeConfig);
  const app = Bun.env.APP_SECRET?.trim();

  if (app !== undefined && app.length > 0) {
    if (isProduction && !isStrongValue(app, MIN_PRODUCTION_SECRET_LENGTH)) {
      throw new Error(
        `APP_SECRET must be a non-placeholder secret of at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production.`,
      );
    }
    if (isProduction && PLACEHOLDER_PATTERN.test(app)) {
      throw new Error("APP_SECRET is a placeholder value; set a strong random secret in production");
    }
    return createHash("sha256").update(app).digest();
  }

  throw new Error("APP_SECRET is required for credential encryption");
}

export function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptWithKey(blob: string, key: Buffer): string {
  const parts = blob.split(":");
  if (parts.length !== 3) throw new Error("Invalid credential blob — expected aes-256-gcm format (iv:tag:ciphertext). Fresh PostgreSQL stores only encrypted values.");
  const iv = Buffer.from(parts[0]!, "base64");
  const tag = Buffer.from(parts[1]!, "base64");
  const enc = Buffer.from(parts[2]!, "base64");
  const tryDecrypt = (k: Buffer): string => {
    const decipher = createDecipheriv("aes-256-gcm", k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  };
  try {
    return tryDecrypt(key);
  } catch {
    const prev = Bun.env.APP_SECRET_PREV?.trim();
    if (prev !== undefined && prev.length > 0) {
      try {
        return tryDecrypt(createHash("sha256").update(prev).digest());
      } catch {}
    }
    throw new Error("Invalid credential blob — expected aes-256-gcm format (iv:tag:ciphertext). Fresh PostgreSQL stores only encrypted values.");
  }
}

export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// ── Hash LRU 2000 with wyhash fast-path ───────────────────────────────────
const HASH_LRU_LIMIT = 2000;

function wyhash64(value: string): bigint {
  // Bun built-in fast path when available (Bun.hash.wyhash)
  try {
    const maybeBun = globalThis as unknown as { Bun?: { hash?: { wyhash?: (input: string, seed?: number) => number | bigint } } };
    const fn = maybeBun.Bun?.hash?.wyhash;
    if (typeof fn === "function") {
      const out = fn(value, 0);
      return typeof out === "bigint" ? out : BigInt(out >>> 0);
    }
  } catch {}
  // Fallback: FNV-1a 64 + wy mix (deterministic, fast, no alloc)
  let h = 14695981039346656037n;
  const prime = 1099511628211n;
  const mask64 = (1n << 64n) - 1n;
  for (let i = 0; i < value.length; i++) {
    h ^= BigInt(value.charCodeAt(i));
    h = (h * prime) & mask64;
  }
  h ^= h >> 33n;
  h = (h * 0xff51afd7ed558ccdn) & mask64;
  h ^= h >> 33n;
  h = (h * 0xc4ceb9fe1a85ec53n) & mask64;
  h ^= h >> 33n;
  return h;
}

type HashCacheEntry = { readonly secret: string; readonly hash: string };
const hashCache = new Map<bigint, HashCacheEntry>();

export function apiKeyHash(secret: string): string {
  const w = wyhash64(secret);
  const hit = hashCache.get(w);
  if (hit !== undefined && hit.secret === secret) {
    // LRU bump
    hashCache.delete(w);
    hashCache.set(w, hit);
    return hit.hash;
  }
  // Also handle wyhash collision where same wyhash but different secret: fall through to compute
  // and treat as miss (verify secret equality above). No need to linear probe because 64-bit collision is negligible.
  const hash = createHash("sha256").update(secret).digest("hex");
  if (hashCache.size >= HASH_LRU_LIMIT) {
    const oldest = hashCache.keys().next().value as bigint | undefined;
    if (oldest !== undefined) hashCache.delete(oldest);
  }
  if (hit !== undefined && hit.secret !== secret) {
    // collision: evict stale entry before insert to avoid losing branch
    hashCache.delete(w);
  }
  hashCache.set(w, { secret, hash });
  return hash;
}

export function keyPrefix(secret: string): string {
  return secret.slice(0, 8);
}
// Expose for testing / introspection (not part of public contract but useful for validation)
export function __hashCacheSize(): number {
  return hashCache.size;
}
export function __hashCacheClear(): void {
  hashCache.clear();
}
export function __wyhash(value: string): bigint {
  return wyhash64(value);
}
// Test helpers delegate to the same production key derivation.
export function encryptForTesting(plaintext: string, options?: ConfigEncryptionOptions): string {
  return encryptWithKey(plaintext, resolveEncryptionKey(options));
}

export function decryptForTesting(blob: string, options?: ConfigEncryptionOptions): string {
  return decryptWithKey(blob, resolveEncryptionKey(options));
}
