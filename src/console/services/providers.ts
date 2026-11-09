import type { PostgresPool } from "../../persistence/pool.js";
import type { CompatibilityProfile, AnthropicCompatibilityProfile, CompatibilityRequestRule } from "../../proxy/types/provider.js";
import { builtinProviderDefinitions, ProviderRegistry } from "../../providers/registry.js";
import { mergeProviderModels } from "../../providers/model-catalog.js";
import { extractAccessTokenOrRaw } from "../../auth/contract.js";
import { fetchOpenAICompatibleModels } from "../../providers/fetch-models.js";
import { isRecord } from "../../proxy/validation.js";

import type { AuthDriverRegistry } from "../../auth/driver-registry.js";
import { encryptWithKey, resolveEncryptionKey } from "../../persistence/crypto.js";

function compatibilityProfileFrom(value: unknown): CompatibilityProfile | undefined {
  if (!isPlainRecord(value)) return undefined;
  const profile: {
    query?: Readonly<Record<string, string>>;
    headers?: Readonly<Record<string, string>>;
    streamUsage?: "always" | "never" | "auto";
    structuredOutputs?: { supported: boolean; strictByDefault?: boolean };
    requestRules?: readonly CompatibilityRequestRule[];
    responseMetadata?: readonly ("request-id" | "system-fingerprint" | "service-tier" | "model")[];
  } = {};
  const query = stringRecord(value.query, 128, 2_048);
  if (value.query !== undefined && query === undefined) return undefined;
  if (query !== undefined) profile.query = query;
  const headers = stringRecord(value.headers, 128, 8_192);
  if (value.headers !== undefined && headers === undefined) return undefined;
  if (headers !== undefined) profile.headers = headers;
  if (value.streamUsage === "always" || value.streamUsage === "never" || value.streamUsage === "auto") profile.streamUsage = value.streamUsage;
  if (isPlainRecord(value.structuredOutputs) && typeof value.structuredOutputs.supported === "boolean") {
    profile.structuredOutputs = {
      supported: value.structuredOutputs.supported,
      ...(typeof value.structuredOutputs.strictByDefault === "boolean" ? { strictByDefault: value.structuredOutputs.strictByDefault } : {}),
    };
  }
  if (Array.isArray(value.responseMetadata)) {
    const allowed = new Set(["request-id", "system-fingerprint", "service-tier", "model"]);
    const responseMetadata = value.responseMetadata.filter((entry): entry is "request-id" | "system-fingerprint" | "service-tier" | "model" => typeof entry === "string" && allowed.has(entry));
    if (responseMetadata.length > 0) profile.responseMetadata = responseMetadata;
  }
  const requestRules = compatibilityRules(value.requestRules);
  if (value.requestRules !== undefined && requestRules === undefined) return undefined;
  if (requestRules !== undefined) profile.requestRules = requestRules;
  return Object.keys(profile).length === 0 ? undefined : profile;
}

function anthropicProfileFrom(value: unknown): AnthropicCompatibilityProfile | undefined {
  if (!isPlainRecord(value)) return undefined;
  const allowedBetas = new Set([
    "prompt-caching-2024-07-31",
    "extended-cache-ttl-2025-04-11",
    "interleaved-thinking-2025-05-14",
    "effort-2025-11-24",
    "user-profiles-2024-10-30",
    "structured-outputs-2025-11-13",
  ]);
  const betas = Array.isArray(value.betas)
    ? value.betas.filter((entry): entry is NonNullable<AnthropicCompatibilityProfile["betas"]>[number] => typeof entry === "string" && allowedBetas.has(entry))
    : [];
  if (value.betas !== undefined && (!Array.isArray(value.betas) || betas.length !== value.betas.length)) return undefined;
  const options: { speed?: "fast" | "standard"; inferenceGeo?: "us" | "global" } = {};
  if (isPlainRecord(value.options)) {
    if (value.options.speed === "fast" || value.options.speed === "standard") options.speed = value.options.speed;
    if (value.options.inferenceGeo === "us" || value.options.inferenceGeo === "global") options.inferenceGeo = value.options.inferenceGeo;
  }
  const profile: AnthropicCompatibilityProfile = {
    ...(betas.length > 0 ? { betas } : {}),
    ...(value.allowUserProfile === true ? { allowUserProfile: true } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
  return Object.keys(profile).length === 0 ? undefined : profile;
}

function compatibilityRules(value: unknown): readonly CompatibilityRequestRule[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const rules: CompatibilityRequestRule[] = [];
  for (const item of value) {
    if (!isPlainRecord(item)) return undefined;
    if (item.kind === "rename-field" && isCompatibilityFieldName(item.from) && isCompatibilityFieldName(item.to)) {
      rules.push({ kind: "rename-field", from: item.from, to: item.to });
      continue;
    }
    if (item.kind === "move-field" && isCompatibilityFieldName(item.from) && Array.isArray(item.to) && item.to.length > 0 && item.to.length <= 3 && item.to.every(isCompatibilityFieldName)) {
      rules.push({ kind: "move-field", from: item.from, to: item.to });
      continue;
    }
    if (item.kind === "set-default" && isCompatibilityFieldName(item.field) && (typeof item.value === "string" || typeof item.value === "number" || typeof item.value === "boolean")) {
      rules.push({ kind: "set-default", field: item.field, value: item.value });
      continue;
    }
    if (item.kind === "omit-field" && isCompatibilityFieldName(item.field)) {
      rules.push({ kind: "omit-field", field: item.field });
      continue;
    }
    return undefined;
  }
  return rules;
}

function isCompatibilityFieldName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oauthFlowsFor(
  metadata: { readonly id: string; readonly credentialKind: string; readonly credentialKinds?: readonly string[] },
  registry: AuthDriverRegistry | undefined,
): { readonly browser: boolean; readonly device: boolean } {
  const kinds = metadata.credentialKinds ?? [metadata.credentialKind];
  if (!kinds.includes("oauth") || registry === undefined) return { browser: false, device: false };
  const capabilities = registry.getCapabilities(metadata.id);
  return {
    browser: capabilities?.supportsStart === true && capabilities.supportsBrowser,
    device: capabilities?.supportsStart === true && capabilities.supportsDevice,
  };
}

function stringRecord(value: unknown, maxEntries: number, maxValueLength: number): Readonly<Record<string, string>> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > maxEntries || entries.some(([key, entry]) => !/^[A-Za-z0-9_.-]{1,128}$/.test(key) || typeof entry !== "string" || entry.length > maxValueLength || /[\r\n]/.test(entry))) {
    return undefined;
  }
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function providerAuthKind(kind: string): "none" | "oauth" | "api-key" {
  if (kind === "oauth") return "oauth";
  if (kind === "none") return "none";
  return "api-key";
}

/**
 * Providers console service — verbatim from bootstrap 612-766.
 * Now accepts an injected ProviderRegistry (single shared instance from
 * bootstrap/persistence.ts). For backwards compat (tests calling with
 * (pool, getCredential) ), the second arg may be a getCredential function.
 */
export function createProvidersService(
  pool: PostgresPool,
  registry: ProviderRegistry,
  getCredential?: (accountId: string) => Promise<string | null>,
  authDrivers?: AuthDriverRegistry,
) {
  const oauthRegistry = authDrivers;
  const builtinIds = new Set(builtinProviderDefinitions().map((definition) => definition.id));
  return {
    async listBuiltins() {
      const accounts = (await pool`SELECT provider, COUNT(*) as count FROM provider_accounts WHERE active = true GROUP BY provider`.catch(() => [] as unknown[])) as unknown as Array<{ provider: string; count: string }>;
      const countByProvider = new Map<string, number>(accounts.map((row) => [String(row.provider), Number(row.count)]));
      return registry.list().filter((adapter) => builtinIds.has(adapter.metadata.id)).map((adapter) => {
        const count = countByProvider.get(adapter.metadata.id) ?? 0;
        return {
          source: "builtin" as const,
          id: adapter.metadata.id,
          name: adapter.metadata.displayName,
          displayName: adapter.metadata.displayName,
          icon: adapter.metadata.id,
          prefix: adapter.metadata.id,
          authKind: providerAuthKind(adapter.metadata.credentialKind),
          credentialKind: adapter.metadata.credentialKind,
          credentialKinds: adapter.metadata.credentialKinds ?? [adapter.metadata.credentialKind],
          oauthFlows: oauthFlowsFor(adapter.metadata, oauthRegistry),
          modelCount: adapter.models.list.length,
          capabilityCounts: {
            chat: adapter.models.list.filter((model) => model.capabilities.surfaces.some((surface) => surface === "openai-chat" || surface === "openai-responses" || surface === "anthropic-messages")).length,
            media: adapter.models.list.filter((model) => model.capabilities.images).length,
            websearch: adapter.models.list.filter((model) => model.capabilities.search === true).length,
          },
          enabled: true,
          configured: count > 0,
          connections: count,
          models: adapter.models.list.map((model) => ({
            id: model.id,
            modelId: model.id,
            name: model.displayName,
            enabled: true,
            capabilities: model.capabilities,
          })),
        };
      });
    },
    async list() {
      const rows = (await pool`
          SELECT id, slug, name, type, base_url, models_json, query_params_json,
                 compatibility_profile_json, anthropic_profile_json, timeout_seconds, headers_json
          FROM custom_providers
          ORDER BY name
        `) as unknown as unknown[];
      return (rows as Array<Record<string, unknown>>).map((row) => ({
        source: "custom" as const,
        ...row,
        id: row.id,
        slug: row.slug,
        name: row.name,
        kind: row.type,
        baseUrl: row.base_url,
        models: Array.isArray(row.models_json) ? row.models_json : [],
        modelCount: Array.isArray(row.models_json) ? row.models_json.length : 0,
        timeoutSeconds: row.timeout_seconds,
        customHeaders: stringRecord(row.headers_json, 128, 8_192) ?? {},
        compatibilityProfile: compatibilityProfileFrom({
          ...(isPlainRecord(row.compatibility_profile_json) ? row.compatibility_profile_json : {}),
          ...(isPlainRecord(row.query_params_json) ? { query: row.query_params_json } : {}),
        }),
        anthropicProfile: anthropicProfileFrom(row.anthropic_profile_json),
      }));
    },
    async get(id: string) {
      try {
        const rows = (await pool`
            SELECT id, slug, name, type, base_url, models_json, query_params_json,
                   compatibility_profile_json, anthropic_profile_json, timeout_seconds, headers_json
            FROM custom_providers
            WHERE id = ${id} OR slug = ${id}
          `) as unknown as Array<Record<string, unknown>>;
        const row = rows[0];
        if (row !== undefined) {
          const rawModels = Array.isArray(row.models_json) ? row.models_json : [];
          const models = rawModels.map((model) => {
            if (typeof model === "string") {
              return { modelId: model, enabled: true, metadata: {} };
            }
            if (!isPlainRecord(model)) return null;
            const modelId = typeof model.id === "string" ? model.id : typeof model.modelId === "string" ? model.modelId : "";
            if (modelId.length === 0) return null;
            return {
              modelId,
              enabled: model.enabled !== false,
              metadata: {
                context: {
                  inputTokens: typeof model.contextWindow === "number" ? model.contextWindow : null,
                  outputTokens: typeof model.maxOutputTokens === "number" ? model.maxOutputTokens : null,
                },
                categories: [
                  ...(model.reasoning === true ? ["reasoning"] : []),
                  ...(model.vision === true ? ["vision"] : []),
                ],
                pricing: isPlainRecord(model.pricing) ? model.pricing : null,
              },
            };
          }).filter((model): model is NonNullable<typeof model> => model !== null);
          return {
            id: row.id,
            slug: row.slug,
            name: row.name,
            kind: row.type,
            baseUrl: row.base_url,
            credentialHint: "",
            timeoutSeconds: row.timeout_seconds,
            customHeaders: stringRecord(row.headers_json, 128, 8_192) ?? {},
            autoFetchModels: true,
            compatibilityProfile: compatibilityProfileFrom({
              ...(isPlainRecord(row.compatibility_profile_json) ? row.compatibility_profile_json : {}),
              ...(isPlainRecord(row.query_params_json) ? { query: row.query_params_json } : {}),
            }),
            anthropicProfile: anthropicProfileFrom(row.anthropic_profile_json),
            models,
            accounts: [],
            routing: { strategy: "priority" as const, stickyLimit: 1, useStickyLimit: false },
            customProvider: {
              id: row.id,
              slug: row.slug,
              name: row.name,
              kind: row.type === "anthropic-compatible" ? "anthropic-compatible" as const : "openai-compatible" as const,
              baseUrl: row.base_url,
              credentialHint: "",
              timeoutSeconds: row.timeout_seconds,
              autoFetchModels: true,
              customHeaders: stringRecord(row.headers_json, 128, 8_192) ?? {},
              compatibilityProfile: compatibilityProfileFrom({
                ...(isPlainRecord(row.compatibility_profile_json) ? row.compatibility_profile_json : {}),
                ...(isPlainRecord(row.query_params_json) ? { query: row.query_params_json } : {}),
              }),
              anthropicProfile: anthropicProfileFrom(row.anthropic_profile_json),
              createdAt: String(row.created_at ?? ""),
              updatedAt: String(row.updated_at ?? ""),
              models: rawModels,
            },
          };
        }
      } catch {}
      const builtin = builtinProviderDefinitions().find((d) => d.id === id || d.id.toLowerCase() === id.toLowerCase());
      if (builtin) {
        const models = (await pool`SELECT model_id, display_name, enabled, source, metadata_json FROM provider_models WHERE provider = ${id} ORDER BY model_id`.catch(() => [] as unknown[])) as unknown as Array<Record<string, unknown>>;
        const accounts = (await pool`SELECT id, provider, name, active, credential_kind, credential_hint FROM provider_accounts WHERE provider = ${id} ORDER BY priority`.catch(() => [] as unknown[])) as unknown as Array<Record<string, unknown>>;
        const registered = registry.get(builtin.id);
        const persistedModelIds = new Set(models.map((model) => String(model.model_id ?? model.id ?? "")));
        const mergedModelRows = [
          ...(registered?.models.list ?? [])
            .filter((model) => !persistedModelIds.has(model.id))
            .map((model) => ({
              model_id: model.id,
              display_name: model.displayName,
              enabled: true,
              source: "built-in",
              metadata_json: { context: model.context, categories: model.categories, pricing: model.pricing },
            })),
          ...models,
        ];
        const mappedModels =
          mergedModelRows.length > 0
            ? mergedModelRows.map((m) => {
                const modelId = String(m.model_id ?? ("id" in m ? m.id : ""));
                const displayName = typeof m.display_name === "string" && (m.display_name as string).length > 0 ? String(m.display_name) : modelId;
                const metaRaw = (m as Record<string, unknown>).metadata_json;
                let meta: Record<string, unknown> | null = null;
                if (isRecord(metaRaw)) meta = metaRaw;
                else if (typeof metaRaw === "string" && metaRaw.length > 0) {
                  try {
                    const parsed = JSON.parse(metaRaw) as unknown;
                    if (isRecord(parsed)) meta = parsed;
                  } catch {}
                }
                const ctx = isRecord(meta?.context) ? (meta?.context as Record<string, unknown>) : null;
                const context = ctx !== null ? { inputTokens: typeof ctx.inputTokens === "number" ? ctx.inputTokens : null, outputTokens: typeof ctx.outputTokens === "number" ? ctx.outputTokens : null } : null;
                const categories = Array.isArray(meta?.categories) ? (meta?.categories as string[]) : [];
                const pricing = isRecord(meta?.pricing) ? (meta?.pricing as Record<string, unknown>) : null;
                const priced = pricing !== null ? { inputPerMillion: typeof pricing.inputPerMillion === "number" ? pricing.inputPerMillion : null, outputPerMillion: typeof pricing.outputPerMillion === "number" ? pricing.outputPerMillion : null } : null;
                const regModel = registered?.models.get(modelId) ?? null;
                const caps = regModel !== null ? regModel.capabilities : { surfaces: ["openai-chat" as const], images: false, search: false } as unknown as import("../../proxy/types/provider.js").ProviderCaps;
                return {
                  modelId,
                  displayName,
                  enabled: Boolean(m.enabled ?? true),
                  source: m.source === "discovered" ? ("discovered" as const) : m.source === "imported" ? ("imported" as const) : m.source === "manual" ? ("manual" as const) : ("built-in" as const),
                  capabilities: {
                    chat: (caps.surfaces as readonly string[]).some((s) => s === "openai-chat" || s === "openai-responses" || s === "anthropic-messages"),
                    media: (caps as unknown as { images?: boolean }).images === true,
                    websearch: (caps as unknown as { search?: boolean }).search === true,
                  },
                  metadata: { context, categories, pricing: priced },
                };
              })
            : (registered?.models.list ?? []).map((model) => ({
                modelId: model.id,
                displayName: model.displayName,
                enabled: true,
                source: "built-in" as const,
                capabilities: {
                  chat: model.capabilities.surfaces.includes("openai-chat" as import("../../proxy/types/surface.js").Surface) || model.capabilities.surfaces.includes("openai-responses" as import("../../proxy/types/surface.js").Surface) || model.capabilities.surfaces.includes("anthropic-messages" as import("../../proxy/types/surface.js").Surface),
                  media: model.capabilities.images,
                  websearch: model.capabilities.search === true,
                },
                metadata: { context: model.context ?? null, categories: model.categories ?? [], pricing: model.pricing ?? null },
              }));
        return {
          id: (builtin as unknown as Record<string, unknown>).id,
          name: (builtin as unknown as Record<string, unknown>).displayName ?? (builtin as unknown as Record<string, unknown>).id,
          protocol: (builtin as unknown as Record<string, unknown>).protocol ?? "openai",
          credentialKind: registered?.metadata.credentialKind ?? (builtin as unknown as Record<string, unknown>).access ?? "api_key",
          credentialKinds: registered?.metadata.credentialKinds ?? [registered?.metadata.credentialKind ?? (builtin as unknown as Record<string, unknown>).access ?? "api_key"],
          oauthFlows: oauthFlowsFor(registered?.metadata ?? {
            id: builtin.id,
            credentialKind: String((builtin as unknown as Record<string, unknown>).access ?? "api_key"),
          }, oauthRegistry),
          enabled: true,
          models: mappedModels,
          accounts: (accounts as Array<Record<string, unknown>>).map((a) => ({
            ...a,
            provider: a.provider,
            credentialKind: a.credential_kind ?? a.credentialKind ?? "api_key",
            credentialHint: a.credential_hint ?? a.credentialHint ?? "",
          })),
          routing: { strategy: "priority" as const },
          timeoutSeconds: 30,
          customHeaders: {} as Record<string, string>,
          compatibilityProfile: compatibilityProfileFrom({} as unknown as Parameters<typeof compatibilityProfileFrom>[0]),
          anthropicProfile: anthropicProfileFrom({} as unknown as Parameters<typeof anthropicProfileFrom>[0]),
        };
      }
      return null;
    },
    async create(body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      const id = typeof v.id === "string" && v.id.length > 0 ? v.id : crypto.randomUUID();
      const slug = typeof v.slug === "string" ? v.slug : id;
      const name = typeof v.name === "string" ? v.name : slug;
      const type = v.type === "anthropic-compatible" || v.kind === "anthropic" || v.kind === "anthropic-compatible"
        ? "anthropic-compatible"
        : "openai-compatible";
      const baseUrl = typeof v.base_url === "string" ? v.base_url : typeof v.baseUrl === "string" ? (v.baseUrl as string) : "";
      if (!baseUrl) return { ok: false, status: 400, message: "base_url required" };
      const customHeaders = stringRecord(v.customHeaders, 128, 8_192);
      if (v.customHeaders !== undefined && customHeaders === undefined) return { ok: false, status: 400, message: "invalid customHeaders" };
      const timeoutSeconds = typeof v.timeoutSeconds === "number" && Number.isInteger(v.timeoutSeconds) && v.timeoutSeconds >= 1 && v.timeoutSeconds <= 300
        ? v.timeoutSeconds
        : 30;
      const compatibility = compatibilityProfileFrom(v.compatibilityProfile);
      const anthropic = anthropicProfileFrom(v.anthropicProfile);
      if (v.compatibilityProfile !== undefined && compatibility === undefined) return { ok: false, status: 400, message: "invalid compatibilityProfile" };
      if (v.anthropicProfile !== undefined && anthropic === undefined) return { ok: false, status: 400, message: "invalid anthropicProfile" };
      const rawCredential = typeof v.credential === "string" ? v.credential : typeof v.apiKey === "string" ? v.apiKey : "";
      const credentialValues = rawCredential
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const firstEncrypted = credentialValues.length > 0 ? encryptWithKey(credentialValues[0]!, resolveEncryptionKey()) : "";
      await pool`
          INSERT INTO custom_providers (
            id, slug, name, type, base_url, timeout_seconds, headers_json, query_params_json,
            compatibility_profile_json, anthropic_profile_json, credential_encrypted
          ) VALUES (
            ${id}, ${slug}, ${name}, ${type}, ${baseUrl}, ${timeoutSeconds}, ${customHeaders ?? {}}::jsonb,
            ${compatibility?.query ?? {}}::jsonb,
            ${compatibility ?? {}}::jsonb,
            ${anthropic ?? {}}::jsonb,
            ${firstEncrypted}
          )
        `;
      if (credentialValues.length > 0) {
        const key = resolveEncryptionKey();
        for (let index = 0; index < credentialValues.length; index++) {
          const value = credentialValues[index]!;
          const accountId = crypto.randomUUID();
          const accountName = credentialValues.length === 1 ? `${slug}-key-1` : `${slug}-key-${index + 1}`;
          const encrypted = encryptWithKey(value, key);
          const hint = value.slice(-4);
          await pool`
            INSERT INTO provider_accounts (id, provider, name, credential_kind, credential_encrypted, credential_hint, priority)
            VALUES (${accountId}, ${slug}, ${accountName}, 'api_key', ${encrypted}, ${hint}, ${100 + index})
            ON CONFLICT (id) DO NOTHING
          `;
        }
      }
      return { ok: true, status: 201, data: { id } };
    },
    async update(id: string, body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      const customHeaders = stringRecord(v.customHeaders, 128, 8_192);
      if (v.customHeaders !== undefined && customHeaders === undefined) return { ok: false, status: 400, message: "invalid customHeaders" };
      const timeoutSeconds = typeof v.timeoutSeconds === "number" && Number.isInteger(v.timeoutSeconds) && v.timeoutSeconds >= 1 && v.timeoutSeconds <= 300
        ? v.timeoutSeconds
        : undefined;
      const baseUrl = typeof v.baseUrl === "string" ? v.baseUrl : undefined;
      if (v.name !== undefined || baseUrl !== undefined || timeoutSeconds !== undefined || customHeaders !== undefined) {
        await pool`
            UPDATE custom_providers
            SET name = COALESCE(${typeof v.name === "string" ? v.name : null}, name),
                base_url = COALESCE(${baseUrl ?? null}, base_url),
                timeout_seconds = COALESCE(${timeoutSeconds ?? null}, timeout_seconds),
                headers_json = COALESCE(${customHeaders === undefined ? null : customHeaders}::jsonb, headers_json),
                updated_at = now()
            WHERE id = ${id}
          `;
      }
      if (v.compatibilityProfile !== undefined) {
        const compatibility = compatibilityProfileFrom(v.compatibilityProfile);
        if (compatibility === undefined) return { ok: false, status: 400, message: "invalid compatibilityProfile" };
        await pool`
            UPDATE custom_providers
            SET query_params_json = ${compatibility.query ?? {}}::jsonb,
                compatibility_profile_json = ${compatibility}::jsonb,
                updated_at = now()
            WHERE id = ${id}
          `;
      }
      if (v.anthropicProfile !== undefined) {
        const anthropic = anthropicProfileFrom(v.anthropicProfile);
        if (anthropic === undefined) return { ok: false, status: 400, message: "invalid anthropicProfile" };
        await pool`
            UPDATE custom_providers
            SET anthropic_profile_json = ${anthropic}::jsonb,
                updated_at = now()
            WHERE id = ${id}
          `;
      }
      return { ok: true, status: 200, data: { id } };
    },
    async remove(id: string) {
      await pool`DELETE FROM custom_providers WHERE id = ${id}`;
      return { ok: true, status: 200, data: {} };
    },
    async fetchModels(id: string) {
      const custom = await (async () => {
        try {
          const rows = (await pool`SELECT id, slug, base_url FROM custom_providers WHERE id = ${id} OR slug = ${id} LIMIT 1`) as unknown as Array<Record<string, unknown>>;
          return rows[0] ?? null;
        } catch {
          return null;
        }
      })();
      const builtin = builtinProviderDefinitions().find((d) => d.id === id || d.id.toLowerCase() === id.toLowerCase());
      if (!custom && !builtin) return { ok: false as const, status: 404 as const, code: "model_not_found" as const, message: `provider ${id} not found` };
      try {
        const providerId = typeof custom?.slug === "string" ? custom.slug : id;
        const adapter = registry.get(id) ?? (custom !== null ? (registry.get(providerId) as unknown as import("../../proxy/types/request.js").Adapter | null) : null);
        // For credentialKind none (opencodeft) bypass account gating even when no rows exist
        const isNoAuth = adapter?.metadata.credentialKind === "none";
        let credential: string | null = null;
        if (isNoAuth) {
          credential = null;
        } else if (getCredential !== undefined) {
          const accountRows = (await pool`SELECT id FROM provider_accounts WHERE provider = ${providerId} AND active = true ORDER BY priority`) as unknown as Array<{ id: string }>;
          for (const account of accountRows) {
            const value = await getCredential(account.id);
            if (value !== null && value.length > 0) {
              credential = value;
              break;
            }
          }
          // Trim via extractAccessTokenOrRaw but keep raw for oauth (adapter handles workos prefix internally)
          if (credential !== null) {
            const trimmed = extractAccessTokenOrRaw(credential);
            // For oauth the raw may be JSON, keep raw; for api_key use trimmed token
            const supportsOAuth = adapter?.metadata.credentialKind === "oauth" || adapter?.metadata.credentialKinds?.includes("oauth") === true;
            if (trimmed !== null && trimmed.length > 0 && !supportsOAuth) credential = trimmed;
          }
        }
        // If api_key provider has no credential, fallback to static without 401
        const needsCredential = adapter !== null && adapter.metadata.credentialKind !== "none" && !isNoAuth;
        let discovered: readonly import("../../proxy/types/provider.js").ProviderModel[] | null = null;
        let source: "remote" | "static" = "static";
        if (adapter !== null && typeof (adapter as unknown as { discoverModels?: unknown }).discoverModels === "function") {
          try {
            const fn = (adapter as unknown as { discoverModels: (input: import("../../proxy/types/request.js").DiscoveryInput) => Promise<readonly import("../../proxy/types/provider.js").ProviderModel[] | null> }).discoverModels;
            // Pass credential (null for no-auth, or raw for oauth) — adapter owns header mapping
            discovered = await fn({ credential, signal: undefined });
          } catch {
            discovered = null;
          }
        } else if (custom !== null && typeof (custom as Record<string, unknown>).base_url === "string") {
          // Custom not yet in registry (race) — direct fetch via shared helper
          const baseUrl = String((custom as Record<string, unknown>).base_url);
          const headers: Record<string, string> =
            credential !== null && credential.length > 0 ? { authorization: `Bearer ${credential}` } : {};
          try {
            discovered = await fetchOpenAICompatibleModels({ baseUrl, headers, signal: undefined });
          } catch {
            discovered = null;
          }
        }
        let models: readonly import("../../proxy/types/provider.js").ProviderModel[] = [];
        let added = 0;
        const staticModels = adapter?.models.list ?? [];
        const staticModelIds = new Set(staticModels.map((model) => model.id));
        if (discovered !== null && discovered.length > 0) {
          models = mergeProviderModels(staticModels, [discovered]);
          source = "remote";
          const existingRows = (await pool`SELECT model_id FROM provider_models WHERE provider = ${id}`) as unknown as Array<{ model_id: string }>;
          const existingModelIds = new Set([...existingRows.map((row) => row.model_id), ...staticModelIds]);
          for (const m of discovered) {
            if (existingModelIds.has(m.id)) continue;
            await pool`
              INSERT INTO provider_models (provider, model_id, display_name, enabled, source, metadata_json)
              VALUES (${id}, ${m.id}, ${m.displayName}, true, 'discovered', ${{ context: m.context, categories: m.categories, pricing: m.pricing }}::jsonb)
              ON CONFLICT (provider, model_id) DO NOTHING
            `;
            existingModelIds.add(m.id);
            added += 1;
          }
        } else if (discovered !== null && discovered.length === 0) {
          // Endpoint replied empty — retain the static catalog and all persisted models.
          models = staticModels;
          source = "static";
        } else {
          // Static fallback — do not write as discovered; keep existing enabled/source untouched
          models = staticModels;
          source = "static";
          if (needsCredential && credential === null) {
            // No credential for api_key provider — return static with fetched 0 handling already
          }
        }
        const outModels = models.map((model) => ({
          modelId: model.id,
          displayName: model.displayName,
          source: source === "remote" && !staticModelIds.has(model.id) ? ("discovered" as const) : ("built-in" as const),
          capabilities: {
            chat: model.capabilities.surfaces.includes("openai-chat" as import("../../proxy/types/surface.js").Surface) || model.capabilities.surfaces.includes("openai-responses" as import("../../proxy/types/surface.js").Surface) || model.capabilities.surfaces.includes("anthropic-messages" as import("../../proxy/types/surface.js").Surface),
            media: model.capabilities.images,
            websearch: model.capabilities.search === true,
          },
          metadata: { context: model.context ?? null, categories: model.categories ?? [], pricing: model.pricing ?? null },
        }));
        return {
          ok: true as const,
          status: 200 as const,
          data: { provider: id, fetched: models.length, added, source, models: outModels },
        };
      } catch (error) {
        return { ok: false as const, status: 501 as const, code: "capability_unsupported" as const, message: error instanceof Error ? error.message : "model discovery not configured for this provider" };
      }
    },
    async health(id: string) {
      const custom = await (async () => {
        try {
          const rows = (await pool`SELECT id, base_url FROM custom_providers WHERE id = ${id} OR slug = ${id} LIMIT 1`) as unknown as Array<Record<string, unknown>>;
          return rows[0] ?? null;
        } catch { return null; }
      })();
      const builtin = builtinProviderDefinitions().find((d) => d.id === id || d.id.toLowerCase() === id.toLowerCase());
      if (!custom && !builtin) return { ok: false as const, status: 404 as const, code: "model_not_found" as const, message: `provider ${id} not found` };
      const baseUrl = (custom as Record<string, unknown> | null)?.base_url as string | undefined;
      if (!baseUrl) {
        // Built-in providers have no custom baseUrl to probe; return typed 501 instead of fake success
        return { ok: false as const, status: 501 as const, code: "capability_unsupported" as const, message: "Health check not configured for this provider" };
      }
      const started = Date.now();
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(baseUrl, { method: "HEAD", signal: controller.signal } as RequestInit);
        clearTimeout(t);
        const latencyMs = Date.now() - started;
        if (res.ok) return { ok: true as const, status: 200 as const, data: { ok: true, latencyMs, status: res.status } };
        return { ok: false as const, status: 502 as const, code: "provider_unavailable" as const, message: `health check failed with status ${res.status}`, data: { ok: false, latencyMs, status: res.status } };
      } catch (error) {
        const latencyMs = Date.now() - started;
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("abort")) return { ok: false as const, status: 504 as const, message: "health check timed out", data: { ok: false, latencyMs, error: msg } };
        return { ok: false as const, status: 502 as const, message: msg, data: { ok: false, latencyMs, error: msg } };
      }
    },
    async createModel(providerId: string, body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      const modelId = typeof v.modelId === "string" ? v.modelId.trim() : typeof v.model === "string" ? String(v.model).trim() : typeof v.id === "string" ? String(v.id).trim() : "";
      if (!modelId) return { ok: false as const, status: 400 as const, message: "modelId required" };
      try {
        await pool`INSERT INTO provider_models (provider, model_id, display_name, enabled) VALUES (${providerId}, ${modelId}, ${String(v.displayName ?? modelId)}, ${true}) ON CONFLICT (provider, model_id) DO UPDATE SET display_name = EXCLUDED.display_name, enabled = true`;
        return { ok: true as const, status: 201 as const, data: { provider: providerId, modelId } };
      } catch (error) {
        return { ok: false as const, status: 500 as const, message: error instanceof Error ? error.message : "failed to create model" };
      }
    },
    async deleteModel(providerId: string, modelId: string) {
      try {
        const result = (await pool`DELETE FROM provider_models WHERE provider = ${providerId} AND model_id = ${modelId}`) as unknown as { count?: number; rowCount?: number } & unknown[];
        const count = (result as unknown as { count?: number })?.count ?? (result as unknown as { rowCount?: number })?.rowCount ?? 0;
        void count;
        return { ok: true as const, status: 200 as const, data: { provider: providerId, modelId } };
      } catch (error) {
        return { ok: false as const, status: 500 as const, message: error instanceof Error ? error.message : "failed to delete model" };
      }
    },
    async setModelEnabled(providerId: string, modelId: string, body: unknown) {
      const enabled = isRecord(body) && typeof body["enabled"] === "boolean" ? (body["enabled"] as boolean) : undefined;
      if (typeof enabled !== "boolean") return { ok: false as const, status: 400 as const, message: "enabled boolean required" };
      const pid = String(providerId ?? "").trim();
      const mid = String(modelId ?? "").trim();
      if (!pid || !mid) return { ok: false as const, status: 400 as const, message: "provider and modelId required" };
      // provider existence: check registry or builtin or persisted/custom rows
      const registered = registry.get(pid) ?? null;
      let providerExists = registered !== null;
      if (!providerExists) {
        const builtin = builtinProviderDefinitions().find((d) => d.id === pid);
        if (builtin !== undefined) providerExists = true;
        else {
          try {
            const rows = (await pool`SELECT 1 FROM provider_models WHERE provider = ${pid} LIMIT 1`) as unknown as unknown[];
            if (Array.isArray(rows) && rows.length > 0) providerExists = true;
            else {
              const customRows = (await pool`SELECT 1 FROM custom_providers WHERE id = ${pid} OR slug = ${pid} LIMIT 1`) as unknown as unknown[];
              if (Array.isArray(customRows) && customRows.length > 0) providerExists = true;
            }
          } catch {}
        }
      }
      if (!providerExists) return { ok: false as const, status: 404 as const, message: `provider ${pid} not found` };
      try {
        const existing = (await pool`SELECT model_id FROM provider_models WHERE provider = ${pid} AND model_id = ${mid} LIMIT 1`) as unknown as Array<Record<string, unknown>>;
        if (Array.isArray(existing) && existing.length > 0) {
          await pool`UPDATE provider_models SET enabled = ${enabled}, updated_at = now() WHERE provider = ${pid} AND model_id = ${mid}`;
          return { ok: true as const, status: 200 as const, data: { provider: pid, modelId: mid, enabled } };
        }
        const regModel = registered?.models.get(mid) ?? null;
        if (regModel !== null) {
          await pool`INSERT INTO provider_models (provider, model_id, display_name, enabled, source, metadata_json) VALUES (${pid}, ${mid}, ${regModel.displayName}, ${enabled}, 'built-in', ${{ context: regModel.context, categories: regModel.categories, pricing: regModel.pricing }}::jsonb) ON CONFLICT (provider, model_id) DO UPDATE SET enabled = EXCLUDED.enabled, display_name = EXCLUDED.display_name, metadata_json = EXCLUDED.metadata_json, updated_at = now()`;
          return { ok: true as const, status: 200 as const, data: { provider: pid, modelId: mid, enabled } };
        }
        return { ok: false as const, status: 404 as const, message: `model ${mid} not found for provider ${pid}` };
      } catch (error) {
        return { ok: false as const, status: 500 as const, message: error instanceof Error ? error.message : "failed to update model" };
      }
    },
    async setAllModelsEnabled(providerId: string, body: unknown) {
      const enabled = isRecord(body) && typeof body["enabled"] === "boolean" ? (body["enabled"] as boolean) : undefined;
      if (typeof enabled !== "boolean") return { ok: false as const, status: 400 as const, message: "enabled boolean required" };
      const pid = String(providerId ?? "").trim();
      if (!pid) return { ok: false as const, status: 400 as const, message: "provider required" };
      const registered = registry.get(pid) ?? null;
      let providerExists = registered !== null;
      if (!providerExists) {
        const builtin = builtinProviderDefinitions().find((d) => d.id === pid);
        if (builtin !== undefined) providerExists = true;
        else {
          try {
            const rows = (await pool`SELECT 1 FROM provider_models WHERE provider = ${pid} LIMIT 1`) as unknown as unknown[];
            if (Array.isArray(rows) && rows.length > 0) providerExists = true;
            else {
              const customRows = (await pool`SELECT 1 FROM custom_providers WHERE id = ${pid} OR slug = ${pid} LIMIT 1`) as unknown as unknown[];
              if (Array.isArray(customRows) && customRows.length > 0) providerExists = true;
            }
          } catch {}
        }
      }
      if (!providerExists) return { ok: false as const, status: 404 as const, message: `provider ${pid} not found` };
      try {
        const existingRows = (await pool`SELECT model_id FROM provider_models WHERE provider = ${pid}`) as unknown as Array<{ model_id: string }>;
        const existingIds = new Set((Array.isArray(existingRows) ? existingRows : []).map((row) => String(row.model_id)));
        let updated = 0;
        if (existingIds.size > 0) {
          const res = (await pool`UPDATE provider_models SET enabled = ${enabled}, updated_at = now() WHERE provider = ${pid}`) as unknown as { count?: number; rowCount?: number } & unknown[];
          const count = (res as unknown as { count?: number })?.count ?? (res as unknown as { rowCount?: number })?.rowCount ?? existingIds.size;
          updated = typeof count === "number" && count > 0 ? count : existingIds.size;
        }
        let inserted = 0;
        const staticModels = registered?.models.list ?? [];
        for (const model of staticModels) {
          if (existingIds.has(model.id)) continue;
          await pool`INSERT INTO provider_models (provider, model_id, display_name, enabled, source, metadata_json) VALUES (${pid}, ${model.id}, ${model.displayName}, ${enabled}, 'built-in', ${{ context: model.context, categories: model.categories, pricing: model.pricing }}::jsonb) ON CONFLICT (provider, model_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`;
          inserted += 1;
        }
        updated = updated + inserted;
        // if no existing and no static, still return success with 0
        return { ok: true as const, status: 200 as const, data: { provider: pid, enabled, updated } };
      } catch (error) {
        return { ok: false as const, status: 500 as const, message: error instanceof Error ? error.message : "failed to update models" };
      }
    },
  };
}
