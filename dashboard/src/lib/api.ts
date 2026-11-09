/** API client — same-origin fetch to /console/api with 401 handling. */

const MAX_RESPONSE_BYTES = 10_485_760; // 10MiB — providers/routing payload can be ~7MiB

export interface ApiErrorShape {
  code: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function redirectToBanned(response: Response): Promise<void> {
  if (window.location.pathname.endsWith("/banned")) return;
  const headerRequestId = response.headers.get("x-request-id")?.trim() || "";
  let requestId = headerRequestId;
  try {
    // Read body once without cloning — we throw immediately after, so consuming is fine.
    const text = await response.text();
    if (text) {
      try {
        const value = JSON.parse(text) as { error?: { request_id?: string } };
        requestId = requestId || value.error?.request_id || "";
      } catch {
        // non-JSON body — ignore
      }
    }
    window.location.replace(requestId ? `/console/banned?rid=${encodeURIComponent(requestId)}` : "/console/banned");
  } catch {
    window.location.replace(headerRequestId ? `/console/banned?rid=${encodeURIComponent(headerRequestId)}` : "/console/banned");
  }
}

export async function api<T>(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const body = init.body;
  const headers = new Headers(init.headers);
  if (body !== undefined && !(body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  // Default 15s timeout; combine with caller signal via AbortSignal.any when available.
  let signal: AbortSignal | undefined = init.signal;
  try {
    // AbortSignal.timeout/any are modern APIs; feature-detect at runtime.
    const AbortSignalModern = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal; any?: (signals: AbortSignal[]) => AbortSignal };
    const timeoutSignal = typeof AbortSignalModern.timeout === "function" ? AbortSignalModern.timeout(15_000) : undefined;
    if (timeoutSignal) {
      if (signal) {
        if (typeof AbortSignalModern.any === "function") {
          signal = AbortSignalModern.any([signal, timeoutSignal]);
        }
      } else {
        signal = timeoutSignal;
      }
    }
  } catch {
    // ignore timeout signal creation failure; fall back to caller signal
    signal = init.signal;
  }
  const res = await fetch(`/console/api${path}`, {
    credentials: "same-origin",
    ...init,
    method,
    body,
    headers,
    signal,
  });
  return parseApiResponse<T>(path, res);
}

async function parseApiResponse<T>(path: string, res: Response): Promise<T> {
  if (res.status === 403) {
    // IP banned or rate-limit ban — redirect to error page with traceable requestId.
    // Avoid loop if already on /banned.
    await redirectToBanned(res);
    throw new ApiError(403, "forbidden", "Access denied — IP banned");
  }
  if (res.status === 401 && path !== "/login") {
    onUnauthorized?.();
    throw new ApiError(401, "unauthorized", "session expired");
  }
  // Early reject via content-length header without touching body.
  const contentLengthHeader = res.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  if (!Number.isNaN(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new ApiError(413, "payload_too_large", `response too large (${contentLength} bytes > ${MAX_RESPONSE_BYTES} bytes)`);
  }
  // Single body-read path: one arrayBuffer read, size-checked, then decoded.
  // Avoids the previous clone().json() + clone().arrayBuffer() double-allocation.
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_RESPONSE_BYTES) {
    throw new ApiError(413, "payload_too_large", `response too large (${buf.byteLength} bytes > ${MAX_RESPONSE_BYTES} bytes)`);
  }
  const text = buf.byteLength === 0 ? "" : new TextDecoder().decode(buf);
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const err = parsed as { error?: ApiErrorShape } | null;
    throw new ApiError(res.status, err?.error?.code ?? "error", err?.error?.message ?? `request failed (${res.status})`);
  }
  return parsed as T;
}

/** Execute a raw console API request while retaining response headers and body. */
export async function apiRaw(path: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  const body = init.body;
  const headers = new Headers(init.headers);
  if (body !== undefined && !(body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`/console/api${path}`, {
    credentials: "same-origin",
    ...init,
    method,
    body,
    headers,
  });
  if (res.status === 403) {
    await redirectToBanned(res);
    throw new ApiError(403, "forbidden", "Access denied — IP banned");
  }
  if (res.status === 401 && path !== "/login") {
    onUnauthorized?.();
    throw new ApiError(401, "unauthorized", "session expired");
  }
  return res;
}

/** Download a console API response, surfacing structured server errors. */
export async function apiDownload(path: string, init: RequestInit = {}): Promise<{ blob: Blob; filename: string | null }> {
  const res = await apiRaw(path, { ...init, method: init.method ?? "GET" });
  if (!res.ok) {
    await parseApiResponse<never>(path, res);
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const filename = disposition.match(/filename="?([^"]+)"?/)?.[1] ?? null;
  return { blob: await res.blob(), filename };
}

export const apiGet = <T>(path: string, init?: { signal?: AbortSignal }) =>
  api<T>(path, { method: "GET", signal: init?.signal });
export const apiPost = <T>(path: string, body?: unknown, init?: { signal?: AbortSignal }) =>
  api<T>(path, { method: "POST", body: body === undefined ? "{}" : JSON.stringify(body), signal: init?.signal });
export const apiPostForm = <T>(path: string, body: FormData, init?: { signal?: AbortSignal }) =>
  api<T>(path, { method: "POST", body, signal: init?.signal });
export const apiPatch = <T>(path: string, body?: unknown, init?: { signal?: AbortSignal }) =>
  api<T>(path, { method: "PATCH", body: body === undefined ? "{}" : JSON.stringify(body), signal: init?.signal });
// Sends a body so `content-type: application/json` is set for console mutations.
export const apiDelete = <T>(path: string, init?: { signal?: AbortSignal }) => api<T>(path, { method: "DELETE", body: "{}", signal: init?.signal });
