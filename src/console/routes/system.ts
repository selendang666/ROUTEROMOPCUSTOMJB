import type { Elysia } from "elysia";
import { OHMYOMOP_ROUTER_VERSION } from "../../runtime/runtime.js";
import { getInFlightCount, getProviderInFlight, subscribeInFlight } from "../../runtime/in-flight.js";
import { guard } from "../../api/guard.js";
import { applySecurityHeaders, errorResponse, jsonResponse } from "../../api/errors.js";
import { toResponse } from "../../api/guard.js";
import type { ConsoleDependencies } from "../api.js";
import type { ConsoleServiceResult } from "../../api/guard.js";

export function registerSystemRoutes(app: Elysia, deps: ConsoleDependencies): void {
  const check = guard(deps.services);

  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/probe",
    async ({ body }: any /* Elysia ctx */) => {
      const maybe = (deps.services as unknown as { probe?: { test: (b: unknown) => Promise<ConsoleServiceResult> } }).probe;
      if (maybe !== undefined && typeof maybe.test === "function") return toResponse(await maybe.test(body));
      return errorResponse(501, "capability_unsupported", "model probe not configured");
    },
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/updates/release",
    async () => {
      const maybe = (deps.services as unknown as { updates?: { release: () => Promise<unknown> } }).updates;
      if (maybe !== undefined && typeof maybe.release === "function") return jsonResponse(await maybe.release());
      return errorResponse(501, "capability_unsupported", "release info not configured");
    },
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/updates/repository",
    async () => {
      const maybe = (deps.services as unknown as { updates?: { repository: () => Promise<unknown> } }).updates;
      if (maybe !== undefined && typeof maybe.repository === "function") return jsonResponse(await maybe.repository());
      return errorResponse(501, "capability_unsupported", "repository updates not configured");
    },
  );

  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/settings/backup",
    async ({ request, body }: any /* Elysia ctx */) => {
      const verified = await deps.services.backup.verifyPassword(request as Request, body);
      if (!verified.ok) return toResponse(verified);
      const url = new URL((request as Request).url);
      const raw = url.searchParams.get("includeHistory");
      let includeHistory = false;
      if (raw !== null) {
        if (raw === "true") includeHistory = true;
        else if (raw === "false") includeHistory = false;
        else return errorResponse(400, "invalid_request", "includeHistory must be true or false");
      }
      const result = (
        deps.services.backup as unknown as {
          exportStream: (opts?: { includeHistory?: boolean }) => Response | { ok: boolean; status: number; message: string };
        }
      ).exportStream({ includeHistory });
      if (result instanceof Response) return result;
      return toResponse(result as unknown as ConsoleServiceResult);
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/settings/restore",
    async ({ body }: any /* Elysia ctx */) => toResponse(await deps.services.backup.import(body)),
  );

  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/logs",
    async ({ request }: any /* Elysia ctx */) => jsonResponse(await deps.services.logs.query(new URL((request as Request).url))),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/logs/stream",
    async ({ request }: any /* Elysia ctx */) => deps.services.logs.stream(request as Request),
  );
  (app as unknown as { delete: (path: string, handler: (ctx: unknown) => unknown) => unknown }).delete(
    "/console/api/logs",
    async () => {
      const maybe = (deps.services.logs as unknown as { clear?: () => Promise<ConsoleServiceResult> }).clear;
      if (typeof maybe === "function") return toResponse(await maybe.call(deps.services.logs));
      return errorResponse(501, "capability_unsupported", "log clear not configured");
    },
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/usage",
    async ({ request }: any /* Elysia ctx */) => jsonResponse(await deps.services.usage.query(new URL((request as Request).url))),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/usage/chart",
    async ({ request }: any /* Elysia ctx */) => {
      const result = await deps.services.usage.query(new URL((request as Request).url));
      if (result !== null && typeof result === "object" && "buckets" in (result as Record<string, unknown>)) return jsonResponse(result);
      return jsonResponse(result);
    },
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/usage/by-model",
    async ({ request }: any /* Elysia ctx */) => {
      return jsonResponse(await deps.services.usage.query(new URL((request as Request).url)));
    },
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/usage/by-provider",
    async ({ request }: any /* Elysia ctx */) => {
      return jsonResponse(await deps.services.usage.query(new URL((request as Request).url)));
    },
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/usage/by-key",
    async ({ request }: any /* Elysia ctx */) => {
      return jsonResponse(await deps.services.usage.query(new URL((request as Request).url)));
    },
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/usage/cache",
    async ({ request }: any /* Elysia ctx */) => jsonResponse(await deps.services.usage.query(new URL((request as Request).url))),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/usage/summary",
    async ({ request }: any /* Elysia ctx */) => {
      return jsonResponse(await deps.services.usage.query(new URL((request as Request).url)));
    },
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/usage/requests",
    async ({ request }: any /* Elysia ctx */) => jsonResponse(await deps.services.usage.query(new URL((request as Request).url))),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/usage/requests/:id",
    async ({ params }: any /* Elysia ctx */) => {
      const id = (params as { id: string }).id;
      const detail = (
        deps.services.usage as unknown as { detail?: (id: string) => Promise<Record<string, unknown> | null> }
      ).detail;
      if (typeof detail === "function") {
        const row = await detail(id);
        if (row !== null) return jsonResponse(row);
        return errorResponse(404, "model_not_found", "request not found");
      }
      return errorResponse(404, "model_not_found", "request not found");
    },
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/health",
    async () => {
      const diag = (await deps.services.diagnostics.health()) as unknown as { ok: boolean };
      const now = Date.now();
      const uptimeSeconds = Math.floor(process.uptime());
      const startedAt = now - uptimeSeconds * 1000;
      return jsonResponse({
        status: (diag as { ok: boolean }).ok ? "ok" : "degraded",
        version: OHMYOMOP_ROUTER_VERSION,
        branch: "main",
        revision: null,
        committedAt: null,
        startedAt,
        uptimeSeconds,
        now,
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      });
    },
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/health/metrics",
    async () => jsonResponse(deps.services.diagnostics.systemMetrics()),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/ready",
    async () => jsonResponse(await deps.services.diagnostics.readiness()),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/diagnostics",
    async () => jsonResponse(await deps.services.diagnostics.health()),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/overhead",
    async () => jsonResponse(await deps.services.diagnostics.overhead()),
  );
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/metrics",
    async () =>
      new Response(deps.services.diagnostics.metrics(), {
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" },
      }),
  );

  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/ips/top",
    async ({ request }: any /* Elysia ctx */) => jsonResponse(await deps.services.ips.top(new URL((request as Request).url))),
  );

  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/live/in-flight/stream",
    async ({ request }: any /* Elysia ctx */) => {
      const encode = (event: string, value: unknown): Uint8Array => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
      let cleanup: (() => void) | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = () => {
            try {
              if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                cleanup?.();
                return;
              }
              const payload = { inFlight: getInFlightCount(), byProvider: getProviderInFlight(), maxFlightsPerIp: 15, byIp: [] };
              controller.enqueue(encode("count", payload));
            } catch {}
          };
          const off = subscribeInFlight(() => send());
          const interval = setInterval(send, 2000);
          const sig = (request as Request).signal;
          let cleaned = false;
          const cleanupStream = () => {
            if (cleaned) return;
            cleaned = true;
            clearInterval(interval);
            try {
              off();
            } catch {}
            sig?.removeEventListener("abort", cleanupStream);
            try {
              controller.close();
            } catch {}
          };
          cleanup = cleanupStream;
          if (sig) sig.addEventListener("abort", cleanupStream, { once: true });
          send();
        },
        cancel() {
          cleanup?.();
          cleanup = null;
        },
      });
      {
        const headers = new Headers({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
        applySecurityHeaders(headers, { noStore: true });
        return new Response(stream, { headers });
      }
    },
  );

  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/payloads/:id",
    async ({ params, request }: any /* Elysia ctx */) => {
      const auth = await check(request as Request);
      if (auth !== null) return auth;
      if (!deps.services.payloads) return errorResponse(501, "capability_unsupported", "payloads not configured");
      const rawParams = params as Record<string, unknown>;
      const id = typeof rawParams["id"] === "string" ? rawParams["id"] : "";
      const data = await deps.services.payloads.get(decodeURIComponent(id));
      if (data === null) return errorResponse(404, "model_not_found", "payload not found");
      return jsonResponse(data);
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/retention/run",
    async ({ request }: any /* Elysia ctx */) => {
      const auth = await check(request as Request);
      if (auth !== null) return auth;
      if (!deps.services.retention) return errorResponse(501, "capability_unsupported", "retention not configured");
      const result = await deps.services.retention.run();
      return jsonResponse(result);
    },
  );

  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/ip-bans",
    async () => {
      if (!deps.services.ipBan) return jsonResponse([]);
      return jsonResponse(await deps.services.ipBan.list());
    },
  );
  (app as unknown as { delete: (path: string, handler: (ctx: unknown) => unknown) => unknown }).delete(
    "/console/api/ip-bans/:ip",
    async ({ params }: any /* Elysia ctx */) => {
      const rawParams = params as Record<string, unknown>;
      const rawIp = typeof rawParams["ip"] === "string" ? rawParams["ip"] : "";
      const ip = decodeURIComponent(rawIp);
      if (!deps.services.ipBan) return errorResponse(404, "model_not_found", "ipBan not available");
      const ok = await deps.services.ipBan.unban(ip);
      if (!ok) return errorResponse(404, "model_not_found", `IP ${ip} not found or not banned`);
      return jsonResponse({ ok: true, ip });
    },
  );
  (app as unknown as { delete: (path: string, handler: (ctx: unknown) => unknown) => unknown }).delete(
    "/console/api/ip-bans",
    async () => {
      if (!deps.services.ipBan) return errorResponse(404, "model_not_found", "ipBan not available");
      const pruned = await deps.services.ipBan.prune();
      const allRaw = await deps.services.ipBan.list();
      const all = Array.isArray(allRaw) ? allRaw : [];
      let deleted = 0;
      for (const row of all) {
        const rowObj = row as Record<string, unknown>;
        const rowIp = typeof rowObj["ip"] === "string" ? rowObj["ip"] : "";
        if (!rowIp) continue;
        const ok = await deps.services.ipBan.unban(rowIp);
        if (ok) deleted++;
      }
      return jsonResponse({ ok: true, deleted, expiredPruned: pruned });
    },
  );

  const cliTools = deps.services.cliTools;
  if (cliTools !== undefined) {
    (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
      "/console/api/cli-tools/registry",
      async () => jsonResponse(await cliTools.registry()),
    );
    (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
      "/console/api/cli-tools/all-statuses",
      async () => jsonResponse(await cliTools.allStatuses()),
    );
    (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
      "/console/api/cli-tools/:toolId/mappings",
      async ({ params }: any /* Elysia ctx */) => {
        const toolId = (params as { toolId: string }).toolId;
        if (!cliTools.isValidTool(toolId)) return errorResponse(404, "model_not_found", "CLI tool not found");
        return jsonResponse(await cliTools.getMappings(toolId));
      },
    );
    (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
      "/console/api/cli-tools/:toolId/mappings",
      async ({ params, body }: any /* Elysia ctx */) => {
        const toolId = (params as { toolId: string }).toolId;
        if (!cliTools.isValidTool(toolId)) return errorResponse(404, "model_not_found", "CLI tool not found");
        const result = await cliTools.saveMappings(toolId, body);
        if (result !== null && typeof result === "object" && "error" in result)
          return errorResponse(400, "invalid_request", String((result as { error: string }).error));
        return jsonResponse(result);
      },
    );
    (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
      "/console/api/cli-tools/:toolId",
      async ({ params }: any /* Elysia ctx */) => {
        const status = await cliTools.status((params as { toolId: string }).toolId);
        if (status === null) return errorResponse(404, "model_not_found", "CLI tool not found");
        return jsonResponse(status);
      },
    );
    (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
      "/console/api/cli-tools/:toolId",
      async ({ params, body }: any /* Elysia ctx */) => {
        const toolId = (params as { toolId: string }).toolId;
        if (!cliTools.isValidTool(toolId)) return errorResponse(404, "model_not_found", "CLI tool not found");
        const result = await cliTools.apply(toolId, body);
        if (!result.success) return errorResponse(400, "invalid_request", result.message);
        return jsonResponse(result);
      },
    );
    (app as unknown as { delete: (path: string, handler: (ctx: unknown) => unknown) => unknown }).delete(
      "/console/api/cli-tools/:toolId",
      async ({ params }: any /* Elysia ctx */) => {
        const toolId = (params as { toolId: string }).toolId;
        if (!cliTools.isValidTool(toolId)) return errorResponse(404, "model_not_found", "CLI tool not found");
        const result = await cliTools.reset(toolId);
        if (!result.success) return errorResponse(400, "invalid_request", result.message);
        return jsonResponse(result);
      },
    );
    (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
      "/console/api/cli-tools/:toolId/download",
      async ({ params, body }: any /* Elysia ctx */) => {
        const toolId = (params as { toolId: string }).toolId;
        if (!cliTools.isValidTool(toolId)) return errorResponse(404, "model_not_found", "CLI tool not found");
        const result = await cliTools.download(toolId, body);
        if (result === null) return errorResponse(400, "invalid_request", "endpoint and apiKey are required");
        return jsonResponse(result);
      },
    );
  } else {
    const unavailable = () => errorResponse(501, "capability_unsupported", "CLI tools are unavailable");
    (app as unknown as { get: (path: string, handler: () => unknown) => unknown }).get("/console/api/cli-tools/registry", unavailable);
    (app as unknown as { get: (path: string, handler: () => unknown) => unknown }).get("/console/api/cli-tools/all-statuses", unavailable);
    (app as unknown as { get: (path: string, handler: () => unknown) => unknown }).get("/console/api/cli-tools/:toolId/mappings", unavailable);
    (app as unknown as { post: (path: string, handler: () => unknown) => unknown }).post("/console/api/cli-tools/:toolId/mappings", unavailable);
    (app as unknown as { get: (path: string, handler: () => unknown) => unknown }).get("/console/api/cli-tools/:toolId", unavailable);
    (app as unknown as { post: (path: string, handler: () => unknown) => unknown }).post("/console/api/cli-tools/:toolId", unavailable);
    (app as unknown as { delete: (path: string, handler: () => unknown) => unknown }).delete("/console/api/cli-tools/:toolId", unavailable);
    (app as unknown as { post: (path: string, handler: () => unknown) => unknown }).post("/console/api/cli-tools/:toolId/download", unavailable);
  }

  if (deps.services.filterRules !== undefined) {
    const fr = deps.services.filterRules;
    (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
      "/console/api/filters",
      async () => jsonResponse(await fr.list()),
    );
    (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
      "/console/api/filters",
      async ({ body }: any /* Elysia ctx */) => toResponse(await fr.create(body)),
    );
    (app as unknown as { patch: (path: string, handler: (ctx: unknown) => unknown) => unknown }).patch(
      "/console/api/filters/:id",
      async ({ params, body }: any /* Elysia ctx */) => toResponse(await fr.update((params as { id: string }).id, body)),
    );
    (app as unknown as { delete: (path: string, handler: (ctx: unknown) => unknown) => unknown }).delete(
      "/console/api/filters/:id",
      async ({ params }: any /* Elysia ctx */) => toResponse(await fr.remove((params as { id: string }).id)),
    );
  } else {
    const unavailable = () => errorResponse(501, "capability_unsupported", "Filter rules are unavailable");
    (app as unknown as { get: (path: string, handler: () => unknown) => unknown }).get("/console/api/filters", unavailable);
    (app as unknown as { post: (path: string, handler: () => unknown) => unknown }).post("/console/api/filters", unavailable);
    (app as unknown as { patch: (path: string, handler: () => unknown) => unknown }).patch("/console/api/filters/:id", unavailable);
    (app as unknown as { delete: (path: string, handler: () => unknown) => unknown }).delete("/console/api/filters/:id", unavailable);
  }

  {
    const overview = deps.services.overview;
    if (overview !== undefined) {
      (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
        "/console/api/overview",
        async () => jsonResponse(await overview.get()),
      );
    } else {
      (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
        "/console/api/overview",
        async () => {
          const [health, models] = await Promise.all([
            deps.services.diagnostics.health() as Promise<Record<string, unknown>>,
            deps.services.models.list() as Promise<unknown>,
          ]);
          return jsonResponse({
            status: (health as Record<string, unknown>)?.status ?? "ok",
            health,
            models,
            totals: { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, errors: 0, avgDurationMs: 0 },
            registered: [],
          });
        },
      );
    }
  }
}
