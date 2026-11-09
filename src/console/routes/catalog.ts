import type { Elysia } from "elysia";
import { errorResponse, jsonResponse } from "../../api/errors.js";
import { toResponse } from "../../api/guard.js";
import type { ConsoleDependencies } from "../api.js";
import type { ConsoleServiceResult } from "../../api/guard.js";

export function registerCatalogRoutes(app: Elysia, deps: ConsoleDependencies): void {
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/models",
    async () => jsonResponse(await deps.services.models.list()),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/models/aliases",
    async () => jsonResponse(await deps.services.models.aliases.list()),
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/models/aliases",
    async ({ body }: any /* Elysia ctx */) => toResponse(await deps.services.models.aliases.create(body)),
  );
  (app as unknown as { patch: (path: string, handler: (ctx: unknown) => unknown) => unknown }).patch(
    "/console/api/models/aliases/:id",
    async ({ params, body }: any /* Elysia ctx */) => {
      const maybe = (
        deps.services.models.aliases as unknown as { patch?: (id: string, b: unknown) => Promise<ConsoleServiceResult> }
      ).patch;
      if (typeof maybe === "function") return toResponse(await maybe.call(deps.services.models.aliases, (params as { id: string }).id, body));
      return errorResponse(501, "capability_unsupported", "alias update not configured");
    },
  );
  (app as unknown as { delete: (path: string, handler: (ctx: unknown) => unknown) => unknown }).delete(
    "/console/api/models/aliases/:id",
    async ({ params }: any /* Elysia ctx */) => toResponse(await deps.services.models.aliases.remove((params as { id: string }).id)),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/models/combos",
    async () => jsonResponse(await deps.services.models.combos.list()),
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/models/combos",
    async ({ body }: any /* Elysia ctx */) => toResponse(await deps.services.models.combos.create(body)),
  );
  (app as unknown as { patch: (path: string, handler: (ctx: unknown) => unknown) => unknown }).patch(
    "/console/api/models/combos/:id",
    async ({ params, body }: any /* Elysia ctx */) => toResponse(await deps.services.models.combos.patch((params as { id: string }).id, body)),
  );
  (app as unknown as { delete: (path: string, handler: (ctx: unknown) => unknown) => unknown }).delete(
    "/console/api/models/combos/:id",
    async ({ params }: any /* Elysia ctx */) => toResponse(await deps.services.models.combos.remove((params as { id: string }).id)),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/routes",
    async () => jsonResponse(await deps.services.accessRules.list()),
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/routes",
    async ({ body }: any /* Elysia ctx */) => toResponse(await deps.services.accessRules.create(body)),
  );
  (app as unknown as { patch: (path: string, handler: (ctx: unknown) => unknown) => unknown }).patch(
    "/console/api/routes/:id",
    async ({ params, body }: any /* Elysia ctx */) => toResponse(await deps.services.accessRules.update((params as { id: string }).id, body)),
  );
  (app as unknown as { delete: (path: string, handler: (ctx: unknown) => unknown) => unknown }).delete(
    "/console/api/routes/:id",
    async ({ params }: any /* Elysia ctx */) => toResponse(await deps.services.accessRules.remove((params as { id: string }).id)),
  );

  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/keys",
    async () => jsonResponse(await deps.services.apiKeys.list()),
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/keys",
    async ({ body }: any /* Elysia ctx */) => toResponse(await deps.services.apiKeys.create(body)),
  );
  (app as unknown as { patch: (path: string, handler: (ctx: unknown) => unknown) => unknown }).patch(
    "/console/api/keys/:id",
    async ({ params, body }: any /* Elysia ctx */) => toResponse(await deps.services.apiKeys.update((params as { id: string }).id, body)),
  );
  (app as unknown as { delete: (path: string, handler: (ctx: unknown) => unknown) => unknown }).delete(
    "/console/api/keys/:id",
    async ({ params }: any /* Elysia ctx */) => {
      const services = deps.services.apiKeys as typeof deps.services.apiKeys & {
        remove?: (id: string) => Promise<ConsoleServiceResult>;
      };
      const remove = services.remove ?? services.revoke;
      return toResponse(await remove.call(services, (params as { id: string }).id));
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/keys/:id/share",
    async ({ params, body }: any /* Elysia ctx */) => {
      const id = (params as { id: string }).id;
      const maybe = (
        deps.services.apiKeys as unknown as {
          share?: (id: string, options?: { kind?: "monitor" | "setup"; expiresAt?: string | null }) => Promise<ConsoleServiceResult>;
        }
      ).share;
      if (typeof maybe === "function") {
        const value = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
        const kind = value.kind === "setup" ? "setup" : "monitor";
        const expiresAt = value.expiresAt === null || typeof value.expiresAt === "string" ? value.expiresAt : null;
        return toResponse(await maybe.call(deps.services.apiKeys, id, { kind, expiresAt }));
      }
      return errorResponse(501, "capability_unsupported", "key share not configured");
    },
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/keys/:id/credential",
    async ({ params }: any /* Elysia ctx */) => {
      const maybe = (deps.services.apiKeys as unknown as { credential?: (id: string) => Promise<unknown> })?.credential;
      if (typeof maybe === "function") {
        const data = await maybe.call(deps.services.apiKeys, (params as { id: string }).id);
        if (data === null || data === undefined)
          return errorResponse(404, "model_not_found", `api key ${(params as { id: string }).id} not found`);
        return jsonResponse(data);
      }
      return errorResponse(404, "model_not_found", "credential not available");
    },
  );

  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/proxies",
    async ({ request }: any /* Elysia ctx */) => {
      const url = new URL((request as Request).url);
      const raw = (await deps.services.proxies.list()) as unknown as Array<Record<string, unknown>>;
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const limitRaw = url.searchParams.get("limit");
      let items: Array<Record<string, unknown>> = raw;
      if (q) items = items.filter((p) => String(p.host ?? p.name ?? p.id ?? "").toLowerCase().includes(q));
      if (limitRaw !== null) {
        const n = Number(limitRaw);
        const limit = Number.isFinite(n) ? Math.max(0, Math.min(1000, Math.floor(n))) : items.length;
        items = items.slice(0, limit);
      }
      return jsonResponse({ items });
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/proxies",
    async ({ body }: any /* Elysia ctx */) => toResponse(await deps.services.proxies.create(body)),
  );
  (app as unknown as { patch: (path: string, handler: (ctx: unknown) => unknown) => unknown }).patch(
    "/console/api/proxies/:id",
    async ({ params, body }: any /* Elysia ctx */) => toResponse(await deps.services.proxies.update((params as { id: string }).id, body)),
  );
  (app as unknown as { delete: (path: string, handler: (ctx: unknown) => unknown) => unknown }).delete(
    "/console/api/proxies/:id",
    async ({ params }: any /* Elysia ctx */) => toResponse(await deps.services.proxies.remove((params as { id: string }).id)),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/proxies/health",
    async () => jsonResponse(await deps.services.proxies.health()),
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/proxies/test",
    async ({ body }: any /* Elysia ctx */) => {
      const maybe = (deps.services.proxies as unknown as { test?: (b: unknown) => Promise<ConsoleServiceResult> }).test;
      if (typeof maybe === "function") return toResponse(await maybe.call(deps.services.proxies, body));
      return errorResponse(501, "capability_unsupported", "proxy test not configured");
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/proxies/:id/test",
    async ({ params, body }: any /* Elysia ctx */) => {
      const id = (params as { id: string }).id;
      const maybeOne = (
        deps.services.proxies as unknown as { testOne?: (id: string, b: unknown) => Promise<ConsoleServiceResult> }
      ).testOne;
      if (typeof maybeOne === "function") return toResponse(await maybeOne.call(deps.services.proxies, id, body));
      const maybe = (deps.services.proxies as unknown as { test?: (b: unknown) => Promise<ConsoleServiceResult> }).test;
      if (typeof maybe === "function" && body !== undefined) return toResponse(await maybe.call(deps.services.proxies, body));
      return errorResponse(501, "capability_unsupported", `proxy ${id} test not configured`);
    },
  );

  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/settings",
    async () => jsonResponse(await deps.services.settings.get()),
  );
  (app as unknown as { patch: (path: string, handler: (ctx: unknown) => unknown) => unknown }).patch(
    "/console/api/settings",
    async ({ body }: any /* Elysia ctx */) => jsonResponse(await deps.services.settings.patch(body)),
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/settings/reset-all",
    async ({ body }: any /* Elysia ctx */) => {
      const maybe = (
        deps.services.settings as unknown as { resetAll?: (b: unknown) => Promise<ConsoleServiceResult> }
      ).resetAll;
      if (typeof maybe === "function") return toResponse(await maybe.call(deps.services.settings, body));
      return errorResponse(501, "capability_unsupported", "settings reset-all not configured");
    },
  );
}
