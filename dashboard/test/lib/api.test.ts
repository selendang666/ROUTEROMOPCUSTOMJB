import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api, apiDelete, apiGet, setUnauthorizedHandler } from "../../src/lib/api";

describe("dashboard API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setUnauthorizedHandler(() => undefined);
  });

  test("redirects unauthorized protected requests through the handler", async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));

    await expect(api("/overview")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  test("preserves structured API errors and handles non-JSON bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "bad_request", message: "invalid" } }), { status: 400 })));
    await expect(api("/settings")).rejects.toEqual(new ApiError(400, "bad_request", "invalid"));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream unavailable", { status: 502 })));
    await expect(api("/settings")).rejects.toEqual(new ApiError(502, "error", "request failed (502)"));
  });

  test("sends JSON content type without a CSRF bootstrap for destructive mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiDelete("/logs");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/console/api/logs", expect.objectContaining({ method: "DELETE", body: "{}", credentials: "same-origin" }));
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("x-ohmyomop-router-csrf")).toBe(false);
  });

  test("sends safe reads as GET with query string", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api("/usage/requests?limit=25&cursor=next");
    expect(fetchMock).toHaveBeenCalledWith("/console/api/usage/requests?limit=25&cursor=next", expect.objectContaining({
      method: "GET",
      credentials: "same-origin",
    }));
  });

  test("enforces 10MiB limit via content-length header before reading body", async () => {
    const bigHeaders = new Headers({ "content-length": String(10_485_761) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200, headers: bigHeaders })));
    await expect(apiGet("/providers")).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
  });

  test("enforces 10MiB limit via actual body size when header missing", async () => {
    const overLimit = "a".repeat(10_485_761);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(overLimit, { status: 200 })));
    await expect(api("/providers")).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
  });

  test("parses JSON through a single body read without cloning", async () => {
    const cloneSpy = vi.spyOn(Response.prototype, "clone");
    const payload = JSON.stringify({ items: [{ id: "openai" }] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(payload, { status: 200, headers: { "content-type": "application/json" } })));
    const data = await apiGet<{ items: Array<{ id: string }> }>("/providers");
    expect(data).toEqual({ items: [{ id: "openai" }] });
    expect(cloneSpy).not.toHaveBeenCalled();
    cloneSpy.mockRestore();
  });
});
