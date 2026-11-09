import type { Elysia } from "elysia";
import { errorResponse, jsonResponse } from "../../api/errors.js";
import { toResponse } from "../../api/guard.js";
import { buildConsoleSessionCookie } from "../../api/guard.js";
import type { ConsoleDependencies } from "../api.js";
import type { ConsoleServiceResult } from "../../api/guard.js";

export function registerAuthUnauthRoutes(app: Elysia, deps: ConsoleDependencies): void {
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/login",
    async ({ request, set, cookie }: any /* Elysia ctx */) => {
      const result = await deps.services.auth.login(request as Request);
      if (!result.ok) return toResponse(result);
      const token = (result.data as Record<string, unknown>)?.token;
      if (typeof token === "string" && token) {
        const headers = new Headers();
        headers.set("Set-Cookie", buildConsoleSessionCookie(token, request as Request));
        if (set) set.headers = headers;
        return jsonResponse(result.data, { status: result.status, headers });
      }
      return toResponse(result);
    },
  );

  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/setup/status",
    async () => {
      if (deps.services.setup) return jsonResponse(await deps.services.setup.status());
      return jsonResponse({ initialized: true });
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/setup",
    async ({ request }: any /* Elysia ctx */) => {
      if (!deps.services.setup) return errorResponse(404, "model_not_found", "setup not available");
      const result = await deps.services.setup.setup(request as Request);
      if (!result.ok) return toResponse(result);
      const token = (result.data as Record<string, unknown>)?.token;
      if (typeof token === "string" && token) {
        const headers = new Headers();
        headers.set("Set-Cookie", buildConsoleSessionCookie(token, request as Request));
        return jsonResponse(result.data, { status: result.status, headers });
      }
      return toResponse(result);
    },
  );
}

export function registerAuthRoutes(app: Elysia, deps: ConsoleDependencies): void {
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/logout",
    async ({ request }: any /* Elysia ctx */) => toResponse(await deps.services.auth.logout(request as Request)),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/session",
    async ({ request }: any /* Elysia ctx */) => toResponse(await deps.services.auth.session(request as Request)),
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/settings/password",
    async ({ body, request }: any /* Elysia ctx */) => {
      const v = (body ?? {}) as Record<string, unknown>;
      return toResponse(
        await (
          deps.services.auth.changePassword as unknown as (
            a: unknown,
            b: unknown,
            c: unknown,
            r: Request,
          ) => Promise<ConsoleServiceResult>
        )(v.currentPassword, v.newPassword, v.confirmPassword, request as Request),
      );
    },
  );
}
