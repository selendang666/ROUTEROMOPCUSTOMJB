/**
 * Global persona snapshot — live `settings.settings_json.runtime.globalPersona` cache
 * consumed by the proxy prepare path on every request. Mirrors the privacy
 * snapshot pattern: module-scoped, sync read, refresh on settings mutation.
 * Storage is the existing `settings` row; no migration needed.
 */
import type { PostgresPool } from "../persistence/pool.js";

/** Persona record as stored under `settings_json.runtime.globalPersona`. */
export interface GlobalPersonaRecord {
  readonly enabled: boolean;
  readonly name: string;
  readonly version: string;
  readonly content: string;
  readonly updatedAt: string;
  readonly hermesSyncedAt: string | null;
}

/** Live snapshot handed to the request pipeline; content is length-bounded. */
export interface GlobalPersonaSnapshot {
  readonly enabled: boolean;
  readonly name: string;
  readonly version: string;
  readonly content: string;
  readonly updatedAt: string;
  readonly loadedAt: number;
}

/** Hard bound so a runaway persona pack cannot blow up request payloads. */
export const MAX_PERSONA_SNAPSHOT_CHARS = 48_000;

const DISABLED: GlobalPersonaSnapshot = {
  enabled: false,
  name: "",
  version: "",
  content: "",
  updatedAt: "",
  loadedAt: 0,
};

let snapshot: GlobalPersonaSnapshot = DISABLED;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parses a raw `globalPersona` value into a snapshot.
 * @param value Raw value from `settings_json.runtime.globalPersona`.
 * @returns Bounded snapshot, or a disabled snapshot when absent/invalid.
 */
export function parsePersonaRecord(value: unknown): GlobalPersonaSnapshot {
  const record = recordOf(value);
  if (record === null) return DISABLED;
  const content = typeof record.content === "string" ? record.content : "";
  const enabled = record.enabled === true && content.length > 0;
  return {
    enabled,
    name: typeof record.name === "string" ? record.name : "",
    version: typeof record.version === "string" ? record.version : "",
    content: content.length <= MAX_PERSONA_SNAPSHOT_CHARS
      ? content
      : content.slice(0, MAX_PERSONA_SNAPSHOT_CHARS),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    loadedAt: Date.now(),
  };
}

async function readPersonaRecord(pool: PostgresPool): Promise<unknown> {
  try {
    const rows = (await pool`SELECT settings_json FROM settings WHERE id = 1`) as unknown as Array<{
      settings_json: unknown;
    }>;
    const runtime = recordOf(recordOf(rows[0]?.settings_json)?.runtime);
    return runtime?.globalPersona ?? null;
  } catch {
    return null;
  }
}

/** Populates the module-scoped snapshot cache; call once during bootstrap before serving. */
export async function initPersonaSnapshot(pool: PostgresPool): Promise<void> {
  snapshot = parsePersonaRecord(await readPersonaRecord(pool));
}

/** Re-reads the live persona; wire to settings mutation so the snapshot stays fresh. */
export async function refreshPersonaSnapshot(pool: PostgresPool): Promise<void> {
  snapshot = parsePersonaRecord(await readPersonaRecord(pool));
}

/** Starts bounded background refreshes for changes made by another process. */
export function startPersonaSnapshotRefresh(pool: PostgresPool, intervalMs = 5_000): () => void {
  const timer = setInterval(() => {
    void refreshPersonaSnapshot(pool);
  }, Math.max(1_000, Math.floor(intervalMs)));
  return () => clearInterval(timer);
}

/** Sync read of the current snapshot; never throws. Disabled before init runs. */
export function getPersonaSnapshot(): GlobalPersonaSnapshot {
  return snapshot;
}
