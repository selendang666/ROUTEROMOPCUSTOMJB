import { describe, test, expect } from "bun:test";
import { fetchWithRedirectPolicy } from "./network.js";

describe("fetchWithRedirectPolicy cross-origin credential stripping", () => {
  test("strips Authorization and x-api-key and cookie across origins and strips body", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown; method: string | undefined }> = [];
    const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
      const headers = new Headers(init.headers as HeadersInit);
      const rec: Record<string, string> = {};
      headers.forEach((v, k) => (rec[k] = v));
      calls.push({ url, headers: rec, body: init.body, method: init.method as string | undefined });
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { location: "https://other.example.com/next" } });
      }
      return new Response("ok", { status: 200 });
    };

    const init: RequestInit = {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "x-api-key": "sk-secret",
        cookie: "session=abc",
        "content-type": "application/json",
        "x-custom": "keep",
      },
      body: JSON.stringify({ hello: "world" }),
    };

    const resp = await fetchWithRedirectPolicy("https://example.com/start", init, { fetcher, validator: () => {} });
    expect(resp.status).toBe(200);
    expect(calls.length).toBe(2);
    // first call retains credentials
    expect(calls[0]?.headers["authorization"]).toBe("Bearer secret");
    expect(calls[0]?.headers["x-api-key"]).toBe("sk-secret");
    // second call (cross-origin) must not have sensitive headers
    expect(calls[1]?.headers["authorization"]).toBeUndefined();
    expect(calls[1]?.headers["x-api-key"]).toBeUndefined();
    expect(calls[1]?.headers["cookie"]).toBeUndefined();
    // body should be stripped across origins
    expect(calls[1]?.body).toBeUndefined();
    // x-custom should be preserved
    expect(calls[1]?.headers["x-custom"]).toBe("keep");
  });

  test("preserves Authorization on same-origin redirect", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
      const headers = new Headers(init.headers as HeadersInit);
      const rec: Record<string, string> = {};
      headers.forEach((v, k) => (rec[k] = v));
      calls.push({ url, headers: rec });
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { location: "/next" } });
      }
      return new Response("ok", { status: 200 });
    };
    const init: RequestInit = { headers: { authorization: "Bearer secret" } };
    const resp = await fetchWithRedirectPolicy("https://example.com/start", init, { fetcher, validator: () => {} });
    expect(resp.status).toBe(200);
    expect(calls[1]?.headers["authorization"]).toBe("Bearer secret");
  });

  test("validates every hop via validator", async () => {
    const visited: string[] = [];
    let fetchCalls = 0;
    const fetcher = async (url: string, _init: RequestInit): Promise<Response> => {
      fetchCalls += 1;
      visited.push(url);
      if (fetchCalls === 1) {
        return new Response(null, { status: 302, headers: { location: "https://example.com/next" } });
      }
      return new Response("ok", { status: 200 });
    };
    const validator = async (url: string) => {
      visited.push(`validate:${url}`);
    };
    await fetchWithRedirectPolicy("https://example.com/start", {}, { fetcher, validator });
    expect(visited).toContain("validate:https://example.com/start");
    expect(visited).toContain("validate:https://example.com/next");
  });
});
