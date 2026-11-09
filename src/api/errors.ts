/**
 * HTTP response serialization and security headers for public API surfaces.
 */

const HSTS = "max-age=63072000; includeSubDomains";

// The console shell loads Inter from Google Fonts, so those origins must be
// allow-listed or the CSP silently drops the webfont.
const CONSOLE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self'; font-src 'self' https://fonts.gstatic.com; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'";

export const SAFE_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-robots-tag": "noindex, nofollow",
} as const);

export const SAFE_HEADERS_HTML = Object.freeze({
  "x-frame-options": "DENY",
  "content-security-policy": CONSOLE_CSP,
} as const);

export const SAFE_HEADERS_HSTS = HSTS;

/** Supported codes in externally serialized proxy errors. */
export type ProxyErrorCode =
  | "invalid_request"
  | "request_too_large"
  | "uri_too_long"
  | "authentication_failed"
  | "authorization_denied"
  | "quota_exceeded"
  | "rate_limit_error"
  | "concurrency_limit"
  | "model_not_found"
  | "context_overflow"
  | "capability_unsupported"
  | "network_unavailable"
  | "provider_unavailable"
  | "provider_protocol_error"
  | "request_timeout"
  | "request_cancelled"
  | "internal_error";

/** JSON body returned for an API error. */
export interface ErrorEnvelope {
  readonly error: {
    readonly type: "error";
    readonly code: ProxyErrorCode;
    readonly message: string;
    readonly request_id: string;
  };
}

/** Controls HTTP security headers attached to a response. */
export interface SecurityHeaderOptions {
  readonly request?: Request;
  readonly html?: boolean;
  readonly noStore?: boolean;
  readonly https?: boolean;
  /** Public marketing pages must stay indexable; private shells stay noindex. */
  readonly indexable?: boolean;
}

const TRUST_PROXY_ENABLED =
  typeof Bun !== "undefined" &&
  (Bun.env.TRUST_PROXY === "1" || Bun.env.TRUST_PROXY?.toLowerCase() === "true");

const PUBLIC_ORIGIN_IS_HTTPS =
  typeof Bun !== "undefined" && (Bun.env.PUBLIC_ORIGIN ?? "").trim().startsWith("https://");

/**
 * True when the *client* request was HTTPS.
 *
 * Behind a reverse proxy or tunnel the process only ever sees a plaintext hop,
 * so `request.url` is `http://…` even though the user is on HTTPS. Without this
 * the app never emits HSTS and never marks the session cookie `Secure`.
 *
 * `x-forwarded-proto` is only honoured when TRUST_PROXY is enabled, otherwise
 * any client could spoof it and force a `Secure` cookie over plain HTTP.
 *
 * With no request at all this stays conservative (`false`) — callers such as
 * `buildConsoleSessionCookie` must not gain `Secure` from ambient config.
 */
export function requestIsSecure(request?: Request): boolean {
  if (request === undefined) return false;
  if (request.url.startsWith("https://")) return true;
  if (!TRUST_PROXY_ENABLED) return false;
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded === null) return false;
  return forwarded.split(",")[0]?.trim().toLowerCase() === "https";
}

/**
 * True when clients reach this deployment over HTTPS, per PUBLIC_ORIGIN.
 *
 * Route helpers frequently build a response without the request, which is why
 * HSTS has to be decidable from configuration as well as from the request.
 */
export function deploymentIsHttps(): boolean {
  return PUBLIC_ORIGIN_IS_HTTPS;
}

/** Applies the standard API security-header policy to headers. */
export function applySecurityHeaders(headers: Headers, options: SecurityHeaderOptions = {}): void {
  for (const [key, value] of Object.entries(SAFE_HEADERS)) {
    if (options.indexable === true && key === "x-robots-tag") continue;
    headers.set(key, value);
  }
  if (options.noStore) headers.set("cache-control", "no-store");
  if (options.html) {
    for (const [key, value] of Object.entries(SAFE_HEADERS_HTML)) headers.set(key, value);
  }
  // HSTS: from the request when one is available, otherwise from the configured
  // public origin — many route helpers build responses without the request.
  const secure =
    options.https === true ||
    requestIsSecure(options.request) ||
    (options.request === undefined && deploymentIsHttps());
  if (secure) {
    headers.set("strict-transport-security", HSTS);
  }
}

/** Adds the standard API security policy to an existing response. */
export function secureResponse(response: Response, options: SecurityHeaderOptions = {}): Response {
  const headers = new Headers(response.headers);
  applySecurityHeaders(headers, options);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Serializes a safe public error body using an allowed public error code. */
export function errorResponse(
  status: number,
  code: ProxyErrorCode,
  message: string,
  requestId: string = crypto.randomUUID(),
): Response {
  const headers = new Headers({ "cache-control": "no-store", "x-request-id": requestId });
  applySecurityHeaders(headers, { noStore: true });
  const body: ErrorEnvelope = { error: { type: "error", code, message, request_id: requestId } };
  return Response.json(body, { status, headers });
}

/** Serializes a JSON API response with request and security headers. */
export function jsonResponse(
  value: unknown,
  init: { status?: number; headers?: Headers | Record<string, string>; requestId?: string; request?: Request } = {},
): Response {
  const headers = new Headers(init.headers);
  if (init.requestId) headers.set("x-request-id", init.requestId);
  applySecurityHeaders(headers, { request: init.request, noStore: true });
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return Response.json(value as Record<string, unknown>, { status: init.status ?? 200, headers });
}
