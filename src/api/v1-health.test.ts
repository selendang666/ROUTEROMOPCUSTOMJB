import { describe, expect, test } from "bun:test";
import { createPublicRouter, type PublicDependencies } from "./v1.js";

function dependencies(overrides: Partial<PublicDependencies> = {}): PublicDependencies {
  return {
    apiKeys: {
      async verify() { return null; },
      async touch() {},
    },
    models: { list: () => [] },
    proxy: {
      async handle() {
        throw new Error("unused");
      },
    },
    readiness: () => ({ ok: true }),
    ...overrides,
  } as unknown as PublicDependencies;
}

async function health(deps: PublicDependencies): Promise<{ status: number; body: Record<string, unknown> }> {
  const router = createPublicRouter(deps);
  const response = await (router as unknown as { handle: (request: Request) => Promise<Response> }).handle(
    new Request("http://127.0.0.1:12800/_health"),
  );
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("public health contract", () => {
  test("returns uptime and relay state from the dependency hook", async () => {
    const result = await health(dependencies({
      health: () => ({ relays: { relayA: { state: "CLOSED", failureCount: 0, retryAt: null } } }),
    }));

    expect(result.status).toBe(200);
    expect(result.body.relays).toEqual({ relayA: { state: "CLOSED", failureCount: 0, retryAt: null } });
    expect(typeof result.body.uptime).toBe("number");
    expect(result.body.uptime).toBeGreaterThanOrEqual(0);
  });

  test("returns empty relay state when no hook is available", async () => {
    const result = await health(dependencies());

    expect(result.status).toBe(200);
    expect(result.body.relays).toEqual({});
    expect(typeof result.body.uptime).toBe("number");
  });
});
