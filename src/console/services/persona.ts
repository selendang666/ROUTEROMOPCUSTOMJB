/**
 * Persona console service — global locked persona stored in
 * `settings.settings_json.runtime.globalPersona`, plus Hermes soul sync.
 *
 * Uploading a pack activates it immediately (drop-and-inject): the proxy
 * snapshot is refreshed in-process and the Hermes SOUL.md is rewritten
 * with a timestamped backup of the previous soul.
 */
import type { PostgresPool } from "../../persistence/pool.js";
import { parsePersonaZip, PersonaPackError } from "../../persona/package.js";
import { hermesHome, syncPersonaToHermes } from "../../persona/hermes-sync.js";
import { MAX_PERSONA_SNAPSHOT_CHARS, refreshPersonaSnapshot } from "../../persona/snapshot.js";

/** Max stored persona content chars (64 KiB, snapshot reads bound it further). */
export const MAX_STORED_PERSONA_CHARS = 65_536;
const SAFE_PERSONA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Public persona view returned to the console. */
export interface PersonaPublic {
  readonly enabled: boolean;
  readonly name: string;
  readonly version: string;
  readonly chars: number;
  readonly preview: string;
  readonly updatedAt: string;
  readonly hermesSyncedAt: string | null;
  readonly hermesHome: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toPublic(stored: Record<string, unknown>): PersonaPublic {
  const content = typeof stored.content === "string" ? stored.content : "";
  return {
    enabled: stored.enabled === true && content.length > 0,
    name: typeof stored.name === "string" ? stored.name : "",
    version: typeof stored.version === "string" ? stored.version : "",
    chars: content.length,
    preview: content.slice(0, 500),
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : "",
    hermesSyncedAt: typeof stored.hermesSyncedAt === "string" ? stored.hermesSyncedAt : null,
    hermesHome: hermesHome(),
  };
}

/** Creates the persona console service over the shared PostgreSQL pool. */
export function createPersonaService(pool: PostgresPool) {
  async function readStored(): Promise<Record<string, unknown>> {
    const rows = (await pool`SELECT settings_json FROM settings WHERE id = 1`) as unknown as Array<{
      settings_json: unknown;
    }>;
    const settingsJson = recordOf(rows[0]?.settings_json);
    const runtime = recordOf(settingsJson?.runtime);
    return recordOf(runtime?.globalPersona) ?? {};
  }

  async function writeStored(next: Record<string, unknown>): Promise<PersonaPublic> {
    const rows = (await pool`SELECT settings_json FROM settings WHERE id = 1`) as unknown as Array<{
      settings_json: unknown;
    }>;
    const base = recordOf(rows[0]?.settings_json) ?? {};
    const runtime: Record<string, unknown> = recordOf(base.runtime) ?? {};
    // Bun's SQL driver serializes object parameters for `::jsonb` casts —
    // never pre-stringify or the column double-encodes (see console-settings).
    await pool`UPDATE settings SET settings_json = ${{ ...base, runtime: { ...runtime, globalPersona: next } }}::jsonb, updated_at = now() WHERE id = 1`;
    await refreshPersonaSnapshot(pool);
    return toPublic(next);
  }

  return {
    async get(): Promise<PersonaPublic> {
      return toPublic(await readStored());
    },

    async patch(body: unknown) {
      const v = recordOf(body) ?? {};
      const current = await readStored();
      const currentContent = typeof current.content === "string" ? current.content : "";
      const next: Record<string, unknown> = { ...current };
      if (v.enabled !== undefined) next.enabled = v.enabled === true;
      if (v.name !== undefined) {
        if (typeof v.name !== "string" || !SAFE_PERSONA_NAME.test(v.name)) {
          return { ok: false as const, status: 400 as const, message: "name must use letters, numbers, ., _, or - (max 64 chars)" };
        }
        next.name = v.name;
      }
      if (v.version !== undefined) {
        if (typeof v.version !== "string" || v.version.length > 32) {
          return { ok: false as const, status: 400 as const, message: "version must be a string up to 32 chars" };
        }
        next.version = v.version;
      }
      if (v.content !== undefined) {
        if (typeof v.content !== "string" || v.content.length === 0) {
          return { ok: false as const, status: 400 as const, message: "content must be a non-empty string" };
        }
        if (v.content.length > MAX_STORED_PERSONA_CHARS) {
          return { ok: false as const, status: 400 as const, message: `content exceeds ${MAX_STORED_PERSONA_CHARS} chars` };
        }
        next.content = v.content;
      }
      next.updatedAt = new Date().toISOString();
      const saved = await writeStored(next);
      if (typeof next.content === "string" && next.content.length > 0) {
        const sync = await syncPersonaToHermes({
          name: typeof next.name === "string" && next.name.length > 0 ? next.name : "custom",
          version: typeof next.version === "string" ? next.version : "1",
          soul: next.content,
        });
        const stamped = await writeStored({ ...next, hermesSyncedAt: sync.at });
        return { ok: true as const, status: 200 as const, data: { ...stamped, sync } };
      }
      return { ok: true as const, status: 200 as const, data: saved };
    },

    async upload(bytes: Uint8Array, filename: string) {
      if (!filename.toLowerCase().endsWith(".zip")) {
        return { ok: false as const, status: 400 as const, message: "Only .zip packs are accepted" };
      }
      let pack;
      try {
        pack = parsePersonaZip(bytes);
      } catch (error) {
        const reason = error instanceof PersonaPackError ? error.reason : "bad_zip";
        const message = error instanceof Error ? error.message : "Invalid persona pack";
        return { ok: false as const, status: 400 as const, message, reason };
      }
      if (pack.content.length > MAX_STORED_PERSONA_CHARS) {
        return { ok: false as const, status: 400 as const, message: `Assembled persona exceeds ${MAX_STORED_PERSONA_CHARS} chars` };
      }
      const at = new Date().toISOString();
      const saved = await writeStored({
        enabled: true,
        name: pack.manifest.name,
        version: pack.manifest.version,
        content: pack.content,
        soul: pack.soul,
        extras: pack.extras.length,
        updatedAt: at,
        hermesSyncedAt: null,
      });
      void saved;
      const sync = await syncPersonaToHermes({ name: pack.manifest.name, version: pack.manifest.version, soul: pack.soul });
      const stored = await readStored();
      const finalView = await writeStored({ ...stored, hermesSyncedAt: sync.at });
      return {
        ok: true as const,
        status: 200 as const,
        data: {
          ...finalView,
          files: pack.extras.map((e) => e.path),
          sync: { home: sync.home, soulPath: sync.soulPath, backedUp: sync.backedUp, at: sync.at },
        },
      };
    },

    async syncHermes() {
      const stored = await readStored();
      const soul = typeof stored.soul === "string" && stored.soul.length > 0
        ? stored.soul
        : typeof stored.content === "string" ? stored.content : "";
      const name = typeof stored.name === "string" && stored.name.length > 0 ? stored.name : "custom";
      if (soul.length === 0) return { ok: false as const, status: 400 as const, message: "No persona stored to sync" };
      if (!SAFE_PERSONA_NAME.test(name)) {
        return { ok: false as const, status: 400 as const, message: "Stored persona name is invalid" };
      }
      const sync = await syncPersonaToHermes({
        name,
        version: typeof stored.version === "string" ? stored.version : "1",
        soul,
      });
      const view = await writeStored({ ...stored, hermesSyncedAt: sync.at });
      return { ok: true as const, status: 200 as const, data: { ...view, sync } };
    },
  };
}

/** Snapshot bound re-export for console consumers. */
export { MAX_PERSONA_SNAPSHOT_CHARS };
