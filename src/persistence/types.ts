// Persistence DTO types
// Extracted from store.ts - verbatim copy
// verbatimModuleSyntax: type-only imports

import type { CredentialKind, RouteStatus } from "../proxy/types/surface.js";
import type { PonytailPolicy, RtkConfig } from "../proxy/types/content.js";
import type { TelemetryRow } from "./telemetry/store/interface.js";
import type { InferSelectModel } from "drizzle-orm";
import type { modelAliases, settings } from "./schema/pg.js";

export interface MigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationStatus {
  readonly currentVersion: number | null;
  readonly expectedVersion: number;
  readonly applied: readonly MigrationRecord[];
  readonly pending: readonly { version: number; name: string; checksum: string }[];
  readonly ok: boolean;
  readonly error?: string;
}

export interface GlobalPersonaPolicy {
  readonly enabled?: boolean;
  readonly name?: string;
  readonly version?: string;
  readonly content?: string;
  readonly soul?: string;
  readonly extras?: number;
  readonly updatedAt?: string;
  readonly hermesSyncedAt?: string | null;
}

export type SettingsJson = Record<string, unknown> & {
  readonly ponytailEnabled?: boolean;
  readonly rtkConfig?: RtkConfig | null;
  readonly ponytailPolicy?: PonytailPolicy | null;
  readonly globalPersona?: GlobalPersonaPolicy | null;
};

export type SettingsRow = Omit<InferSelectModel<typeof settings>, "settingsJson"> & {
  readonly settingsJson: SettingsJson;
};

export interface ApiKeyPublic {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly active: boolean;
  readonly rateLimitRpm: number | null;
  readonly dailyTokenLimit: number | null;
  readonly monthlyTokenLimit: number | null;
  readonly oneTimeTokenLimit: number | null;
  readonly oneTimeTokensUsed: number;
  readonly maxConcurrentRequests: number | null;
  readonly providerAllowlist: string | null;
  readonly modelAllowlist: string | null;
  readonly modelDenylist: string | null;
  readonly disableRemoteMapping?: boolean;
  readonly quoteBigText?: string | null;
  readonly quoteSubText?: string | null;
  readonly quoteBody?: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

// ---------------------------------------------------------------------------
// Provider accounts — aligned with canonical AccountCandidate
// DB column `provider` maps to canonical `providerId`; `id` maps to `accountId`.
// Both database and canonical names are populated; canonical is authoritative.
// credentialKind is the strict CredentialKind union, not a loose string.
// Upcoming canonical AccountCandidate shape adds: healthy, health: RouteHealth|null, enabled,
// quotaAvailable, modelLocks. Persistence row retains DB authority + health map join;
// port layer can synthesize those health fields from accountHealth/modelLocks maps.
// ---------------------------------------------------------------------------
export interface ProviderAccountPublic {
  readonly id: string;
  readonly accountId: string;
  readonly provider: string;
  readonly providerId: string;
  readonly name: string;
  readonly credentialKind: CredentialKind;
  readonly credentialHint: string;
  readonly priority: number;
  readonly active: boolean;
  readonly enabled: boolean;
  // Canonical health/availability — derived from active + health tables
  readonly healthy: boolean;
  readonly health?: { readonly status: RouteStatus; readonly retryAt: string | null; readonly statusCode?: number | null } | null;
  readonly quotaAvailable?: boolean | null;
  readonly modelLocks?: ReadonlyMap<string, { readonly retryAt: string; readonly reason?: string | null }> | null;
  readonly cooldownUntil: string | null;
  readonly cooldownLevel: number;
  readonly consecutiveUseCount: number;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// Row as stored — same shape as public for PostgreSQL
export type ProviderAccountRow = ProviderAccountPublic;

// ---------------------------------------------------------------------------
// Provider models — aligned with canonical ProviderModelMeta / RouteTarget
// `provider` (DB) == `providerId` (canonical). Row retains only PostgreSQL
// columns; capability mapping (pdf/video via ProviderCaps) is derived in
// application layer, not stored as image-generation operation fields.
// Canonical RouteTarget adds surface + upstreamModelId; row provides base
// providerId/modelId and source for that derivation.
// ---------------------------------------------------------------------------
export interface ProviderModelRow {
  readonly provider: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly upstreamModelId?: string;
  readonly enabled: boolean;
  readonly source: string;
  readonly displayName?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AliasRow = InferSelectModel<typeof modelAliases>;

export interface ComboRow {
  readonly id: string;
  readonly name: string;
  readonly models: readonly string[];
  /** Canonical alias for models — combo members */
  readonly members?: readonly string[];
  readonly strategy: string;
  readonly stickyLimit: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProxyRow {
  readonly id: string;
  readonly name: string;
  readonly protocol: "http" | "https" | "socks5";
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly maxConcurrency: number;
  readonly priority: number;
  readonly weight: number;
  readonly active: boolean;
  readonly cooldownUntil: string | null;
  readonly cooldownLevel: number;
  readonly consecutiveUseCount: number;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AccessRuleRow {
  readonly scope: string;
  readonly mode: string;
  readonly entries: readonly unknown[];
  readonly updatedAt: string;
}

export interface ConsoleSessionRow {
  readonly id: string;
  readonly tokenHash: string;
  readonly data: Record<string, unknown>;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface AccountHealthRow {
  readonly accountId: string;
  readonly status: RouteStatus;
  readonly errorKind: string | null;
  readonly statusCode: number | null;
  readonly safeMessage: string | null;
  readonly occurredAt: string | null;
  readonly retryAt: string | null;
  readonly updatedAt: string;
}

export interface ModelLockRow {
  readonly accountId: string;
  readonly modelId: string;
  readonly retryAt: string;
  readonly errorKind: string | null;
  readonly statusCode: number | null;
  readonly safeMessage: string | null;
  readonly failureCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RouteSnapshot {
  readonly accounts: readonly ProviderAccountPublic[];
  readonly accountHealth: ReadonlyMap<string, AccountHealthRow>;
  readonly modelLocks: readonly ModelLockRow[];
  readonly models: readonly ProviderModelRow[];
  readonly aliases: readonly AliasRow[];
  readonly combos: readonly ComboRow[];
  readonly proxies: readonly ProxyRow[];
  readonly proxyHealth: ReadonlyMap<string, AccountHealthRow>;
  readonly cliModelMappings?: ReadonlyMap<string, { readonly enabled: boolean; readonly entries: readonly { readonly sourceModel: string; readonly targetModel: string; readonly enabled: boolean }[]; readonly allowedApiKeyIds?: readonly string[] }>;
}

export const CURRENT_BACKUP_VERSION = 2;

export interface BackupPayload {
  readonly app: "ohmyomop-router";
  readonly version: number;
  readonly exportedAt: string;
  readonly tables: Record<string, unknown>;
  readonly history?: {
    readonly requestEvents: ReadonlyArray<TelemetryRow>;
  };
}

export interface IpBanRecord {
  readonly ip: string;
  readonly reason: string;
  readonly failedAttempts: number;
  readonly banStartedAt: string;
  readonly banExpiresAt: string;
}

export interface FilterRuleRecord {
  readonly id: number;
  readonly ruleId: string;
  readonly pattern: string;
  readonly replacement: string;
  readonly isActive: boolean;
  readonly isRegex: boolean;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
