/**
 * Runtime privacy snapshot — live `settings.settings_json.runtime.privacyMode` cache
 * consumed by every read-time IP presentation path (Console Logs SSE, `queryLogs`,
 * Usage detail). Storage always keeps raw IPs; this module is the single place that
 * decides masked vs full for the wire.
 */
import type { PostgresPool } from "../persistence/pool.js";

export type PrivacyMode = "masked" | "full";

export interface PrivacySnapshot {
  readonly privacyMode: PrivacyMode;
  readonly loadedAt: number;
}

let snapshot: PrivacySnapshot = { privacyMode: "masked", loadedAt: 0 };

async function readPrivacyMode(pool: PostgresPool): Promise<PrivacyMode> {
  try {
    const rows = (await pool`SELECT settings_json FROM settings WHERE id = 1`) as unknown as Array<{ settings_json: unknown }>;
    const raw = rows[0]?.settings_json;
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const runtime = (raw as Record<string, unknown>).runtime;
      if (runtime !== null && typeof runtime === "object" && !Array.isArray(runtime)) {
        const mode = (runtime as Record<string, unknown>).privacyMode;
        if (mode === "full") return "full";
      }
    }
  } catch {}
  return "masked";
}

/** Populates the module-scoped snapshot cache; call once during bootstrap before the HTTP server accepts requests. */
export async function initPrivacySnapshot(pool: PostgresPool): Promise<void> {
  const privacyMode = await readPrivacyMode(pool);
  snapshot = { privacyMode, loadedAt: Date.now() };
}

/** Re-reads the live setting; wire to settings mutation (patch/resetAll) so the snapshot stays fresh. */
export async function refreshPrivacySnapshot(pool: PostgresPool): Promise<void> {
  const privacyMode = await readPrivacyMode(pool);
  snapshot = { privacyMode, loadedAt: Date.now() };
}

/** Sync read of the current snapshot; never throws. Returns the masked default before `initPrivacySnapshot` runs. */
export function getPrivacySnapshot(): PrivacySnapshot {
  return snapshot;
}

/**
 * Canonical IP masker — dot-quad becomes `a.b.c.*`, colon-separated becomes last hextet `*`,
 * opaque values fall back to last 2 chars replaced with `**`.
 */
export function maskClientIp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return value as string | null;
  const ip = String(value).trim();
  if (ip.length === 0) return ip;
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
    // fallback for partial ipv4
    return `${parts.slice(0, -1).join(".")}.*`;
  }
  if (ip.includes(":")) {
    const parts = ip.split(":");
    if (parts.length > 1) {
      parts[parts.length - 1] = "*";
      // preserve compressed :: handling by not expanding
      return parts.join(":");
    }
  }
  return `${ip.slice(0, Math.max(0, ip.length - 2))}**`;
}

/** Presents a client IP under the given (or live) privacy mode: masked or raw. */
export function presentClientIp(value: string | null | undefined, mode?: PrivacyMode): string | null {
  const effectiveMode = mode ?? getPrivacySnapshot().privacyMode;
  return effectiveMode === "masked" ? maskClientIp(value) : ((value ?? null) as string | null);
}
