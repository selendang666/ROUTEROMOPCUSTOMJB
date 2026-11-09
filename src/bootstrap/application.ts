import { Elysia } from "elysia";
import { createPublicRouter, type PublicDependencies } from "../api/v1.js";
import { applySecurityHeaders } from "../api/errors.js";
import { createConsoleRouter, type ConsoleDependencies } from "../console/api.js";
import { createShareRouter } from "../api/share.js";
import { clientIpForBan } from "../api/guard.js";
import type { PostgresPool } from "../persistence/pool.js";
import type { TelemetryPipeline } from "../persistence/telemetry/pipeline.js";
import { getOverheadSnapshot, overheadPrometheus } from "../runtime/overhead.js";
import type { RuntimeConfig } from "../runtime/runtime.js";
import type { RouteSnapshot } from "../persistence/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { createMontanaApiKeyPort } from "../api/montana-auth.js";
import { serveDashboardRequest } from "./dashboard-static.js";

export interface RouteRepositoryPort {
  readonly getRouteSnapshot: () => Promise<RouteSnapshot>;
  readonly invalidateRouteSnapshot: () => void;
  readonly accounts: { readonly getCredential: (id: string) => Promise<string | null> };
  readonly leaseCredential?: (accountId: string) => Promise<{ readonly secret: string; readonly release: () => Promise<void> }>;
}

export interface PersistencePorts {
  readonly pool: PostgresPool;
  readonly telemetry: TelemetryPipeline;
  readonly ipBan: import("../persistence/repositories/security.js").IpBanRepositoryShape;
  readonly rateLimit: import("../persistence/repositories/security.js").RateLimitRepositoryShape;
  readonly close: () => Promise<void> | void;
  readonly readiness: () => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
  readonly apiKeys: PublicDependencies["apiKeys"];
  readonly models: PublicDependencies["models"];
  readonly console: ConsoleDependencies["services"];
  readonly coordination: {
    readonly kind: "redis" | "local";
    readonly degraded: () => boolean;
    readonly close?: () => Promise<void> | void;
  };
  readonly routeRepositories?: RouteRepositoryPort;
  readonly registry: ProviderRegistry;
}

export interface ApplicationPorts {
  readonly proxy: PublicDependencies["proxy"];
  readonly getClientIp?: PublicDependencies["getClientIp"];
}

export interface CreateApplicationOptions {
  readonly config: RuntimeConfig;
  readonly persistence: PersistencePorts;
  readonly application: ApplicationPorts;
}

export interface Application {
  readonly app: Elysia;
  readonly config: RuntimeConfig;
  readonly persistence: PersistencePorts;
}

export function createApplication(options: CreateApplicationOptions): Application {
  const { config, persistence, application } = options;
  const app = new Elysia({ precompile: true });
  const pool = persistence.pool;
  const ipBanRepo = persistence.ipBan;
  const rateLimitRepo = persistence.rateLimit;

  // Baseline hardening on every response. Routes that already set the security
  // headers themselves still need this pass: HSTS depends on the request scheme,
  // and the previous `has()` early-exit silently skipped those responses so HSTS
  // was never emitted on the API surface.
  (app as unknown as { afterHandle: (fn: (ctx: unknown) => unknown) => unknown }).afterHandle((ctx: unknown) => {
    const c = ctx as { response: unknown; request: unknown };
    if (!(c.response instanceof Response)) return;
    const alreadyHardened = c.response.headers.has("x-content-type-options");
    applySecurityHeaders(c.response.headers, {
      request: c.request as Request,
      noStore: !alreadyHardened,
    });
  });

  const publicDeps: PublicDependencies = {
    apiKeys: createMontanaApiKeyPort(persistence.apiKeys),
    models: persistence.models,
    proxy: application.proxy,
    readiness: persistence.readiness,
    health: application.proxy.health,
    getClientIp: application.getClientIp,
    ipBan: ipBanRepo,
    rateLimit: rateLimitRepo,
    overhead: { snapshot: getOverheadSnapshot, metrics: overheadPrometheus },
  };
  const publicRouter = createPublicRouter(publicDeps);
  (app as unknown as { use: (p: unknown) => unknown }).use(publicRouter as unknown as Parameters<Elysia["use"]>[0]);

  const consoleRouter = createConsoleRouter({
    services: persistence.console,
    pool,
    proxy: application.proxy,
    registry: persistence.registry,
    routeRepositories: persistence.routeRepositories,
  });
  (app as unknown as { use: (p: unknown) => unknown }).use(consoleRouter as unknown as Parameters<Elysia["use"]>[0]);

  const shareRouter = createShareRouter({ pool, usage: persistence.telemetry, registry: persistence.registry });
  const shareGuard = new Elysia();
  (shareGuard as unknown as { beforeHandle: (fn: (ctx: unknown) => unknown) => unknown }).beforeHandle(async ({ request, set }: any /* Elysia set */) => {
    const url = new URL((request as Request).url);
    if (!url.pathname.startsWith("/share/")) return;
    const ip = clientIpForBan(request as Request);
    if (ip !== null) {
      const banned = await ipBanRepo.isBanned(ip).catch(() => false);
      if (banned) {
        (set as any /* Elysia set */).status = 403;
        return new Response(JSON.stringify({ error: { type: "error", code: "authorization_denied", message: "IP banned", request_id: crypto.randomUUID() } }), { status: 403, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      const limit = 100;
      let count = 0;
      try {
        const r = await rateLimitRepo.touch(ip, "open", limit);
        count = r.count;
      } catch { count = 0; }
      if (count > limit) {
        (set as any /* Elysia set */).status = 429;
        return new Response(JSON.stringify({ error: { type: "error", code: "rate_limit_error", message: "Too many requests", request_id: crypto.randomUUID() } }), { status: 429, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
    }
  });
  (shareGuard as unknown as { use: (p: unknown) => unknown }).use(shareRouter as unknown as Parameters<Elysia["use"]>[0]);
  (app as unknown as { use: (p: unknown) => unknown }).use(shareGuard as unknown as Parameters<Elysia["use"]>[0]);

  (app as unknown as { all: (p: string, fn: (ctx: unknown) => Promise<Response>) => unknown }).all("/*", async ({ request }: any /* Elysia ctx */) => {
    const dashboardResponse = await serveDashboardRequest(request as Request);
    if (dashboardResponse !== null) return dashboardResponse;
    const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    applySecurityHeaders(headers, { noStore: true });
    return new Response(JSON.stringify({ error: { type: "error", code: "not_found", message: "Route not found", request_id: crypto.randomUUID() } }), { status: 404, headers });
  });

  return { app, config, persistence };
}
