/**
 * Coolify connection store — Postgres persistence for configured instances.
 *
 * Owns the `coolify_servers` table (created by
 * `drizzle/pg/025_coolify_monitoring.sql`). DDL is re-applied idempotently
 * on first use so instances upgraded from an older database never crash —
 * the migration may not have run yet.
 */

import { randomUUID } from "node:crypto";
import { decryptWithKey, encryptWithKey, resolveEncryptionKey } from "../../persistence/crypto.js";
import type { PostgresPool } from "../../persistence/pool.js";
import type { CoolifyConnection } from "./types.js";

/** DDL kept in sync with `drizzle/pg/025_coolify_monitoring.sql`. */
const ENSURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS coolify_servers (
  id text PRIMARY KEY,
  name text NOT NULL,
  base_url text NOT NULL,
  api_token_encrypted text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

interface CoolifyServerRow {
  readonly id: string;
  readonly name: string;
  readonly base_url: string;
  readonly api_token_encrypted: string;
  readonly enabled: boolean;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toConnection(row: CoolifyServerRow): CoolifyConnection {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    enabled: row.enabled === true,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function encryptionKey(): Buffer {
  return resolveEncryptionKey();
}

/**
 * Create the store; DDL runs lazily on first query.
 *
 * @param pool - Postgres connection pool.
 * @returns Store with CRUD over `coolify_servers`.
 */
export function createCoolifyStore(pool: PostgresPool) {
  let ensured = false;
  async function ensure(): Promise<void> {
    if (ensured) return;
    await pool.unsafe(ENSURE_TABLE_SQL);
    ensured = true;
  }

  return {
    /**
     * List all configured instances (newest first, tokens excluded).
     *
     * @returns Connection rows without secrets.
     */
    async list(): Promise<readonly CoolifyConnection[]> {
      await ensure();
      const rows = (await pool`SELECT id, name, base_url, api_token_encrypted, enabled, created_at, updated_at FROM coolify_servers ORDER BY created_at DESC`) as unknown as readonly CoolifyServerRow[];
      return rows.map(toConnection);
    },

    /**
     * Fetch one instance by id (without secret).
     *
     * @param id - Connection id.
     * @returns Connection or null.
     */
    async get(id: string): Promise<CoolifyConnection | null> {
      await ensure();
      const rows = (await pool`SELECT id, name, base_url, api_token_encrypted, enabled, created_at, updated_at FROM coolify_servers WHERE id = ${id} LIMIT 1`) as unknown as readonly CoolifyServerRow[];
      const row = rows[0];
      return row === undefined ? null : toConnection(row);
    },

    /**
     * Fetch the decrypted API token for live Coolify calls.
     *
     * @param id - Connection id.
     * @returns `{ connection, apiToken }` or null when missing.
     */
    async getWithToken(id: string): Promise<{ readonly connection: CoolifyConnection; readonly apiToken: string } | null> {
      await ensure();
      const rows = (await pool`SELECT id, name, base_url, api_token_encrypted, enabled, created_at, updated_at FROM coolify_servers WHERE id = ${id} LIMIT 1`) as unknown as readonly CoolifyServerRow[];
      const row = rows[0];
      if (row === undefined) return null;
      let apiToken: string;
      try {
        apiToken = decryptWithKey(row.api_token_encrypted, encryptionKey());
      } catch {
        throw new Error("Stored Coolify token cannot be decrypted — re-save the connection (APP_SECRET may have changed)");
      }
      return { connection: toConnection(row), apiToken };
    },

    /**
     * Insert a new instance.
     *
     * @param input - Normalized `{ name, baseUrl, apiToken, enabled }`.
     * @returns Created connection (without secret).
     */
    async create(input: { readonly name: string; readonly baseUrl: string; readonly apiToken: string; readonly enabled: boolean }): Promise<CoolifyConnection> {
      await ensure();
      const id = randomUUID();
      const encrypted = encryptWithKey(input.apiToken, encryptionKey());
      const rows = (await pool`INSERT INTO coolify_servers (id, name, base_url, api_token_encrypted, enabled) VALUES (${id}, ${input.name}, ${input.baseUrl}, ${encrypted}, ${input.enabled}) RETURNING id, name, base_url, api_token_encrypted, enabled, created_at, updated_at`) as unknown as readonly CoolifyServerRow[];
      const row = rows[0];
      if (row === undefined) throw new Error("Failed to save Coolify connection");
      return toConnection(row);
    },

    /**
     * Update name/URL/token/enabled of an instance.
     *
     * @param id - Connection id.
     * @param patch - Fields to change (`apiToken` re-encrypts when non-empty).
     * @returns Updated connection or null when missing.
     */
    async update(
      id: string,
      patch: { readonly name?: string; readonly baseUrl?: string; readonly apiToken?: string; readonly enabled?: boolean },
    ): Promise<CoolifyConnection | null> {
      await ensure();
      const current = await this.getWithToken(id);
      if (current === null) return null;
      const existing = (await pool`SELECT api_token_encrypted FROM coolify_servers WHERE id = ${id} LIMIT 1` as unknown as ReadonlyArray<{ readonly api_token_encrypted: string }>)[0];
      if (existing === undefined) return null;
      const name = patch.name ?? current.connection.name;
      const baseUrl = patch.baseUrl ?? current.connection.baseUrl;
      const enabled = patch.enabled ?? current.connection.enabled;
      const encrypted =
        patch.apiToken !== undefined && patch.apiToken.length > 0
          ? encryptWithKey(patch.apiToken, encryptionKey())
          : existing.api_token_encrypted;
      const rows = (await pool`UPDATE coolify_servers SET name = ${name}, base_url = ${baseUrl}, api_token_encrypted = ${encrypted}, enabled = ${enabled}, updated_at = now() WHERE id = ${id} RETURNING id, name, base_url, api_token_encrypted, enabled, created_at, updated_at`) as unknown as readonly CoolifyServerRow[];
      const row = rows[0];
      return row === undefined ? null : toConnection(row);
    },

    /**
     * Delete an instance.
     *
     * @param id - Connection id.
     * @returns True when a row was removed.
     */
    async remove(id: string): Promise<boolean> {
      await ensure();
      const rows = (await pool`DELETE FROM coolify_servers WHERE id = ${id} RETURNING id`) as unknown as ReadonlyArray<{ readonly id: string }>;
      return rows.length > 0;
    },
  };
}

/** Store shape consumed by the Coolify service. */
export type CoolifyStore = ReturnType<typeof createCoolifyStore>;
