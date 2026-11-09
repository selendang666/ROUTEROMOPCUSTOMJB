import { afterEach, describe, expect, test } from "bun:test";
import { createDiagnosticsService } from "./diagnostics.js";
import type { PostgresPool } from "../../persistence/pool.js";
import type { TelemetryPipeline } from "../../persistence/telemetry/pipeline.js";
import { resetInFlightForTests } from "../../runtime/in-flight.js";

afterEach(resetInFlightForTests);

describe("diagnostics overview request health", () => {
  test("surfaces latency totals without request pressure fields", async () => {
    const telemetry = {
      getOverviewTotals: async () => ({ requests: 12, inputTokens: 120, cachedTokens: 12, outputTokens: 60, errors: 2, avgDurationMs: 75, p95DurationMs: 220, totalTokens: 180, estimatedCostUsd: 0 }),
      getProviderAggregates: async () => [
        { providerId: "anthropic", requests: 5, inputTokens: 50, cachedTokens: 0, outputTokens: 20, errors: 2 },
        { providerId: "openai", requests: 7, inputTokens: 70, cachedTokens: 12, outputTokens: 40, errors: 0 },
      ],
    } as unknown as TelemetryPipeline;
    const svc = createDiagnosticsService(
      (async () => []) as unknown as PostgresPool,
      telemetry,
      { mode: "local", degraded: () => false },
    );
    const overview = await svc.overview.get() as {
      totals?: { p95DurationMs: number };
    };

    expect(overview.totals?.p95DurationMs).toBe(220);
    expect("inFlight" in overview).toBe(false);
    expect("requestHealth" in overview).toBe(false);
  });

  test("reports local coordination without a Redis degradation", async () => {
    const telemetry = {} as TelemetryPipeline;
    const svc = createDiagnosticsService(
      (async () => []) as unknown as PostgresPool,
      telemetry,
      { mode: "local", degraded: () => false },
    );

    const health = await svc.diagnostics.health() as {
      coordination: { mode: string; degraded: boolean };
    };

    expect(health.coordination).toEqual({ mode: "local", degraded: false });
  });
});
