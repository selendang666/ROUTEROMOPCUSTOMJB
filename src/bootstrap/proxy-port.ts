import { createConfigRepositories } from "../persistence/persistence-api.js";
import type { PostgresPool } from "../persistence/pool.js";
import type { TelemetryPipeline } from "../persistence/telemetry/pipeline.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { syncCustomAdapters, type CustomProviderRecord } from "../providers/api-key/custom-provider.js";
import { executeProxyRequest } from "../proxy/request/execute.js";
import type { ProxyRequestLogEvent } from "../proxy/request/prepare.js";
import type { ProviderUsage } from "../proxy/types/telemetry.js";
import { createRoutePlan } from "../proxy/routing/plan.js";
import { getPersonaSnapshot } from "../persona/snapshot.js";
import { applyGlobalPersonaToOpenAIPayload } from "../persona/persona.js";
import { isRouteAllowed } from "../api/guard.js";
import { createInternalFailure } from "../proxy/errors.js";
import { getMontanaConfigRuntime, montanaKeyId, montanaPersonaSnapshot } from "../runtime/montana-config.js";
import { CredentialSelector, createAccountManager } from "../proxy/routing/account.js";
import type { PublicDependencies } from "../api/v1.js";
import { levelFor, renderTraceLine, buildContext, renderMontanaLog } from "./request-log-format.js";
import type { Adapter } from "../proxy/types/request.js";
import type { AnthropicCompatibilityProfile, CompatibilityProfile, CompatibilityRequestRule } from "../proxy/types/provider.js";
import { mapWithConcurrency } from "../runtime/runtime.js";
import { runtimeMemoryLimits } from "../runtime/limits.js";
import { NetworkSelector } from "../proxy/transport/network.js";
import { RelayCircuitBreaker } from "../proxy/transport/relay-circuit.js";
import type { RuntimeConfig } from "../runtime/runtime.js";
import type { RouteRepositoryPort } from "./application.js";
import { compatibilityProfileFrom, anthropicProfileFrom, isPlainRecord } from "../providers/api-key/compatibility-profile.js";
import type { ProviderModelMeta } from "../proxy/types/provider.js";
import type { AccountCandidate, ModelLockRecord, ProxyCandidate, RoutingSnapshot } from "../proxy/types/routing.js";
import { resolveCliModelMapping } from "../proxy/routing/mapping.js";
import { deriveRequiredCapabilities, hasWebSearchCapability, isWebSearchTool } from "../proxy/routing/capability.js";
import { BoundedRouteSessionStore } from "../proxy/routing/plan.js";
import { ApiKeyAdmission } from "../runtime/key.js";
import type { ApiKeyPublic } from "../persistence/types.js";
import { createRelaySecretService } from "../relay/secret.js";

// ── Cached env: read once at module load ───────────────────────────────────
const CACHED_HEDGE_DELAY_MS = Math.min(
  5_000,
  Math.max(0, Number(Bun.env.OHMYOMOP_ROUTER_HEDGE_DELAY_MS ?? 300) || 0),
);

// ── Per-key authorization context ──────────────────────────────────────────

interface KeyAuthorizationContext {
  readonly apiKey?: ApiKeyPublic;
  readonly providerAllowlist?: readonly string[] | null;
  readonly modelAllowlist?: readonly string[] | null;
  readonly modelDenylist?: readonly string[] | null;
}

function toStringArray(value: unknown): readonly string[] | null {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
    } catch {
      // fall through to comma-separated legacy form
    }
    const items = text.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
    return items.length > 0 ? items : null;
  }
  return null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Loads the live per-key authorization context for admission + route ACL.
 * Falls back to keyless behavior when the row is missing so proxy traffic
 * is never broken by a lookup failure. Auth itself stays in the guard layer.
 * @param pool - PostgreSQL authority pool.
 * @param apiKeyId - Authenticated API key id, or null for keyless traffic.
 * @returns Authorization context with limits and allowlists.
 */
export async function loadKeyAuthorization(pool: PostgresPool, apiKeyId: string | null): Promise<KeyAuthorizationContext> {
  if (apiKeyId === null) return {};
  const montana = getMontanaConfigRuntime();
  const montanaKey = montanaKeyId(apiKeyId) ? montana?.findKeyById(apiKeyId) ?? null : null;
  if (montanaKey !== null) {
    return {
      apiKey: {
        id: montanaKey.id,
        name: montanaKey.label ?? "Montana key",
        keyPrefix: montanaKey.key.slice(0, 8),
        active: true,
        rateLimitRpm: null,
        dailyTokenLimit: null,
        monthlyTokenLimit: null,
        oneTimeTokenLimit: montanaKey.quota,
        oneTimeTokensUsed: montanaKey.used,
        maxConcurrentRequests: null,
        providerAllowlist: null,
        modelAllowlist: null,
        modelDenylist: null,
        lastUsedAt: null,
        createdAt: "",
        revokedAt: null,
      },
      providerAllowlist: null,
      modelAllowlist: null,
      modelDenylist: null,
    };
  }
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (await pool`
      SELECT id, name, key_prefix, active, rate_limit_rpm, daily_token_limit,
             monthly_token_limit, one_time_token_limit, one_time_tokens_used,
             max_concurrent_requests, provider_allowlist, model_allowlist,
             model_denylist, revoked_at
      FROM api_keys WHERE id = ${apiKeyId} LIMIT 1
    `) as unknown as Array<Record<string, unknown>>;
  } catch {
    return {};
  }
  const row = rows[0];
  if (row === undefined || row.active !== true || row.revoked_at !== null) return {};
  return {
    apiKey: {
      id: String(row.id),
      name: typeof row.name === "string" ? row.name : "",
      keyPrefix: typeof row.key_prefix === "string" ? row.key_prefix : "",
      active: true,
      rateLimitRpm: toNullableNumber(row.rate_limit_rpm),
      dailyTokenLimit: toNullableNumber(row.daily_token_limit),
      monthlyTokenLimit: toNullableNumber(row.monthly_token_limit),
      oneTimeTokenLimit: toNullableNumber(row.one_time_token_limit),
      oneTimeTokensUsed: typeof row.one_time_tokens_used === "number" ? row.one_time_tokens_used : 0,
      maxConcurrentRequests: toNullableNumber(row.max_concurrent_requests),
      providerAllowlist: null,
      modelAllowlist: null,
      modelDenylist: null,
      lastUsedAt: null,
      createdAt: "",
      revokedAt: null,
    },
    providerAllowlist: toStringArray(row.provider_allowlist),
    modelAllowlist: toStringArray(row.model_allowlist),
    modelDenylist: toStringArray(row.model_denylist),
  };
}

function responseWithRelease(response: Response, release: () => Promise<void>): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let released = false;
  const finish = async (): Promise<void> => {
    if (released) return;
    released = true;
    await release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await finish();
        } else if (result.value !== undefined) controller.enqueue(result.value);
      } catch (error) {
        await finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { await finish(); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function createProxyPort(
  pool: PostgresPool,
  config: RuntimeConfig,
  registry: ProviderRegistry,
  telemetry?: TelemetryPipeline,
  routeRepositories?: RouteRepositoryPort,
): Promise<PublicDependencies["proxy"]> {
  const routeSessionStore = new BoundedRouteSessionStore();
  const customRows = (await pool`
    SELECT slug, name, type, base_url, models_json, headers_json, query_params_json,
           compatibility_profile_json, anthropic_profile_json, timeout_seconds
    FROM custom_providers
    ORDER BY slug
  `) as unknown as Array<Record<string, unknown>>;
  const customProviders: CustomProviderRecord[] = customRows.map((row) => ({
    slug: String(row.slug),
    name: String(row.name),
    baseUrl: String(row.base_url),
    type: row.type === "anthropic-compatible" ? "anthropic-compatible" : "openai-compatible",
    models: Array.isArray(row.models_json) ? row.models_json : [],
    customHeaders: typeof row.headers_json === "object" && row.headers_json !== null && !Array.isArray(row.headers_json)
      ? Object.fromEntries(Object.entries(row.headers_json as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
      : {},
    compatibility: compatibilityProfileFrom({
      ...(isPlainRecord(row.compatibility_profile_json) ? row.compatibility_profile_json : {}),
      ...(isPlainRecord(row.query_params_json) ? { query: row.query_params_json } : {}),
    }),
    anthropic: anthropicProfileFrom(row.anthropic_profile_json),
    timeoutSeconds: Number(row.timeout_seconds ?? 30),
  }));
  const customBySlug = new Map(customProviders.map((provider) => [provider.slug, provider]));
  syncCustomAdapters(registry, {
    list: () => customProviders,
    getBySlug: (slug) => customBySlug.get(slug) ?? null,
  });
  const repositories = routeRepositories ?? createConfigRepositories(pool);
  const relaySecretService = createRelaySecretService(pool);
  const accountManager = createAccountManager();
  const admission = new ApiKeyAdmission({
    consumeOneTimeTokens: (id, tokens) => {
      const montanaRuntime = getMontanaConfigRuntime();
      if (montanaKeyId(id) && montanaRuntime?.findKeyById(id) !== null && montanaRuntime !== null) {
        montanaRuntime.recordUsage(id, tokens);
        return;
      }
      void (async () => {
        try {
          await pool`UPDATE api_keys SET one_time_tokens_used = COALESCE(one_time_tokens_used, 0) + ${Math.max(0, Math.floor(tokens))} WHERE id = ${id}`;
        } catch {
          // Usage accounting must never break proxy traffic.
        }
      })();
    },
  });
  const modelLocksFor = (account: { accountId: string; modelLocks?: ReadonlyMap<string, { readonly retryAt: string; readonly reason?: string | null }> | null }): ReadonlyMap<string, ModelLockRecord> | null => {
    if (account.modelLocks === undefined || account.modelLocks === null) return null;
    return new Map([...account.modelLocks.entries()].map(([modelId, lock]) => [modelId, { accountId: account.accountId, modelId, retryAt: lock.retryAt, safeMessage: lock.reason ?? null }] as const));
  };
  void (async () => {
    const accounts = (await pool`
      SELECT id, provider
      FROM provider_accounts
      WHERE active = true AND provider IN ('antigravity', 'codex')
      ORDER BY priority, id
    `) as unknown as Array<{ id: string; provider: string }>;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      await mapWithConcurrency(accounts, 5, async (account) => {
        const credential = await repositories.accounts.getCredential(account.id);
        if (credential === null) return;
        const adapter = registry.get(account.provider) as Adapter & {
          refreshCatalog?: (value: string, signal: AbortSignal) => Promise<void>;
        };
        if (typeof adapter?.refreshCatalog === "function") {
          await adapter.refreshCatalog(credential, controller.signal);
        }
      });
    } catch {
      // Dynamic catalogs are advisory; static model fallbacks stay available.
    } finally {
      clearTimeout(timer);
    }
  })();
  const requestLimits = {
    maxBodyBytes: runtimeMemoryLimits.requestBodyBytes,
    connectTimeoutMs: 30_000,
    firstByteTimeoutMs: 60_000,
    idleTimeoutMs: 60_000,
    totalTimeoutMs: 10 * 60_000,
  } as const;
  const hedgeDelayMs = CACHED_HEDGE_DELAY_MS;
  const telemetryWriter = telemetry === undefined
    ? undefined
    : {
        start(input: { readonly requestId: string; readonly endpoint: string; readonly surface: string; readonly apiKeyId: string | null; readonly apiKeyPrefix?: string | null; readonly client: { readonly name: string; readonly source: string }; readonly clientIp?: string | null; readonly userAgent?: string | null; readonly fingerprint?: string | null; readonly safeHeaders?: Readonly<Record<string, string>> }) {
          const startedAt = Date.now();
          let firstByteAt: number | null = null;
          let firstTokenAt: number | null = null;
          const startedAtIso = new Date(startedAt).toISOString().slice(0, 19).replace("T", " ");
          return {
            recordFirstByte(): void { if (firstByteAt === null) firstByteAt = Date.now(); },
            recordFirstToken(): void { if (firstTokenAt === null) firstTokenAt = Date.now(); },
            async finish(result: { readonly statusCode: number; readonly errorKind: string | null; readonly errorProviderCode?: string | null; readonly errorProviderType?: string | null; readonly errorUpstreamRequestId?: string | null; readonly errorRetryAfterMs?: number | null; readonly usage: ProviderUsage | null; readonly providerId: string | null; readonly model: string | null; readonly mode: "non_stream" | "stream" | null; readonly accountId?: string | null; readonly proxyId?: string | null; readonly reasoningTokens?: number | null }): Promise<void> {
              const tffbMs = firstByteAt === null ? null : Math.max(0, firstByteAt - startedAt);
              const tfftMs = firstTokenAt === null ? null : Math.max(0, firstTokenAt - startedAt);
              const finishedAtIso = new Date().toISOString().slice(0, 19).replace("T", " ");
              telemetry.enqueue({ requestId: input.requestId, endpoint: input.endpoint, surface: input.surface, model: result.model ?? "", providerId: result.providerId, apiKeyId: input.apiKeyId, apiKeyPrefix: input.apiKeyPrefix ?? null, clientIp: input.clientIp ?? null, clientName: input.client.name, clientSource: input.client.source, userAgent: input.userAgent ?? null, fingerprint: input.fingerprint ?? null, safeHeaders: input.safeHeaders ?? {}, statusCode: result.statusCode, errorKind: result.errorKind, errorProviderCode: result.errorProviderCode ?? null, errorProviderType: result.errorProviderType ?? null, errorUpstreamRequestId: result.errorUpstreamRequestId ?? null, errorRetryAfterMs: result.errorRetryAfterMs ?? null, durationMs: Date.now() - startedAt, usage: result.usage, committed: result.mode === "stream" || firstTokenAt !== null || firstByteAt !== null, tffbMs, tfftMs, messageCount: null, toolCount: null, imageCount: null, startedAt: startedAtIso, finishedAt: finishedAtIso, accountId: result.accountId ?? null, proxyId: result.proxyId ?? null, reasoningTokens: result.reasoningTokens ?? null });
            },
          };
        },
      };

  const payloadSink = telemetry === undefined || typeof (telemetry as unknown as { savePayload?: unknown }).savePayload !== "function"
    ? undefined
    : {
        createPayloadCapture: (requestId: string) => ({
          save: (id: string, kind: "client_request" | "provider_request" | "provider_response" | "client_response", artifact: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number }) => {
            void (telemetry as unknown as { savePayload(requestId: string, kind: string, artifact: unknown): Promise<void> }).savePayload(id, kind, artifact);
          },
        }),
      };

  const relayIds = new Set<string>();
  const relayCircuit = new RelayCircuitBreaker();
  const network = new NetworkSelector({
    circuit: relayCircuit,
    getProxies: async () => {
      const snapshot = await repositories.getRouteSnapshot();
      const montanaRelays = getMontanaConfigRuntime()?.snapshot().relays ?? [];
      const relaySecrets = new Map(montanaRelays.map((relay) => [relay.url.replace(/\/$/, ""), relay.secret]));
      const configuredRelaySecret = await relaySecretService.getSecret().catch(() => null);
      return snapshot.proxies.map((proxy) => {
        const id = String(proxy.id);
        const isRelay = (proxy as unknown as { readonly isRelay?: unknown }).isRelay === true;
        if (isRelay) relayIds.add(id);
        const url = `${String(proxy.protocol ?? "http")}://${String(proxy.host)}:${Number(proxy.port)}`;
        const relaySecret = isRelay ? relaySecrets.get(url) ?? relaySecrets.get(url.replace(/\/$/, "")) ?? configuredRelaySecret : null;
        return {
          id,
          url,
          isRelay,
          relaySecret,
          healthy: (proxy as { readonly last_test_error?: unknown }).last_test_error == null,
          priority: Number(proxy.priority ?? 100),
          weight: Number(proxy.weight ?? 100),
        };
      });
    },
  });

  const accounts = new CredentialSelector({ getCredential: repositories.accounts.getCredential, leaseCredential: routeRepositories?.leaseCredential, accountManager });
  const routeDependencies = {
    providers: registry,
    accounts,
    network,
    telemetry: telemetryWriter,
    onRouteFailure: async (_candidate: import("../proxy/types/routing.js").RouteCandidate, error: import("../proxy/types/error-types.js").InternalFailure, selected: import("../proxy/request/prepare.js").RouteAttemptSelection | null) => {
      if (error.routeScope === "proxy" && selected?.proxyId !== null && selected?.proxyId !== undefined && relayIds.has(selected.proxyId)) {
        relayCircuit.recordFailure(selected.proxyId);
      }
    },
    onRouteSuccess: async (_candidate: import("../proxy/types/routing.js").RouteCandidate, selected: import("../proxy/request/prepare.js").RouteAttemptSelection | null) => {
      if (selected?.proxyId !== null && selected?.proxyId !== undefined && relayIds.has(selected.proxyId)) {
        relayCircuit.recordSuccess(selected.proxyId);
      }
    },
    ...(payloadSink ?? {}),
    ...(telemetry === undefined ? {} : {
           onRequestLog: (event: ProxyRequestLogEvent): void => {
             console.log(renderMontanaLog(event));
             void telemetry.writeLogs([{
          level: levelFor(event.event),
          scope: "request",
          msg: renderTraceLine(event),
          context: buildContext(event),
        }]).catch(() => {});
      },
    }),
    accountCandidates: async (providerId: string) => {
      const snapshot = await repositories.getRouteSnapshot();
      return snapshot.accounts
        .filter((account) => account.providerId === providerId)
        .map((account): AccountCandidate => ({
          id: account.accountId,
          accountId: account.accountId,
          providerId: account.providerId,
          credentialKind: account.credentialKind,
          healthy: account.healthy,
          health: account.health ?? null,
          enabled: account.enabled,
          quotaAvailable: account.quotaAvailable ?? true,
          modelLocks: modelLocksFor(account),
          priority: account.priority,
        }));
    },
    resolveRoutes: async (request: import("../proxy/types/request.js").ProxyRequest, affinity: import("../proxy/types/routing.js").AffinityKey, client: import("../proxy/types/request.js").ClientIdentity, disableRemoteMapping?: boolean) => {
      const source = await repositories.getRouteSnapshot();
      const persistedByProvider = new Map<string, Map<string, boolean>>();
      for (const model of source.models) {
        const enabled = persistedByProvider.get(model.providerId) ?? new Map<string, boolean>();
        enabled.set(model.modelId, model.enabled);
        persistedByProvider.set(model.providerId, enabled);
      }
      const models = registry.list().flatMap((adapter): ProviderModelMeta[] => {
        const persisted = persistedByProvider.get(adapter.metadata.id);
        return adapter.models.list
          .filter((model) => persisted === undefined || persisted.has(model.id))
          .map((model) => ({
            providerId: adapter.metadata.id,
            modelId: model.id,
            enabled: persisted?.get(model.id) ?? true,
            displayName: model.displayName,
            caps: model.capabilities,
            contextWindowTokens: model.context?.inputTokens ?? null,
            protocol: adapter.metadata.protocol,
            credentialKinds: [adapter.metadata.credentialKind],
          }));
      });
      const aliases = new Map<string, string>();
      for (const alias of source.aliases as unknown as Array<{ alias: string; model: string }>) aliases.set(alias.alias, alias.model);
      const combos = new Map<string, { readonly members: readonly string[]; readonly strategy: "fallback" | "round-robin"; readonly stickyLimit?: number }>();
      for (const combo of source.combos as unknown as Array<{ id: string; name?: string; models_json: unknown; strategy?: string; sticky_limit?: unknown }>) {
        const members = Array.isArray(combo.models_json) ? combo.models_json.filter((item): item is string => typeof item === "string") : [];
        const stickyLimit = typeof combo.sticky_limit === "number" ? combo.sticky_limit : undefined;
        const entry = { members, strategy: combo.strategy === "round-robin" ? "round-robin" as const : "fallback" as const, ...(stickyLimit === undefined ? {} : { stickyLimit }) };
        combos.set(combo.id, entry);
        if (combo.name && combo.name !== combo.id) combos.set(combo.name, entry);
      }
      const proxies: ProxyCandidate[] = source.proxies.map((proxy) => ({ id: String(proxy.id), healthy: true }));
      const accountsSnapshot: AccountCandidate[] = source.accounts.map((account) => ({ id: account.accountId, accountId: account.accountId, providerId: account.providerId, credentialKind: account.credentialKind, healthy: account.healthy, health: account.health ?? null, enabled: account.enabled, quotaAvailable: account.quotaAvailable ?? true, modelLocks: modelLocksFor(account), priority: account.priority }));
      const providerPrefixes = new Map(registry.list().map((adapter) => [adapter.metadata.id, adapter.metadata.id]));
      const cliMappings = (source as unknown as { cliModelMappings?: ReadonlyMap<string, import("../proxy/routing/mapping.js").CliModelMappingSnapshot> }).cliModelMappings ?? new Map();
      const apiKeyId = affinity.namespace === "api_key" ? affinity.value : null;
      const mappedModel = disableRemoteMapping ? request.model : resolveCliModelMapping(client, request.model, apiKeyId, cliMappings);
      const snapshot: RoutingSnapshot = { revision: Date.now(), createdAt: new Date().toISOString(), aliases, combos, providerPrefixes, proxies, accounts: accountsSnapshot, models, ponytailEnabled: false, rtkConfig: null, providerCredentialKinds: new Map(registry.list().map((adapter) => [adapter.metadata.id, adapter.metadata.credentialKind])), cliModelMappings: cliMappings };
      const requiredCapabilities = { tools: request.tools.length > 0, hostedSearch: request.tools.some(isWebSearchTool), reasoning: request.reasoning === "enabled" || request.reasoningConfig !== undefined, image: request.messages.some((m) => m.content.some((b) => b.type === "image")), pdf: request.messages.some((m) => m.content.some((b) => b.type === "pdf")), video: request.messages.some((m) => m.content.some((b) => b.type === "video")), responseFormat: (() => { const _f = (request as unknown as { responseFormat?: unknown }).responseFormat; return (typeof _f === "string" ? _f : (_f != null && typeof _f === "object" && "kind" in (_f as Record<string, unknown>) ? String((_f as Record<string, unknown>)["kind"]) : "text")) as "text" | "json_object" | "json_schema"; })(), stream: request.stream, sourceSurface: request.sourceSurface } as const;
      let plan = createRoutePlan({ requestedModel: mappedModel, snapshot, affinityKey: affinity, sourceSurface: request.sourceSurface, stream: request.stream, requiredCapabilities, rawRequestedModel: request.model, mappedModel, routeSessionStore });
      if (request.tools.some(isWebSearchTool)) {
        plan = { ...plan, webSearch: true } as typeof plan;
        const firstCandidate = plan.candidates[0];
        if (firstCandidate !== undefined) {
          const adapter = registry.get(firstCandidate.providerId);
          const supportsSearch = adapter ? hasWebSearchCapability(adapter.capabilities) || hasWebSearchCapability(adapter.models.get(firstCandidate.modelId)?.capabilities ?? null) : false;
          if (!supportsSearch) {
            const searchAdapter = registry.get("exa");
            if (searchAdapter && hasWebSearchCapability(searchAdapter.capabilities)) {
              const hasAccount = accountsSnapshot.some((a) => a.providerId === "exa" && a.healthy);
              if (hasAccount || searchAdapter.metadata.credentialKind === "none") {
                const searchModel = searchAdapter.models.list.find((m) => hasWebSearchCapability(m.capabilities))?.id ?? searchAdapter.models.list[0]?.id;
                if (searchModel) {
                  const searchPlan = createRoutePlan({ requestedModel: "exa/" + searchModel, snapshot, affinityKey: affinity, routeSessionStore });
                  if (searchPlan.candidates.length > 0) plan = { ...plan, candidates: Object.freeze(searchPlan.candidates), webSearch: true } as typeof plan;
                }
              }
            }
          }
        }
      }
      return plan;
    },
  } as unknown as import("../proxy/request/prepare.js").ProxyRequestDependencies;
  let passthroughRouteDependencies: import("../proxy/request/prepare.js").ProxyRequestDependencies | null = routeDependencies;
  return {
    health: () => relayCircuit.snapshot(),
    async handle(input) {
      const keyContext = await loadKeyAuthorization(pool, (input as { apiKeyId?: string | null }).apiKeyId ?? null);
      const authorizedInput = {
        request: {
          endpoint: input.endpoint,
          surface: input.surface,
          body: input.body,
          headers: input.headers,
          signal: input.signal,
          requestId: input.requestId,
          clientIp: input.clientIp ?? null,
        },
        authorization: {
          apiKeyId: (input as { apiKeyId?: string | null }).apiKeyId ?? null,
          trustedIdentity: null,
          ...(keyContext.apiKey !== undefined ? { apiKey: keyContext.apiKey } : {}),
          ...(keyContext.providerAllowlist !== undefined ? { providerAllowlist: keyContext.providerAllowlist } : {}),
          ...(keyContext.modelAllowlist !== undefined ? { modelAllowlist: keyContext.modelAllowlist } : {}),
          ...(keyContext.modelDenylist !== undefined ? { modelDenylist: keyContext.modelDenylist } : {}),
        },
      } as unknown as import("../proxy/request/prepare.js").AuthorizedProxyRequestInput;
      return executeProxyRequest(authorizedInput, {
        ...routeDependencies,
        admission,
        requestLimits,
        hedgeDelayMs,
        pool,
        repositories,
        telemetry: telemetryWriter,
        globalPersona: () => montanaPersonaSnapshot() ?? getPersonaSnapshot(),
      } as unknown as import("../proxy/request/prepare.js").ProxyRequestDependencies);
    },
    async passthrough(input: {
      readonly path: string;
      readonly body: Readonly<Record<string, unknown>>;
      readonly headers: Headers;
      readonly signal: AbortSignal;
      readonly requestId: string;
      readonly clientIp: string | null;
      readonly apiKeyId: string;
    }): Promise<Response> {
      const dependencies = passthroughRouteDependencies;
      if (dependencies === null) throw createInternalFailure({ kind: "provider_unavailable", safeMessage: "Proxy routing is unavailable", retryable: false, routeScope: "provider" });
      const keyContext = await loadKeyAuthorization(pool, input.apiKeyId);
      const authorization = {
        apiKeyId: input.apiKeyId,
        trustedIdentity: null,
        ...(keyContext.apiKey !== undefined ? { apiKey: keyContext.apiKey } : {}),
        ...(keyContext.providerAllowlist !== undefined ? { providerAllowlist: keyContext.providerAllowlist } : {}),
        ...(keyContext.modelAllowlist !== undefined ? { modelAllowlist: keyContext.modelAllowlist } : {}),
        ...(keyContext.modelDenylist !== undefined ? { modelDenylist: keyContext.modelDenylist } : {}),
      };
      const upstream = getMontanaConfigRuntime()?.snapshot().upstream ?? null;
      const requestedModel = typeof input.body.model === "string" && input.body.model.trim().length > 0
        ? input.body.model.trim()
        : upstream?.modelsDefault ?? "";
      if (requestedModel.length === 0) throw createInternalFailure({ kind: "invalid_request", safeMessage: "A model is required", statusCode: 400, retryable: false, routeScope: null });
      const forwardedBody = applyGlobalPersonaToOpenAIPayload({ ...input.body, model: requestedModel }, montanaPersonaSnapshot() ?? getPersonaSnapshot());
      const routeRequest = {
        model: requestedModel,
        messages: [],
        tools: [],
        stream: input.body.stream === true,
        responseFormat: "text",
        reasoning: "default",
        maxOutputTokens: null,
        sourceSurface: "openai-chat",
        images: [],
        limits: requestLimits,
        signal: input.signal,
      } as unknown as import("../proxy/types/request.js").ProxyRequest;
      const affinity: import("../proxy/types/routing.js").AffinityKey = { namespace: "api_key", value: input.apiKeyId };
      const plan = await dependencies.resolveRoutes(routeRequest, affinity, { name: "unknown", source: "unknown" });
      const candidates = plan.candidates.filter((candidate) => isRouteAllowed(candidate.providerId, candidate.modelId, authorization, plan.requestedModel));
      if (candidates.length === 0) throw createInternalFailure({ kind: "model_not_found", safeMessage: "No eligible route found", statusCode: 404, retryable: false, routeScope: null });
      const accounts = new CredentialSelector({ getCredential: repositories.accounts.getCredential, leaseCredential: routeRepositories?.leaseCredential, accountManager });
      let admissionLease: ReturnType<ApiKeyAdmission["acquire"]> | null = null;
      if (keyContext.apiKey !== undefined && keyContext.apiKey !== null) admissionLease = admission.acquire(keyContext.apiKey, Math.max(1, Math.ceil(JSON.stringify(forwardedBody).length / 4)));
      let lastFailure: import("../proxy/types/error-types.js").InternalFailure | null = null;
      for (const candidate of candidates) {
        const adapter = registry.get(candidate.providerId);
        if (adapter === null || typeof adapter.callPassthrough !== "function") continue;
        const accountCandidates = await dependencies.accountCandidates(candidate.providerId);
        const credential = adapter.metadata.credentialKind === "none" ? null : await accounts.select({ providerId: candidate.providerId, candidates: accountCandidates, strategy: "priority", affinityKey: input.apiKeyId, modelId: candidate.modelId, preferredAccountId: candidate.accountId });
        if (adapter.metadata.credentialKind !== "none" && credential === null) continue;
        const selectedNetwork = await network.select({ providerId: candidate.providerId, affinityKey: input.apiKeyId, preferredProxyId: candidate.proxyId });
        if (selectedNetwork === null) {
          if (credential !== null) await accounts.release(credential.selection.leaseId).catch(() => {});
          continue;
        }
        const selected = { accountId: credential?.selection.accountId ?? null, proxyId: selectedNetwork.proxyId };
        let released = false;
        const release = async (): Promise<void> => {
          if (released) return;
          released = true;
          const releases: Promise<void>[] = [];
          if (credential !== null) releases.push(accounts.release(credential.selection.leaseId));
          if (typeof selectedNetwork.selection.release === "function") releases.push(selectedNetwork.selection.release());
          if (admissionLease !== null) {
            const lease = admissionLease;
            admissionLease = null;
            lease.release();
          }
          await Promise.all(releases);
        };
        try {
          const target = adapter.resolveTarget(candidate.modelId, "openai-chat");
          const result = await adapter.callPassthrough({
            target: { ...target, surface: "openai-chat", upstreamModelId: target.upstreamModelId ?? candidate.modelId },
            path: input.path,
            body: forwardedBody,
            credential: credential?.selection.secret ?? "",
            network: selectedNetwork.selection,
            signal: input.signal,
            headers: input.headers,
            stream: input.body.stream === true,
            limits: requestLimits,
          });
          await dependencies.onRouteSuccess?.(candidate, selected);
          if (input.body.stream === true && result.response.body !== null) return responseWithRelease(result.response, async () => { await result.release(); await release(); });
          await result.release();
          await release();
          return result.response;
        } catch (error) {
          const failure = adapter.mapError(error);
          lastFailure = failure;
          await dependencies.onRouteFailure?.(candidate, failure, selected).catch(() => {});
          await release().catch(() => {});
        }
      }
      if (admissionLease !== null) admissionLease.release();
      throw lastFailure ?? createInternalFailure({ kind: "provider_unavailable", safeMessage: "No passthrough-capable route found", retryable: false, routeScope: "provider" });
    },
  };
}
