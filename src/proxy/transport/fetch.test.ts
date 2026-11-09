import { describe, expect, test } from "bun:test";
import { assertUpstreamContentType, executeFetch, readJsonObject } from "./fetch.js";
import { AbortCoordinator } from "./abort.js";

function coordinator() { return new AbortCoordinator(new AbortController().signal, { totalTimeoutMs: 5000 }); }
function res(ct: string | null, ok = true, body: string | null = "") {
  const headers = new Headers();
  if (ct) headers.set("content-type", ct);
  return new Response(body, { status: ok ? 200 : 500, headers });
}

describe("assertUpstreamContentType (merged from response.ts)", () => {
  test("accepts json and sse with params", async () => {
    await expect(assertUpstreamContentType(res("application/json"), "json", coordinator())).resolves.toBeUndefined();
    await expect(assertUpstreamContentType(res("application/json; charset=utf-8"), "json", coordinator())).resolves.toBeUndefined();
    await expect(assertUpstreamContentType(res("text/event-stream"), "sse", coordinator())).resolves.toBeUndefined();
    await expect(assertUpstreamContentType(res("text/event-stream; charset=utf-8"), "sse", coordinator())).resolves.toBeUndefined();
  });

  test("error status bypasses guard", async () => {
    await expect(assertUpstreamContentType(res("text/html", false), "json", coordinator())).resolves.toBeUndefined();
  });

  test("html on success throws provider_protocol_error", async () => {
    await expect(assertUpstreamContentType(res("text/html", true, "<html>bad</html>"), "json", coordinator())).rejects.toMatchObject({ kind: "provider_protocol_error" });
  });

  test("permissive for json-type on sse mock (tests compat)", async () => {
    await expect(assertUpstreamContentType(res("application/json"), "sse", coordinator())).resolves.toBeUndefined();
  });
});

describe("executeFetch", () => {
  test("uses the direct fetch path when no proxy is configured", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; proxy?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit & { proxy?: string }) => {
      calls.push({ url: String(input), proxy: init?.proxy });
      return new Response("direct", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    try {
      const response = await executeFetch("https://example.com/test", {}, coordinator(), null);
      expect(await response.text()).toBe("direct");
      expect(calls).toEqual([{ url: "https://example.com/test", proxy: undefined }]);
      expect(response.headers.get("x-ohmyomop-router-proxied")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("adds the proxied marker and proxy option when a proxy is configured", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; proxy?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit & { proxy?: string }) => {
      calls.push({ url: String(input), proxy: init?.proxy });
      return new Response("proxied", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    try {
      const response = await executeFetch("https://example.com/test", {}, coordinator(), { url: "http://proxy.local:8080", isRelay: false });
      expect(await response.text()).toBe("proxied");
      expect(calls).toEqual([{ url: "https://example.com/test", proxy: "http://proxy.local:8080" }]);
      expect(response.headers.get("x-ohmyomop-router-proxied")).toBe("1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("readJsonObject", () => {
  test("parses a bounded JSON body", async () => {
    const response = res("application/json", true, JSON.stringify({ ok: true, n: 1 }));
    await expect(readJsonObject(response, coordinator())).resolves.toMatchObject({ ok: true, n: 1 });
  });

  test("rejects oversized bodies as protocol errors", async () => {
    const response = res("application/json", true, JSON.stringify({ data: "x".repeat(128) }));
    await expect(readJsonObject(response, coordinator(), 16)).rejects.toMatchObject({ kind: "provider_protocol_error" });
  });
});
