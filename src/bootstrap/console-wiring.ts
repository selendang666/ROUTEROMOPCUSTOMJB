import type { ConsoleDependencies } from "../console/api.js";
import { createAccountsService } from "../console/services/accounts.js";
import { createAuthServices } from "../console/services/auth.js";
import { createBackupService } from "../console/services/backup.js";
import { createDiagnosticsService } from "../console/services/diagnostics.js";
import { createFilterRulesService } from "../console/services/filter-rules.js";
import { createModelsService } from "../console/services/models.js";
import { createObservabilityService } from "../console/services/observability.js";
import { createProvidersService } from "../console/services/providers.js";
import { createProxiesService } from "../console/services/proxy-pool.js";
import { createRoutesService } from "../console/services/access-rules.js";
import { createSettingsService } from "../console/services/console-settings.js";
import type { TelemetryPipeline } from "../persistence/telemetry/pipeline.js";
import type { PostgresPool } from "../persistence/pool.js";
import { createIpBanRepository, createRateLimitRepository } from "../persistence/repositories/security.js";
import type { QuotaRuntime } from "./quota.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { createAuthDriverRegistry } from "../auth/driver-registry.js";
import { OAuthLoginSessionManager } from "../auth/login-session.js";
import { createProbeService } from "../console/services/probe.js";
import { createBuyersService } from "../console/services/buyers.js";
import { createCoolifyService } from "../console/services/coolify.js";
import { createPersonaService } from "../console/services/persona.js";
import { refreshPrivacySnapshot } from "../runtime/privacy.js";
import { refreshPersonaSnapshot } from "../persona/snapshot.js";

export interface ConsoleWiringDependencies {
  readonly pool: PostgresPool;
  readonly telemetry: TelemetryPipeline;
  readonly coordination: { readonly mode: "redis" | "local"; readonly degraded: () => boolean };
  readonly quota: QuotaRuntime;
  readonly consoleApiKeys: ConsoleDependencies["services"]["apiKeys"];
  readonly cliTools: ConsoleDependencies["services"]["cliTools"];
  readonly ipBan: ReturnType<typeof createIpBanRepository>;
  readonly rateLimit: ReturnType<typeof createRateLimitRepository>;
  readonly clientIpForBan: (request: Request) => string | null;
  readonly onRouteMutation: () => void;
  readonly getAccountCredential: (accountId: string) => Promise<string | null>;
  readonly registry: ProviderRegistry;
}

export function createConsoleServices(deps: ConsoleWiringDependencies): ConsoleDependencies["services"] {
  const auth = createAuthServices(deps.pool, deps.ipBan, deps.clientIpForBan);
  const authDrivers = createAuthDriverRegistry();
  const oauth = new OAuthLoginSessionManager({ drivers: authDrivers });
  const observability = createObservabilityService(deps.pool, deps.telemetry);
  const diagnostics = createDiagnosticsService(deps.pool, deps.telemetry, deps.coordination);
  const accounts = createAccountsService(deps.pool, deps.quota.refreshAccountQuota, deps.onRouteMutation, deps.registry, deps.getAccountCredential, deps.quota.refreshOAuthAccount, (accountId) => deps.quota.state.get(accountId), (accountIds) => deps.quota.state.listForAccountIds([...accountIds]));
  const probe = createProbeService(deps.registry, deps.getAccountCredential, deps.pool, deps.telemetry);

  return {
    session: auth.session,
    oauth,
    auth: auth.auth,
    setup: auth.setup,
    providers: createProvidersService(deps.pool, deps.registry, deps.getAccountCredential, authDrivers),
    accounts,
    models: createModelsService(deps.pool, deps.onRouteMutation),
    accessRules: createRoutesService(deps.pool),
    apiKeys: deps.consoleApiKeys,
    buyers: createBuyersService(deps.pool, deps.consoleApiKeys),
    coolify: createCoolifyService(deps.pool),
    proxies: createProxiesService(deps.pool, deps.onRouteMutation),
    settings: createSettingsService(deps.pool, () => {
      void refreshPrivacySnapshot(deps.pool);
      void refreshPersonaSnapshot(deps.pool);
    }),
    backup: createBackupService(deps.pool, deps.telemetry),
    logs: observability.logs,
    usage: observability.usage,
    ips: observability.ips,
    diagnostics: diagnostics.diagnostics,
    overview: diagnostics.overview,
    filterRules: createFilterRulesService(deps.pool),
    persona: createPersonaService(deps.pool),
    cliTools: deps.cliTools,
    ipBan: deps.ipBan,
    rateLimit: deps.rateLimit,
    payloads: { get: (id: string) => deps.telemetry.getPayload(id) },
    retention: { run: () => deps.telemetry.retain() },
    probe,
  };
}
