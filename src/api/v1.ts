import { Elysia } from "elysia";
import { readBoundedJson as readCanonicalBoundedJson } from "../proxy/protocol-request.js";

import { markOverhead, runWithOverheadRequest } from "../runtime/overhead.js";
import { OHMYOMOP_ROUTER_VERSION } from "../runtime/runtime.js";
import { renderHealthPage } from "./health-page.js";
import { clientIpOf, authenticateApiKey, headerSnapshot, cachedUrl } from "./guard.js";
import { createPublicBanAndRateLimitGuard, sseHeaders, computeBodyLimit } from "./guard.js";
import { applySecurityHeaders, errorResponse, jsonResponse, secureResponse } from "./errors.js";
import type { ApiKeyPort } from "./guard.js";
import { createSurfaceStream } from "../proxy/translate/stream.js";
import { detectClientFormat, normalizationEndpoint } from "../proxy/translate/cross-surface.js";
import { internalFailureFromUnknown } from "../proxy/errors.js";
import { writeErrorResponse } from "../proxy/events/commit.js";
import type { StreamEvent } from "../proxy/types/stream.js";
import type { PresentedProxyResponse } from "../proxy/types/request.js";
import type { ProxyEndpoint } from "../proxy/types/routing.js";
import type { Surface } from "../proxy/types/surface.js";

function endpointForPath(pathname: string): { endpoint: ProxyEndpoint; surface: Surface } | null {
  switch (pathname) {
    case "/v1/chat/completions":
      return { endpoint: "/v1/chat/completions", surface: "openai-chat" };
    case "/v1/responses":
      return { endpoint: "/v1/responses", surface: "openai-responses" };
    case "/v1/responses/compact":
      return { endpoint: "/v1/responses/compact", surface: "openai-responses" };
    case "/v1/messages":
      return { endpoint: "/v1/messages", surface: "anthropic-messages" };
    default:
      return null;
  }
}

export interface ModelCatalogEntry {
  readonly id: string;
  readonly object: "model";
  readonly owned_by: string;
  readonly metadata?: unknown;
}

export interface ModelCatalogPort {
  list(authorized: { apiKeyId: string }): Promise<readonly ModelCatalogEntry[]> | readonly ModelCatalogEntry[];
}

export interface ProxyRequestPort {
  handle(input: {
    endpoint: ProxyEndpoint;
    surface: Surface;
    body: unknown;
    estimatedInputTokens: number;
    headers: Headers;
    signal: AbortSignal;
    requestId: string;
    clientIp: string | null;
    apiKeyId: string;
  }): Promise<PresentedProxyResponse>;
  passthrough?(input: {
    path: string;
    body: Readonly<Record<string, unknown>>;
    headers: Headers;
    signal: AbortSignal;
    requestId: string;
    clientIp: string | null;
    apiKeyId: string;
  }): Promise<Response>;
  readonly health?: () => unknown | Promise<unknown>;
}

export interface PublicDependencies {
  readonly apiKeys: ApiKeyPort;
  readonly models: ModelCatalogPort;
  readonly proxy: ProxyRequestPort;
  readonly readiness: () => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
  readonly health?: () => unknown | Promise<unknown>;
  readonly getClientIp?: (request: Request) => string | null;
  readonly ipBan?: {
    isBanned(ip: string): Promise<boolean>;
    recordFailure(ip: string, opts: { maxFailures: number; banDurationMs: number; reason?: 'failed_login' | 'suspicious_activity' | 'rate_limit_abuse' }): Promise<unknown>;
    list(): Promise<unknown>;
    unban(ip: string): Promise<boolean>;
    prune(): Promise<unknown>;
  };
  readonly rateLimit?: {
    touch(ip: string, scope: "open" | "console", limitPerMinute: number): Promise<{ count: number; remaining: number; windowStartedAt: string }>;
  };
  readonly overhead?: {
    snapshot(): unknown;
    metrics(): string;
  };
}

async function readBoundedJson(request: Request, maxBytes: number, requestId: string, signal?: AbortSignal): Promise<{ ok: true; value: unknown; byteLength: number } | { ok: false; response: Response }> {
  const stop = markOverhead("ingress.body_read");
  // Forward abort signal so oversized streaming bodies cancel promptly; fallback still respects maxBytes.
  const boundedRequest = signal ? new Request(request.url, { method: request.method, headers: request.headers, body: request.body, signal } as RequestInit & { duplex?: string }) : request;
  // If body already consumed as object (tests), readCanonical handles null body with byte length check via content-length fallback inside readBoundedBytes.
  // We keep passing original request when signal not needed to avoid cloning overhead.
  const effectiveRequest = signal && request.body !== null ? boundedRequest : request;
  const result = await readCanonicalBoundedJson(effectiveRequest as Request, maxBytes);
  stop();
  if (result.ok) return result;
  const response = result.reason === "too_large"
    ? errorResponse(413, "request_too_large", `Request body exceeds ${maxBytes} bytes`, requestId)
    : errorResponse(400, "invalid_request", "Request body must be valid JSON", requestId);
  return { ok: false, response };
}

function touchApiKey(port: ApiKeyPort, id: string): void {
  try {
    void Promise.resolve(port.touch(id)).catch(() => {});
  } catch {
    // Last-used timestamps are advisory and never fail an otherwise valid request.
  }
}

export function createPublicRouter(deps: PublicDependencies): Elysia {
  const app = new Elysia();
  const startedAt = Date.now();
  (app as unknown as { beforeHandle: (fn: (ctx: unknown) => unknown) => unknown }).beforeHandle(
    createPublicBanAndRateLimitGuard(deps.ipBan, deps.rateLimit),
  );

  app.get("/health", ({ request }) =>
    secureResponse(
      new Response(renderHealthPage(request), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-ohmyomop-router-version": OHMYOMOP_ROUTER_VERSION,
        },
      }),
      { noStore: true },
    ),
  );

  app.get("/_health", async () => {
    const healthHook = deps.health ?? deps.proxy.health;
    const health = healthHook === undefined ? null : await Promise.resolve(healthHook()).catch(() => null);
    const relays = typeof health === "object" && health !== null && "relays" in health
      && typeof health.relays === "object" && health.relays !== null && !Array.isArray(health.relays)
      ? health.relays
      : {};
    return secureResponse(Response.json({
      relays,
      uptime: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    }, { headers: { "cache-control": "no-store" } }), { noStore: true });
  });

  app.get("/health/ready", async () => {
    const state = await deps.readiness();
    if (!state.ok) {
      const body = { status: "not_ready" as const, reason: state.reason ?? "not_ready" };
      return secureResponse(Response.json(body, { status: 503, headers: { "cache-control": "no-store" } }), {
        noStore: true,
      });
    }
    return secureResponse(Response.json({ status: "ready" as const, version: OHMYOMOP_ROUTER_VERSION }, { headers: { "cache-control": "no-store" } }), {
      noStore: true,
    });
  });

  app.get("/health/overhead", async ({ request }) => {
    const auth = await authenticateApiKey(request as Request, deps.apiKeys);
    if (auth.response !== null) return auth.response;
    if (auth.key === null) return errorResponse(401, "authentication_failed", "A valid API key is required.");
    if (deps.overhead === undefined) return errorResponse(404, "model_not_found", "Overhead tracking is unavailable.");
    return jsonResponse(deps.overhead.snapshot(), { request: request as Request });
  });

  app.get("/metrics", async ({ request }) => {
    const auth = await authenticateApiKey(request as Request, deps.apiKeys);
    if (auth.response !== null) return auth.response;
    if (auth.key === null) return errorResponse(401, "authentication_failed", "A valid API key is required.");
    if (deps.overhead === undefined) return errorResponse(404, "model_not_found", "Metrics are unavailable.");
    return new Response(deps.overhead.metrics(), {
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" },
    });
  });



  const handleProxy = async (request: Request, endpoint: ProxyEndpoint, surface: Surface): Promise<Response> => {
    // Single snapshot read avoids repeated headers.get calls.
    const snap = headerSnapshot(request.headers);
    const requestId = snap.requestId?.trim() || crypto.randomUUID();
    return runWithOverheadRequest(requestId, async () => {
      const url = cachedUrl(request);
      if (url.pathname.length > 2048) return errorResponse(414, "uri_too_long", "URI too long", requestId);
      const stopAuth = markOverhead("ingress.auth");
      const auth = await authenticateApiKey(request, deps.apiKeys);
      stopAuth();
      if (auth.response !== null) return auth.response;
      if (auth.key === null) return errorResponse(401, "authentication_failed", "Oh My Omop - Router requires a valid x-api-key header or Authorization: Bearer token.", requestId);
      const maxBytes = computeBodyLimit();
      const parsed = await readBoundedJson(request, maxBytes, requestId, request.signal);
      if (!parsed.ok) return parsed.response;
      const ip = clientIpOf(request, deps.getClientIp);
      const upstreamController = new AbortController();
      const abortUpstream = (): void => upstreamController.abort(request.signal.reason);
      if (request.signal.aborted) abortUpstream();
      else request.signal.addEventListener("abort", abortUpstream, { once: true });
      let streamOwnsAbortListener = false;
      try {
        let normalizedEndpoint = endpoint;
        let wireSurface: Surface = surface;
        try {
          const detection = detectClientFormat(endpoint, surface, request.headers, parsed.value);
          normalizedEndpoint = normalizationEndpoint(endpoint, detection) as ProxyEndpoint;
          if (normalizedEndpoint === "/v1/responses") wireSurface = "openai-responses";
          else if (normalizedEndpoint === "/v1/messages") wireSurface = "anthropic-messages";
        } catch {}
        const result = await deps.proxy.handle({
          endpoint: normalizedEndpoint,
          surface: wireSurface,
          body: parsed.value,
          estimatedInputTokens: Math.max(1, Math.ceil(parsed.byteLength / 4)),
          headers: request.headers,
          signal: upstreamController.signal,
          requestId,
          clientIp: ip,
          apiKeyId: auth.key.id,
        });
        touchApiKey(deps.apiKeys, auth.key.id);
        if (result.body.mode === "json") {
          const headers = new Headers(result.headers);
          headers.set("x-request-id", requestId);
          applySecurityHeaders(headers, { request, noStore: true });
          return Response.json(result.body.value, { status: result.status, headers });
        }
        const headers = sseHeaders(result.headers);
        headers.set("x-request-id", requestId);
        headers.set("x-accel-buffering", "no");
        applySecurityHeaders(headers, { request, noStore: true });

        const requestBody = parsed.value;
        let model: string = result.body.model ?? "unknown";
        if (typeof requestBody === "object" && requestBody !== null && !Array.isArray(requestBody)) {
          const rec = requestBody as Record<string, unknown>;
          const mv = rec.model;
          if (typeof mv === "string") {
            const trimmed = mv.trim();
            if (trimmed.length > 0) model = trimmed;
            else model = "unknown";
          }
        }
        if (model.trim().length === 0) model = "unknown";
        const events = (async function* (): AsyncGenerator<StreamEvent> {
          try {
            yield* (result.body as Extract<typeof result.body, { readonly mode: "stream" }>).events as AsyncIterable<StreamEvent>;
          } finally {
            request.signal.removeEventListener("abort", abortUpstream);
          }
        })();
        streamOwnsAbortListener = true;
        const stream = createSurfaceStream(
          wireSurface,
          events,
          model,
          upstreamController.signal,
          (reason) => upstreamController.abort(reason),
        );
        return new Response(stream, { status: result.status, headers });
      } catch (err) {
        upstreamController.abort(err);
        const presented = writeErrorResponse(internalFailureFromUnknown(err), requestId);
        const headers = new Headers(presented.headers);
        applySecurityHeaders(headers, { request, noStore: true });
        return Response.json(
          (presented.body as Extract<typeof presented.body, { readonly mode: "json" }>).value,
          { status: presented.status, headers },
        );
      } finally {
        if (!streamOwnsAbortListener) request.signal.removeEventListener("abort", abortUpstream);
      }
    });
  };

  const handlePassthrough = async (request: Request): Promise<Response> => {
    const snap = headerSnapshot(request.headers);
    const requestId = snap.requestId?.trim() || crypto.randomUUID();
    return runWithOverheadRequest(requestId, async () => {
      const url = cachedUrl(request);
      if (!url.pathname.startsWith("/v1/") || url.pathname.includes("..")) return errorResponse(404, "model_not_found", "Route not found", requestId);
      if (url.pathname.length > 2048) return errorResponse(414, "uri_too_long", "URI too long", requestId);
      const auth = await authenticateApiKey(request, deps.apiKeys);
      if (auth.response !== null) return auth.response;
      if (auth.key === null) return errorResponse(401, "authentication_failed", "Oh My Omop - Router requires a valid x-api-key header or Authorization: Bearer token.", requestId);
      if (deps.proxy.passthrough === undefined) return errorResponse(404, "model_not_found", "Route not found", requestId);
      const parsed = await readBoundedJson(request, computeBodyLimit(), requestId, request.signal);
      if (!parsed.ok) return parsed.response;
      if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) return errorResponse(400, "invalid_request", "Request body must be a JSON object", requestId);
      try {
        const result = await deps.proxy.passthrough({
          path: `${url.pathname}${url.search}`,
          body: parsed.value as Readonly<Record<string, unknown>>,
          headers: request.headers,
          signal: request.signal,
          requestId,
          clientIp: clientIpOf(request, deps.getClientIp),
          apiKeyId: auth.key.id,
        });
        touchApiKey(deps.apiKeys, auth.key.id);
        const headers = new Headers(result.headers);
        headers.set("x-request-id", requestId);
        applySecurityHeaders(headers, { request, noStore: true });
        return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
      } catch (err) {
        const presented = writeErrorResponse(internalFailureFromUnknown(err), requestId);
        const headers = new Headers(presented.headers);
        applySecurityHeaders(headers, { request, noStore: true });
        return Response.json((presented.body as Extract<typeof presented.body, { readonly mode: "json" }>).value, { status: presented.status, headers });
      }
    });
  };

  app.post("/v1/chat/completions", async ({ request }) => handleProxy(request as Request, "/v1/chat/completions", "openai-chat"));
  app.post("/v1/responses", async ({ request }) => handleProxy(request as Request, "/v1/responses", "openai-responses"));
  app.post("/v1/responses/compact", async ({ request }) => handleProxy(request as Request, "/v1/responses/compact", "openai-responses"));
  app.post("/v1/messages", async ({ request }) => handleProxy(request as Request, "/v1/messages", "anthropic-messages"));
  app.post("/v1/*", async ({ request }) => handlePassthrough(request as Request));
  app.get("/v1/models", async ({ request }) => {
    const auth = await authenticateApiKey(request as Request, deps.apiKeys);
    if (auth.response !== null) return auth.response;
    if (auth.key === null) return errorResponse(401, "authentication_failed", "Oh My Omop - Router requires a valid x-api-key header or Authorization: Bearer token.");
    try {
      const entries = await deps.models.list({ apiKeyId: auth.key.id });
      await Promise.resolve(deps.apiKeys.touch(auth.key.id)).catch(() => {});
      return jsonResponse({ object: "list", data: entries }, { request: request as Request });
    } catch {
      return errorResponse(500, "internal_error", "Unable to list models.");
    }
  });

  // Explicitly no QUERY, no image-generation/edit endpoints.
  return app;
}

export function registerPublicRoutes(app: Elysia, deps: PublicDependencies): Elysia {
  const router = createPublicRouter(deps);
  // Mount router onto provided app without introducing a gateway root.
  app.use(router as unknown as Parameters<Elysia["use"]>[0]);
  return app;
}
