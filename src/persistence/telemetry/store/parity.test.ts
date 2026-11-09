import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { TelemetryEvent } from "../../../proxy/types/telemetry.js";
import { SqliteTelemetryStore } from "./sqlite/writer.js";
import { D1TelemetryStore } from "./d1/writer.js";

const event: TelemetryEvent = {
  requestId: "trace-1",
  endpoint: "/v1/chat/completions",
  surface: "openai-chat",
  model: "model-1",
  providerId: "provider-1",
  statusCode: 200,
  errorKind: null,
  durationMs: 12,
  usage: null,
  committed: true,
  accountId: "acc_1",
  proxyId: "proxy_1",
  reasoningTokens: 17,
};

const artifact = { text: "{\"safe\":true}", truncated: false, originalBytes: 13, capturedBytes: 13 };
const logContext = { accountId: "acc_1", event: "complete", clientIp: "9.9.9.9" };

describe("SQLite telemetry store parity", () => {
  test("persists events, payloads, logs, streams logs, and retains", async () => {
    const path = `./data/test-parity-${crypto.randomUUID()}.db`;
    const store = await SqliteTelemetryStore.create(path);
    try {
      await store.writeBatch([event]);
      const rows = (await store.query({ limit: 10 })).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ accountId: "acc_1", proxyId: "proxy_1", reasoningTokens: 17 });
      await store.savePayload("trace-1", "client_request", artifact);
      expect((await store.getPayload("trace-1"))?.clientRequest?.text).toBe(artifact.text);
      await store.writeLogs([{ level: "info", scope: "request", msg: "hello" }]);
      expect((await store.queryLogs({ limit: 10 })).rows[0]?.msg).toBe("hello");
      await store.writeLogs([{ level: "info", scope: "request", msg: "with-context", context: logContext }]);
      const contextRow = (await store.queryLogs({ limit: 10 })).rows.find((row) => row.msg === "with-context");
      expect(contextRow?.context).toEqual(logContext);
      const streamed = [];
      for await (const row of store.streamLogs()) streamed.push(row.msg);
      expect(streamed).toEqual(["hello", "with-context"]);
      expect(await store.retain()).toMatchObject({ requestEvents: 0, payloads: 0, consoleLogs: 0, consoleCapped: 0 });
    } finally {
      store.close();
      await rm(path, { force: true });
      await rm(`${path}-wal`, { force: true });
      await rm(`${path}-shm`, { force: true });
    }
  });
});

describe("D1 telemetry store parity", () => {
  test("uses bounded batch statements for events, payloads, logs, reads, and retention", async () => {
    const originalFetch = globalThis.fetch;
    const sqls: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { batch: Array<{ sql: string }> };
      sqls.push(...body.batch.map((statement) => statement.sql));
      const results = body.batch.map((statement) => {
        if (statement.sql.includes("SELECT id, ts, level")) {
          return { results: [{ id: 1, ts: "2026-01-01T00:00:00.000Z", level: "info", scope: "request", msg: "hello", context_json: JSON.stringify(logContext) }], meta: {} };
        }
        if (statement.sql.includes("SELECT request_id")) {
          return { results: [{ request_id: "trace-1", client_request: artifact.text, client_request_meta: JSON.stringify(artifact), provider_request: null, provider_response: null, client_response: null }], meta: {} };
        }
        if (statement.sql.includes("SELECT id, trace_id")) {
          return { results: [{ id: 1, trace_id: "trace-1", endpoint: "/v1/chat/completions", surface: "openai-chat", provider: "provider-1", model: "model-1", status: 200, error_kind: null, client_ip: null, api_key_id: null, api_key_prefix: null, meta_json: "{}", input_tokens: null, output_tokens: null, cached_tokens: null, total_tokens: null, created_at: "2026-01-01T00:00:00.000Z", account_id: "acc_1", proxy_id: "proxy_1", reasoning_tokens: 17 }], meta: {} };
        }
        return { results: [], meta: { changes: 1 } };
      });
      return new Response(JSON.stringify(results), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const store = new D1TelemetryStore("https://telemetry.test", "token");
      await store.writeBatch([event]);
      await store.savePayload("trace-1", "client_request", artifact);
      expect((await store.getPayload("trace-1"))?.clientRequest?.text).toBe(artifact.text);
      await store.writeLogs([{ level: "info", scope: "request", msg: "hello" }]);
      expect((await store.queryLogs({ limit: 10 })).rows[0]?.msg).toBe("hello");
      expect((await store.queryLogs({ limit: 10 })).rows[0]?.context).toEqual(logContext);
      const requestEventsRows = (await store.query({ limit: 10 })).rows;
      expect(requestEventsRows[0]).toMatchObject({ accountId: "acc_1", proxyId: "proxy_1", reasoningTokens: 17 });
      const streamed = [];
      for await (const row of store.streamLogs()) streamed.push(row.msg);
      expect(streamed).toEqual(["hello"]);
      expect(await store.retain()).toMatchObject({ requestEvents: 1, payloads: 1, consoleLogs: 1, consoleCapped: 1 });
      expect(sqls.some((sql) => sql.includes("request_payloads"))).toBe(true);
      expect(sqls.some((sql) => sql.includes("console_logs"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
