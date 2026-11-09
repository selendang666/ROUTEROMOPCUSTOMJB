import type { AliasRow, ComboRow, ProviderAccountRow, ProviderModelRow } from "../../persistence/types.js";
import type { Surface } from "../types/surface.js";
import type { AffinityKey, ProxyCandidate, ProxyRoutePlan, RouteCandidate, RoutePlanDiagnostic, RouteTarget, RoutingSnapshot } from "../types/routing.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { CliModelMappingSnapshot } from "./mapping.js";
import { hasWebSearchCapability, isWebSearchTool } from "./capability.js";
import { resolveModelWireSurface } from "../translate/policy.js";

export const MAX_ALIAS_DEPTH = 8;

export const MAX_DIAGNOSTICS = 32;

const MAX_CANDIDATES = 64;

/** Application-owned snapshot source — config + registry + revision counter. */
export interface RouteSnapshotSources {
  readonly config: {
    readonly providerModels?: { list(providerId: string): readonly ProviderModelRow[] | Promise<readonly ProviderModelRow[]> };
    readonly aliases: { list(): readonly AliasRow[] | Promise<readonly AliasRow[]> };
    readonly combos: { list(): readonly ComboRow[] | Promise<readonly ComboRow[]> };
    readonly cliModelMappings?: {
      getSettings(toolId: string): { readonly enabled?: boolean } | null | Promise<{ readonly enabled?: boolean } | null>;
      list(toolId: string): readonly { readonly sourceModel: string; readonly targetModel: string; readonly enabled: boolean }[] | Promise<readonly { readonly sourceModel: string; readonly targetModel: string; readonly enabled: boolean }[]>;
    };
    readonly accounts: { list(): readonly ProviderAccountRow[] | Promise<readonly ProviderAccountRow[]> };
  };
  readonly registry: ProviderRegistry;
  readonly readRevision: () => number;
}

export interface RouteSnapshotCache {
  get(): Promise<RoutingSnapshot>;
  invalidate(): void;
}

export function createRouteSnapshotCache(sources: RouteSnapshotSources): RouteSnapshotCache {
  let cached: RoutingSnapshot | null = null;
  let rebuildPromise: Promise<RoutingSnapshot> | null = null;
  const rebuild = async (): Promise<RoutingSnapshot> => {
    while (true) {
      const revision = sources.readRevision();
      const snapshot = await buildRouteSnapshot(sources, revision);
      if (sources.readRevision() === revision) {
        cached = snapshot;
        return snapshot;
      }
    }
  };
  return {
    async get(): Promise<RoutingSnapshot> {
      const revision = sources.readRevision();
      const current = cached;
      if (current !== null && (current as unknown as { revision: number }).revision === revision) return current;
      if (rebuildPromise !== null) return rebuildPromise;
      const promise = rebuild();
      rebuildPromise = promise;
      void promise.then(() => { if (rebuildPromise === promise) rebuildPromise = null; }, () => { if (rebuildPromise === promise) rebuildPromise = null; });
      return promise;
    },
    invalidate(): void {},
  };
}

async function buildRouteSnapshot(sources: RouteSnapshotSources, revision: number): Promise<RoutingSnapshot> {
  const { config, registry } = sources;
  const adapters = registry.list();
  const prefixes = new Map<string, string>();
  for (const adapter of adapters) {
    prefixes.set(adapter.metadata.id, adapter.metadata.id);
    for (const model of adapter.models.list) {
      const sep = model.id.indexOf("/");
      if (sep > 0) {
        const modelPrefix = model.id.slice(0, sep);
        if (!prefixes.has(modelPrefix)) prefixes.set(modelPrefix, adapter.metadata.id);
      }
    }
  }
  const providerModels = config.providerModels;
  const knownModelIds = new Map<string, Set<string>>();
  if (providerModels !== undefined) {
    const modelRows = await Promise.all(adapters.map(async (adapter) => ({
      adapter,
      models: await Promise.resolve(providerModels.list(adapter.metadata.id)),
    })));
    for (const { adapter, models } of modelRows) {
      const ids = new Set<string>();
      for (const model of models) {
        ids.add(model.modelId);
        const sep = model.modelId.indexOf("/");
        if (sep > 0) {
          const modelPrefix = model.modelId.slice(0, sep);
          if (!prefixes.has(modelPrefix)) prefixes.set(modelPrefix, adapter.metadata.id);
        }
      }
      if (ids.size > 0) knownModelIds.set(adapter.metadata.id, ids);
    }
  }
  const [aliasRows, comboRows, accountRows] = await Promise.all([
    Promise.resolve(config.aliases.list()),
    Promise.resolve(config.combos.list()),
    Promise.resolve(config.accounts.list()),
  ]);
  const aliases = new Map<string, string>(aliasRows.map((row: AliasRow) => [row.alias, row.model]));
  const combos = new Map<string, { readonly members: readonly string[]; readonly strategy: "fallback" | "round-robin"; readonly stickyLimit?: number; readonly name?: string }>();
  for (const row of comboRows) {
    const members = (row.models as unknown as readonly string[]) ?? (row.members as unknown as readonly string[]) ?? [];
    const entry = { members, strategy: row.strategy === "round-robin" ? "round-robin" as const : "fallback" as const, stickyLimit: typeof row.stickyLimit === "number" ? row.stickyLimit : undefined, name: row.name };
    combos.set(row.id, entry);
    // legacy: allow lookup by name for tests/fixtures that use name as identifier
    if (row.name !== row.id && !combos.has(row.name)) combos.set(row.name, entry);
  }
  const accountsByProviderMutable = new Map<string, { id: string; providerId: string; credentialKind: import("../types/surface.js").CredentialKind; active: boolean }[]>();
  for (const row of accountRows) {
    let rows = accountsByProviderMutable.get(row.provider);
    if (rows === undefined) { rows = []; accountsByProviderMutable.set(row.provider, rows); }
    rows.push({ id: row.id, providerId: row.provider, credentialKind: row.credentialKind, active: row.active });
  }
  const frozenAccounts = new Map<string, readonly { id: string; providerId: string; credentialKind: import("../types/surface.js").CredentialKind; active: boolean }[]>();
  for (const [k, v] of accountsByProviderMutable) frozenAccounts.set(k, Object.freeze([...v]));
  void knownModelIds;
  void prefixes;
  void combos;
  // Build minimal RoutingSnapshot shape expected by createRoutePlan (which only uses aliases, combos, prefixes via snapshot)
  // For now return a frozen object that satisfies RoutingSnapshot interface via casting; actual fields beyond aliases/combos are optional for route plan
  const cliModelMappings = new Map<string, CliModelMappingSnapshot>();
  const mappingStore = config.cliModelMappings;
  if (mappingStore !== undefined) {
    const toolIds = ["claude", "codex", "opencode", "cline", "cursor", "copilot", "gemini-cli"] as const;
    const mappingResults = await Promise.all(toolIds.map(async (toolId) => ({
      toolId,
      settings: await Promise.resolve(mappingStore.getSettings(toolId)),
      rows: await Promise.resolve(mappingStore.list(toolId)),
    })));
    for (const { toolId, settings, rows: mappingRows } of mappingResults) {
      const entries = mappingRows.map((r) => ({ sourceModel: r.sourceModel, targetModel: r.targetModel, enabled: r.enabled }));
      if (settings !== null || entries.length > 0) cliModelMappings.set(toolId, { enabled: settings?.enabled !== false, entries: Object.freeze(entries) });
    }
  }
  return Object.freeze({
    revision,
    aliases,
    combos: combos as unknown as ReadonlyMap<string, { readonly members: readonly string[]; readonly strategy: "fallback" | "round-robin" }>,
    prefixes: prefixes as unknown as ReadonlyMap<string, string>,
    cliModelMappings: cliModelMappings as unknown as ReadonlyMap<string, CliModelMappingSnapshot>,
    accountsByProvider: frozenAccounts as unknown as ReadonlyMap<string, readonly { id: string; providerId: string; credentialKind: import("../types/surface.js").CredentialKind; active: boolean }[]>,
    knownModelIds: new Map() as unknown as ReadonlyMap<string, ReadonlySet<string>>,
    providerPrefixes: prefixes as unknown as ReadonlyMap<string, string>,
    proxies: [] as unknown as readonly import("../types/routing.js").ProxyCandidate[],
    accounts: [] as unknown as readonly import("../types/routing.js").AccountCandidate[],
    models: [] as unknown as readonly import("../types/provider.js").ProviderModelMeta[],
    ponytailEnabled: false,
    rtkConfig: null,
    createdAt: new Date().toISOString(),
  } as unknown as RoutingSnapshot);
}

let diagnosticsTruncatedWarned = false;
function pushDiagnostic(diagnostics: RoutePlanDiagnostic[], diag: RoutePlanDiagnostic): void {
  if (diagnostics.length >= MAX_DIAGNOSTICS) {
    if (!diagnosticsTruncatedWarned) {
      diagnosticsTruncatedWarned = true;
      console.warn(`[route] diagnostics truncated at ${MAX_DIAGNOSTICS}`);
    }
    return;
  }
  diagnostics.push(diag);
  if (diagnostics.length >= MAX_DIAGNOSTICS && !diagnosticsTruncatedWarned) {
    diagnosticsTruncatedWarned = true;
    console.warn(`[route] diagnostics truncated at ${MAX_DIAGNOSTICS}`);
  }
}

function resolveAliasChain(
  raw: string,
  aliases: ReadonlyMap<string, string>,
  diagnostics: RoutePlanDiagnostic[],
): string | null {
  let cur = raw;
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth += 1) {
    const next = aliases.get(cur);
    if (next === undefined) return cur;
    if (seen.has(cur)) {
      pushDiagnostic(diagnostics, { code: "cycle", message: `alias cycle at ${cur}`, reference: cur });
      return cur;
    }
    seen.add(cur);
    cur = next;
  }
  pushDiagnostic(diagnostics, { code: "max_depth", message: `alias depth exceeded for ${raw}`, reference: raw });
  return null;
}

function expandComboMembers(
  comboName: string,
  combos: ReadonlyMap<string, { readonly members: readonly string[]; readonly strategy: "fallback" | "round-robin" }>,
  aliases: ReadonlyMap<string, string>,
  diagnostics: RoutePlanDiagnostic[],
): readonly string[] {
  const combo = combos.get(comboName);
  if (!combo) return [];
  const members: string[] = [];
  const seen = new Set<string>();
  for (const raw of combo.members) {
    const resolvedOrNull = resolveAliasChain(raw, aliases, diagnostics);
    if (resolvedOrNull === null) continue;
    const resolved = resolvedOrNull;
    const nested = combos.get(resolved);
    if (nested) {
      for (const n of nested.members) {
        const rNull = resolveAliasChain(n, aliases, diagnostics);
        if (rNull === null) continue;
        const r = rNull;
        if (!seen.has(r)) { seen.add(r); members.push(r); }
      }
      continue;
    }
    if (!seen.has(resolved)) { seen.add(resolved); members.push(resolved); }
  }
  if (members.length === 0) {
    pushDiagnostic(diagnostics, { code: "empty_combo", message: `combo ${comboName} has no resolvable members`, reference: comboName });
  }
  return members;
}

function parseQualifiedModel(model: string, prefixes: ReadonlyMap<string, string>): RouteTarget | null {
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const prefix = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  const providerId = prefixes.get(prefix);
  if (!providerId || !modelId) return null;
  // surface will be resolved via resolveModelWireSurface in createRoutePlan filtering; default to openai-chat for now
  return { providerId, modelId, surface: "openai-chat", upstreamModelId: modelId, contextWindowTokens: null };
}

function resolveTargets(
  requestedModel: string,
  snapshot: RoutingSnapshot,
  diagnostics: RoutePlanDiagnostic[],
  affinityKey?: AffinityKey | null,
  revision?: number,
  routeSessionStore?: BoundedRouteSessionStore,
): readonly RouteTarget[] {
  const afterAliasNull = resolveAliasChain(requestedModel, snapshot.aliases, diagnostics);
  if (afterAliasNull === null) return [];
  const afterAlias = afterAliasNull;
  if (snapshot.combos.has(afterAlias)) {
    const comboEntry = snapshot.combos.get(afterAlias);
    let members = expandComboMembers(afterAlias, snapshot.combos, snapshot.aliases, diagnostics);
    // round-robin rotation via bounded store
    if (comboEntry?.strategy === "round-robin") {
      const store = routeSessionStore ?? globalRoundRobinStore;
      const key = `${revision ?? snapshot.revision}\u0000${afterAlias}\u0000${affinityKey ? affinityKeyString(affinityKey) : ""}`;
      const state = store.get(key);
      const nextIndex = state?.nextIndex ?? 0;
      const uses = state?.uses ?? 0;
      const stickyLimit = (comboEntry as { stickyLimit?: number }).stickyLimit;
      if (members.length > 0) {
        const ordered = [...members.slice(nextIndex), ...members.slice(0, nextIndex)];
        members = ordered;
        const newUses = uses + 1;
        let newNext = nextIndex;
        if (stickyLimit !== undefined && stickyLimit > 0 && newUses >= stickyLimit) {
          newNext = (nextIndex + 1) % members.length;
          store.set(key, { nextIndex: newNext, uses: 0 });
        } else {
          store.set(key, { nextIndex, uses: newUses });
          if (stickyLimit === undefined || stickyLimit <= 0) {
            store.set(key, { nextIndex: (nextIndex + 1) % members.length, uses: 0 });
          }
        }
      }
    }
    const targets: RouteTarget[] = [];
    for (const m of members) {
      const q = parseQualifiedModel(m, snapshot.providerPrefixes);
      if (q) targets.push(q);
      else pushDiagnostic(diagnostics, { code: "unresolved_member", message: `unresolved combo member ${m}`, reference: m });
    }
    return targets;
  }
  const qualified = parseQualifiedModel(afterAlias, snapshot.providerPrefixes);
  if (qualified) return [qualified];
  const bareIndex = getBareModelIndex(snapshot);
  const providers = bareIndex.get(afterAlias);
  if (providers !== undefined) {
    if (providers.length === 1) {
      const providerId = providers[0]!;
      return [{ providerId, modelId: afterAlias, surface: "openai-chat", upstreamModelId: afterAlias, contextWindowTokens: null }];
    }
    if (providers.length > 1) {
      pushDiagnostic(diagnostics, { code: "ambiguous_model", message: `model ${afterAlias} is ambiguous across providers: ${providers.join(", ")}`, reference: afterAlias });
      return [];
    }
  }
  pushDiagnostic(diagnostics, { code: "unqualified_model", message: `model must use provider/model slug: ${requestedModel}`, reference: requestedModel });
  return [];
}

function fnv1a32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rendezvousScore(key: string, candidateId: string): number {
  return fnv1a32(`${key}\u0000${candidateId}`);
}

function orderByRendezvous<T>(key: string, items: readonly T[], idOf: (item: T) => string): readonly T[] {
  const scores = new Map<T, { readonly id: string; readonly score: number }>();
  for (const item of items) {
    const id = idOf(item);
    scores.set(item, { id, score: rendezvousScore(key, id) });
  }
  return [...items].sort((a, b) => {
    const left = scores.get(a);
    const right = scores.get(b);
    if (left === undefined || right === undefined) return 0;
    const sa = left.score;
    const sb = right.score;
    if (sa !== sb) return sb - sa;
    const ia = left.id;
    const ib = right.id;
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

function affinityKeyString(key: AffinityKey): string {
  return `${key.namespace}:${key.value}`;
}

function orderedProxies(proxies: readonly ProxyCandidate[], affinityKey: AffinityKey | null): readonly ProxyCandidate[] {
  const healthy = proxies.filter((p) => p.healthy);
  const pool = healthy.length > 0 ? healthy : proxies;
  if (affinityKey) return orderByRendezvous(affinityKeyString(affinityKey), pool, (p) => p.id);
  return [...pool].sort((a, b) => a.id.localeCompare(b.id));
}

export interface RoutePlanInput {
  readonly requestedModel: string;
  readonly snapshot: RoutingSnapshot;
  readonly affinityKey?: AffinityKey | null;
  readonly isAccountEligible?: (accountId: string, target: RouteTarget) => boolean;
  readonly sourceSurface?: Surface;
  readonly stream?: boolean;
  readonly requiredCapabilities?: import("../types/routing.js").RequiredRouteCapabilities;
  readonly rawRequestedModel?: string;
  readonly mappedModel?: string;
  readonly routeSessionStore?: BoundedRouteSessionStore;
}

const routePlanCache = new WeakMap<RoutingSnapshot, Map<string, ProxyRoutePlan>>();
let routePlanCacheHits = 0;
let routePlanCacheMisses = 0;
let routePlanCacheBypasses = 0;
let routePlanCacheStores = 0;

const bareModelIndexCache = new WeakMap<RoutingSnapshot, ReadonlyMap<string, readonly string[]>>();
function getBareModelIndex(snapshot: RoutingSnapshot): ReadonlyMap<string, readonly string[]> {
  const cached = bareModelIndexCache.get(snapshot);
  if (cached !== undefined) return cached;
  const map = new Map<string, string[]>();
  for (const model of snapshot.models) {
    const arr = map.get(model.modelId);
    if (arr === undefined) map.set(model.modelId, [model.providerId]);
    else if (!arr.includes(model.providerId)) arr.push(model.providerId);
  }
  // sort provider IDs for determinism
  for (const [k, v] of map) map.set(k, [...v].sort());
  const frozen = new Map<string, readonly string[]>();
  for (const [k, v] of map) frozen.set(k, v as readonly string[]);
  bareModelIndexCache.set(snapshot, frozen);
  return frozen;
}

// Bounded round-robin store: 256 entries, 30min idle TTL — persisted per proxy process, keyed by revision+comboId+affinity
export interface RouteSessionState {
  readonly nextIndex: number;
  readonly uses: number;
}
export class BoundedRouteSessionStore {
  private readonly map = new Map<string, { state: RouteSessionState; expiresAt: number }>();
  private readonly maxEntries = 256;
  private readonly ttlMs = 30 * 60 * 1000;
  get(key: string): RouteSessionState | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) { this.map.delete(key); return undefined; }
    return entry.state;
  }
  set(key: string, state: RouteSessionState): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { state, expiresAt: Date.now() + this.ttlMs });
  }
}
export const globalRoundRobinStore = new BoundedRouteSessionStore();

/** Returns process-local route-plan cache counters for diagnostics. */
export function getRoutePlanCacheStats(): {
  readonly hits: number;
  readonly misses: number;
  readonly bypasses: number;
  readonly stores: number;
} {
  return {
    hits: routePlanCacheHits,
    misses: routePlanCacheMisses,
    bypasses: routePlanCacheBypasses,
    stores: routePlanCacheStores,
  };
}

export function createRoutePlan(input: RoutePlanInput): ProxyRoutePlan {
  const affinityCacheKey = input.affinityKey === undefined || input.affinityKey === null
    ? ""
    : affinityKeyString(input.affinityKey);
  const cacheKey = `${input.requestedModel}\u0000${affinityCacheKey}`;
  if (input.isAccountEligible === undefined) {
    const plans = routePlanCache.get(input.snapshot);
    const cached = plans?.get(cacheKey);
    if (cached !== undefined) {
      routePlanCacheHits += 1;
      // LRU: move to end (most recent)
      plans!.delete(cacheKey);
      plans!.set(cacheKey, cached);
      return cached;
    }
    routePlanCacheMisses += 1;
  } else {
    routePlanCacheBypasses += 1;
  }
  const diagnostics: RoutePlanDiagnostic[] = [];
  const targetsRaw = resolveTargets(input.requestedModel, input.snapshot, diagnostics, input.affinityKey ?? null, input.snapshot.revision, input.routeSessionStore);
  const enabledTargets = targetsRaw.filter((target) => {
    const meta = input.snapshot.models.find((model) => model.providerId === target.providerId && model.modelId === target.modelId);
    if (meta?.enabled === false) {
      pushDiagnostic(diagnostics, { code: "model_disabled", message: `model ${target.providerId}/${target.modelId} is disabled`, reference: `${target.providerId}/${target.modelId}` });
      return false;
    }
    return true;
  });
  // capability-aware filtering before account/network selection
  let targets = enabledTargets;
  if (input.requiredCapabilities !== undefined) {
    const req = input.requiredCapabilities;
    targets = enabledTargets.filter((target) => {
      const meta = input.snapshot.models.find((m) => m.providerId === target.providerId && m.modelId === target.modelId);
      const caps = meta?.caps;
      if (caps === undefined) return true; // allow if no metadata
      if (req.tools && !caps.toolCalls) return false;
      if (req.hostedSearch && !(caps.search === true)) return false;
      if (req.reasoning && !caps.reasoning) return false;
      if (req.image && !caps.images) return false;
      if (req.pdf && !(caps as unknown as { pdf?: boolean }).pdf) return false;
      if (req.video && !(caps as unknown as { video?: boolean }).video) return false;
      // surface projection check via resolveModelWireSurface
      if (req.sourceSurface) {
        try {
          const wire = resolveModelWireSurface({ protocol: meta?.protocol } as unknown as Record<string, unknown>, caps, null, req.sourceSurface);
          if (wire === null) return false;
          // update target surface to resolved wire surface for downstream attempt
          (target as unknown as { surface: string }).surface = wire;
        } catch { return false; }
      }
      return true;
    });
    if (targets.length === 0 && targetsRaw.length > 0) {
      pushDiagnostic(diagnostics, { code: "capability_unsupported", message: `no candidate supports required capabilities for ${input.requestedModel}`, reference: input.requestedModel });
    }
  }
  if (targets.length === 0) {
    const ambiguous = diagnostics.find((d) => d.code === "ambiguous_model");
    const capability = diagnostics.find((d) => d.code === "capability_unsupported");
    return {
      candidates: [],
      diagnostics: Object.freeze([...diagnostics]),
      snapshotRevision: input.snapshot.revision,
      requestedModel: input.rawRequestedModel ?? input.requestedModel,
      mappedModel: input.mappedModel ?? input.requestedModel,
      sourceSurface: input.sourceSurface,
      unsupportedReason: ambiguous?.message ?? capability?.message ?? diagnostics.find((d) => d.code === "unknown_reference")?.message ?? diagnostics[0]?.message ?? `model ${input.requestedModel} not found`,
      failureCode: ambiguous ? "ambiguous_model" : capability ? "capability_unsupported" : "model_not_found",
    };
  }
  const proxies = orderedProxies(input.snapshot.proxies, input.affinityKey ?? null);
  const proxyCount = Math.max(1, proxies.length);
  const candidates: RouteCandidate[] = [];
  const affinityStr = input.affinityKey ? affinityKeyString(input.affinityKey) : null;

  for (const target of targets) {
    let accounts = input.snapshot.accounts.filter((a) => a.providerId === target.providerId && a.healthy);
    let isFreeProvider = accounts.length === 0;
    if (isFreeProvider) {
      isFreeProvider = input.snapshot.providerCredentialKinds?.get(target.providerId) === "none";
    }
    if (input.isAccountEligible) accounts = accounts.filter((a) => input.isAccountEligible!(a.accountId, target));
    accounts.sort((a, b) => a.priority - b.priority || a.accountId.localeCompare(b.accountId));
    if (affinityStr) {
      const grouped = new Map<number, typeof accounts>();
      for (const a of accounts) { const g = grouped.get(a.priority) ?? []; g.push(a); grouped.set(a.priority, g); }
      accounts = [];
      for (const prio of [...grouped.keys()].sort((a, b) => a - b)) {
        const group = grouped.get(prio)!;
        accounts.push(...orderByRendezvous(affinityStr, group, (x) => x.accountId));
      }
    }
    if (isFreeProvider) {
      // Free tier: no account needed, direct to provider with accountId: null
      for (let pi = 0; pi < proxyCount; pi += 1) {
        const proxy = proxies[pi] ?? null;
        const id = `${target.providerId}/${target.modelId}::direct::${proxy?.id ?? "direct"}`;
        candidates.push({ id, target, accountId: null, proxyId: proxy?.id ?? null, providerId: target.providerId, modelId: target.modelId, priority: 0 });
        if (candidates.length >= MAX_CANDIDATES) break;
      }
    } else {
    for (const acc of accounts) {
      for (let pi = 0; pi < proxyCount; pi += 1) {
        const proxy = proxies[pi] ?? null;
        const id = `${target.providerId}/${target.modelId}::${acc.accountId}::${proxy?.id ?? "direct"}`;
        candidates.push({
          id,
          target,
          accountId: acc.accountId,
          proxyId: proxy?.id ?? null,
          providerId: target.providerId,
          modelId: target.modelId,
          priority: acc.priority,
        });
        if (candidates.length >= MAX_CANDIDATES) break;
      }
        if (candidates.length >= MAX_CANDIDATES) break;
      }
    }
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  const plan: ProxyRoutePlan = {
    candidates: Object.freeze([...candidates]),
    diagnostics: Object.freeze([...diagnostics]),
    snapshotRevision: input.snapshot.revision,
    requestedModel: input.rawRequestedModel ?? input.requestedModel,
    mappedModel: input.mappedModel ?? input.requestedModel,
    sourceSurface: input.sourceSurface,
    webSearchPassthrough: undefined,
    unsupportedReason: undefined,
    failureCode: undefined,
  };
  if (input.isAccountEligible === undefined) {
    let plans = routePlanCache.get(input.snapshot);
    if (plans === undefined) {
      plans = new Map();
      routePlanCache.set(input.snapshot, plans);
    }
    if (plans.size >= 256) {
      const oldest = plans.keys().next().value as string | undefined;
      if (oldest !== undefined) plans.delete(oldest);
    }
    plans.set(cacheKey, plan);
    routePlanCacheStores += 1;
  }
  return plan;
}

export function buildRequestSnapshotBase(snapshot: RoutingSnapshot): RoutingSnapshot {
  return snapshot;
}

export const RouteInternals = {
  resolveTargets,
  orderedProxies,
  rendezvousScore,
  orderByRendezvous,
  affinityKeyString,
  resolveAliasChain,
  expandComboMembers,
  MAX_ALIAS_DEPTH,
  MAX_CANDIDATES,
};

export interface ResolvedModel {
  readonly providerId: string;
  readonly modelId: string;
}

export type ComboStrategy = "fallback" | "round-robin";

export interface ComboDefinitionCompat {
  readonly id: string;
  readonly models: readonly string[];
  readonly strategy: ComboStrategy;
  readonly stickyLimit?: number | null;
}

export interface ModelReferenceConfig {
  readonly prefixes: ReadonlyMap<string, string>;
  readonly aliases: ReadonlyMap<string, string>;
  readonly combos: ReadonlyMap<string, ComboDefinitionCompat>;
}

export type ModelReferenceParseResult =
  | { readonly kind: "qualified"; readonly providerId: string; readonly modelId: string }
  | { readonly kind: "unqualified" }
  | { readonly kind: "invalid"; readonly reason: string };

export type ModelResolutionDiagnosticCode = "cycle" | "max_depth" | "empty_combo" | "unresolved_member" | "unknown_reference";

export interface ModelResolutionDiagnostic {
  readonly code: ModelResolutionDiagnosticCode;
  readonly message: string;
  readonly reference: string;
}

export type ChainResult =
  | { readonly kind: "qualified"; readonly model: ResolvedModel }
  | { readonly kind: "combo"; readonly candidates: readonly ResolvedModel[]; readonly diagnostics?: readonly ModelResolutionDiagnostic[] }
  | { readonly kind: "unresolved" };

export interface ModelChainResolution {
  readonly result: ChainResult;
  readonly diagnostics: readonly ModelResolutionDiagnostic[];
}

export const MAX_MODEL_CHAIN_DEPTH = MAX_ALIAS_DEPTH;

const MAX_MODEL_DIAGNOSTICS = 32;

export function parseModelReference(
  model: string,
  prefixes: ReadonlyMap<string, string>,
): ModelReferenceParseResult {
  const slash = model.indexOf("/");
  if (slash <= 0) return { kind: "unqualified" };
  const prefix = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  if (modelId.length === 0) return { kind: "invalid", reason: "empty model id" };
  const providerId = prefixes.get(prefix);
  if (providerId === undefined) return { kind: "unqualified" };
  return { kind: "qualified", providerId, modelId };
}

export function resolveAlias(name: string, aliases: ReadonlyMap<string, string>): string | null {
  return aliases.get(name) ?? null;
}

function deduplicateDiagnostics(diagnostics: readonly ModelResolutionDiagnostic[]): readonly ModelResolutionDiagnostic[] {
  const seen = new Set<string>();
  const out: ModelResolutionDiagnostic[] = [];
  for (const d of diagnostics) {
    const key = `${d.code}:${d.reference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
    if (out.length >= MAX_MODEL_DIAGNOSTICS) break;
  }
  return out;
}

export function expandComboWithDiagnostics(
  combo: ComboDefinitionCompat,
  resolveMember: (modelName: string) => ChainResult | ModelChainResolution,
  affinityKey: AffinityKey | null,
): { readonly candidates: readonly ResolvedModel[]; readonly diagnostics: readonly ModelResolutionDiagnostic[] } {
  const candidates: ResolvedModel[] = [];
  const diagnostics: ModelResolutionDiagnostic[] = [];
  const seen = new Set<string>();
  for (const raw of combo.models) {
    const resolved = resolveMember(raw);
    const chain: ChainResult = (resolved as ModelChainResolution).result !== undefined ? (resolved as ModelChainResolution).result : (resolved as ChainResult);
    const extra = (resolved as ModelChainResolution).diagnostics ?? [];
    for (const d of extra) if (diagnostics.length < MAX_MODEL_DIAGNOSTICS) diagnostics.push(d);
    if (chain.kind === "qualified") {
      const key = `${chain.model.providerId}/${chain.model.modelId}`;
      if (!seen.has(key)) { seen.add(key); candidates.push(chain.model); }
    } else if (chain.kind === "combo") {
      for (const m of chain.candidates) {
        const key = `${m.providerId}/${m.modelId}`;
        if (!seen.has(key)) { seen.add(key); candidates.push(m); }
      }
      for (const d of chain.diagnostics ?? []) if (diagnostics.length < MAX_MODEL_DIAGNOSTICS) diagnostics.push(d);
    } else {
      if (diagnostics.length < MAX_MODEL_DIAGNOSTICS) diagnostics.push({ code: "unresolved_member", message: `unresolved combo member ${raw}`, reference: raw });
    }
  }
  if (candidates.length === 0 && diagnostics.length < MAX_MODEL_DIAGNOSTICS) {
    diagnostics.push({ code: "empty_combo", message: `combo ${combo.id} has no resolvable members`, reference: combo.id });
  }
  // Preserve deterministic ordering; when affinityKey is present, rendezvous applies inside route plan but for metadata we keep insertion order.
  void affinityKey;
  return { candidates: Object.freeze([...candidates]), diagnostics: Object.freeze(deduplicateDiagnostics(diagnostics)) };
}

export function expandCombo(
  combo: ComboDefinitionCompat,
  resolveMember: (modelName: string) => ChainResult,
  affinityKey: AffinityKey | null,
): readonly ResolvedModel[] {
  return expandComboWithDiagnostics(combo, resolveMember, affinityKey).candidates;
}

export function resolveModelChainWithDiagnostics(
  rawModel: string,
  config: ModelReferenceConfig,
  affinityKey: AffinityKey | null = null,
): ModelChainResolution {
  const diagnostics: ModelResolutionDiagnostic[] = [];
  let cur = rawModel;
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth += 1) {
    if (config.combos.has(cur)) {
      const combo = config.combos.get(cur)!;
      const result = expandComboWithDiagnostics(combo, (m) => resolveModelChainWithDiagnostics(m, config, affinityKey).result, affinityKey);
      for (const d of result.diagnostics) if (diagnostics.length < MAX_MODEL_DIAGNOSTICS) diagnostics.push(d);
      if (result.candidates.length > 0) {
        return { result: { kind: "combo", candidates: result.candidates, diagnostics: [...diagnostics] }, diagnostics: Object.freeze([...diagnostics]) };
      }
      return { result: { kind: "unresolved" }, diagnostics: Object.freeze([...diagnostics]) };
    }
    const next = config.aliases.get(cur);
    if (next === undefined) break;
    if (seen.has(cur)) {
      if (diagnostics.length < MAX_MODEL_DIAGNOSTICS) diagnostics.push({ code: "cycle", message: `alias cycle at ${cur}`, reference: cur });
      return { result: { kind: "unresolved" }, diagnostics: Object.freeze([...diagnostics]) };
    }
    seen.add(cur);
    cur = next;
  }
  if (seen.size >= MAX_ALIAS_DEPTH && diagnostics.length < MAX_MODEL_DIAGNOSTICS) {
    diagnostics.push({ code: "max_depth", message: `alias depth exceeded for ${rawModel}`, reference: rawModel });
  }
  const parsed = parseModelReference(cur, config.prefixes);
  if (parsed.kind === "qualified") {
    return { result: { kind: "qualified", model: { providerId: parsed.providerId, modelId: parsed.modelId } }, diagnostics: Object.freeze([...diagnostics]) };
  }
  if (parsed.kind === "invalid") {
    if (diagnostics.length < MAX_MODEL_DIAGNOSTICS) diagnostics.push({ code: "unknown_reference", message: parsed.reason, reference: rawModel });
    return { result: { kind: "unresolved" }, diagnostics: Object.freeze([...diagnostics]) };
  }
  if (diagnostics.length < MAX_MODEL_DIAGNOSTICS) diagnostics.push({ code: "unknown_reference", message: `unknown model ${rawModel}`, reference: rawModel });
  return { result: { kind: "unresolved" }, diagnostics: Object.freeze([...diagnostics]) };
}

export function resolveModelChain(
  rawModel: string,
  config: ModelReferenceConfig,
  affinityKey: AffinityKey | null = null,
): ChainResult {
  return resolveModelChainWithDiagnostics(rawModel, config, affinityKey).result;
}

// Additional affinity/proxy ordering helpers required by Req 6
export type SelectionReason = "preferred" | "sticky" | "round_robin" | "least_loaded" | "usage_headroom" | "fallback";

export interface SelectionDecision {
  readonly candidateId: string;
  readonly reason: SelectionReason;
  readonly affinityKey: AffinityKey | null;
}

export interface SelectionDecisionInput {
  readonly candidateId: string;
  readonly reason: SelectionReason;
  readonly affinityKey?: AffinityKey | null;
}

export function createSelectionDecision(input: SelectionDecisionInput): SelectionDecision {
  return { candidateId: input.candidateId, reason: input.reason, affinityKey: input.affinityKey ?? null };
}

/**
 * Configuration for a bounded route session state store.
 *
 * Values kept by this store are provider-owned references only. Callers MUST
 * keep prompts, credentials, raw request/response bodies, and other secrets
 * outside the value passed to the store.
 */
export interface RouteSessionStateStoreOptions {
  /** Maximum number of live route entries retained by the store. */
  readonly maxEntries: number;
  /** Idle lifetime in milliseconds; zero expires entries on the next operation. */
  readonly idleTtlMs: number;
  /** Clock used by the store; injectable to make eviction deterministic in tests. */
  readonly now?: () => number;
}

/** Read-only test/diagnostic view of one bounded route session entry. */
export interface RouteSessionStateInspection<T> {
  readonly key: string;
  readonly value: T;
  readonly lastTouchedAtMs: number;
}

type RouteSessionStateEntry<T> = {
  value: T;
  lastTouchedAtMs: number;
  touchOrder: number;
};

type RouteSessionStateReset<T> = string | ((entry: RouteSessionStateInspection<T>) => boolean);

/**
 * In-process bounded state keyed by a caller-supplied route identity.
 *
 * The store expires idle entries before every operation, refreshes recency on
 * get/create/update/touch, and evicts the oldest idle entry at the hard cap.
 * Keys are opaque to the store so callers can compose route affinity,
 * provider, and upstream model identity without this utility knowing provider
 * details.
 */
export class RouteSessionStateStore<T> {
  private readonly entries = new Map<string, RouteSessionStateEntry<T>>();
  private readonly now: () => number;
  private nextTouchOrder = 0;

  constructor(private readonly options: RouteSessionStateStoreOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError("Route session state maxEntries must be a positive integer");
    }
    if (!Number.isFinite(options.idleTtlMs) || options.idleTtlMs < 0) {
      throw new RangeError("Route session state idleTtlMs must be a finite non-negative number");
    }
    this.now = options.now ?? Date.now;
  }

  /** Number of non-expired route entries currently retained. */
  get size(): number {
    const now = this.readNow();
    this.evictExpired(now);
    return this.entries.size;
  }

  /**
   * Returns and touches a state reference, or undefined when the key is absent
   * or its idle lifetime has elapsed.
   */
  get(key: string): T | undefined {
    const now = this.readNow();
    this.evictExpired(now);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.touchEntry(key, entry, now);
    return entry.value;
  }

  /** Returns true when a non-expired entry exists, without exposing its value. */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Returns an existing touched state or creates and stores a new typed state
   * reference. The factory is called only when the key is absent.
   */
  create(key: string, factory: () => T): T {
    const now = this.readNow();
    this.evictExpired(now);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.touchEntry(key, existing, now);
      return existing.value;
    }
    const value = factory();
    this.evictForInsert(now);
    this.entries.set(key, { value, lastTouchedAtMs: now, touchOrder: this.nextTouchOrder++ });
    return value;
  }

  /** Alias for callers that prefer an explicit get-or-create name. */
  getOrCreate(key: string, factory: () => T): T {
    return this.create(key, factory);
  }

  /**
   * Updates an existing state reference and touches it. Missing or expired
   * keys return undefined and are never implicitly created.
   */
  update(key: string, update: T | ((current: T) => T)): T | undefined {
    const now = this.readNow();
    this.evictExpired(now);
    const existing = this.entries.get(key);
    if (existing === undefined) return undefined;
    const value = typeof update === "function"
      ? (update as (current: T) => T)(existing.value)
      : update;
    existing.value = value;
    this.touchEntry(key, existing, now);
    return value;
  }

  /** Touches an existing entry without exposing or replacing its value. */
  touch(key: string): boolean {
    const now = this.readNow();
    this.evictExpired(now);
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.touchEntry(key, entry, now);
    return true;
  }

  /** Deletes one route entry and reports whether an entry was removed. */
  delete(key: string): boolean {
    this.evictExpired(this.readNow());
    return this.entries.delete(key);
  }

  /**
   * Explicitly resets one key, all keys, or entries matching a predicate.
   * Returns the number of removed entries so integrations can assert reset
   * behavior without exposing provider payloads.
   */
  reset(selection?: RouteSessionStateReset<T>): number {
    this.evictExpired(this.readNow());
    if (selection === undefined) {
      const removed = this.entries.size;
      this.entries.clear();
      return removed;
    }
    if (typeof selection === "string") return this.entries.delete(selection) ? 1 : 0;
    let removed = 0;
    for (const [key, entry] of this.entries) {
      const inspection: RouteSessionStateInspection<T> = {
        key,
        value: entry.value,
        lastTouchedAtMs: entry.lastTouchedAtMs,
      };
      if (selection(inspection)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Returns a stable oldest-to-newest inspection snapshot for focused tests.
   * The values are typed references; this method never serializes or clones
   * provider state.
   */
  inspect(): readonly RouteSessionStateInspection<T>[] {
    this.evictExpired(this.readNow());
    return Array.from(this.entries, ([key, entry]) => ({
      key,
      value: entry.value,
      lastTouchedAtMs: entry.lastTouchedAtMs,
    }));
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError("Route session state clock must return a finite number");
    return now;
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now >= entry.lastTouchedAtMs && now - entry.lastTouchedAtMs >= this.options.idleTtlMs) {
        this.entries.delete(key);
      }
    }
  }

  private evictForInsert(now: number): void {
    this.evictExpired(now);
    while (this.entries.size >= this.options.maxEntries) {
      let oldestKey: string | undefined;
      let oldest: RouteSessionStateEntry<T> | undefined;
      for (const [key, entry] of this.entries) {
        if (oldest === undefined || entry.lastTouchedAtMs < oldest.lastTouchedAtMs || (entry.lastTouchedAtMs === oldest.lastTouchedAtMs && entry.touchOrder < oldest.touchOrder)) {
          oldestKey = key;
          oldest = entry;
        }
      }
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  private touchEntry(key: string, entry: RouteSessionStateEntry<T>, now: number): void {
    entry.lastTouchedAtMs = now;
    entry.touchOrder = this.nextTouchOrder++;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
}
