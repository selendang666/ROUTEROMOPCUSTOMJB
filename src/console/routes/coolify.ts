/**
 * Coolify monitoring console routes — mounts the monitoring dashboard API
 * on the existing console router (`/console/api/coolify/*`).
 *
 * Session guard is inherited from `createConsoleRouter`; every handler only
 * needs to check the optional `coolify` service port (501 when unwired,
 * e.g. persistence unavailable) and forward to `toResponse`.
 */

import type { Elysia } from "elysia";
import { errorResponse, jsonResponse } from "../../api/errors.js";
import { toResponse } from "../../api/guard.js";
import type { ConsoleDependencies } from "../api.js";

/**
 * Register Coolify monitoring endpoints on the console app.
 *
 * @param app - Console Elysia instance.
 * @param deps - Console dependencies (uses `services.coolify` when present).
 */
export function registerCoolifyRoutes(app: Elysia, deps: ConsoleDependencies): void {
  type Ctx = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Elysia ctx
  const post = (app as unknown as { post: (path: string, handler: (ctx: Ctx) => unknown) => unknown }).post.bind(app);
  const get = (app as unknown as { get: (path: string, handler: (ctx: Ctx) => unknown) => unknown }).get.bind(app);
  const patch = (app as unknown as { patch: (path: string, handler: (ctx: Ctx) => unknown) => unknown }).patch.bind(app);
  const remove = (app as unknown as { delete: (path: string, handler: (ctx: Ctx) => unknown) => unknown }).delete.bind(app);

  const service = () => deps.services.coolify;
  const unavailable = () => errorResponse(501, "capability_unsupported", "Coolify monitoring is unavailable");

  get("/console/api/coolify/connections", async () => {
    const svc = service();
    if (svc === undefined) return unavailable();
    return toResponse(await svc.list());
  });

  post("/console/api/coolify/connections", async ({ body }: Ctx) => {
    const svc = service();
    if (svc === undefined) return unavailable();
    return toResponse(await svc.create(body));
  });

  patch("/console/api/coolify/connections/:id", async ({ params, body }: Ctx) => {
    const svc = service();
    if (svc === undefined) return unavailable();
    return toResponse(await svc.update((params as { id: string }).id, body));
  });

  remove("/console/api/coolify/connections/:id", async ({ params }: Ctx) => {
    const svc = service();
    if (svc === undefined) return unavailable();
    return toResponse(await svc.remove((params as { id: string }).id));
  });

  post("/console/api/coolify/test", async ({ body }: Ctx) => {
    const svc = service();
    if (svc === undefined) return unavailable();
    return toResponse(await svc.test(body));
  });

  const withConnection = async (params: unknown, run: (svc: NonNullable<ReturnType<typeof service>>, id: string) => Promise<unknown>) => {
    const svc = service();
    if (svc === undefined) return unavailable();
    return run(svc, (params as { id: string }).id);
  };

  get("/console/api/coolify/connections/:id/overview", async ({ params }: Ctx) =>
    withConnection(params, async (svc, id) => toResponse(await svc.overview(id))),
  );

  get("/console/api/coolify/connections/:id/projects", async ({ params }: Ctx) =>
    withConnection(params, async (svc, id) => toResponse(await svc.projects(id))),
  );

  // Project detail — opened when a deployed project is clicked.
  get("/console/api/coolify/connections/:id/projects/:uuid", async ({ params }: Ctx) => {
    const svc = service();
    if (svc === undefined) return unavailable();
    const p = params as { id: string; uuid: string };
    return toResponse(await svc.projectDetail(p.id, decodeURIComponent(p.uuid)));
  });

  get("/console/api/coolify/connections/:id/applications", async ({ params }: Ctx) =>
    withConnection(params, async (svc, id) => toResponse(await svc.applications(id))),
  );

  get("/console/api/coolify/connections/:id/applications/:uuid", async ({ params }: Ctx) => {
    const svc = service();
    if (svc === undefined) return unavailable();
    const p = params as { id: string; uuid: string };
    return toResponse(await svc.applicationDetail(p.id, decodeURIComponent(p.uuid)));
  });

  get("/console/api/coolify/connections/:id/services", async ({ params }: Ctx) =>
    withConnection(params, async (svc, id) => toResponse(await svc.services(id))),
  );

  get("/console/api/coolify/connections/:id/servers", async ({ params }: Ctx) =>
    withConnection(params, async (svc, id) => toResponse(await svc.servers(id))),
  );

  get("/console/api/coolify/connections/:id/deployments", async ({ params }: Ctx) =>
    withConnection(params, async (svc, id) => toResponse(await svc.deployments(id))),
  );

  get("/console/api/coolify/health", async () => {
    const svc = service();
    if (svc === undefined) return unavailable();
    return jsonResponse({ ok: true, service: "coolify" });
  });
}
