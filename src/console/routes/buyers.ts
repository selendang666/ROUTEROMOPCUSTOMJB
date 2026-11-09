import type { Elysia } from "elysia";
import { errorResponse, jsonResponse } from "../../api/errors.js";
import { toResponse } from "../../api/guard.js";
import type { ConsoleDependencies } from "../api.js";
import type { BuyerCreateInput } from "../services/buyers.js";

/**
 * Registers buyer management console routes. Additive only: buyer lifecycle
 * delegates to the existing api-keys service, persistence lives in the new
 * `buyers` table.
 * @param app - Elysia application to register routes on.
 * @param deps - Console dependencies (pool + services).
 */
export function registerBuyersRoutes(app: Elysia, deps: ConsoleDependencies): void {
  const buyers = () => deps.services.buyers;

  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/buyers",
    async () => jsonResponse(await buyers().list()),
  );

  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/buyers/:id",
    async ({ params }: any /* Elysia ctx */) => {
      const item = await buyers().get((params as { id: string }).id);
      if (item === null) return errorResponse(404, "model_not_found", "buyer not found");
      return jsonResponse(item);
    },
  );

  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/buyers",
    async ({ body }: any /* Elysia ctx */) => toResponse(await buyers().create((body ?? {}) as BuyerCreateInput)),
  );

  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/buyers/:id/revoke",
    async ({ params }: any /* Elysia ctx */) => toResponse(await buyers().revoke((params as { id: string }).id)),
  );

  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/buyers/:id/renew",
    async ({ params, body }: any /* Elysia ctx */) => {
      const days = (body as Record<string, unknown> | null)?.expiresInDays;
      return toResponse(await buyers().renew((params as { id: string }).id, typeof days === "number" ? days : undefined));
    },
  );

  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/buyers/:id/share",
    async ({ params }: any /* Elysia ctx */) => toResponse(await buyers().share((params as { id: string }).id)),
  );
}
