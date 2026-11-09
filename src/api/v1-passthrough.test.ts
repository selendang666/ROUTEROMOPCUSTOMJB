import { describe, expect, test } from "bun:test";
import { createPublicRouter, type PublicDependencies } from "./v1.js";

function dependencies(passthrough: PublicDependencies["proxy"]["passthrough"]): PublicDependencies {
  return {
    apiKeys: {
      getBySecret: (secret) => secret === "valid" ? { id: "key-1", active: true, revokedAt: null } : null,
      touch: () => {},
    },
    models: { list: () => [] },
    proxy: {
      async handle() {
        throw new Error("unused");
      },
      ...(passthrough === undefined ? {} : { passthrough }),
    },
    readiness: () => ({ ok: true }),
  };
}

async function call(router: ReturnType<typeof createPublicRouter>, pathname: string, method = "POST"): Promise<Response> {
  return (router as unknown as { handle: (request: Request) => Promise<Response> }).handle(new Request(`http://127.0.0.1:12800${pathname}`, {
    method,
    headers: { authorization: "Bearer valid", "content-type": "application/json" },
    body: JSON.stringify({ model: "m1", input: "hello" }),
  }));
}

describe("generic OpenAI passthrough", () => {
  test("forwards arbitrary v1 POST paths without using normalized routing", async () => {
    let received: { path: string; body: Readonly<Record<string, unknown>> } | null = null;
    const router = createPublicRouter(dependencies(async (input) => {
      received = { path: input.path, body: input.body };
      return Response.json({ object: "forwarded" }, { headers: { "x-upstream": "ok" } });
    }));
    const response = await call(router, "/v1/completions?beta=true");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream")).toBe("ok");
    expect(await response.json()).toEqual({ object: "forwarded" });
    expect(received).toEqual({ path: "/v1/completions?beta=true", body: { model: "m1", input: "hello" } });
  });

  test("keeps non-v1 paths out of passthrough", async () => {
    const router = createPublicRouter(dependencies(async () => Response.json({ object: "wrong" })));
    const response = await call(router, "/completions");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ type: "not-found" });
  });

  test("preserves normalized routes", async () => {
    let normalized = 0;
    const router = createPublicRouter({
      ...dependencies(async () => Response.json({ object: "wrong" })),
      proxy: {
        async handle() {
          normalized += 1;
          return { status: 200, headers: new Headers(), body: { mode: "json", value: { object: "normalized" } } };
        },
        async passthrough() { return Response.json({ object: "wrong" }); },
      },
    });
    const response = await call(router, "/v1/chat/completions");
    expect(response.status).toBe(200);
    expect(normalized).toBe(1);
  });
});
