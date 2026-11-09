import type { Elysia } from "elysia";
import { builtinProviderDefinitions } from "../../providers/registry.js";
import { errorResponse, jsonResponse } from "../../api/errors.js";
import { toResponse } from "../../api/guard.js";
import type { ConsolePorts, ConsoleServiceResult } from "../../api/guard.js";
import type { ConsoleDependencies } from "../api.js";
import { OAuthSessionError, type OAuthLoginSessionManager, type OAuthLoginSessionView } from "../../auth/login-session.js";
import { defaultRedirectUriForProvider, registerOAuthCallback } from "../../auth/callback-server.js";

function oauthErrorResponse(error: unknown): Response {
  if (!(error instanceof OAuthSessionError)) return errorResponse(502, "provider_unavailable", "OAuth provider request failed.");
  if (error.kind === "not_found") return errorResponse(404, "model_not_found", error.message);
  if (error.kind === "authorization_denied") return errorResponse(error.status, "authentication_failed", error.message);
  if (error.kind === "driver_unavailable") return errorResponse(501, "capability_unsupported", error.message);
  return errorResponse(error.status, "invalid_request", error.message);
}

async function persistOAuthAccount(
  manager: OAuthLoginSessionManager,
  accounts: ConsolePorts["accounts"],
  sessionId: string,
): Promise<OAuthLoginSessionView | null> {
  const view = manager.get(sessionId);
  if (view === null || view.status !== "completed" || view.accountId !== null) return view;
  const tokenSet = manager.getTokenSet(sessionId);
  if (tokenSet === null) return view;
  const result = await accounts.create({
    provider: view.providerId,
    name: view.name,
    credentialKind: "oauth",
    credential: JSON.stringify(tokenSet),
    credentialHint: tokenSet.email ?? tokenSet.providerAccountId ?? "",
  });
  if (!result.ok) throw new OAuthSessionError("invalid_request", result.message ?? "OAuth account persistence failed.", result.status);
  const accountId =
    result.data !== undefined && typeof result.data === "object" && result.data !== null && "id" in result.data
      ? (result.data as { id?: unknown }).id
      : null;
  if (typeof accountId !== "string" || !manager.attachAccountId(sessionId, accountId)) {
    throw new OAuthSessionError("invalid_request", "OAuth account persistence returned no account id.", 502);
  }
  return manager.get(sessionId);
}

export function registerAccountRoutes(app: Elysia, deps: ConsoleDependencies): void {
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/accounts",
    async ({ request }: any /* Elysia ctx */) => {
      const url = new URL((request as Request).url);
      const provider = url.searchParams.get("provider");
      const limitValue = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(limitValue) ? Math.min(Math.max(Math.floor(limitValue), 1), 100) : 50;
      const cursor = url.searchParams.get("cursor");
      try {
        return jsonResponse(await deps.services.accounts.list({ provider, limit, cursor }));
      } catch {
        return errorResponse(400, "invalid_request", "invalid account cursor");
      }
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/accounts",
    async ({ body }: any /* Elysia ctx */) => toResponse(await deps.services.accounts.create(body)),
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/accounts/batch",
    async ({ body }: any /* Elysia ctx */) => {
      const v = (body ?? {}) as Record<string, unknown>;
      const provider = typeof v.provider === "string" ? v.provider : undefined;
      const items = Array.isArray(v.items) ? v.items : Array.isArray(v) ? v : [];
      let created = 0;
      let skipped = 0;
      for (const item of items.slice(0, 500)) {
        const merged = {
          ...(item as Record<string, unknown>),
          ...(provider !== undefined && (item as Record<string, unknown>).provider === undefined ? { provider } : {}),
        } as Record<string, unknown>;
        const r = await deps.services.accounts.create(merged);
        const ok = (r as { ok?: boolean })?.ok !== false;
        if (ok) created += 1;
        else skipped += 1;
      }
      return jsonResponse({ created, skipped });
    },
  );
  (app as unknown as { patch: (path: string, handler: (ctx: unknown) => unknown) => unknown }).patch(
    "/console/api/accounts/:id",
    async ({ params, body }: any /* Elysia ctx */) => toResponse(await deps.services.accounts.update((params as { id: string }).id, body)),
  );
  (app as unknown as { delete: (path: string, handler: (ctx: unknown) => unknown) => unknown }).delete(
    "/console/api/accounts/:id",
    async ({ params }: any /* Elysia ctx */) => toResponse(await deps.services.accounts.remove((params as { id: string }).id)),
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/accounts/:id/oauth/start",
    async ({ params, body }: any /* Elysia ctx */) => toResponse(await deps.services.accounts.oauthStart((params as { id: string }).id, body)),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/accounts/oauth/callback",
    async ({ request }: any /* Elysia ctx */) => toResponse(await deps.services.accounts.oauthCallback(request as Request)),
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/providers/:id/oauth/start",
    async ({ params, body }: any /* Elysia ctx */) => {
      const provider = (params as { id: string }).id;
      const builtin = builtinProviderDefinitions().find((d) => d.id === provider);
      const custom = builtin === undefined ? await deps.services.providers.get(provider) : null;
      const exists = builtin !== undefined || custom !== null;
      if (!exists) return errorResponse(404, "model_not_found", `provider ${provider} not found`);
      const providerDetails = builtin === undefined ? custom : await deps.services.providers.get(provider);
      const providerRecord =
        providerDetails !== null && typeof providerDetails === "object" && !Array.isArray(providerDetails)
          ? (providerDetails as Record<string, unknown>)
          : null;
      const providerKinds = Array.isArray(providerRecord?.credentialKinds) ? providerRecord.credentialKinds : [];
      const supportsOAuth =
        builtin?.access === "oauth" || providerRecord?.credentialKind === "oauth" || providerKinds.includes("oauth");
      if (!supportsOAuth) return errorResponse(400, "invalid_request", `provider ${provider} does not advertise OAuth`);
      const mgr = deps.services.oauth;
      if (!mgr) return errorResponse(501, "capability_unsupported", `OAuth not configured for provider ${provider}`);
      const v = (body ?? {}) as Record<string, unknown>;
      const flow = v.flow === "device" ? "device" : "browser";
      const name =
        typeof v.name === "string" && v.name.length > 0 ? v.name.trim().slice(0, 128) : `${provider}-${Date.now().toString(36)}`;
      try {
        const scopes = Array.isArray(v.scopes)
          ? v.scopes.filter((scope): scope is string => typeof scope === "string")
          : undefined;
        const redirectUri =
          typeof v.redirectUri === "string" && v.redirectUri.length > 0 ? v.redirectUri : defaultRedirectUriForProvider(provider);
        const result = await mgr.start({ providerId: provider, name, flow, scopes, redirectUri });
        if (redirectUri !== undefined && result.flow !== "device") {
          registerOAuthCallback(provider, result.sessionId, result.state, mgr, async (sessionId, input) => {
            await mgr.complete(sessionId, input);
            await persistOAuthAccount(mgr, deps.services.accounts, sessionId);
          });
        }
        return jsonResponse({
          sessionId: result.sessionId,
          provider: result.providerId,
          status: result.status,
          authorizationUrl: result.authorizationUrl,
          state: result.state,
          redirectUri: result.redirectUri,
          expiresAt: result.expiresAtMs,
          flow: result.flow,
          userCode: result.userCode,
          verificationUri: result.verificationUri,
          intervalSeconds: result.intervalSeconds,
        });
      } catch (error) {
        return oauthErrorResponse(error);
      }
    },
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/oauth/sessions/:sessionId",
    async ({ params }: any /* Elysia ctx */) => {
      const sid = (params as { sessionId: string }).sessionId;
      const mgr = deps.services.oauth;
      if (!mgr) return errorResponse(501, "capability_unsupported", "OAuth sessions not configured");
      try {
        const view = await mgr.poll(sid);
        if (view === null) return errorResponse(404, "model_not_found", "oauth session not found");
        return jsonResponse((await persistOAuthAccount(mgr, deps.services.accounts, sid)) ?? view);
      } catch (error) {
        return oauthErrorResponse(error);
      }
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/oauth/sessions/:sessionId/complete",
    async ({ params, body }: any /* Elysia ctx */) => {
      const sid = (params as { sessionId: string }).sessionId;
      const mgr = deps.services.oauth;
      if (!mgr) return errorResponse(501, "capability_unsupported", "OAuth not configured");
      try {
        const input = (body ?? {}) as unknown as Parameters<typeof mgr.complete>[1];
        await mgr.complete(sid, input);
        const view = await persistOAuthAccount(mgr, deps.services.accounts, sid);
        return view === null ? errorResponse(404, "model_not_found", "oauth session not found") : jsonResponse(view);
      } catch (error) {
        return oauthErrorResponse(error);
      }
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/oauth/sessions/:sessionId/cancel",
    async ({ params }: any /* Elysia ctx */) => {
      const sid = (params as { sessionId: string }).sessionId;
      const mgr = deps.services.oauth;
      if (!mgr) return errorResponse(501, "capability_unsupported", "OAuth not configured");
      if (mgr.get(sid) === null || !mgr.cancel(sid)) return errorResponse(404, "model_not_found", "oauth session not found");
      return jsonResponse(mgr.get(sid));
    },
  );
  (app as unknown as { patch: (path: string, handler: (ctx: unknown) => unknown) => unknown }).patch(
    "/console/api/accounts/batch",
    async ({ body }: any /* Elysia ctx */) => {
      const maybe = (
        deps.services.accounts as unknown as { batchUpdate?: (b: unknown) => Promise<ConsoleServiceResult> }
      ).batchUpdate;
      if (typeof maybe === "function") return toResponse(await maybe.call(deps.services.accounts, body));
      return errorResponse(501, "capability_unsupported", "bulk account update not configured");
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/accounts/batch-delete",
    async ({ body }: any /* Elysia ctx */) => {
      const maybe = (
        deps.services.accounts as unknown as { batchDelete?: (b: unknown) => Promise<ConsoleServiceResult> }
      ).batchDelete;
      if (typeof maybe === "function") return toResponse(await maybe.call(deps.services.accounts, body));
      return errorResponse(501, "capability_unsupported", "bulk account delete not configured");
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/quota/refresh",
    async ({ body }: any /* Elysia ctx */) => {
      const maybe = (
        deps.services.accounts as unknown as { quotaRefreshBulk?: (b: unknown) => Promise<ConsoleServiceResult> }
      ).quotaRefreshBulk;
      if (typeof maybe === "function") return toResponse(await maybe.call(deps.services.accounts, body));
      return errorResponse(501, "capability_unsupported", "bulk quota refresh not configured");
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/oauth/refresh",
    async ({ body }: any /* Elysia ctx */) => {
      const maybe = (
        deps.services.accounts as unknown as { oauthRefresh?: (b: unknown) => Promise<ConsoleServiceResult> }
      ).oauthRefresh;
      if (typeof maybe === "function") return toResponse(await maybe.call(deps.services.accounts, body));
      return errorResponse(501, "capability_unsupported", "OAuth refresh not configured");
    },
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/accounts/:id/quota",
    async ({ params }: any /* Elysia ctx */) => {
      const id = (params as { id: string }).id;
      const maybe = (deps.services.accounts as unknown as { quota?: (id: string) => Promise<unknown> }).quota;
      if (typeof maybe === "function") {
        const data = await maybe.call(deps.services.accounts, id);
        if (data === null || data === undefined) return errorResponse(404, "model_not_found", `account ${id} not found or quota unavailable`);
        return jsonResponse(data);
      }
      return errorResponse(501, "capability_unsupported", "quota query not configured for this account");
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/accounts/:id/quota/refresh",
    async ({ params }: any /* Elysia ctx */) => toResponse(await deps.services.accounts.quotaRefresh((params as { id: string }).id)),
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/accounts/:id/validate",
    async ({ params }: any /* Elysia ctx */) => toResponse(await deps.services.accounts.validateApiKey((params as { id: string }).id)),
  );
}
