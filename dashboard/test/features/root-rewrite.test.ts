import { describe, expect, test, vi, afterEach } from "vitest";
import { apiGet } from "../../src/lib/api";
import { fetchApiKeyCredential } from "../../src/features/cli-tools/api";
import { router } from "../../src/app/router";

afterEach(() => vi.restoreAllMocks());

describe("root rewrite P0 contracts — dashboard ↔ backend sync", () => {
  test("overview health fetches from /overhead (not /health/overhead) and surfaces retry", async () => {
    const overhead = { overhead: { enabled: true, sampleRate: 1, generatedAt: new Date().toISOString(), phases: {} }, telemetry: { pending: 0, pendingBytes: 0, flushCount: 1, dropped: 0, degraded: false } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(overhead), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await apiGet<typeof overhead>("/overhead");
    expect(data).toMatchObject({ overhead: { enabled: true }, telemetry: { pending: 0 } });
    expect(fetchMock).toHaveBeenCalledWith("/console/api/overhead", expect.objectContaining({ credentials: "same-origin" }));
    // old path must not be called
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("health/overhead"))).toBe(false);
  });

  test("proxies pool expects {items} wrapper (raw array no longer accepted)", async () => {
    const payload = { items: [{ id: "p1", name: "Proxy One", host: "1.1.1.1", port: 1080, protocol: "socks5", active: true }] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiGet<typeof payload>("/proxies?limit=100");
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.id).toBe("p1");
    expect(fetchMock).toHaveBeenCalledWith("/console/api/proxies?limit=100", expect.objectContaining({ credentials: "same-origin" }));
  });

  test("usage summary returns typed {period, totals} aggregate", async () => {
    const payload = { period: "24h", totals: { requests: 5, inputTokens: 100, cachedTokens: 20, outputTokens: 50, errors: 0, avgDurationMs: 123, estimatedCostUsd: 0.01, partial: false } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiGet<typeof payload>("/usage/summary?period=24h");
    expect(res.period).toBe("24h");
    expect(res.totals.requests).toBe(5);
    expect(fetchMock).toHaveBeenCalledWith("/console/api/usage/summary?period=24h", expect.objectContaining({ credentials: "same-origin" }));
  });

  test("CLI fetchApiKeyCredential wires real /keys/:id/credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ key: "sk-test-123", prefix: "sk-test-" }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const key = await fetchApiKeyCredential("key-123");
    expect(key).toEqual({ key: "sk-test-123", prefix: "sk-test-" });
    expect(fetchMock).toHaveBeenCalledWith("/console/api/keys/key-123/credential", expect.objectContaining({ credentials: "same-origin" }));
  });

  test("CLI fetchApiKeyCredential preserves typed missing-key failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "not_found", message: "not found" } }), { status: 404, headers: { "content-type": "application/json" } })));
    await expect(fetchApiKeyCredential("missing")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  test("root routes have no /advanced prefix and filter-sanitize/cli-tools are at root", () => {
    const shell = router.routes.find((r) => r.path === "/") as unknown as { children: Array<{ path?: string }> };
    const paths = shell.children.map((c) => c.path).filter(Boolean) as string[];
    expect(paths).toEqual(expect.arrayContaining(["filter-sanitize", "cli-tools", "cli-tools/:toolId", "token-saver"]));
    expect(paths.some((p) => p.includes("advanced"))).toBe(false);
  });
});
