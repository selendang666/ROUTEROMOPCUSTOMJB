import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { PostgresPool } from "../../persistence/pool.js";
import { createProxiesService } from "./proxy-pool.js";

describe("proxy pool active-state contract", () => {
  test("lists newly created proxies as active", async () => {
    const pool = (async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("FROM proxies")) {
        return [{
          id: "proxy-1",
          name: "local",
          protocol: "socks5",
          is_relay: false,
          host: "127.0.0.1",
          port: 1080,
          username: null,
          password_encrypted: null,
          priority: 100,
          weight: 100,
          max_concurrency: 8,
          active: true,
          last_used_at: null,
          created_at: "2026-08-27T00:00:00.000Z",
          updated_at: "2026-08-27T00:00:00.000Z",
          last_test_at: null,
          last_test_success_at: null,
          last_test_success_latency_ms: null,
          last_test_error_at: null,
          last_test_error: null,
          last_test_status_code: null,
        }];
      }
      return [];
    }) as unknown as PostgresPool;
    const service = createProxiesService(pool);

    await expect(service.list()).resolves.toMatchObject([{ id: "proxy-1", active: true, protocol: "socks5" }]);
  });

  test("persists the active toggle", async () => {
    const queries: string[] = [];
    const pool = (async (strings: TemplateStringsArray) => {
      queries.push(strings.join(""));
      return [];
    }) as unknown as PostgresPool;
    const service = createProxiesService(pool);

    await service.update("proxy-1", { active: false });

    expect(queries.some((query) => query.includes("SET active ="))).toBe(true);
  });

  test("deactivates an HTTP endpoint that is not a forward proxy", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 400;
      response.end("BAD_REQUEST");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test endpoint did not bind a TCP port");
    const queries: string[] = [];
    const pool = (async (strings: TemplateStringsArray) => {
      queries.push(strings.join(""));
      return [];
    }) as unknown as PostgresPool;
    const service = createProxiesService(pool);

    try {
      await expect(service.test({ protocol: "http", host: "127.0.0.1", port: address.port })).resolves.toMatchObject({
        ok: false,
        status: 502,
      });
      expect(queries.some((query) => query.includes("SET active = false"))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
