import { describe, test, expect } from "bun:test";
import { NetworkSelector, createUpstreamFetcher } from "./network.js";
import { SsrfGuardError } from "./network.js";
import { RelayCircuitBreaker } from "./relay-circuit.js";

describe("NetworkSelector real proxy selection", () => {
  test("preferDirect returns direct without consulting proxies", async () => {
    const selector = new NetworkSelector({
      proxies: [{ id: "p1", url: "http://proxy.example.com:8080" }],
    });
    const result = await selector.select({ providerId: "openai", affinityKey: "a1", preferDirect: true });
    expect(result?.proxyId).toBeNull();
    expect(result?.selection.url).toBeNull();
  });

  test("selects from eligible proxies round-robin and respects priority", async () => {
    const selector = new NetworkSelector({
      proxies: [
        { id: "p1", url: "http://p1.example.com:8080", priority: 10 },
        { id: "p2", url: "http://p2.example.com:8080", priority: 20 },
      ],
    });
    const r1 = await selector.select({ providerId: "openai", affinityKey: "k1" });
    const r2 = await selector.select({ providerId: "openai", affinityKey: "k2" });
    expect(r1?.proxyId).toBe("p1");
    expect(r2?.proxyId).toBe("p2");
    const r3 = await selector.select({ providerId: "openai", affinityKey: "k3" });
    expect(r3?.proxyId).toBe("p1");
  });

  test("uses the proxy selected by the route candidate", async () => {
    const selector = new NetworkSelector({
      proxies: [
        { id: "p1", url: "http://p1.example.com:8080" },
        { id: "p2", url: "http://p2.example.com:8080" },
      ],
    });

    const result = await selector.select({ providerId: "openai", affinityKey: "k1", preferredProxyId: "p2" });

    expect(result?.proxyId).toBe("p2");
    expect(result?.selection.url).toBe("http://p2.example.com:8080");
  });

  test("sticky affinity pins same proxy for same key", async () => {
    const selector = new NetworkSelector({
      proxies: [
        { id: "p1", url: "http://p1.example.com:8080" },
        { id: "p2", url: "http://p2.example.com:8080" },
      ],
    });
    const a1 = await selector.select({ providerId: "openai", affinityKey: "user123", sticky: true });
    const a2 = await selector.select({ providerId: "openai", affinityKey: "user123", sticky: true });
    expect(a1?.proxyId).toBe(a2?.proxyId);
    const b = await selector.select({ providerId: "openai", affinityKey: "user456", sticky: true });
    // different affinity may get different proxy but still from pool
    expect(["p1", "p2"]).toContain(b?.proxyId);
  });

  test("filters unhealthy and empty url proxies -> direct fallback", async () => {
    const selector = new NetworkSelector({
      proxies: [{ id: "p1", url: "", healthy: false }],
    });
    const result = await selector.select({ providerId: "openai", affinityKey: "k" });
    expect(result?.proxyId).toBeNull();
    expect(result?.selection.url).toBeNull();
  });

  test("getProxies async source is awaited", async () => {
    const selector = new NetworkSelector({
      getProxies: async () => [{ id: "p1", url: "socks5://proxy.example.com:1080", isRelay: false }],
    });
    const result = await selector.select({ providerId: "openai", affinityKey: "k" });
    expect(result?.proxyId).toBe("p1");
    expect(result?.selection.url).toBe("socks5://proxy.example.com:1080");
  });

  test("skips an open relay and reports all-open instead of direct fallback", async () => {
    let now = 0;
    const circuit = new RelayCircuitBreaker({ now: () => now });
    const selector = new NetworkSelector({
      circuit,
      proxies: [{ id: "relay-1", url: "https://relay.example.com", isRelay: true }],
    });
    circuit.recordFailure("relay-1");
    circuit.recordFailure("relay-1");
    expect(await selector.select({ providerId: "openai", affinityKey: "k" })).toBeNull();
    now = 30_000;
    expect((await selector.select({ providerId: "openai", affinityKey: "k" }))?.proxyId).toBe("relay-1");
  });

  test("keeps non-relay proxies available while a relay is open", async () => {
    const circuit = new RelayCircuitBreaker({ now: () => 0 });
    const selector = new NetworkSelector({
      circuit,
      proxies: [
        { id: "relay-1", url: "https://relay.example.com", isRelay: true, priority: 1 },
        { id: "http-1", url: "http://proxy.example.com:8080", priority: 2 },
      ],
    });
    circuit.recordFailure("relay-1");
    circuit.recordFailure("relay-1");
    const result = await selector.select({ providerId: "openai", affinityKey: "k" });
    expect(result?.proxyId).toBe("http-1");
  });

  test("automatically dispatches deployment relays with relay headers", async () => {
    const originalFetch = globalThis.fetch;
    let receivedUrl = "";
    let receivedHeaders: Headers | null = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      receivedUrl = String(url);
      receivedHeaders = new Headers(init?.headers);
      return new Response("ok");
    }) as typeof fetch;
    try {
      const fetcher = createUpstreamFetcher({ proxy: { url: "https://relay.vercel.app", relaySecret: "relay-secret" } });
      await fetcher("https://api.cerebras.ai/v1/chat/completions?trace=1", { headers: { host: "api.cerebras.ai" } });

      expect(receivedUrl).toBe("https://relay.vercel.app/");
      expect(receivedHeaders?.get("x-relay-target")).toBe("https://api.cerebras.ai");
       expect(receivedHeaders?.get("x-relay-path")).toBe("/v1/chat/completions?trace=1");
       expect(receivedHeaders?.get("x-upstream-path")).toBe("/v1/chat/completions?trace=1");
       expect(receivedHeaders?.get("x-relay-secret")).toBe("relay-secret");
      expect(receivedHeaders?.get("host")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("createUpstreamFetcher redirect + SSRF validation", () => {
  test("direct path validates redirect hop via SSRF (private IP after redirect is rejected)", async () => {
    let calls = 0;
    const fakeFetcher = async (url: string, _init: RequestInit): Promise<Response> => {
      calls++;
      if (calls === 1) {
        return new Response(null, { status: 302, headers: { location: "http://10.0.0.1/evil" } });
      }
      return new Response("ok", { status: 200 });
    };
    // We inject fake fetcher via fetchWithSsrfGuard? Instead test createUpstreamFetcher's validator.
    // createUpstreamFetcher uses assertPublicUrlAtDispatch which will check 10.0.0.1 as IP literal and block.
    const fetcher = createUpstreamFetcher({});
    // Monkey-patch global fetch for the duration
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fakeFetcher }).fetch = fakeFetcher as unknown as typeof fetch;
    try {
      await expect(fetcher("http://example.com/start", {})).rejects.toThrow(SsrfGuardError);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("proxied fetcher uses same redirect policy (validates hops)", async () => {
    const calls: string[] = [];
    const proxyFetcherCalls: string[] = [];
    // build a fetcher that records urls and returns redirect then success
    const fetcher = createUpstreamFetcher({
      proxy: { url: "http://proxy.example.com:8080" },
    });
    // Replace buildProxyFetcher indirectly by mocking fetch used by httpProxyFetcher
    // httpProxyFetcher uses global fetch with proxy option; we mock fetch to simulate proxy
    const origFetch = globalThis.fetch;
    const mockFetch = async (url: string, _init: RequestInit): Promise<Response> => {
      proxyFetcherCalls.push(url);
      if (proxyFetcherCalls.length === 1) {
        return new Response(null, { status: 302, headers: { location: "http://10.0.0.5/evil" } });
      }
      return new Response("proxied-ok", { status: 200 });
    };
    (globalThis as unknown as { fetch: typeof mockFetch }).fetch = mockFetch as unknown as typeof fetch;
    try {
      await expect(fetcher("http://example.com/start", {})).rejects.toThrow(SsrfGuardError);
      expect(proxyFetcherCalls.length).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
    void calls;
  });
});
