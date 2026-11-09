import { encryptWithKey, decryptWithKey, resolveEncryptionKey } from "../persistence/crypto.js";
import type { PostgresPool } from "../persistence/pool.js";
import type { ConfigEncryptionOptions } from "../persistence/crypto.js";

interface RelaySecretState {
  readonly configured: boolean;
  readonly masked: string | null;
}

interface RelaySecretRecord {
  readonly get: () => Promise<RelaySecretState>;
  readonly getSecret: () => Promise<string | null>;
  readonly update: (body: unknown) => Promise<{ readonly ok: boolean; readonly status: number; readonly data?: RelaySecretState; readonly message?: string }>;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function encryptedSecretOf(settings: unknown): string | null {
  const root = recordOf(settings);
  const relay = recordOf(root?.relay);
  const vercel = recordOf(relay?.vercel);
  const value = vercel?.secretEncrypted;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function maskSecret(value: string): string {
  return `••••${value.slice(-4)}`;
}

function readSettings(pool: PostgresPool): Promise<Record<string, unknown>> {
  return (async () => {
    const rows = (await pool`SELECT settings_json FROM settings WHERE id = 1`) as unknown as Array<{ settings_json: unknown }>;
    return recordOf(rows[0]?.settings_json) ?? {};
  })();
}

function setSecret(settings: Record<string, unknown>, encrypted: string | null): Record<string, unknown> {
  const relay = recordOf(settings.relay) ?? {};
  const vercel = recordOf(relay.vercel) ?? {};
  return {
    ...settings,
    relay: {
      ...relay,
      vercel: {
        ...vercel,
        ...(encrypted === null ? { secretEncrypted: null } : { secretEncrypted: encrypted }),
      },
    },
  };
}

export function createRelaySecretService(pool: PostgresPool, options?: ConfigEncryptionOptions): RelaySecretRecord {
  const getSecret = async (): Promise<string | null> => {
    const encrypted = encryptedSecretOf(await readSettings(pool));
    if (encrypted === null) return null;
    try {
      return decryptWithKey(encrypted, resolveEncryptionKey(options));
    } catch {
      return null;
    }
  };
  return {
    async get(): Promise<RelaySecretState> {
      const settings = await readSettings(pool);
      const encrypted = encryptedSecretOf(settings);
      if (encrypted === null) return { configured: false, masked: null };
      const secret = await getSecret();
      return { configured: secret !== null, masked: secret === null ? "••••configured" : maskSecret(secret) };
    },
    getSecret,
    async update(body: unknown) {
      const value = recordOf(body);
      if (value === null || Object.keys(value).length !== 1 || typeof value.secret !== "string") {
        return { ok: false, status: 400, message: "body must contain only secret" };
      }
      const secret = value.secret.trim();
      if (secret.length < 8 || secret.length > 4096 || /[\r\n]/.test(secret)) {
        return { ok: false, status: 400, message: "secret must be 8 to 4096 characters" };
      }
      const encrypted = encryptWithKey(secret, resolveEncryptionKey(options));
      const next = setSecret(await readSettings(pool), encrypted);
      await pool`UPDATE settings SET settings_json = ${next}::jsonb, updated_at = now() WHERE id = 1`;
      return { ok: true, status: 200, data: { configured: true, masked: maskSecret(secret) } };
    },
  };
}
