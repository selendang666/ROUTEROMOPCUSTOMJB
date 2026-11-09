import { Elysia } from "elysia";
import { applySecurityHeaders } from "./errors.js";
import { decryptWithKey, resolveEncryptionKey } from "../persistence/crypto.js";
import type { PostgresPool } from "../persistence/pool.js";
import { getPool } from "../persistence/pool.js";
import { createDrizzlePG } from "../persistence/db.js";
import { createShareRepository, type ShareApiKeyRow } from "../persistence/repositories/share.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { parseStringArray } from "../console/services/api-keys.js";

interface ApiKeyUsage {
  readonly totalTokens: number;
  readonly totalRequests: number;
  readonly dailyTokens: number;
  readonly monthlyTokens: number;
  readonly successCount: number;
  readonly errorCount: number;
}

/** Telemetry reader needed by the public share page. */
export interface ShareUsagePort {
  /** Returns aggregate usage for one API key. */
  getApiKeyTotals(apiKeyId: string): Promise<ApiKeyUsage>;
}

/** Dependencies for the public monitor and setup share routes. */
export interface ShareRouterOptions {
  readonly pool?: PostgresPool;
  readonly usage?: ShareUsagePort;
  readonly registry: ProviderRegistry;
  readonly shareRepository?: Pick<ReturnType<typeof createShareRepository>, "getApiKeyByShareToken" | "consumeSetupToken" | "touchView">;
}

function notFound(): Response {
  return Response.json(
    { error: { code: "not_found", message: "Share not found" } },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

function originFor(request: Request): string {
  const configured = Bun.env.PUBLIC_ORIGIN?.trim();
  return configured === undefined || configured === "" ? new URL(request.url).origin : configured.replace(/\/$/, "");
}

function decryptSharedKey(row: ShareApiKeyRow): string | null {
  if (row.key_encrypted === null) return null;
  try {
    return decryptWithKey(row.key_encrypted, resolveEncryptionKey());
  } catch {
    return null;
  }
}

function canonicalSlug(provider: string, modelId: string): string {
  return modelId.startsWith(`${provider}/`) ? modelId : `${provider}/${modelId}`;
}

async function modelsForShare(pool: PostgresPool, row: ShareApiKeyRow, registry: ProviderRegistry): Promise<string[]> {
  const activeRows = (await pool`SELECT DISTINCT provider FROM provider_accounts WHERE active = true`) as unknown as Array<{ provider: string }>;
  const eligible = new Set(activeRows.map((account) => account.provider));
  for (const adapter of registry.list()) {
    if (adapter.metadata.credentialKind === "none") eligible.add(adapter.metadata.id);
  }

  const providerAllowlist = parseStringArray(row.provider_allowlist);
  const providers = [...eligible].filter((provider) => providerAllowlist === null || providerAllowlist.includes(provider)).sort();
  if (providers.length === 0) return [];

  const allPersistedRows = (await pool`SELECT provider, model_id FROM provider_models WHERE enabled = true`) as unknown as Array<{ provider: string; model_id: string }>;
  const persistedByProvider = new Map<string, string[]>();
  const providerSet = new Set(providers);
  for (const model of allPersistedRows) {
    if (!providerSet.has(model.provider)) continue;
    const current = persistedByProvider.get(model.provider) ?? [];
    current.push(model.model_id);
    persistedByProvider.set(model.provider, current);
  }

  const allowedModels = parseStringArray(row.model_allowlist);
  const deniedModels = new Set(parseStringArray(row.model_denylist) ?? []);
  const models = new Set<string>();
  for (const provider of providers) {
    const persisted = persistedByProvider.get(provider);
    const modelIds = persisted ?? registry.list().find((adapter) => adapter.metadata.id === provider)?.models.list.map((model) => model.id) ?? [];
    for (const modelId of modelIds) {
      const slug = canonicalSlug(provider, modelId);
      if (allowedModels !== null && !allowedModels.includes(slug) && !allowedModels.includes(modelId)) continue;
      if (deniedModels.has(slug) || deniedModels.has(modelId)) continue;
      models.add(slug);
    }
  }
  return [...models].sort((left, right) => left.localeCompare(right));
}

function numberOrZero(value: number | null): number {
  return value ?? 0;
}

/** Creates public monitor and one-time setup share routes. */
export function createShareRouter(options: ShareRouterOptions) {
  const pool = options.pool ?? getPool();
  const registry = options.registry;
  const shareRepo = options.shareRepository ?? createShareRepository(createDrizzlePG(pool));
  const usage: ShareUsagePort = options.usage ?? {
    async getApiKeyTotals(): Promise<ApiKeyUsage> {
      return { totalTokens: 0, totalRequests: 0, dailyTokens: 0, monthlyTokens: 0, successCount: 0, errorCount: 0 };
    },
  };

  return new Elysia()
    .get("/share/:token/data", async ({ params, request }) => {
      const token = (params as { token: string }).token;
      if (token.length < 20) return notFound();
      const row = await shareRepo.getApiKeyByShareToken(token);
      if (row === null) return notFound();

      const [models, totals] = await Promise.all([modelsForShare(pool, row, registry), usage.getApiKeyTotals(row.id)]);
      void shareRepo.touchView(token).catch(() => undefined);
      const dailyUsed = totals.dailyTokens;
      const monthlyUsed = totals.monthlyTokens;
      const apiKey = decryptSharedKey(row);
      {
        const headers = new Headers({ "cache-control": "no-store" });
        applySecurityHeaders(headers, { noStore: true });
        return Response.json({
          name: row.name,
          active: row.active,
          apiKey: { id: row.id, prefix: row.key_prefix, key: apiKey, active: row.active },
          quotaAvailable: true,
          dailyUsed,
          dailyLimit: row.daily_token_limit,
          dailyRemaining: row.daily_token_limit === null ? null : Math.max(0, row.daily_token_limit - dailyUsed),
          monthlyUsed,
          monthlyLimit: row.monthly_token_limit,
          monthlyRemaining: row.monthly_token_limit === null ? null : Math.max(0, row.monthly_token_limit - monthlyUsed),
          oneTimeLimit: row.one_time_token_limit,
          oneTimeUsed: numberOrZero(row.one_time_tokens_used),
          oneTimeRemaining: row.one_time_token_limit === null ? null : Math.max(0, row.one_time_token_limit - numberOrZero(row.one_time_tokens_used)),
          rateLimitRpm: row.rate_limit_rpm,
          maxConcurrentRequests: row.max_concurrent_requests,
          providerAllowlist: parseStringArray(row.provider_allowlist),
          modelAllowlist: models,
          modelDenylist: parseStringArray(row.model_denylist),
          notes: { title: row.notes_title, subtitle: row.notes_subtitle, body: row.notes_body },
          createdAt: row.share_created_at,
          lastUsedAt: row.last_used_at,
          baseUrl: originFor(request as Request),
          totalTokens: totals.totalTokens,
          totalRequests: totals.totalRequests,
          successCount: totals.successCount,
          errorCount: totals.errorCount,
        }, { headers });
      }
    })
    .get("/share/setup/:token/data", async ({ params, request }) => {
      const token = (params as { token: string }).token;
      if (token.length < 20) return notFound();
      const row = await shareRepo.consumeSetupToken(token);
      if (row === null) return notFound();
      {
        const headers = new Headers({ "cache-control": "no-store" });
        applySecurityHeaders(headers, { noStore: true });
        return Response.json({
          name: row.name,
          key: decryptSharedKey(row),
          baseUrl: originFor(request as Request),
          expiresAt: row.expires_at,
        }, { headers });
      }
    });
}
