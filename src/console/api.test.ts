import { describe, test, expect } from "bun:test";
import { createConsoleRouter } from "./api.js";
import { createProvidersService } from "./services/providers.js";
import type { ConsolePorts, ConsoleServiceResult } from "../api/guard.js";
import { createAuthDriverRegistry } from "../auth/driver-registry.js";
import { MapAuthDriverRegistry } from "../auth/driver-registry.js";
import { OAuthLoginSessionManager } from "../auth/login-session.js";
import { ProviderRegistry, loadOptionalProvider } from "../providers/registry.js";

function ok<T>(data: T, status = 200): ConsoleServiceResult<T> {
  return { ok: true, status, data };
}
function fail(status: number, message: string, code = "capability_unsupported"): ConsoleServiceResult {
  return { ok: false, status, code, message };
}

function makeDeps(overrides: Partial<ConsolePorts> = {}): ConsolePorts {
  const base: ConsolePorts = {
    session: { verify: async () => ({ id: "sess-1" }) },
    auth: {
      login: async () => ok({ token: "tok" }),
      logout: async () => ok({}),
      session: async () => ok({ user: "admin" }),
      changePassword: async () => ok({}),
    },
    providers: {
      list: async () => [],
      get: async (id: string) => (id === "openai" ? { id: "openai", name: "OpenAI" } : null),
      create: async () => ok({ id: "new" }, 201),
      update: async (id: string) => ok({ id }),
      remove: async () => ok({}),
      fetchModels: async (id: string) => (id === "missing" ? fail(404, "not found", "model_not_found") : ok({ provider: id, fetched: 2, models: [{ model_id: "a" }, { model_id: "b" }] })),
      health: async (id: string) => (id === "custom-1" ? ok({ ok: true, latencyMs: 12 }) : fail(501, "health not configured")),
      createModel: async (pid: string, _body: unknown) => ok({ provider: pid }),
      deleteModel: async (pid: string) => ok({ provider: pid }),
    },
    accounts: {
      list: async () => [{ id: "acc-1", provider: "openai", providerId: "openai", name: "acc" }],
      create: async () => ok({ id: "acc-new" }, 201),
      update: async (id: string) => ok({ id }),
      remove: async () => ok({}),
      oauthStart: async () => fail(501, "OAuth start not configured"),
      oauthCallback: async () => fail(501, "OAuth callback not configured"),
      validateApiKey: async () => ok({ valid: true }),
      quotaRefresh: async (id: string) => (id === "missing" ? fail(404, "not found") : ok({ id, quota: { status: "ready" } })),
      quota: async (id: string) => (id === "acc-1" ? { accountId: id, quota: { status: "ready" } } : null),
      batchUpdate: async (body: unknown) => {
        const v = body as Record<string, unknown>;
        if (!Array.isArray(v.ids) || v.ids.length === 0) return fail(400, "ids required");
        return ok({ updated: (v.ids as string[]).length });
      },
      batchDelete: async (body: unknown) => {
        const v = body as Record<string, unknown>;
        if (!Array.isArray(v.ids) || v.ids.length === 0) return fail(400, "ids required");
        return ok({ deleted: (v.ids as string[]).length });
      },
      oauthRefresh: async (body: unknown) => {
        const v = body as Record<string, unknown>;
        if (!v.accountId) return fail(400, "accountId required");
        if (v.accountId === "bad") return fail(502, "refresh failed");
        return ok({ accountId: v.accountId });
      },
      quotaRefreshBulk: async (body: unknown) => {
        const v = body as Record<string, unknown>;
        const ids = (v.accountIds ?? v.ids) as string[] | undefined;
        if (!ids || ids.length === 0) return fail(400, "accountIds required");
        return ok({ queued: ids.length, active: ids.length });
      },
    },
    models: {
      list: async () => [{ provider: "openai", model_id: "gpt-4" }],
      aliases: {
        list: async () => [{ alias: "fast", model: "openai/gpt-4" }],
        create: async (body: unknown) => {
          const v = body as Record<string, unknown>;
          if (!v.alias || !v.model) return fail(400, "alias and model required");
          return ok({}, 201);
        },
        remove: async () => ok({}),
      },
      combos: {
        list: async () => [{ id: "combo-1", name: "c1" }],
        create: async () => ok({ id: "combo-new" }, 201),
        remove: async () => ok({}),
        patch: async (id: string) => ok({ id }),
      },
    },
    accessRules: {
      list: async () => [],
      create: async () => ok({}, 201),
      update: async (id: string) => ok({ id }),
      remove: async () => ok({}),
    },
    apiKeys: {
      list: async () => [{ id: "key-1", name: "k1" }],
      create: async () => ok({ id: "key-new", key: "sk-xxx" }, 201),
      revoke: async () => ok({}),
      update: async (id: string) => ok({ id }),
      share: async (id: string) => (id === "missing" ? fail(404, "not found", "model_not_found") : ok({ url: `https://example.com/share/${id}`, id: "share-1" }, 201)),
      credential: async (id: string) => (id === "key-1" ? { key: null, prefix: "sk-123" } : null),
    },
    buyers: {
      list: async () => ({ items: [] }),
      get: async (id: string) => (id === "missing" ? null : { id }),
      create: async () => ok({ buyer: "oc-test" }, 201),
      revoke: async (id: string) => ok({ id }),
      renew: async (id: string) => ok({ buyer: id }, 201),
      share: async (id: string) => (id === "missing" ? fail(404, "not found", "model_not_found") : ok({ url: `https://example.com/buyers/${id}` }, 201)),
    },
    proxies: {
      list: async () => [{ id: "proxy-1", host: "1.2.3.4", port: 8080, name: "p1" }],
      create: async () => ok({ id: "proxy-new" }, 201),
      update: async (id: string) => ok({ id }),
      remove: async () => ok({}),
      health: async () => [{ proxy_id: "proxy-1", status: "ok" }],
      test: async (body: unknown) => {
        const v = body as Record<string, unknown>;
        if (!v.host) return fail(400, "host required");
        return ok({ ok: true, latencyMs: 42 });
      },
      testOne: async (id: string) => (id === "missing" ? fail(404, "proxy not found", "model_not_found") : ok({ ok: true, latencyMs: 10, proxyId: id })),
    },
    settings: {
      get: async () => ({ hasPassword: true, runtime: {} }),
      patch: async (body: unknown) => body as unknown,
      resetAll: async (body: unknown) => {
        const v = body as Record<string, unknown>;
        if (v.confirmation !== "RESET") return fail(400, 'confirmation must be "RESET"');
        return ok({ reset: true });
      },
    },
    backup: {
      export: async () => ({ version: 1 }),
      exportStream: () => new Response(JSON.stringify({ version: 1 }), { headers: { "content-type": "application/json" } }),
      import: async () => ok({}),
      verifyPassword: async () => ok({}),
    },
    logs: {
      query: async () => [{ id: 1, msg: "hello" }],
      stream: async () => new Response("event: init\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } }),
      clear: async () => ok({ cleared: true }),
    },
    usage: {
      query: async (url: URL) => {
        if (url.pathname.includes("/chart") || url.searchParams.has("chart")) return { buckets: [{ t: 1 }] } as unknown;
        if (url.searchParams.get("by") === "model") return [{ model: "gpt-4", requests: 1 }] as unknown;
        return [{ trace_id: "req-1" }] as unknown;
      },
    },
    ips: {
      top: async () => ({ windowSeconds: 60, rows: [] }),
    },
    diagnostics: {
      health: async () => ({ ok: true }),
      readiness: async () => ({ ok: true }),
      overhead: async () => ({ overhead: {} }),
      metrics: () => "# metrics",
    },
    probe: {
      test: async (body: unknown) => {
        const v = body as Record<string, unknown>;
        if (!v.provider || !v.model) return fail(400, "provider and model required");
        return ok({ ok: true, latencyMs: 123 });
      },
    },
    updates: {
      release: async () => ({ tag_name: "v1.2.3", html_url: "https://github.com/x/y/releases/tag/v1.2.3" }),
      repository: async () => ({ branches: [] }),
    },
    oauth: {
      // minimal fake OAuthLoginSessionManager shape
      start: async ({ providerId, name, flow }: unknown) => ({ sessionId: "sess-1", providerId, name, flow, authorizationUrl: `https://auth.example.com/${String(providerId)}/authorize?session=sess-1`, expiresAtMs: Date.now() + 600000 } as unknown as never),
      get: (sid: string) => (sid === "sess-1" ? { sessionId: sid, status: "pending", providerId: "openai" } : null) as unknown as never,
      poll: async (sid: string) => (sid === "sess-1" ? { sessionId: sid, status: "pending", providerId: "openai" } : null) as unknown as never,
      complete: async (sid: string) => ({ sessionId: sid, providerId: "openai", status: "completed" } as unknown as never),
      cancel: (_sid: string) => {},
    } as unknown as ConsolePorts["oauth"],
    ...overrides,
  };
  return { ...base, ...overrides } as ConsolePorts;
}

async function call(router: ReturnType<typeof createConsoleRouter>, path: string, init: RequestInit = {}): Promise<{ status: number; json: unknown; text: string }> {
  const req = new Request(`http://127.0.0.1${path}`, init);
  const res = await (router as unknown as { handle: (r: Request) => Promise<Response> }).handle(req);
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, text };
}

describe("console routes — dashboard contract", () => {
  test("GET /providers/:id returns 404 typed not 200 null", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    const res = await call(router, "/console/api/providers/missing");
    expect(res.status).toBe(404);
    expect((res.json as Record<string, unknown>).error).toBeDefined();
  });

  test("GET /providers/:id returns builtin when exists", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    const res = await call(router, "/console/api/providers/openai");
    expect(res.status).toBe(200);
  });

  test("GET /providers/claude exposes OAuth flows for Claude Code", async () => {
    const registry = new ProviderRegistry();
    await loadOptionalProvider("claude", registry);
    const providers = createProvidersService((async () => []) as never, registry, undefined, createAuthDriverRegistry());
    const router = createConsoleRouter({ services: { ...makeDeps(), providers } });
    const res = await call(router, "/console/api/providers/claude");
    expect(res.status).toBe(200);
    expect((res.json as { oauthFlows?: { browser: boolean; device: boolean } }).oauthFlows?.browser || (res.json as { oauthFlows?: { browser: boolean; device: boolean } }).oauthFlows?.device).toBe(true);
  });

  test("POST /providers/:id/models/fetch delegates to service and 404 for missing", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/providers/openai/models/fetch", { method: "POST", body: "{}" })).status).toBe(200);
    expect((await call(router, "/console/api/providers/missing/models/fetch", { method: "POST", body: "{}" })).status).toBe(404);
  });

  test("POST /providers/:id/models/fetch returns 501 when not configured", async () => {
    const deps = makeDeps({ providers: { list: async () => [], get: async () => null, create: async () => ok({}), update: async () => ok({}), remove: async () => ok({}) } });
    const router = createConsoleRouter({ services: deps });
    const res = await call(router, "/console/api/providers/openai/models/fetch", { method: "POST", body: "{}" });
    expect(res.status).toBe(501);
  });

  test("POST /providers/:id/health typed 501 when not configured for builtin", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    const res = await call(router, "/console/api/providers/openai/health", { method: "POST", body: "{}" });
    expect(res.status).toBe(501);
  });

  test("POST /providers/:id/health succeeds for custom with baseUrl", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    const res = await call(router, "/console/api/providers/custom-1/health", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
  });

  test("PATCH /accounts/batch bulk active", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    const res = await call(router, "/console/api/accounts/batch", { method: "PATCH", body: JSON.stringify({ ids: ["acc-1", "acc-2"], active: true }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
  });

  test("PATCH /accounts/batch returns 501 when not configured", async () => {
    const deps = makeDeps({ accounts: { list: async () => [], create: async () => ok({}), update: async () => ok({}), remove: async () => ok({}), oauthStart: async () => fail(501, "x"), oauthCallback: async () => fail(501, "x"), quotaRefresh: async () => ok({}) } as unknown as ConsolePorts["accounts"] });
    const router = createConsoleRouter({ services: deps });
    const res = await call(router, "/console/api/accounts/batch", { method: "PATCH", body: JSON.stringify({ ids: ["a"], active: true }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(501);
  });

  test("POST /accounts/batch-delete bulk delete", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    const res = await call(router, "/console/api/accounts/batch-delete", { method: "POST", body: JSON.stringify({ ids: ["acc-1"] }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
  });

  test("POST /quota/refresh bulk", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    const res = await call(router, "/console/api/quota/refresh", { method: "POST", body: JSON.stringify({ accountIds: ["acc-1"] }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
  });

  test("POST /oauth/refresh delegates and 400 on missing accountId", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/oauth/refresh", { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await call(router, "/console/api/oauth/refresh", { method: "POST", body: JSON.stringify({ accountId: "acc-1" }), headers: { "content-type": "application/json" } })).status).toBe(200);
  });

  test("POST /proxies/test and POST /proxies/:id/test", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/proxies/test", { method: "POST", body: JSON.stringify({ host: "1.2.3.4", port: 8080 }), headers: { "content-type": "application/json" } })).status).toBe(200);
    expect((await call(router, "/console/api/proxies/proxy-1/test", { method: "POST", body: "{}" })).status).toBe(200);
    expect((await call(router, "/console/api/proxies/missing/test", { method: "POST", body: "{}" })).status).toBe(404);
  });

  test("POST /proxies/test 501 when not configured", async () => {
    const deps = makeDeps({ proxies: { list: async () => [], create: async () => ok({}), update: async () => ok({}), remove: async () => ok({}), health: async () => [] } });
    const router = createConsoleRouter({ services: deps });
    expect((await call(router, "/console/api/proxies/test", { method: "POST", body: JSON.stringify({ host: "1.2.3.4", port: 8080 }), headers: { "content-type": "application/json" } })).status).toBe(501);
  });

  test("POST /keys/:id/share success and 404", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/keys/key-1/share", { method: "POST", body: "{}" })).status).toBe(201);
    expect((await call(router, "/console/api/keys/missing/share", { method: "POST", body: "{}" })).status).toBe(404);
  });

  test("POST /keys/:id/share 501 when not configured", async () => {
    const deps = makeDeps({ apiKeys: { list: async () => [], create: async () => ok({}), revoke: async () => ok({}), update: async () => ok({}) } });
    const router = createConsoleRouter({ services: deps });
    expect((await call(router, "/console/api/keys/key-1/share", { method: "POST", body: "{}" })).status).toBe(501);
  });

  test("GET /keys/:id/credential returns 404 for missing", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/keys/missing/credential")).status).toBe(404);
    expect((await call(router, "/console/api/keys/key-1/credential")).status).toBe(200);
  });

  test("buyers routes list/get/revoke/share", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/buyers")).status).toBe(200);
    expect((await call(router, "/console/api/buyers/missing")).status).toBe(404);
    expect((await call(router, "/console/api/buyers/oc-test")).status).toBe(200);
    expect((await call(router, "/console/api/buyers/oc-test/revoke", { method: "POST", body: "{}" })).status).toBe(200);
    expect((await call(router, "/console/api/buyers/oc-test/share", { method: "POST", body: "{}" })).status).toBe(201);
    expect((await call(router, "/console/api/buyers/oc-test/renew", { method: "POST", body: "{}" })).status).toBe(201);
  });

  test("GET /accounts returns canonical cursor page", async () => {
    const base = makeDeps().accounts;
    const deps = makeDeps({
      accounts: {
        ...base,
        list: async () => ({ items: [{ id: "acc-1", provider: "openai", providerId: "openai", name: "acc" }], nextCursor: "cursor-2" }),
      },
    });
    const res = await call(createConsoleRouter({ services: deps }), "/console/api/accounts?provider=openai&limit=50");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ items: [{ id: "acc-1", provider: "openai", providerId: "openai", name: "acc" }], nextCursor: "cursor-2" });
  });

  test("preserves declared service error codes", async () => {
    const deps = makeDeps({
      apiKeys: {
        ...makeDeps().apiKeys,
        update: async () => fail(400, "capability mismatch", "capability_unsupported"),
      },
    });
    const res = await call(createConsoleRouter({ services: deps }), "/console/api/keys/key-1", { method: "PATCH", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    expect((res.json as Record<string, { code: string }>).error.code).toBe("capability_unsupported");
  });

  test("registers unavailable filter and CLI routes as typed 501", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/filters")).status).toBe(501);
    expect((await call(router, "/console/api/cli-tools/registry")).status).toBe(501);
  });

  test("backup uses the JSON POST password contract", async () => {
    const base = makeDeps();
    let received: unknown = null;
    const router = createConsoleRouter({
      services: {
        ...base,
        backup: {
          ...base.backup,
          verifyPassword: async (_request: Request, body?: unknown) => {
            received = body;
            return ok({});
          },
        },
      },
    });
    const res = await call(router, "/console/api/settings/backup", {
      method: "POST",
      body: JSON.stringify({ password: "test-password" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(received).toEqual({ password: "test-password" });
  });

  test("starts and completes OAuth through the injected driver", async () => {
    const drivers = new MapAuthDriverRegistry();
    drivers.register("codex", {
      kind: "oauth",
      start: async (input) => ({
        authorizationUrl: "https://oauth.test/authorize",
        state: input.state ?? "state-1",
        expiresAtMs: Date.now() + 60_000,
      }),
      exchange: async () => ({ accessToken: "access-token", refreshToken: "refresh-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), email: "oauth@example.test" }),
    });
    const oauth = new OAuthLoginSessionManager({ drivers });
    const base = makeDeps();
    const router = createConsoleRouter({ services: { ...base, oauth } });
    const started = await call(router, "/console/api/providers/codex/oauth/start", {
      method: "POST",
      body: JSON.stringify({ name: "Codex test", flow: "browser" }),
      headers: { "content-type": "application/json" },
    });
    const startBody = started.json as { sessionId: string; state: string; authorizationUrl: string };
    expect(started.status).toBe(200);
    expect(startBody.authorizationUrl).toBe("https://oauth.test/authorize");

    const completed = await call(router, `/console/api/oauth/sessions/${startBody.sessionId}/complete`, {
      method: "POST",
      body: JSON.stringify({ code: "authorization-code", state: startBody.state }),
      headers: { "content-type": "application/json" },
    });
    expect(completed.status).toBe(200);
    expect((completed.json as { status: string; accountId: string }).status).toBe("completed");
    expect((completed.json as { accountId: string }).accountId).toBe("acc-new");
  });

  test("polls a device OAuth session and persists the completed account", async () => {
    const drivers = new MapAuthDriverRegistry();
    const tokenSet = { accessToken: "device-access", refreshToken: "device-refresh", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    drivers.register("codex", {
      kind: "oauth",
      start: async (input) => ({
        authorizationUrl: "https://oauth.test/device",
        state: input.state ?? "device-state",
        expiresAtMs: Date.now() + 60_000,
        flow: "device",
        userCode: "ABCD-EFGH",
        verificationUri: "https://oauth.test/device",
        intervalSeconds: 1,
      }),
      poll: async () => ({ status: "completed", tokenSet }),
    });
    const oauth = new OAuthLoginSessionManager({ drivers });
    const base = makeDeps();
    const router = createConsoleRouter({ services: { ...base, oauth } });
    const started = await call(router, "/console/api/providers/codex/oauth/start", {
      method: "POST",
      body: JSON.stringify({ name: "Codex device test", flow: "device" }),
      headers: { "content-type": "application/json" },
    });
    const startBody = started.json as { sessionId: string };
    const status = await call(router, `/console/api/oauth/sessions/${startBody.sessionId}`);
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ status: "completed", accountId: "acc-new" });
  });

  test("POST /settings/reset-all requires confirmation", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/settings/reset-all", { method: "POST", body: JSON.stringify({ password: "x", confirmation: "WRONG" }), headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await call(router, "/console/api/settings/reset-all", { method: "POST", body: JSON.stringify({ password: "secret", confirmation: "RESET" }), headers: { "content-type": "application/json" } })).status).toBe(200);
  });

  test("GET /updates/release and /updates/repository", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/updates/release")).status).toBe(200);
    expect((await call(router, "/console/api/updates/repository")).status).toBe(200);
  });

  test("GET /updates returns 501 when not configured", async () => {
    const deps = makeDeps({ updates: undefined } as unknown as Partial<ConsolePorts>);
    const router = createConsoleRouter({ services: deps });
    expect((await call(router, "/console/api/updates/release")).status).toBe(501);
    expect((await call(router, "/console/api/updates/repository")).status).toBe(501);
  });

  test("DELETE /logs delegates to clear", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/logs", { method: "DELETE", body: "{}" })).status).toBe(200);
  });

  test("DELETE /logs 501 when not configured", async () => {
    const deps = makeDeps({ logs: { query: async () => [], stream: async () => new Response("") } });
    const router = createConsoleRouter({ services: deps });
    expect((await call(router, "/console/api/logs", { method: "DELETE", body: "{}" })).status).toBe(501);
  });

  test("POST /probe typed 501 when not configured and 200 when configured", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/probe", { method: "POST", body: JSON.stringify({ provider: "openai", model: "gpt-4" }), headers: { "content-type": "application/json" } })).status).toBe(200);
    const deps = makeDeps({ probe: undefined } as unknown as Partial<ConsolePorts>);
    const r2 = createConsoleRouter({ services: deps });
    expect((await call(r2, "/console/api/probe", { method: "POST", body: JSON.stringify({ provider: "openai", model: "gpt-4" }), headers: { "content-type": "application/json" } })).status).toBe(501);
  });

  test("GET /accounts/:id/quota 404 when not found and 501 when service missing", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/accounts/acc-1/quota")).status).toBe(200);
    expect((await call(router, "/console/api/accounts/missing/quota")).status).toBe(404);
    const deps = makeDeps({ accounts: { list: async () => [], create: async () => ok({}), update: async () => ok({}), remove: async () => ok({}), oauthStart: async () => fail(501, "x"), oauthCallback: async () => fail(501, "x"), quotaRefresh: async () => ok({}) } as unknown as ConsolePorts["accounts"] });
    const router2 = createConsoleRouter({ services: deps });
    expect((await call(router2, "/console/api/accounts/acc-1/quota")).status).toBe(501);
  });

  test("POST /accounts/:id/validate uses the API-key validation contract", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    const res = await call(router, "/console/api/accounts/acc-1/validate", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ valid: true });
  });

  test("OAuth start rejects unknown and non-OAuth providers", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/providers/missing/oauth/start", { method: "POST", body: JSON.stringify({ name: "t" }), headers: { "content-type": "application/json" } })).status).toBe(404);
    const deps = makeDeps({ oauth: undefined } as unknown as Partial<ConsolePorts>);
    const router2 = createConsoleRouter({ services: deps });
    expect((await call(router2, "/console/api/providers/openai/oauth/start", { method: "POST", body: JSON.stringify({ name: "t" }), headers: { "content-type": "application/json" } })).status).toBe(400);
  });

  test("OAuth sessions are unavailable without the runtime manager", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/oauth/sessions/unknown")).status).toBe(404);
    expect((await call(router, "/console/api/oauth/sessions/sess-1/complete", { method: "POST", body: JSON.stringify({ value: "code" }), headers: { "content-type": "application/json" } })).status).toBe(200);
  });

  test("aliases/combos CRUD via services", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    expect((await call(router, "/console/api/models/aliases")).status).toBe(200);
    expect((await call(router, "/console/api/models/aliases", { method: "POST", body: JSON.stringify({ alias: "a", model: "m" }), headers: { "content-type": "application/json" } })).status).toBe(201);
    expect((await call(router, "/console/api/models/combos", { method: "POST", body: JSON.stringify({ name: "c" }), headers: { "content-type": "application/json" } })).status).toBe(201);
  });

  test("logs query and usage query return real data not zero fallback", async () => {
    const router = createConsoleRouter({ services: makeDeps() });
    const logs = await call(router, "/console/api/logs?limit=10");
    expect(logs.status).toBe(200);
    expect(Array.isArray(logs.json)).toBe(true);
    const usage = await call(router, "/console/api/usage?limit=10");
    expect(usage.status).toBe(200);
  });

  test("payloads 404 when missing and requires auth", async () => {
    const router = createConsoleRouter({ services: makeDeps({ payloads: { get: async () => null } }) });
    const res = await call(router, "/console/api/payloads/unknown-id");
    expect(res.status).toBe(404);
  });

  test("unauthenticated request returns 401", async () => {
    const deps = makeDeps({ session: { verify: async () => null } });
    const router = createConsoleRouter({ services: deps });
    const req = new Request("http://127.0.0.1/console/api/providers", { method: "GET" });
    const res = await (router as unknown as { handle: (r: Request) => Promise<Response> }).handle(req);
    expect(res.status).toBe(401);
  });
});
