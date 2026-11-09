/**
 * Routing domain — route targets, snapshots, candidates, ports
 * Manual write
 */

import type { Surface, RouteScope, RouteStatus } from "./surface.js";
import type { CredentialKind } from "./surface.js";
import type { ProviderModelMeta, ModelContextLimits } from "./provider.js";
import type { RtkConfig } from "./content.js";
import type { CliModelMappingSnapshot } from "../routing/mapping.js";

export interface RouteTarget {
  readonly providerId: string;
  readonly modelId: string;
  readonly surface: string;
  readonly upstreamModelId?: string;
  readonly contextWindowTokens?: number | null;
}

export interface ProxyCandidate {
  readonly id: string;
  readonly url?: string;
  readonly healthy: boolean;
}

export interface RouteHealth {
  readonly status: RouteStatus;
  readonly retryAt: string | null;
  readonly statusCode?: number | null;
  readonly failureKind?: string | null;
  readonly safeMessage?: string | null;
  readonly occurredAt?: string | null;
  readonly scope?: RouteScope;
}

export interface ModelLockRecord {
  readonly accountId: string;
  readonly modelId: string;
  readonly retryAt: string;
  readonly errorKind?: string | null;
  readonly statusCode?: number | null;
  readonly safeMessage?: string | null;
  readonly failureCount?: number;
}

export interface AccountCandidate {
  readonly id: string;
  readonly accountId: string;
  readonly providerId: string;
  readonly credentialKind: CredentialKind;
  readonly healthy: boolean;
  readonly health: RouteHealth | null;
  readonly enabled: boolean;
  readonly quotaAvailable: boolean;
  readonly modelLocks: ReadonlyMap<string, ModelLockRecord> | null;
  readonly priority: number;
}

export type WebSearchRouteKind = "native" | "codex" | "antigravity" | "exa" | "passthrough";

export interface RouteCandidate {
  readonly id: string;
  readonly target: RouteTarget;
  readonly accountId: string | null;
  readonly proxyId: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly priority: number;
  readonly affinityScore?: number;
  readonly searchRoute?: WebSearchRouteKind;
}

export interface ProxyRoutePlan {
  readonly candidates: readonly RouteCandidate[];
  readonly diagnostics: readonly RoutePlanDiagnostic[];
  readonly snapshotRevision: number;
  readonly requestedModel?: string;
  readonly mappedModel?: string;
  readonly sourceSurface?: import("./surface.js").Surface;
  readonly webSearchPassthrough?: boolean;
  readonly unsupportedReason?: string;
  readonly failureCode?: "model_not_found" | "ambiguous_model" | "capability_unsupported";
}

export interface RoutePlanDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly reference?: string;
}

export interface RequiredRouteCapabilities {
  readonly tools: boolean;
  readonly hostedSearch: boolean;
  readonly reasoning: boolean;
  readonly image: boolean;
  readonly pdf: boolean;
  readonly video: boolean;
  readonly responseFormat: "text" | "json_object" | "json_schema";
  readonly stream: boolean;
  readonly sourceSurface: import("./surface.js").Surface;
}

export interface AffinityKey {
  readonly namespace: string;
  readonly value: string;
}

export interface RoutingSnapshot {
  readonly revision: number;
  readonly createdAt: string;
  readonly aliases: ReadonlyMap<string, string>;
  readonly combos: ReadonlyMap<string, { readonly members: readonly string[]; readonly strategy: "fallback" | "round-robin" }>;
  readonly providerPrefixes: ReadonlyMap<string, string>;
  readonly proxies: readonly ProxyCandidate[];
  readonly accounts: readonly AccountCandidate[];
  readonly models: readonly ProviderModelMeta[];
  readonly ponytailEnabled: boolean;
  readonly rtkConfig: RtkConfig | null;
  readonly providerCredentialKinds?: ReadonlyMap<string, CredentialKind>;
  readonly cliModelMappings?: ReadonlyMap<string, CliModelMappingSnapshot>;
}

export interface LeaseHandle {
  readonly kind: "account" | "proxy" | "provider";
  readonly id: string;
  readonly acquiredAt: number;
  release(): Promise<void>;
  readonly released: boolean;
}

export interface CommitGate {
  readonly committed: boolean;
  commit(): boolean;
  readonly canRetry: boolean;
}

export interface RouteHealthStore {
  readHealth(scope: RouteScope, routeId: string): Promise<RouteHealth | null>;
  writeHealth(scope: RouteScope, routeId: string, health: RouteHealth): Promise<void>;
  clearHealth(scope: RouteScope, routeId: string): Promise<void>;
}

export interface RouteSwitch {
  readonly scope: RouteScope | "provider" | null;
  readonly from: string | null;
  readonly to: string;
  readonly reason: string;
  readonly previousRouteId?: string | null;
  readonly replacementRouteId?: string | null;
  readonly occurredAt?: string;
}

export type ProxyEndpoint = "/v1/chat/completions" | "/v1/messages" | "/v1/responses" | "/v1/responses/compact" | "/v1/models";
