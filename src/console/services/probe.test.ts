import { expect, test } from "bun:test";
import type { PostgresPool } from "../../persistence/pool.js";
import type { TelemetryPipeline } from "../../persistence/telemetry/pipeline.js";
import { createProbeService } from "./probe.js";

test("routes a probe through an active proxy and records its telemetry trace", async () => {
  let receivedNetwork: unknown = null;
  const adapter = {
    metadata: { credentialKind: "none", protocol: "openai" },
    capabilities: { surfaces: ["openai-chat", "openai-responses"] },
    models: { get: () => ({ capabilities: { surfaces: ["openai-chat"] } }) },
    resolveTarget: (model: string) => ({ providerId: "probe", modelId: model, upstreamModelId: model, surface: "openai-chat" }),
    call: async (input: { readonly network: unknown }) => {
      receivedNetwork = input.network;
      return {
        mode: "non_stream",
        body: { model: "probe-model", choices: [{ message: { content: "Hello" } }] },
        usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16, cachedTokens: 3, reasoningTokens: 1 },
      };
    },
    mapError: (error: unknown) => ({ kind: "provider_unavailable", statusCode: 502, retryable: true, routeScope: "provider", source: "upstream", safeMessage: String(error), retryAt: null }),
  };
  const registry = { get: () => adapter } as unknown as Parameters<typeof createProbeService>[0];
  const pool = (async (strings: TemplateStringsArray) => {
    if (strings.join("").includes("FROM proxies")) {
      return [{ id: "relay-1", protocol: "https", host: "relay.vercel.app", port: 443, priority: 100, weight: 100 }];
    }
    return [];
  }) as unknown as PostgresPool;
  const events: unknown[] = [];
  const logs: Array<{ level: string; scope: string; msg: string; context?: Record<string, unknown> }> = [];
  const telemetry = {
    enqueue: (event: unknown) => { events.push(event); return { enqueued: true, dropped: false, degraded: false, accepted: true }; },
    writeLogs: async (rows: readonly { level: string; scope: string; msg: string; context?: Record<string, unknown> }[]) => { logs.push(...rows); },
  } as unknown as TelemetryPipeline;
  const service = createProbeService(registry, async () => null, pool, telemetry);

  const result = await service.test({ provider: "probe", model: "probe-model" });

  expect(result).toMatchObject({ ok: true, data: { proxyId: "relay-1", route: "proxy", sample: "Hello" } });
  expect(receivedNetwork).toMatchObject({ proxyId: "relay-1", url: "https://relay.vercel.app:443" });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ endpoint: "/console/api/probe", providerId: "probe", statusCode: 200, errorKind: null, safeHeaders: { "x-ohmyomop-router-proxy-id": "relay-1" } });
  expect(logs.map((row) => row.msg)).toEqual([
    expect.stringContaining("Incoming Request: POST /console/api/probe"),
    expect.stringContaining("Request Complete: 200"),
  ]);
  expect(logs.map((row) => row.level)).toEqual(["debug", "info"]);
  expect(logs[0]?.context).toMatchObject({ event: "incoming", requestId: logs[1]?.context?.requestId, surface: "probe" });
  expect(logs[1]?.context).toMatchObject({
    event: "complete",
    providerId: "probe",
    proxyId: "relay-1",
    inputTokens: 12,
    outputTokens: 4,
    cachedTokens: 3,
    reasoningTokens: 1,
    messageCount: 2,
    toolCount: 0,
    imageCount: 0,
  });
});

test("returns provider probe failures as console-safe result data", async () => {
  const adapter = {
    metadata: { credentialKind: "none", protocol: "openai" },
    capabilities: { surfaces: ["openai-chat"] },
    models: { get: () => ({ capabilities: { surfaces: ["openai-chat"] } }) },
    resolveTarget: (model: string, surface: string) => ({ providerId: "probe", modelId: model, upstreamModelId: model, surface }),
    call: async () => { throw new Error("proxy blocked"); },
    mapError: () => ({ kind: "network_unavailable", statusCode: 403, retryable: true, routeScope: "proxy", source: "upstream", safeMessage: "Oh My Omop - Router proxy error (HTTP 403)", retryAt: null }),
  };
  const registry = { get: () => adapter } as unknown as Parameters<typeof createProbeService>[0];
  const service = createProbeService(registry, async () => null);

  const result = await service.test({ provider: "probe", model: "probe-model" });

  expect(result).toMatchObject({
    ok: true,
    status: 200,
    data: { upstreamStatus: 403, error: { message: "Oh My Omop - Router proxy error (HTTP 403)" } },
  });
});
