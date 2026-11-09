import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  clientIpOf,
  clientIpForBan,
  createRateLimitGuard,
  createPublicBanAndRateLimitGuard,
  guardApiKeyHash,
  clearGuardHashCache,
  getGuardHashCacheSizeForTest,
  hasGuardHashPlaintextForTest,
  buildConsoleSessionCookie,
} from "./guard.js";

describe("forwarded IP spoofing and TRUST_PROXY", () => {
  const originalTrustProxy = Bun.env.TRUST_PROXY;

  afterEach(() => {
    if (originalTrustProxy === undefined) delete (Bun.env as Record<string, unknown>).TRUST_PROXY;
    else Bun.env.TRUST_PROXY = originalTrustProxy;
  });

  test("when TRUST_PROXY=false, forwarded-for is ignored", () => {
    Bun.env.TRUST_PROXY = "false";
    const req = new Request("http://example.com/", {
      headers: { "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" },
    });
    expect(clientIpOf(req)).toBe("5.6.7.8");
    // for ban, should also ignore forwarded when not trusting
    expect(clientIpForBan(req)).toBe("5.6.7.8");
  });

  test("when TRUST_PROXY=true, first forwarded IP is trusted if valid", () => {
    Bun.env.TRUST_PROXY = "true";
    const req = new Request("http://example.com/", {
      headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1", "x-real-ip": "5.6.7.8" },
    });
    expect(clientIpOf(req)).toBe("9.9.9.9");
    expect(clientIpForBan(req)).toBe("9.9.9.9");
  });

  test("invalid forwarded IP is ignored (treated as not present)", () => {
    Bun.env.TRUST_PROXY = "true";
    const req = new Request("http://example.com/", {
      headers: { "x-forwarded-for": "not-an-ip", "x-real-ip": "5.6.7.8" },
    });
    expect(clientIpOf(req)).toBe("5.6.7.8");
    const req2 = new Request("http://example.com/", {
      headers: { "x-forwarded-for": "evil.example.com" },
    });
    expect(clientIpOf(req2)).toBeNull();
    expect(clientIpForBan(req2)).toBe("127.0.0.1");
  });

  test("malformed x-real-ip is rejected", () => {
    Bun.env.TRUST_PROXY = "false";
    const req = new Request("http://example.com/", {
      headers: { "x-real-ip": "not-ip" },
    });
    expect(clientIpOf(req)).toBeNull();
  });
});

describe("rate limit clamping (NaN/negative/Infinity)", () => {
  test("NaN and negative and Infinity fallback to defaults and are clamped", async () => {
    const touches: Array<{ limit: number }> = [];
    const mockRateLimit = {
      touch: async (_ip: string, _scope: "open" | "console", limit: number) => {
        touches.push({ limit });
        return { count: 1, remaining: limit - 1, windowStartedAt: new Date().toISOString() };
      },
    };
    const mockSession = { verify: async () => ({ id: "s1" }) };

    // console guard with NaN env
    Bun.env.CONSOLE_RATE_LIMIT_PER_MIN = "NaN";
    const guard = createRateLimitGuard({ session: mockSession as never, rateLimit: mockRateLimit as never, ipBan: undefined } as never);
    const req = new Request("http://example.com/console/api/test", { headers: { "x-real-ip": "1.1.1.1" } });
    await guard({ request: req, set: {} } as never);
    expect(touches[0]?.limit).toBe(200);

    touches.length = 0;
    Bun.env.CONSOLE_RATE_LIMIT_PER_MIN = "-5";
    await guard({ request: req, set: {} } as never);
    expect(touches[0]?.limit).toBe(200);

    touches.length = 0;
    Bun.env.CONSOLE_RATE_LIMIT_PER_MIN = "Infinity";
    await guard({ request: req, set: {} } as never);
    expect(touches[0]?.limit).toBe(200);

    touches.length = 0;
    Bun.env.CONSOLE_RATE_LIMIT_PER_MIN = "999999";
    await guard({ request: req, set: {} } as never);
    expect(touches[0]?.limit).toBe(10000);
    expect(touches[0]?.limit).toBeLessThanOrEqual(10000);

    // public guard
    const touches2: Array<{ limit: number }> = [];
    const mockRateLimit2 = {
      touch: async (_ip: string, _scope: "open" | "console", limit: number) => {
        touches2.push({ limit });
        return { count: 1, remaining: limit - 1, windowStartedAt: new Date().toISOString() };
      },
    };
    Bun.env.OPEN_ENDPOINT_RATE_LIMIT_PER_MIN = "-100";
    const pubGuard = createPublicBanAndRateLimitGuard(undefined, mockRateLimit2 as never);
    const req2 = new Request("http://example.com/v1/chat/completions", { headers: { "x-real-ip": "1.1.1.1" } });
    await pubGuard({ request: req2, set: {} } as never);
    expect(touches2[0]?.limit).toBe(500);
    delete (Bun.env as Record<string, unknown>).CONSOLE_RATE_LIMIT_PER_MIN;
    delete (Bun.env as Record<string, unknown>).OPEN_ENDPOINT_RATE_LIMIT_PER_MIN;
  });

  test("rate guard works without ipBan storage", async () => {
    const touches: Array<{ limit: number }> = [];
    const mockRateLimit = {
      touch: async (_ip: string, _scope: "open" | "console", limit: number) => {
        touches.push({ limit });
        // exceed limit
        return { count: 9999, remaining: 0, windowStartedAt: new Date().toISOString() };
      },
    };
    const mockSession = { verify: async () => ({ id: "s1" }) };
    Bun.env.CONSOLE_RATE_LIMIT_PER_MIN = "2";
    const guard = createRateLimitGuard({ session: mockSession as never, rateLimit: mockRateLimit as never } as never);
    const req = new Request("http://example.com/console/api/test", { headers: { "x-real-ip": "1.1.1.1" } });
    const set: Record<string, unknown> = {};
    const result = await guard({ request: req, set } as never);
    expect(result).toBeDefined();
    expect((result as Response).status).toBe(429);
    delete (Bun.env as Record<string, unknown>).CONSOLE_RATE_LIMIT_PER_MIN;
  });
});

describe("guard API-key cache digest-keyed and TTL", () => {
  beforeEach(() => clearGuardHashCache());
  test("does not retain plaintext values", () => {
    const secret = "sk-test-secret-12345";
    const hash = guardApiKeyHash(secret);
    expect(hash).not.toBe(secret);
    expect(hasGuardHashPlaintextForTest(secret)).toBe(false);
    expect(getGuardHashCacheSizeForTest()).toBe(1);
  });

  test("cache expires after TTL", async () => {
    const secret = "sk-expire-test";
    guardApiKeyHash(secret);
    expect(getGuardHashCacheSizeForTest()).toBe(1);
    // Fast-forward time beyond TTL
    const origNow = Date.now;
    const base = origNow();
    (Date as unknown as { now: () => number }).now = () => base + 61_000;
    try {
      const hit = guardApiKeyHash(secret);
      // should have re-computed and still return same hash but entry refreshed
      expect(hit).toBeDefined();
      expect(getGuardHashCacheSizeForTest()).toBe(1);
    } finally {
      (Date as unknown as { now: () => number }).now = origNow;
    }
  });
});

describe("console cookie Secure behavior", () => {
  test("adds Secure only for https requests", () => {
    const httpReq = new Request("http://example.com/");
    const httpsReq = new Request("https://example.com/");
    const httpCookie = buildConsoleSessionCookie("tok123", httpReq);
    const httpsCookie = buildConsoleSessionCookie("tok123", httpsReq);
    expect(httpCookie).not.toContain("Secure");
    expect(httpsCookie).toContain("Secure");
    expect(httpsCookie).toContain("HttpOnly");
    expect(httpsCookie).toContain("SameSite=Lax");
  });
  test("buildConsoleSessionCookie without request omits Secure", () => {
    const c = buildConsoleSessionCookie("tok");
    expect(c).not.toContain("Secure");
  });
});
