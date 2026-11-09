import { describe, expect, test } from "bun:test";
import { loadRuntimeConfig } from "./runtime.js";

const baseEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:pass@127.0.0.1:5432/ohmyomop_router",
  APP_SECRET: "test-secret-that-is-long-enough-for-config",
  PROXY_API_KEY: "test-proxy-key",
};

describe("runtime configuration", () => {
  test("loads telemetry fields and clamps runtime limits", () => {
    const config = loadRuntimeConfig({
      ...baseEnv,
      SQLITE_PATH: "./data/test.db",
      TELEMETRY_D1_URL: "https://d1.test",
      TELEMETRY_D1_TOKEN: "token",
      OHMYOMOP_ROUTER_MAX_REQUEST_BODY_BYTES: "999999999",
      OHMYOMOP_ROUTER_MAX_STREAM_EVENTS: "1",
      OHMYOMOP_ROUTER_DB_POOL_MAX: "999",
      OHMYOMOP_ROUTER_DB_STATEMENT_TIMEOUT_MS: "1",
      OHMYOMOP_ROUTER_DB_IDLE_TXN_TIMEOUT_MS: "999999",
    });
    expect(config.sqlitePath).toBe("./data/test.db");
    expect(config.telemetryD1Url).toBe("https://d1.test");
    expect(config.telemetryD1Token).toBe("token");
    expect(config.limits.requestBodyBytes).toBe(64 * 1024 * 1024);
    expect(config.limits.streamEventCount).toBe(1_000);
    expect(config.dbPoolMax).toBe(100);
    expect(config.dbStatementTimeoutMs).toBe(1_000);
    expect(config.dbIdleInTransactionTimeoutMs).toBe(300_000);
  });

  test("fails when the encryption secret is missing", () => {
    expect(() => loadRuntimeConfig({ ...baseEnv, APP_SECRET: undefined })).toThrow("APP_SECRET");
  });
});
import { expect, test } from "bun:test";
import { OHMYOMOP_ROUTER_VERSION } from "./runtime.js";

test("runtime version matches root and dashboard manifests", async () => {
  const root = await Bun.file(new URL("../../package.json", import.meta.url)).json() as { version: string };
  const dashboard = await Bun.file(new URL("../../dashboard/package.json", import.meta.url)).json() as { version: string };
  expect(OHMYOMOP_ROUTER_VERSION).toBe(root.version);
  expect(dashboard.version).toBe(root.version);
});
