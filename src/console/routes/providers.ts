import type { Elysia } from "elysia";
import { builtinProviderDefinitions } from "../../providers/registry.js";
import { errorResponse, jsonResponse } from "../../api/errors.js";
import { toResponse } from "../../api/guard.js";
import type { ConsoleDependencies } from "../api.js";
import type { ConsoleServiceResult } from "../../api/guard.js";

export function registerProviderRoutes(app: Elysia, deps: ConsoleDependencies): void {
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/providers",
    async () => {
      const custom = (await deps.services.providers.list()) as unknown as Array<Record<string, unknown>>;
      const builtins =
        typeof deps.services.providers.listBuiltins === "function"
          ? ((await deps.services.providers.listBuiltins()) as Array<Record<string, unknown>>)
          : builtinProviderDefinitions().map((definition) => ({
              id: definition.id,
              name: definition.displayName,
              displayName: definition.displayName,
              icon: definition.id,
              prefix: definition.id,
              authKind: definition.access === "oauth" ? "oauth" : "api-key",
              credentialKind: definition.access,
              credentialKinds: [definition.access],
              modelCount: 0,
              capabilityCounts: { chat: 0, media: 0, websearch: 0 },
              enabled: true,
              configured: false,
              connections: 0,
            }));
      return jsonResponse({ items: [...builtins.map((provider) => ({ ...provider, source: "builtin" as const })), ...custom.map((provider) => ({ ...provider, source: "custom" as const }))] });
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/providers",
    async ({ body }: any /* Elysia ctx */) => toResponse(await deps.services.providers.create(body)),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/providers/:id",
    async ({ params }: any /* Elysia ctx */) => {
      const id = (params as { id: string }).id;
      const custom = await deps.services.providers.get(id);
      if (custom) return jsonResponse(custom);
      const builtin = builtinProviderDefinitions().find((d) => d.id === id);
      if (builtin) return jsonResponse(builtin);
      return errorResponse(404, "model_not_found", `provider ${id} not found`);
    },
  );
  (app as unknown as { patch: (path: string, handler: (ctx: unknown) => unknown) => unknown }).patch(
    "/console/api/providers/:id",
    async ({ params, body }: any /* Elysia ctx */) => toResponse(await deps.services.providers.update((params as { id: string }).id, body)),
  );
  (app as unknown as { delete: (path: string, handler: (ctx: unknown) => unknown) => unknown }).delete(
    "/console/api/providers/:id",
    async ({ params }: any /* Elysia ctx */) => toResponse(await deps.services.providers.remove((params as { id: string }).id)),
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/providers/:id/models/fetch",
    async ({ params }: any /* Elysia ctx */) => {
      const id = (params as { id: string }).id;
      const maybe = (
        deps.services.providers as unknown as { fetchModels?: (id: string) => Promise<ConsoleServiceResult> }
      ).fetchModels;
      if (typeof maybe === "function") return toResponse(await maybe.call(deps.services.providers, id));
      return errorResponse(501, "capability_unsupported", "model discovery not configured for this provider");
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/providers/:id/health",
    async ({ params }: any /* Elysia ctx */) => {
      const id = (params as { id: string }).id;
      const maybe = (deps.services.providers as unknown as { health?: (id: string) => Promise<ConsoleServiceResult> }).health;
      if (typeof maybe === "function") return toResponse(await maybe.call(deps.services.providers, id));
      return errorResponse(501, "capability_unsupported", "health check not configured for this provider");
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/providers/:id/models",
    async ({ params, body }: any /* Elysia ctx */) => {
      const id = (params as { id: string }).id;
      const maybe = (
        deps.services.providers as unknown as { createModel?: (pid: string, b: unknown) => Promise<ConsoleServiceResult> }
      ).createModel;
      if (typeof maybe === "function") return toResponse(await maybe.call(deps.services.providers, id, body));
      return errorResponse(501, "capability_unsupported", "provider model creation not configured");
    },
  );
  (app as unknown as { patch: (path: string, handler: (ctx: unknown) => unknown) => unknown }).patch(
    "/console/api/providers/:id/models/enabled",
    async ({ params, body }: any /* Elysia ctx */) => {
      const providerId = (params as { id: string }).id;
      const maybe = (
        deps.services.providers as unknown as { setAllModelsEnabled?: (pid: string, b: unknown) => Promise<ConsoleServiceResult> }
      ).setAllModelsEnabled;
      if (typeof maybe === "function") return toResponse(await maybe.call(deps.services.providers, providerId, body));
      return errorResponse(501, "capability_unsupported", "provider model update not configured");
    },
  );
  (app as unknown as { patch: (path: string, handler: (ctx: unknown) => unknown) => unknown }).patch(
    "/console/api/providers/:id/models/:modelId",
    async ({ params, body }: any /* Elysia ctx */) => {
      const providerId = (params as { id: string }).id;
      const raw = params as Record<string, unknown>;
      const modelId =
        typeof raw["modelId"] === "string"
          ? String(raw["modelId"])
          : typeof raw["model_id"] === "string"
            ? String(raw["model_id"])
            : "";
      const decoded = (() => {
        try {
          return decodeURIComponent(modelId);
        } catch {
          return modelId;
        }
      })();
      const maybe = (
        deps.services.providers as unknown as { setModelEnabled?: (pid: string, mid: string, b: unknown) => Promise<ConsoleServiceResult> }
      ).setModelEnabled;
      if (typeof maybe === "function") return toResponse(await maybe.call(deps.services.providers, providerId, decoded, body));
      return errorResponse(501, "capability_unsupported", "provider model update not configured");
    },
  );
  (app as unknown as { delete: (path: string, handler: (ctx: unknown) => unknown) => unknown }).delete(
    "/console/api/providers/:id/models/:modelId",
    async ({ params }: any /* Elysia ctx */) => {
      const providerId = (params as { id: string }).id;
      const raw = params as Record<string, unknown>;
      const modelId =
        typeof raw["modelId"] === "string"
          ? String(raw["modelId"])
          : typeof raw["model_id"] === "string"
            ? String(raw["model_id"])
            : "";
      const decoded = decodeURIComponent(modelId);
      const maybe = (
        deps.services.providers as unknown as { deleteModel?: (pid: string, mid: string) => Promise<ConsoleServiceResult> }
      ).deleteModel;
      if (typeof maybe === "function") return toResponse(await maybe.call(deps.services.providers, providerId, decoded));
      return errorResponse(501, "capability_unsupported", "provider model deletion not configured");
    },
  );
}
