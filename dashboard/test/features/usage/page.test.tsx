import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UsagePage } from "../../../src/features/usage/page";

function createRequestRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    requestId: id,
    endpoint: "/v1/chat/completions",
    surface: "openai",
    apiKeyId: "key-1",
    apiKeyPrefix: "sk-test",
    providerId: "openai",
    model: "gpt-4o-mini",
    statusCode: 200,
    errorKind: null,
    mode: "non_stream" as const,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 123,
    inputTokens: 10,
    outputTokens: 20,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: null,
    totalTokens: 30,
    usageSource: "stream",
    clientName: "test",
    clientSource: "test",
    routing: { requestedModel: "gpt-4o-mini", mappedModel: "gpt-4o-mini", upstreamModel: "gpt-4o-mini", wireSurface: "openai", errorMessage: null },
    messageCount: 1,
    toolCount: 0,
    imageCount: 0,
    tfftMs: 50,
    overhead: null,
    payloads: null,
    ...overrides,
  };
}

function createFetchMock(responses: Record<string, unknown>, onFetch?: (url: string) => void) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (onFetch) onFetch(url);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const key = Object.keys(responses).find((k) => path === k || path === `/console/api${k}` || path.endsWith(k));
    const body = key ? responses[key] : { items: [] };
    if (path.includes("/usage/requests/")) {
      const id = path.split("/").pop() ?? "unknown";
      const detail = (responses[`/usage/requests/${id}`] as unknown) ?? (responses[path] as unknown) ?? null;
      if (detail) return new Response(JSON.stringify(detail), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(body as unknown), { status: 200, headers: { "content-type": "application/json" } });
  });
}

function renderUsage(responses: Record<string, unknown>, onFetch?: (url: string) => void) {
  const fetchSpy = createFetchMock(responses, onFetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/console/usage"]}>
        <UsagePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { fetchSpy, view, client };
}

class FakeEventSource {
  static instance: FakeEventSource | null = null;
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, (e: MessageEvent) => void>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instance = this as unknown as FakeEventSource;
    queueMicrotask(() => this.onopen?.());
  }
  addEventListener(type: string, cb: EventListener) {
    this.listeners.set(type, cb as never);
  }
  close() {}
}

describe("UsagePage snapshot flow", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
        disconnect() {}
        unobserve() {}
      };
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instance = null;
  });

  test("first paint issues one by-* fetch shared between panels, not duplicated", async () => {
    const fetchedUrls: string[] = [];
    const responses: Record<string, unknown> = {
      "/usage/summary?period=24h&limit=1000": { period: "24h", totals: { requests: 5, inputTokens: 100, cachedTokens: 10, outputTokens: 50, errors: 0, avgDurationMs: 12, estimatedCostUsd: 0.01, partial: false } },
      "/usage/chart?period=24h": { buckets: [{ t: "2026-08-29T00:00:00Z", requests: 1, input: 10, cached: 0, output: 5 }] },
      "/usage/by-model?period=24h": { rows: [{ name: "gpt-4o-mini", requests: 5, input: 100, output: 50, cached: 10, total: 150, errors: 0, costUsd: 0.01 }] },
      "/usage/cache?period=24h": { period: "24h", inputTokens: 100, cachedTokens: 10, cacheWriteTokens: 5, hitRate: 10, rows: [] },
      "/usage/requests?limit=100": { items: [createRequestRow("req-1")] },
    };
    renderUsage(responses, (url) => fetchedUrls.push(url));
    await waitFor(() => expect(screen.getByText(/Requests per bucket/)).toBeInTheDocument());
    expect(screen.queryByText("TFFB")).not.toBeInTheDocument();
    await waitFor(() => expect(fetchedUrls.some((u) => u.includes("/usage/summary"))).toBe(true));
    const byModelCalls = fetchedUrls.filter((u) => u.includes("/usage/by-model")).length;
    expect(byModelCalls).toBe(1);
    const totalUsageCalls = fetchedUrls.filter((u) => u.includes("/usage/")).length;
    expect(totalUsageCalls).toBe(5);
  });

  test("request-detail fetch is deferred when row is already cached in snapshot", async () => {
    const fetchedUrls: string[] = [];
    const cached = createRequestRow("cached-1", { model: "cached-model" });
    const responses: Record<string, unknown> = {
      "/usage/summary?period=24h&limit=1000": { period: "24h", totals: { requests: 1, inputTokens: 10, cachedTokens: 0, outputTokens: 5, errors: 0, avgDurationMs: 10, estimatedCostUsd: 0, partial: false } },
      "/usage/chart?period=24h": { buckets: [] },
      "/usage/by-model?period=24h": { rows: [] },
      "/usage/cache?period=24h": { period: "24h", inputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, hitRate: 0, rows: [] },
      "/usage/requests?limit=100": { items: [cached] },
      "/usage/requests/cached-1": cached,
    };
    renderUsage(responses, (url) => fetchedUrls.push(url));
    await waitFor(() => expect(screen.getByText("cached-model")).toBeInTheDocument());
    fetchedUrls.length = 0;
    fireEvent.click(screen.getByText("cached-model"));
    await waitFor(() => expect(screen.getByText("Request Detail")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("cached-1")).toBeInTheDocument());
    expect(screen.queryByText("Time to First Byte (TFFB)")).not.toBeInTheDocument();
    expect(fetchedUrls.some((u) => u.includes("/usage/requests/cached-1"))).toBe(false);
  });

  test("request rows surface backend resolve time through TFFB", async () => {
    const row = createRequestRow("req-overhead", {
      model: "resolve-model",
      tfftMs: 11,
      tffbMs: 222,
      overhead: { totalMs: 999, total: 999, phases: [{ phase: "routing", durationMs: 5 }], marks: [{ phase: "routing", durationMs: 5 }] },
    });
    const responses: Record<string, unknown> = {
      "/usage/summary?period=24h&limit=1000": { period: "24h", totals: { requests: 1, inputTokens: 10, cachedTokens: 0, outputTokens: 5, errors: 0, avgDurationMs: 10, estimatedCostUsd: 0, partial: false } },
      "/usage/chart?period=24h": { buckets: [] },
      "/usage/by-model?period=24h": { rows: [] },
      "/usage/cache?period=24h": { period: "24h", inputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, hitRate: 0, rows: [] },
      "/usage/requests?limit=100": { items: [row] },
    };
    renderUsage(responses);
    await waitFor(() => expect(screen.getByText("resolve-model")).toBeInTheDocument());
    expect(screen.getByText("222ms")).toBeInTheDocument();
    expect(screen.queryByText("999ms")).not.toBeInTheDocument();
  });

  test("request list remains correct when windowed — count label matches total while visible rows are windowed", async () => {
    const items = Array.from({ length: 30 }, (_, i) => createRequestRow(`req-${i}`, { model: `model-${i}` }));
    const responses: Record<string, unknown> = {
      "/usage/summary?period=24h&limit=1000": { period: "24h", totals: { requests: 30, inputTokens: 300, cachedTokens: 0, outputTokens: 150, errors: 0, avgDurationMs: 10, estimatedCostUsd: 0, partial: false } },
      "/usage/chart?period=24h": { buckets: [] },
      "/usage/by-model?period=24h": { rows: [] },
      "/usage/cache?period=24h": { period: "24h", inputTokens: 300, cachedTokens: 0, cacheWriteTokens: 0, hitRate: 0, rows: [] },
      "/usage/requests?limit=100": { items },
    };
    renderUsage(responses);
    await waitFor(() => expect(screen.getByText("Showing 30 most recent requests")).toBeInTheDocument());
    const rows = screen.getAllByRole("row");
    const dataRows = rows.filter((r) => within(r).queryByText(/model-/));
    expect(dataRows.length).toBeGreaterThan(0);
    expect(dataRows.length).toBeLessThan(30);
    expect(screen.getByText("Showing 30 most recent requests")).toBeInTheDocument();
  });
});
