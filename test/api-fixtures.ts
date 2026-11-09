import type { PostgresPool } from "../src/persistence/pool.js";
import type { TelemetryPipeline } from "../src/persistence/telemetry/pipeline.js";
import type { ProviderRegistry } from "../src/providers/registry.js";
import { createDefaultRegistry } from "../src/providers/default-registry.js";
import type { Elysia } from "elysia";

export type FakePool = PostgresPool & {
  queries: string[];
  tableData: Map<string, unknown[]>;
};

export function createFakePool(initial?: Record<string, unknown[]>): FakePool {
  const tableData = new Map<string, unknown[]>(Object.entries(initial ?? {}));
  const queries: string[] = [];
  const fn = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      queries.push(sql);
      // simple routing for provider_models etc - return from tableData
      if (sql.includes("FROM provider_models")) {
        const provider = String(values[0] ?? "");
        const all = (tableData.get("provider_models") ?? []) as Array<Record<string, unknown>>;
        if (provider) return all.filter((r) => r["provider"] === provider);
        return all;
      }
      if (sql.includes("FROM custom_providers")) return tableData.get("custom_providers") ?? [];
      if (sql.includes("FROM share_links")) return tableData.get("share_links") ?? [];
      if (sql.includes("FROM api_keys")) return tableData.get("api_keys") ?? [];
      if (sql.includes("SELECT 1 FROM provider_models")) {
        const provider = String(values[0] ?? "");
        const all = (tableData.get("provider_models") ?? []) as Array<Record<string, unknown>>;
        return all.filter((r) => r["provider"] === provider).slice(0,1).map(()=>({ "1":1 }));
      }
      if (sql.includes("FROM provider_accounts")) return tableData.get("provider_accounts") ?? [];
      if (sql.includes("INSERT INTO provider_models") || sql.includes("UPDATE provider_models") || sql.includes("DELETE FROM provider_models")) {
        // simulate write
        return { count: 1 } as unknown as never;
      }
      if (sql.includes("SELECT 1 FROM custom_providers")) return [];
      return [];
    },
    {
      unsafe: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM provider_models")) {
          const m = sql.match(/provider = '([^']+)'/);
          const provider = m?.[1] ?? "";
          const all = (tableData.get("provider_models") ?? []) as Array<Record<string, unknown>>;
          if (provider) return all.filter((r) => r["provider"] === provider);
          return all;
        }
        if (sql.includes("SELECT 1 FROM provider_models")) return [];
        if (sql.includes("SELECT 1 FROM custom_providers")) return [];
        return [];
      },
      begin: async (cb: (tx: unknown) => Promise<void>) => cb(fn),
    } as unknown as PostgresPool
  );
  const fake = fn as unknown as FakePool;
  (fake as unknown as Record<string, unknown>).queries = queries;
  (fake as unknown as Record<string, unknown>).tableData = tableData;
  return fake;
}

export function createFakeTelemetry(): TelemetryPipeline & { enqueued: unknown[]; flushed: boolean } {
  const enqueued: unknown[] = [];
  let flushed = false;
  const fake = {
    enqueue: (event: unknown) => { enqueued.push(event); return { enqueued: true, dropped: false, degraded: false, accepted: true }; },
    flush: async () => { flushed = true; },
    query: async ({ limit, cursor }: { limit: number; cursor?: number | null }) => {
      // simple paginated fake with 3 rows total
      const all = [
        { id: 1, traceId: "t1", endpoint: "/v1/chat/completions", surface: "openai-chat", provider: "openai", model: "gpt-4", status: 200, errorKind: null, clientIp: "127.0.0.1", apiKeyId: null, apiKeyPrefix: null, metaJson: "{}", inputTokens: 10, outputTokens: 20, cachedTokens: 0, totalTokens: 30, createdAt: new Date().toISOString(), tfftMs: 10, messageCount: 1, toolCount: 0, imageCount: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
        { id: 2, traceId: "t2", endpoint: "/v1/chat/completions", surface: "openai-chat", provider: "openai", model: "gpt-4", status: 200, errorKind: null, clientIp: "127.0.0.1", apiKeyId: null, apiKeyPrefix: null, metaJson: "{}", inputTokens: 10, outputTokens: 20, cachedTokens: 0, totalTokens: 30, createdAt: new Date().toISOString(), tfftMs: 10, messageCount: 1, toolCount: 0, imageCount: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
        { id: 3, traceId: "t3", endpoint: "/v1/chat/completions", surface: "openai-chat", provider: "openai", model: "gpt-4", status: 200, errorKind: null, clientIp: "127.0.0.1", apiKeyId: null, apiKeyPrefix: null, metaJson: "{}", inputTokens: 10, outputTokens: 20, cachedTokens: 0, totalTokens: 30, createdAt: new Date().toISOString(), tfftMs: 10, messageCount: 1, toolCount: 0, imageCount: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
      ];
      const start = cursor ?? 0;
      const slice = all.slice(start, start + limit);
      const nextCursor = start + slice.length < all.length ? start + slice.length : null;
      return { rows: slice as unknown as never, nextCursor };
    },
    stats: () => ({ pending: enqueued.length, pendingBytes: 0, flushCount: flushed ? 1 : 0, degraded: false } as never),
    getPayload: async () => null,
    retain: async () => ({ requestEvents: 0, payloads: 0, consoleLogs: 0, consoleCapped: 0 }),
    writeLogs: async () => {},
    queryLogs: async () => ({ rows: [], nextCursor: null }),
    streamLogs: async function* () {},
    clearLogs: async () => {},
    getOverviewTotals: async () => ({ requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, errors: 0, avgDurationMs: 0 }),
    getProviderAggregates: async () => [],
    getTopIps: async () => ({ rows: [] }),
    asPort: () => ({ enqueue: (e: unknown) => { enqueued.push(e); return { enqueued: true, dropped: false, degraded: false, accepted: true }; } } as never),
    savePayload: async () => {},
    close: () => {},
  } as unknown as TelemetryPipeline & { enqueued: unknown[]; flushed: boolean };
  (fake as unknown as Record<string, unknown>).enqueued = enqueued;
  return fake;
}

export async function createTestRegistry(): Promise<ProviderRegistry> {
  return createDefaultRegistry();
}

export function aChatBody(overrides?: Record<string, unknown>) {
  return { model: "openai/gpt-4", messages: [{ role: "user", content: "hello" }], ...(overrides ?? {}) };
}
export function aResponsesBody(overrides?: Record<string, unknown>) {
  return { model: "openai/gpt-4", input: "hello", ...(overrides ?? {}) };
}
export function anAnthropicBody(overrides?: Record<string, unknown>) {
  return { model: "anthropic/claude-3-5-sonnet", messages: [{ role: "user", content: "hello" }], max_tokens: 100, ...(overrides ?? {}) };
}
export function aProviderModelId(id = "test-model") { return encodeURIComponent(id); }
export function aBackupPayload(withHistory = false) {
  const base: Record<string, unknown> = { app: "ohmyomop-router", version: 2, exportedAt: new Date().toISOString(), tables: {} };
  if (withHistory) (base as Record<string, unknown>).history = { requestEvents: [{ id: 1, traceId: "t1", endpoint: "/v1/chat/completions", surface: "openai-chat", provider: "openai", model: "gpt-4", status: 200, errorKind: null, createdAt: new Date().toISOString() }] };
  return base;
}

export async function composeApp(deps: { pool?: FakePool; registry?: ProviderRegistry; telemetry?: TelemetryPipeline }): Promise<Elysia> {
  const pool = deps.pool ?? createFakePool();
  const registry = deps.registry ?? await createTestRegistry();
  const telemetry = deps.telemetry ?? createFakeTelemetry();
  // Use real bootstrap wiring where possible: createConsoleServices + createPublicPorts + share
  const { createConsoleServices } = await import("../src/bootstrap/console-wiring.js");
  const { createPublicPorts } = await import("../src/bootstrap/public-ports.js");
  const { createShareRouter } = await import("../src/api/share.js");
  const { createConsoleRouter } = await import("../src/console/api.js");
  // Minimal quota stub
  const quota = { state: { get: () => null }, refreshAccountQuota: async () => null, refreshOAuthAccount: async () => null, worker: { stop: () => {} }, tokenRefreshPool: { stop: () => {} } } as unknown as never;
  // Create a minimal Elysia app mirroring application.ts mounts
  const { Elysia } = await import("elysia");
  const app = new Elysia();
  // Public ports
  const publicPorts = createPublicPorts(pool, registry, telemetry as never);
  // We cannot fully replicate createApplication without DB, but we can mount routes directly for contract tests:
  // For structure tests, we just need app.routes to be populated, so we mount the routers.
  const shareRouter = createShareRouter({ pool, usage: telemetry as never, registry } as never);
  (app as unknown as { use: (p: unknown) => unknown }).use(shareRouter as never);
  const consoleServices = createConsoleServices({ pool, telemetry: telemetry as never, quota: quota as never, consoleApiKeys: publicPorts.consoleApiKeys, cliTools: { registry: () => null, allStatuses: async () => [] } as never, ipBan: { isBanned: async () => false, recordFailure: async () => {}, list: async () => [], unban: async () => false, prune: async () => {} } as never, rateLimit: { touch: async () => ({ count: 1, remaining: 199, windowStartedAt: new Date().toISOString() }) } as never, clientIpForBan: () => null, onRouteMutation: () => {}, getAccountCredential: async () => null, registry } as never);
  const consoleRouter = createConsoleRouter({ services: consoleServices, pool } as never);
  (app as unknown as { use: (p: unknown) => unknown }).use(consoleRouter as never);
  // Public API routes (health, models, proxy) — we mount a minimal subset for route parity
  try {
    const mod = await import("../src/api/v1.js") as Record<string, unknown>;
    const createPublicRouter = mod["createPublicRouter"] as unknown as ((deps: unknown) => unknown) | undefined;
    if (typeof createPublicRouter === "function") {
      const maybe = createPublicRouter({ pool, registry, telemetry } as never) as unknown;
      const publicRouter = maybe instanceof Promise ? await (maybe as Promise<unknown>) : maybe;
      if (publicRouter) (app as unknown as { use: (p: unknown) => unknown }).use(publicRouter as never);
    }
  } catch {}
  (app as unknown as { all: (p: string, fn: () => Response) => unknown }).all("/*", () => new Response(JSON.stringify({ error: { type: "error", code: "not_found", message: "Route not found", request_id: crypto.randomUUID() } }), { status: 404, headers: { "content-type": "application/json" } }));
  return app as Elysia;
}
