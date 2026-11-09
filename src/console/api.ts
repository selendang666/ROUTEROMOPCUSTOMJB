import { Elysia } from "elysia";
import { guard, createBannedIpGuard, createRateLimitGuard } from "../api/guard.js";
import type { ConsolePorts, ConsoleServiceResult } from "../api/guard.js";
import type { PostgresPool } from "../persistence/pool.js";
import {
  wireguardProcesses,
  getWireguardPoolEnabled,
  setWireguardPoolEnabled,
} from "./wireguard-helpers.js";
import { registerAuthUnauthRoutes, registerAuthRoutes } from "./routes/auth.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerBuyersRoutes } from "./routes/buyers.js";
import { registerCoolifyRoutes } from "./routes/coolify.js";
import { registerWireguardRoutes } from "./routes/wireguard.js";
import { registerPersonaRoutes } from "./routes/persona.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerPlaygroundRoutes } from "./routes/playground.js";
import type { ProxyRequestPort } from "../api/v1.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { RouteSnapshot } from "../persistence/types.js";

export type { ConsolePorts, ConsoleServiceResult };

export interface ConsoleDependencies {
  readonly services: ConsolePorts;
  readonly pool?: PostgresPool;
  readonly proxy?: ProxyRequestPort;
  readonly registry?: ProviderRegistry;
  readonly routeRepositories?: {
    readonly getRouteSnapshot: () => Promise<RouteSnapshot>;
  };
}

export function createConsoleRouter(deps: ConsoleDependencies): Elysia {
  const app = new Elysia() as unknown as Elysia;
  if (deps.pool) {
    void (async () => {
      try {
        const settings = (await deps.pool!`SELECT enabled FROM wireguard_pool_settings WHERE id=true`) as unknown as Array<{ enabled: boolean }>;
        setWireguardPoolEnabled(settings[0]?.enabled === true);
        if (!getWireguardPoolEnabled()) return;
        const tunnels = (await deps.pool!`SELECT proxy_id, config_path FROM wireguard_tunnels WHERE enabled=true`) as unknown as Array<{
          proxy_id: string | null;
          config_path: string;
        }>;
        const wireproxyBin = Bun.env.WIREPROXY_BIN?.trim() || "./bin/wireproxy.exe";
        for (const t of tunnels) {
          if (!t.proxy_id || wireguardProcesses.has(t.proxy_id)) continue;
          const f = Bun.file(t.config_path);
          if (!(await f.exists())) continue;
          try {
            const proc = Bun.spawn([wireproxyBin, "-c", t.config_path], { stdout: "ignore", stderr: "pipe" });
            wireguardProcesses.set(t.proxy_id, proc);
            await deps.services.proxies.update(t.proxy_id, { active: true });
            await deps.pool!`UPDATE wireguard_tunnels SET runtime_status='running', last_error=NULL, updated_at=now() WHERE proxy_id=${t.proxy_id}`;
            void proc.exited.then(async () => {
              wireguardProcesses.delete(t.proxy_id!);
              await deps.services.proxies.update(t.proxy_id!, { active: false });
              await deps.pool!`UPDATE wireguard_tunnels SET runtime_status='failed', last_error='wireproxy process exited', updated_at=now() WHERE proxy_id=${t.proxy_id}`;
            });
          } catch {}
        }
      } catch {}
    })();
  }
  const check = guard(deps.services);
  (app as unknown as { beforeHandle: (fn: (ctx: unknown) => unknown) => unknown }).beforeHandle(createBannedIpGuard(deps.services));
  (app as unknown as { beforeHandle: (fn: (ctx: unknown) => unknown) => unknown }).beforeHandle(createRateLimitGuard(deps.services));

  registerAuthUnauthRoutes(app, deps);

  (app as unknown as { beforeHandle: (fn: (ctx: unknown) => unknown) => unknown }).beforeHandle(async ({ request, set }: any /* Elysia ctx */) => {
    const maybe = await check(request as Request);
    if (maybe !== null) {
      set.status = maybe.status;
      return maybe;
    }
  });

  registerAuthRoutes(app, deps);
  registerProviderRoutes(app, deps);
  registerAccountRoutes(app, deps);
  registerCatalogRoutes(app, deps);
  registerBuyersRoutes(app, deps);
  registerCoolifyRoutes(app, deps);
  registerWireguardRoutes(app, deps);
  registerPersonaRoutes(app, deps);
  registerSystemRoutes(app, deps);
  registerPlaygroundRoutes(app, deps);

  return app;
}

export function registerConsoleRoutes(app: Elysia, deps: ConsoleDependencies): Elysia {
  const router = createConsoleRouter(deps);
  app.use(router as unknown as Parameters<Elysia["use"]>[0]);
  return app;
}
