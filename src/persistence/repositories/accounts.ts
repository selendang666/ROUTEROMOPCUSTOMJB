import { resolveEncryptionKey, encryptWithKey, decryptWithKey, toIso } from "../crypto.js";
import type { ConfigEncryptionOptions } from "../crypto.js";
import type { ProviderAccountPublic, RouteSnapshot } from "../types.js";
import type { CredentialKind } from "../../proxy/types/surface.js";
import type { ModelLockRecord } from "../../proxy/types/routing.js";
import { createDrizzlePG, type DrizzlePG } from "../db.js";
import {
  accountModelLocks,
  cliMappings,
  cliTools,
  combos,
  modelAliases,
  providerAccountHealth,
  providerAccounts,
  providerModels,
  proxies,
  proxyHealth,
} from "../schema/pg.js";
import { eq, gt, sql } from "drizzle-orm";

function toSnake<T extends Record<string, unknown>>(row: T): T & Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const [key, value] of Object.entries(row)) {
    const snake = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
    if (!(snake in out)) out[snake] = value;
  }
  return out as T & Record<string, unknown>;
}

function parseAllowedApiKeyIds(raw: unknown): string[] | undefined {
  try {
    if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === "string");
    if (typeof raw === "string") {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {}
  return undefined;
}

/** Creates the provider account repository over the canonical Drizzle PostgreSQL client. */
export function createAccountRepository(db: DrizzlePG = createDrizzlePG(), options?: ConfigEncryptionOptions & { readonly onMutation?: () => void }) {
  const key = resolveEncryptionKey(options);
  const encrypt = (value: string): string => encryptWithKey(value, key);
  const decrypt = (value: string): string => decryptWithKey(value, key);
  const snapshotCache: SnapshotCacheRef = { value: null, pending: null };

  return {
    async list(provider?: string) {
      const rows = provider
        ? await db.select().from(providerAccounts).where(eq(providerAccounts.provider, provider)).orderBy(providerAccounts.priority, providerAccounts.name, providerAccounts.id)
        : await db.select().from(providerAccounts).orderBy(providerAccounts.provider, providerAccounts.priority, providerAccounts.name, providerAccounts.id);
      return rows.map((row) => toSnake(row as unknown as Record<string, unknown>));
    },
    async get(id: string) {
      const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, id)).limit(1);
      const row = rows[0];
      return row ? toSnake(row as unknown as Record<string, unknown>) : null;
    },
    async getCredential(id: string): Promise<string | null> {
      const rows = await db.select({ credentialEncrypted: providerAccounts.credentialEncrypted }).from(providerAccounts).where(eq(providerAccounts.id, id)).limit(1);
      const row = rows[0];
      return row?.credentialEncrypted ? decrypt(row.credentialEncrypted) : null;
    },
    async create(input: { id: string; provider: string; name: string; credentialKind: string; credential: string; credentialHint?: string; priority?: number }) {
      const encrypted = encrypt(input.credential);
      await db.insert(providerAccounts).values({
        id: input.id,
        provider: input.provider,
        name: input.name,
        credentialKind: input.credentialKind as CredentialKind,
        credentialEncrypted: encrypted,
        credentialHint: input.credentialHint ?? "",
        priority: input.priority ?? 100,
      });
      options?.onMutation?.();
      const rows = await db.select({ id: providerAccounts.id, provider: providerAccounts.provider, name: providerAccounts.name }).from(providerAccounts).where(eq(providerAccounts.id, input.id)).limit(1);
      return rows[0] as unknown as Record<string, unknown>;
    },
    async update(id: string, patch: Record<string, unknown>) {
      const set: Record<string, unknown> = {};
      if (patch.credential !== undefined) set.credentialEncrypted = encrypt(String(patch.credential));
      if (patch.name !== undefined) set.name = String(patch.name);
      if (patch.active !== undefined) set.active = Boolean(patch.active);
      if (patch.priority !== undefined) set.priority = Number(patch.priority);
      if (Object.keys(set).length > 0) {
        await db.update(providerAccounts).set({ ...set, updatedAt: sql`now()` as unknown as string }).where(eq(providerAccounts.id, id));
      }
      options?.onMutation?.();
      const rows = await db.select({ id: providerAccounts.id }).from(providerAccounts).where(eq(providerAccounts.id, id)).limit(1);
      return (rows[0] as unknown as Record<string, unknown> | undefined) ?? null;
    },
    async remove(id: string) {
      await db.delete(providerAccounts).where(eq(providerAccounts.id, id));
      options?.onMutation?.();
    },
    getRouteSnapshot: () => loadRouteSnapshot(db, snapshotCache),
    invalidateRouteSnapshot(): void { snapshotCache.value = null; },
  };
}

interface SnapshotCacheRef {
  value: { data: RouteSnapshot; expiresAt: number } | null;
  pending: Promise<RouteSnapshot> | null;
}
const SNAPSHOT_TTL_MS = 5000;

async function loadRouteSnapshot(db: DrizzlePG, cache: SnapshotCacheRef): Promise<RouteSnapshot> {
  if (cache.value !== null && Date.now() < cache.value.expiresAt) return cache.value.data;
  if (cache.pending !== null) return cache.pending;
  cache.pending = (async () => {
    const [accounts, models, aliases, combosRows, proxiesRows, accountHealth, proxyHealthRows, modelLocks, cliToolsRows, cliMappingsRows] = await Promise.all([
      db.select().from(providerAccounts).where(eq(providerAccounts.active, true)).orderBy(providerAccounts.provider, providerAccounts.priority, providerAccounts.name, providerAccounts.id),
      db.select().from(providerModels).orderBy(providerModels.provider, providerModels.modelId),
      db.select().from(modelAliases).orderBy(modelAliases.alias),
      db.select().from(combos).orderBy(combos.name),
      db.select().from(proxies).where(eq(proxies.active, true)).orderBy(proxies.priority, proxies.name, proxies.id),
      db.select().from(providerAccountHealth),
      db.select().from(proxyHealth),
      db.select().from(accountModelLocks).where(gt(accountModelLocks.retryAt, sql`now()`)),
      db.select().from(cliTools),
      db.select().from(cliMappings),
    ]);

    const accountsSnake = accounts.map((row) => toSnake(row as unknown as Record<string, unknown>));
  const modelsSnake = models.map((row) => toSnake(row as unknown as Record<string, unknown>));
  const aliasesSnake = aliases.map((row) => toSnake(row as unknown as Record<string, unknown>));
  const combosSnake = combosRows.map((row) => toSnake(row as unknown as Record<string, unknown>));
  const proxiesSnake = proxiesRows.map((row) => toSnake(row as unknown as Record<string, unknown>));
  const accountHealthSnake = accountHealth.map((row) => toSnake(row as unknown as Record<string, unknown>));
  const proxyHealthSnake = proxyHealthRows.map((row) => {
    const snake = toSnake(row as unknown as Record<string, unknown>);
    if (snake.proxy_id === undefined && snake.proxyId !== undefined) snake.account_id = snake.proxyId;
    if (snake.proxy_id !== undefined) snake.account_id = snake.proxy_id;
    return snake;
  });
  const modelLocksSnake = modelLocks.map((row) => toSnake(row as unknown as Record<string, unknown>));
  const cliToolsSnake = cliToolsRows.map((row) => toSnake(row as unknown as Record<string, unknown>));
  const cliMappingsSnake = cliMappingsRows.map((row) => toSnake(row as unknown as Record<string, unknown>));

  const healthMap = new Map<string, Record<string, unknown>>();
  for (const health of accountHealthSnake) healthMap.set(String(health.account_id), health);
  const proxyHealthMap = new Map<string, Record<string, unknown>>();
  for (const health of proxyHealthSnake) proxyHealthMap.set(String(health.account_id), health);

  const modelLockMap = new Map<string, Map<string, ModelLockRecord>>();
  for (const row of modelLocksSnake) {
    const accountId = String(row.account_id);
    const modelId = String(row.model_id);
    const locks = modelLockMap.get(accountId) ?? new Map<string, ModelLockRecord>();
    locks.set(modelId, {
      accountId,
      modelId,
      retryAt: toIso(row.retry_at) ?? new Date().toISOString(),
      errorKind: typeof row.error_kind === "string" ? row.error_kind : null,
      statusCode: typeof row.status_code === "number" ? row.status_code : null,
      safeMessage: typeof row.sanitized_message === "string" ? row.sanitized_message : null,
      failureCount: typeof row.failure_count === "number" ? row.failure_count : 0,
    });
    modelLockMap.set(accountId, locks);
  }

  const cliModelMappings = new Map<string, { enabled: boolean; entries: Array<{ sourceModel: string; targetModel: string; enabled: boolean }>; allowedApiKeyIds?: string[] }>();
  const cliToolsById = new Map<string, Record<string, unknown>>();
  for (const row of cliToolsSnake) cliToolsById.set(String(row.tool_id), row);
  const cliMappingsByTool = new Map<string, Array<Record<string, unknown>>>();
  for (const row of cliMappingsSnake) {
    const toolId = String(row.tool_id);
    const list = cliMappingsByTool.get(toolId) ?? [];
    list.push(row);
    cliMappingsByTool.set(toolId, list);
  }
  for (const [toolId, rows] of cliMappingsByTool) {
    const toolRow = cliToolsById.get(toolId);
    const enabled = toolRow ? Boolean(toolRow.enabled) : true;
    const allowed = parseAllowedApiKeyIds(toolRow?.allowed_api_key_ids);
    cliModelMappings.set(toolId, {
      enabled,
      entries: rows.map((row) => ({ sourceModel: String(row.source_model), targetModel: String(row.target_model), enabled: Boolean(row.enabled) })),
      ...(allowed ? { allowedApiKeyIds: allowed } : {}),
    });
  }
  for (const [toolId, row] of cliToolsById) {
    if (cliModelMappings.has(toolId)) continue;
    const allowed = parseAllowedApiKeyIds(row.allowed_api_key_ids);
    cliModelMappings.set(toolId, { enabled: Boolean(row.enabled), entries: [], ...(allowed ? { allowedApiKeyIds: allowed } : {}) });
  }

  const normalizedAccounts: ProviderAccountPublic[] = accountsSnake.map((row) => {
    const id = String(row.id);
    const provider = String(row.provider);
    const active = Boolean(row.active);
    const healthRaw = healthMap.get(id);
    const status = (healthRaw?.status as string | undefined) ?? (active ? "healthy" : "disabled");
    const retryAt = (healthRaw?.retry_at as string | null | undefined) ?? (row.cooldown_until as string | null | undefined) ?? null;
    const healthy = active && status === "healthy" && !(retryAt && Date.parse(String(retryAt)) > Date.now());
    return {
      id,
      accountId: id,
      provider,
      providerId: provider,
      name: String(row.name),
      credentialKind: (row.credential_kind as CredentialKind | undefined) ?? "api_key",
      credentialHint: String(row.credential_hint ?? ""),
      priority: Number(row.priority ?? 100),
      active,
      enabled: active,
      healthy,
      health: healthRaw ? { status: status as never, retryAt: retryAt ? toIso(retryAt) : null, statusCode: (healthRaw.status_code as number | null) ?? null } as never : null,
      quotaAvailable: null,
      modelLocks: modelLockMap.get(id) ?? null,
      cooldownUntil: toIso(row.cooldown_until),
      cooldownLevel: Number(row.cooldown_level ?? 0),
      consecutiveUseCount: Number(row.consecutive_use_count ?? 0),
      lastUsedAt: toIso(row.last_used_at),
      createdAt: toIso(row.created_at)!,
      updatedAt: toIso(row.updated_at)!,
    } as unknown as ProviderAccountPublic;
  });
  const normalizedModels = modelsSnake.map((row) => ({
    provider: String(row.provider),
    providerId: String(row.provider),
    modelId: String(row.model_id),
    upstreamModelId: String(row.model_id),
    enabled: Boolean(row.enabled),
    source: String(row.source ?? "manual"),
    displayName: typeof row.display_name === "string" ? row.display_name : null,
    metadata: typeof row.metadata_json === "object" && row.metadata_json !== null && !Array.isArray(row.metadata_json) ? row.metadata_json as Record<string, unknown> : {},
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  }));
  const normalizedProxies = proxiesSnake.map((row) => ({ ...row, cooldownUntil: toIso(row.cooldown_until), lastUsedAt: toIso(row.last_used_at), createdAt: toIso(row.created_at)!, updatedAt: toIso(row.updated_at)! }));
  const snapshot: RouteSnapshot = {
    accounts: normalizedAccounts,
    accountHealth: healthMap as unknown as RouteSnapshot["accountHealth"],
    modelLocks: modelLocksSnake as unknown as RouteSnapshot["modelLocks"],
    models: normalizedModels as unknown as RouteSnapshot["models"],
    aliases: aliasesSnake as unknown as RouteSnapshot["aliases"],
    combos: combosSnake as unknown as RouteSnapshot["combos"],
    proxies: normalizedProxies as unknown as RouteSnapshot["proxies"],
    proxyHealth: proxyHealthMap as unknown as RouteSnapshot["proxyHealth"],
    cliModelMappings: cliModelMappings as unknown as RouteSnapshot["cliModelMappings"],
  };
    cache.value = { data: snapshot, expiresAt: Date.now() + SNAPSHOT_TTL_MS };
    return snapshot;
  })().finally(() => {
    cache.pending = null;
  });
  return cache.pending;
}

/** Loads a fresh route snapshot through the canonical Drizzle PostgreSQL client. */
export async function getRouteSnapshot(db: DrizzlePG = createDrizzlePG()): Promise<RouteSnapshot> {
  return loadRouteSnapshot(db, { value: null, pending: null });
}
