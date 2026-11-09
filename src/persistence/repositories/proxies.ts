import { resolveEncryptionKey, encryptWithKey } from "../crypto.js";
import type { ConfigEncryptionOptions } from "../crypto.js";
import { createDrizzlePG, type DrizzlePG } from "../db.js";
import { proxies, proxySettings } from "../schema/pg.js";
import { eq } from "drizzle-orm";

function toSnakeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const [k, v] of Object.entries(row)) {
    const snake = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    out[snake] = v;
    // keep camelCase already present via spread
  }
  return out;
}

export function createProxyRepository(
  db: DrizzlePG = createDrizzlePG(),
  options?: ConfigEncryptionOptions & { readonly onMutation?: () => void },
) {
  const key = resolveEncryptionKey(options);

  return {
    async list() {
      const rows = await db
        .select()
        .from(proxies)
        .orderBy(proxies.priority, proxies.name, proxies.id);
      return rows.map((r) => toSnakeRow(r as unknown as Record<string, unknown>)) as unknown as Array<Record<string, unknown>>;
    },
    async get(id: string) {
      const rows = await db.select().from(proxies).where(eq(proxies.id, id)).limit(1);
      const row = rows[0] as unknown as Record<string, unknown> | undefined;
      return row ? (toSnakeRow(row) as Record<string, unknown>) : null;
    },
    async create(input: {
      id: string;
      name: string;
      protocol: string;
      host: string;
      port: number;
      username?: string | null;
      password?: string;
      isRelay?: boolean;
      priority?: number;
      weight?: number;
      maxConcurrency?: number;
    }) {
      const enc = input.password ? encryptWithKey(input.password, key) : null;
      await db.insert(proxies).values({
        id: input.id,
        name: input.name,
        protocol: input.protocol,
        isRelay: Boolean(input.isRelay),
        host: input.host,
        port: input.port,
        username: input.username ?? null,
        passwordEncrypted: enc as string | null,
        priority: input.priority ?? 100,
        weight: input.weight ?? 100,
        maxConcurrency: input.maxConcurrency ?? 8,
      } as never);
      options?.onMutation?.();
      const rows = await db.select().from(proxies).where(eq(proxies.id, input.id)).limit(1);
      const row = rows[0] as unknown as Record<string, unknown> | undefined;
      // Preserve original shape: SELECT id FROM proxies WHERE id = ... returns at least { id }
      // Return full row snake-mapped for compatibility; caller casts to Record<string,unknown>
      return row ? (toSnakeRow(row) as Record<string, unknown>) : ({ id: input.id } as Record<string, unknown>);
    },
    async getSettings() {
      const rows = await db.select().from(proxySettings).where(eq(proxySettings.id, 1)).limit(1);
      const row = rows[0] as unknown as Record<string, unknown> | undefined;
      return row ? (toSnakeRow(row) as Record<string, unknown>) : null;
    },
  };
}
