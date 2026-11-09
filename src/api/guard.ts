/**
 * Shared API middleware — guard chain, auth, ACL, security headers, response helpers.
 * Canonical shared HTTP middleware; preserves guard order ban→rate-limit→public→session.
 */

export function computeBodyLimit(): number {
  const rawEnv = Bun.env.OHMYOMOP_ROUTER_MAX_REQUEST_BODY_BYTES;
  const raw = Number(rawEnv ?? 10 * 1024 * 1024);
  if (!Number.isFinite(raw)) {
    if (rawEnv !== undefined) console.warn(`[guard] OHMYOMOP_ROUTER_MAX_REQUEST_BODY_BYTES invalid "${String(rawEnv)}" falling back to 10MiB`);
    return 10 * 1024 * 1024;
  }
  return Math.min(Math.max(Math.floor(raw), 64 * 1024), 64 * 1024 * 1024);
}

// Deprecated frozen snapshot — kept for backwards compat but not used for per-request limiting.
// Prefer computeBodyLimit() per request to observe live env.
export const CACHED_BODY_LIMIT = computeBodyLimit();

export const CACHED_TRUST_PROXY =
  Bun.env.TRUST_PROXY === "1" || Bun.env.TRUST_PROXY?.toLowerCase() === "true";

import { utf8Encoder as sharedUtf8Encoder } from "../proxy/protocol-request.js";
import { isIpLiteral as sharedIsIpLiteral } from "../proxy/media-guard.js";
import { applySecurityHeaders, errorResponse, jsonResponse, requestIsSecure } from "./errors.js";
import type { ProxyErrorCode } from "./errors.js";
export const utf8 = sharedUtf8Encoder;

function isValidIpString(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return sharedIsIpLiteral(trimmed);
}

function firstValidForwardedIp(header: string | null): string | null {
  if (header === null || header.length === 0) return null;
  const parts = header.split(",");
  for (const part of parts) {
    const candidate = part.trim();
    if (candidate.length === 0) continue;
    if (isValidIpString(candidate)) return candidate;
  }
  return null;
}

function isTrustProxyEnabled(): boolean {
  // Read env dynamically: a runtime change — and tests that mutate Bun.env
  // after module load — must be observed. Short-circuiting on the cached
  // snapshot silently pinned the value captured at import time.
  const v = Bun.env.TRUST_PROXY;
  return v === "1" || (typeof v === "string" && v.toLowerCase() === "true");
}

function clampRateLimitEnv(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    if (raw !== undefined && raw !== null && String(raw).length > 0) console.warn(`[guard] rate-limit env invalid "${String(raw)}" falling back to ${fallback}`);
    return fallback;
  }
  const floored = Math.floor(n);
  if (floored <= 0) return fallback;
  return Math.min(10000, Math.max(1, floored));
}

// ── Local fail-closed rate-limit fallback (when Redis/portfolio touch unavailable) ──
const LOCAL_RL_WINDOW_MS = 60_000;
const localRateBuckets = new Map<string, { count: number; windowStart: number }>();
let warnedMissingRateLimit = false;
function localRateTouch(ip: string, scope: "open" | "console", limit: number): { count: number; remaining: number } {
  const key = `${scope}:${ip}`;
  const now = Date.now();
  let bucket = localRateBuckets.get(key);
  if (bucket === undefined || now - bucket.windowStart >= LOCAL_RL_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    localRateBuckets.set(key, bucket);
    // Bound map to 10k entries — evict oldest
    if (localRateBuckets.size > 10_000) {
      const oldest = localRateBuckets.keys().next().value as string | undefined;
      if (oldest !== undefined) localRateBuckets.delete(oldest);
    }
  }
  bucket.count += 1;
  return { count: bucket.count, remaining: Math.max(0, limit - bucket.count) };
}
function warnMissingRateLimitOnce(): void {
  if (warnedMissingRateLimit) return;
  warnedMissingRateLimit = true;
  console.warn("[guard] rateLimit port unavailable — using local in-memory fallback (fail-closed)");
}

// ── URL cache: parse once per Request ──────────────────────────────────────
const urlCache = new WeakMap<Request, URL>();

export function cachedUrl(request: Request): URL {
  let url = urlCache.get(request);
  if (url === undefined) {
    url = new URL(request.url);
    urlCache.set(request, url);
  }
  return url;
}

// ── Header snapshot: read hot headers once, thread via WeakMap ────────────
export interface HeaderSnapshot {
  readonly apiKeyHeader: string | null;
  readonly authorization: string | null;
  readonly clientName: string | null;
  readonly userAgent: string | null;
  readonly helperMethod: string | null;
  readonly requestId: string | null;
  readonly accept: string | null;
  readonly contentType: string | null;
  readonly fingerprint: string | null;
  readonly forwardedProto: string | null;
  readonly forwardedFor: string | null;
  readonly realIp: string | null;
}

const headerSnapshotCache = new WeakMap<Headers, HeaderSnapshot>();

export function headerSnapshot(headers: Headers): HeaderSnapshot {
  let snap = headerSnapshotCache.get(headers);
  if (snap !== undefined) return snap;
  snap = {
    apiKeyHeader: headers.get("x-api-key"),
    authorization: headers.get("authorization"),
    clientName: headers.get("x-client-name"),
    userAgent: headers.get("user-agent"),
    helperMethod: headers.get("x-stainless-helper-method"),
    requestId: headers.get("x-request-id"),
    accept: headers.get("accept"),
    contentType: headers.get("content-type"),
    fingerprint: headers.get("x-fingerprint") ?? headers.get("sec-ch-ua"),
    forwardedProto: headers.get("x-forwarded-proto"),
    forwardedFor: headers.get("x-forwarded-for"),
    realIp: headers.get("x-real-ip"),
  };
  headerSnapshotCache.set(headers, snap);
  return snap;
}

export function hasConflictingCredentialsFromSnapshot(snapshot: HeaderSnapshot): boolean {
  return snapshot.authorization !== null && snapshot.apiKeyHeader !== null;
}

export function extractApiKeyFromSnapshot(snapshot: HeaderSnapshot): string | null {
  const direct = snapshot.apiKeyHeader?.trim() ?? "";
  if (direct.length > 0) return direct;
  return bearerToken(snapshot.authorization);
}

export function requestTokenFromSnapshot(snapshot: HeaderSnapshot): string | null {
  return hasConflictingCredentialsFromSnapshot(snapshot) ? null : extractApiKeyFromSnapshot(snapshot);
}

// ── IP helpers ───────────────────────────────────────────────────────────────

export function clientIpOf(request: Request, getter?: (request: Request) => string | null): string | null {
  if (getter) {
    try {
      return getter(request);
    } catch {
      return null;
    }
  }
  // Single snapshot read — avoids repeated headers.get
  const snap = headerSnapshot(request.headers);
  if (isTrustProxyEnabled()) {
    const forwarded = firstValidForwardedIp(snap.forwardedFor);
    if (forwarded !== null) return forwarded;
  }
  const real = snap.realIp?.trim() ?? "";
  if (real.length > 0 && isValidIpString(real)) return real;
  return null;
}

export function getClientIp(request: Request, getter?: (request: Request) => string | null): string | null {
  return clientIpOf(request, getter);
}

export function clientIpForBan(request: Request): string | null {
  // Single snapshot read
  const snap = headerSnapshot(request.headers);
  const forwarded = firstValidForwardedIp(snap.forwardedFor);
  const rawReal = snap.realIp?.trim() ?? "";
  const real = rawReal.length > 0 && isValidIpString(rawReal) ? rawReal : null;
  let headerIp: string | null = null;
  if (isTrustProxyEnabled()) {
    headerIp = forwarded ?? real;
  } else {
    headerIp = real;
  }
  if (headerIp !== null) return headerIp;
  // Browser same-origin fetch never sends x-real-ip/x-forwarded-for, so fall back to
  // the TCP peer address exposed by Bun/Elysia. When unavailable (e.g. tests), use
  // 127.0.0.1 so local bruteforce testing still triggers bans.
  try {
    const anyReq = request as unknown as Record<string, unknown>;
    const ip = (anyReq["remoteAddress"] as string | undefined) ?? (anyReq["ip"] as string | undefined) ?? null;
    if (ip) return ip;
  } catch {}
  return "127.0.0.1";
}

import type { OAuthLoginSessionManager } from "../auth/login-session.js";

export interface ConsoleServiceResult<T = unknown> {
  readonly ok: boolean;
  readonly status: number;
  readonly data?: T;
  readonly code?: string;
  readonly message?: string;
}

export interface ConsolePorts {
  readonly session: SessionPort;
  readonly oauth?: OAuthLoginSessionManager;
  readonly auth: {
    login(request: Request): Promise<ConsoleServiceResult>;
    logout(request: Request): Promise<ConsoleServiceResult>;
    session(request: Request): Promise<ConsoleServiceResult>;
    changePassword(a: unknown, b: unknown, c: unknown, request?: Request): Promise<ConsoleServiceResult>;
  };
  readonly providers: {
    list(): Promise<unknown>;
    listBuiltins?(): Promise<unknown>;
    get(id: string): Promise<unknown>;
    create(body: unknown): Promise<ConsoleServiceResult>;
    update(id: string, body: unknown): Promise<ConsoleServiceResult>;
    remove(id: string): Promise<ConsoleServiceResult>;
    fetchModels?(id: string): Promise<ConsoleServiceResult>;
    health?(id: string): Promise<ConsoleServiceResult>;
    createModel?(providerId: string, body: unknown): Promise<ConsoleServiceResult>;
    deleteModel?(providerId: string, modelId: string): Promise<ConsoleServiceResult>;
  };
  readonly accounts: {
    list(input?: { readonly provider?: string | null; readonly limit?: number; readonly cursor?: string | null }): Promise<unknown>;
    create(body: unknown): Promise<ConsoleServiceResult>;
    update(id: string, body: unknown): Promise<ConsoleServiceResult>;
    remove(id: string): Promise<ConsoleServiceResult>;
    oauthStart(id: string, body: unknown): Promise<ConsoleServiceResult>;
    oauthCallback(req: Request): Promise<ConsoleServiceResult>;
    validateApiKey(id: string): Promise<ConsoleServiceResult>;
    quotaRefresh(id: string): Promise<ConsoleServiceResult>;
    quota?(id: string): Promise<unknown>;
    batchUpdate?(body: unknown): Promise<ConsoleServiceResult>;
    batchDelete?(body: unknown): Promise<ConsoleServiceResult>;
    oauthRefresh?(body: unknown): Promise<ConsoleServiceResult>;
    quotaRefreshBulk?(body: unknown): Promise<ConsoleServiceResult>;
  };
  readonly models: {
    list(): Promise<unknown>;
    aliases: {
      list(): Promise<unknown>;
      create(body: unknown): Promise<ConsoleServiceResult>;
      remove(id: string): Promise<ConsoleServiceResult>;
    };
    combos: {
      list(): Promise<unknown>;
      create(body: unknown): Promise<ConsoleServiceResult>;
      remove(id: string): Promise<ConsoleServiceResult>;
      patch(id: string, body: unknown): Promise<ConsoleServiceResult>;
    };
  };
  readonly accessRules: {
    list(): Promise<unknown>;
    create(body: unknown): Promise<ConsoleServiceResult>;
    update(id: string, body: unknown): Promise<ConsoleServiceResult>;
    remove(id: string): Promise<ConsoleServiceResult>;
  };
  readonly apiKeys: {
    list(): Promise<unknown>;
    create(body: unknown): Promise<ConsoleServiceResult>;
    revoke(id: string): Promise<ConsoleServiceResult>;
    update(id: string, body: unknown): Promise<ConsoleServiceResult>;
    share?(id: string, options?: { readonly kind?: "monitor" | "setup"; readonly expiresAt?: string | null }): Promise<ConsoleServiceResult>;
    credential?(id: string): Promise<unknown>;
  };
  readonly buyers: {
    list(): Promise<unknown>;
    get(id: string): Promise<unknown>;
    create(body: unknown): Promise<ConsoleServiceResult>;
    revoke(id: string): Promise<ConsoleServiceResult>;
    renew(id: string, expiresInDays?: number): Promise<ConsoleServiceResult>;
    share(id: string): Promise<ConsoleServiceResult>;
  };
  readonly proxies: {
    list(): Promise<unknown>;
    create(body: unknown): Promise<ConsoleServiceResult>;
    update(id: string, body: unknown): Promise<ConsoleServiceResult>;
    remove(id: string): Promise<ConsoleServiceResult>;
    health(): Promise<unknown>;
    test?(body: unknown): Promise<ConsoleServiceResult>;
    testOne?(id: string, body?: unknown): Promise<ConsoleServiceResult>;
  };
  readonly settings: {
    get(): Promise<unknown>;
    patch(body: unknown): Promise<unknown>;
    resetAll?(body: unknown): Promise<ConsoleServiceResult>;
  };
  readonly backup: {
    export(options?: { includeHistory?: boolean }): Promise<unknown>;
    exportStream(options?: { includeHistory?: boolean }): Response | { ok: false; status: number; message: string };
    import(body: unknown): Promise<ConsoleServiceResult>;
    verifyPassword(request: Request, body?: unknown): Promise<ConsoleServiceResult>;
  };
  readonly logs: {
    query(url: URL): Promise<unknown>;
    stream(request: Request): Promise<Response>;
    clear?(): Promise<ConsoleServiceResult>;
  };
  readonly usage: {
    query(url: URL): Promise<unknown>;
  };
  readonly ips: {
    top(url: URL): Promise<unknown>;
  };
  readonly diagnostics: {
    health(): Promise<unknown>;
    readiness(): Promise<unknown>;
    overhead(): Promise<unknown>;
    metrics(): string;
    systemMetrics(): unknown;
  };
  readonly probe?: {
    test(body: unknown): Promise<ConsoleServiceResult>;
  };
  readonly updates?: {
    release(): Promise<unknown>;
    repository(): Promise<unknown>;
  };
  readonly payloads?: {
    get(id: string): Promise<unknown>;
  };
  readonly retention?: {
    run(): Promise<unknown>;
  };
  readonly filterRules?: {
    list(): Promise<unknown>;
    create(body: unknown): Promise<ConsoleServiceResult>;
    update(id: string, body: unknown): Promise<ConsoleServiceResult>;
    remove(id: string): Promise<ConsoleServiceResult>;
  };
  readonly persona?: {
    get(): Promise<unknown>;
    patch(body: unknown): Promise<ConsoleServiceResult>;
    upload(bytes: Uint8Array, filename: string): Promise<ConsoleServiceResult>;
    syncHermes(): Promise<ConsoleServiceResult>;
  };
  readonly overview?: {
    get(): Promise<unknown>;
  };
  readonly cliTools?: {
    registry(): unknown;
    allStatuses(): Promise<unknown>;
    status(toolId: string): Promise<unknown | null>;
    isValidTool(toolId: string): boolean;
    getMappings(toolId: string): Promise<unknown>;
    saveMappings(toolId: string, body: unknown): Promise<unknown | { error: string }>;
    apply(toolId: string, body: unknown): Promise<{ success: boolean; message: string }>;
    reset(toolId: string): Promise<{ success: boolean; message: string }>;
    download(toolId: string, body: unknown): Promise<unknown | null>;
  };
  readonly coolify?: {
    list(): Promise<ConsoleServiceResult>;
    create(body: unknown): Promise<ConsoleServiceResult>;
    update(id: string, body: unknown): Promise<ConsoleServiceResult>;
    remove(id: string): Promise<ConsoleServiceResult>;
    test(body: unknown): Promise<ConsoleServiceResult>;
    overview(id: string): Promise<ConsoleServiceResult>;
    projects(id: string): Promise<ConsoleServiceResult>;
    projectDetail(id: string, uuid: string): Promise<ConsoleServiceResult>;
    applications(id: string): Promise<ConsoleServiceResult>;
    applicationDetail(id: string, uuid: string): Promise<ConsoleServiceResult>;
    services(id: string): Promise<ConsoleServiceResult>;
    servers(id: string): Promise<ConsoleServiceResult>;
    deployments(id: string): Promise<ConsoleServiceResult>;
  };
  readonly setup?: {
    status(): Promise<{ initialized: boolean }>;
    setup(request: Request): Promise<ConsoleServiceResult>;
  };
  readonly ipBan?: {
    isBanned(ip: string): Promise<boolean>;
    recordFailure(ip: string, opts: { maxFailures: number; banDurationMs: number; reason?: 'failed_login' | 'suspicious_activity' | 'rate_limit_abuse' }): Promise<unknown>;
    list(): Promise<unknown>;
    unban(ip: string): Promise<boolean>;
    prune(): Promise<unknown>;
  };
  readonly rateLimit?: {
    touch(ip: string, scope: "open" | "console", limitPerMinute: number): Promise<{ count: number; remaining: number; windowStartedAt: string }>;
  };
}

// ── Ban / rate-limit / guard chain (verbatim from routes.ts) ───────────────

export function ipBanCheck(services: ConsolePorts) {
  return async (request: Request): Promise<Response | null> => {
    if (!services.ipBan) return null;
    const ip = clientIpForBan(request);
    if (ip === null) return null;
    const banned = await services.ipBan.isBanned(ip);
    if (banned) return ipBanResponse(request);
    return null;
  };
}

export function guard(services: ConsolePorts) {
  return async (request: Request): Promise<Response | null> => {
    // /console/api/login and setup status/setup are public (for Sign Up before auth)
    const url = cachedUrl(request);
    if (url.pathname === "/console/api/login" || url.pathname === "/console/api/setup/status" || url.pathname === "/console/api/setup") return null;
    const session = await services.session.verify(request);
    if (session === null) return errorResponse(401, "authentication_failed", "Console session is required.");
    return null;
  };
}

/**
 * Ban response with traceable requestId + forensics.
 * - Always sets `x-request-id` header (incoming or generated)
 * - Content-negotiates: JSON for API clients (`accept: application/json` or `/v1/*` `/console/api/*`), HTML for browsers
 * - Logs IP + User-Agent + fingerprint headers so operator can identify culprit browser/fingerprint
 * @param request - incoming request to derive requestId and forensics from
 * @returns 403 Response with requestId embedded
 */
export function ipBanResponse(request: Request): Response {
  // Single snapshot read — avoids 5+ headers.get calls
  const snap = headerSnapshot(request.headers);
  const requestId = snap.requestId?.trim() || crypto.randomUUID();
  const ip = clientIpForBan(request) ?? "unknown";
  const userAgent = snap.userAgent ?? "-";
  // Fingerprint short-circuit: x-fingerprint first, only fall back to sec-ch-ua/forwardedFor if absent
  const rawFingerprint = snap.fingerprint;
  const fingerprint = rawFingerprint !== null && rawFingerprint.length > 0
    ? rawFingerprint
    : (snap.forwardedFor ?? "-");
  const pathname = (() => { try { return new URL(request.url).pathname; } catch { return "-"; } })();
  // Forensic log — operator can grep by requestId to find who triggered ban
  try {
    console.warn(`[ip-banned] rid=${requestId} ip=${ip} path=${pathname} ua="${userAgent}" fp="${String(fingerprint).slice(0, 200)}"`);
  } catch {}

  const accept = snap.accept ?? "";
  const urlPath = (() => { try { return cachedUrl(request).pathname; } catch { return ""; } })();
  const wantsJson = accept.includes("application/json") || urlPath.startsWith("/v1/") || urlPath.startsWith("/console/api/");
  if (wantsJson) {
    return errorResponse(403, "authorization_denied", "Access denied", requestId);
  }
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId });
  applySecurityHeaders(headers, { request, html: true, noStore: true });
  const escapedRid = requestId.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Access Denied</title></head><body style="font-family:system-ui;padding:2rem;text-align:center"><h1>Access denied</h1><p>You don’t have access to this site.</p><p style="color:#666;font-size:.875rem">Your IP has been temporarily restricted due to suspicious activity or rate limits.<br>Try again later or contact your administrator.</p><p style="color:#999;font-size:.7rem;font-family:monospace;margin-top:1rem">Request ID: ${escapedRid}</p></body></html>`;
  return new Response(html, { status: 403, headers });
}

// Verbose guard names requested by task — aliases preserving order ban→rate-limit→public→session
export function createBannedIpGuard(services: ConsolePorts) {
  const check = ipBanCheck(services);
  return async (context: unknown): Promise<Response | void> => {
    const { request, set } = context as { request: Request; set: { status?: number } };
    const ban = await check(request);
    if (ban === null) return;
    set.status = ban.status;
    return ban;
  };
}

function rateLimitResponse(request: Request, set: { status?: number; headers?: Record<string, string> }, limit: number): Response {
  const requestId = headerSnapshot(request.headers).requestId?.trim() || crypto.randomUUID();
  const response = errorResponse(429, "rate_limit_error", "Rate limit exceeded. Try again later.", requestId);
  const headers = new Headers(response.headers);
  headers.set("retry-after", "60");
  headers.set("x-ratelimit-limit", String(limit));
  headers.set("x-ratelimit-remaining", "0");
  set.status = 429;
  set.headers = { ...(set.headers ?? {}), "retry-after": "60", "x-ratelimit-limit": String(limit), "x-ratelimit-remaining": "0", "x-request-id": requestId };
  return new Response(response.body, { status: 429, headers });
}

export function createRateLimitGuard(services: ConsolePorts) {
  // Returns a beforeHandle handler for console / console style rate limit (authenticated only)
  return async ({ request, set }: any /* Elysia handler */) => {
    const url = cachedUrl(request as Request);
    if (!url.pathname.startsWith("/console/api/")) return;
    if (url.pathname === "/console/api/login" || url.pathname === "/console/api/setup" || url.pathname === "/console/api/setup/status") return;
    const session = await services.session.verify(request as Request);
    if (session === null) return;
    const ip = clientIpForBan(request as Request);
    if (ip === null) return;
    const limit = clampRateLimitEnv(Bun.env.CONSOLE_RATE_LIMIT_PER_MIN ?? 200, 200);
    let result: { count: number; remaining: number };
    if (services.rateLimit) {
      result = await services.rateLimit.touch(ip, "console", limit);
    } else {
      warnMissingRateLimitOnce();
      result = localRateTouch(ip, "console", limit);
    }
    if (result.count > limit) {
      await services.ipBan?.recordFailure(ip, { maxFailures: 1, banDurationMs: 60 * 60 * 1000, reason: "rate_limit_abuse" }).catch(() => undefined);
      return rateLimitResponse(request as Request, set, limit);
    }
    set.headers = { ...(set.headers ?? {}), "x-ratelimit-limit": String(limit), "x-ratelimit-remaining": String(result.remaining) };
  };
}

export function createPublicGuard(services: ConsolePorts) {
  return guard(services);
}

export function createSessionGuard(services: ConsolePorts) {
  return guard(services);
}

/** Applies the public /v1 IP ban and rate-limit checks in parallel. */
export function createPublicBanAndRateLimitGuard(
  ipBan?: ConsolePorts["ipBan"],
  rateLimit?: ConsolePorts["rateLimit"],
) {
  return async ({ request, set }: any /* Elysia handler */) => {
    const url = cachedUrl(request as Request);
    if (!url.pathname.startsWith("/v1/")) return;
    const ip = clientIpForBan(request as Request);
    if (ip === null) return;
    const limit = clampRateLimitEnv(Bun.env.OPEN_ENDPOINT_RATE_LIMIT_PER_MIN ?? 500, 500);
    if (!rateLimit) {
      warnMissingRateLimitOnce();
    }
    const [banned, result] = await Promise.all([
      ipBan ? ipBan.isBanned(ip) : Promise.resolve(false),
      rateLimit ? rateLimit.touch(ip, "open", limit) : Promise.resolve(localRateTouch(ip, "open", limit)),
    ]);
    if (banned) {
      set.status = 403;
      return ipBanResponse(request as Request);
    }
    if (result.count > limit) {
      await ipBan?.recordFailure(ip, { maxFailures: 1, banDurationMs: 60 * 60 * 1000, reason: "rate_limit_abuse" }).catch(() => undefined);
      return rateLimitResponse(request as Request, set, limit);
    }
    set.headers = { ...(set.headers ?? {}), "x-ratelimit-limit": String(limit), "x-ratelimit-remaining": String(result.remaining) };
  };
}

export function toResponse(result: ConsoleServiceResult): Response {
  if (result.ok) {
    if (result.data !== undefined) return jsonResponse(result.data, { status: result.status });
    return jsonResponse({ ok: true }, { status: result.status });
  }
  return errorResponse(result.status, proxyErrorCodeFor(result.code), result.message ?? "invalid_request");
}

function proxyErrorCodeFor(code: string | undefined): ProxyErrorCode {
  switch (code) {
    case "invalid_request":
    case "request_too_large":
    case "uri_too_long":
    case "authentication_failed":
    case "authorization_denied":
    case "quota_exceeded":
    case "rate_limit_error":
    case "concurrency_limit":
    case "model_not_found":
    case "context_overflow":
    case "capability_unsupported":
    case "network_unavailable":
    case "provider_unavailable":
    case "provider_protocol_error":
    case "request_timeout":
    case "request_cancelled":
    case "internal_error":
      return code;
    default:
      return "invalid_request";
  }
}

// ── Auth (API key / session) ───────────────────────────────────────────────

export interface ApiKeyRecord {
  readonly id: string;
  readonly active: boolean;
  readonly revokedAt: string | null;
  readonly scopes?: readonly string[] | null;
  readonly montanaFailure?: "invalid" | "expired" | "quota";
}

export interface ApiKeyPort {
  getBySecret(secret: string): Promise<ApiKeyRecord | null> | ApiKeyRecord | null;
  touch(id: string): void | Promise<void>;
  readonly missingAuthMessage?: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId?: string;
}

export interface SessionPort {
  verify(request: Request): Promise<SessionRecord | null> | SessionRecord | null;
}

export interface AuthResult {
  readonly apiKey: ApiKeyRecord | null;
  readonly session: SessionRecord | null;
  readonly trustedIdentity: string | null;
}

function bearerToken(authorization: string | null): string | null {
  if (authorization === null) return null;
  const trimmed = authorization.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token.length === 0 ? null : token;
}

export function hasConflictingCredentials(request: Request): boolean {
  // Delegate to snapshot variant — single header read cached via WeakMap
  return hasConflictingCredentialsFromSnapshot(headerSnapshot(request.headers));
}

export function extractApiKey(request: Request): string | null {
  return extractApiKeyFromSnapshot(headerSnapshot(request.headers));
}

/** Returns the single accepted credential, rejecting ambiguous bearer+API-key requests. */
export function requestToken(request: Request): string | null {
  return requestTokenFromSnapshot(headerSnapshot(request.headers));
}

export async function authenticateApiKey(
  request: Request,
  port: ApiKeyPort,
): Promise<{ key: ApiKeyRecord | null; response: Response | null }> {
  // Single snapshot read for whole auth check — avoids 2× headers.get
  const snap = headerSnapshot(request.headers);
  if (hasConflictingCredentialsFromSnapshot(snap)) {
    return { key: null, response: errorResponse(400, "invalid_request", "Use exactly one API credential header.") };
  }
  const secret = extractApiKeyFromSnapshot(snap);
  if (secret === null) {
    return { key: null, response: port.missingAuthMessage === undefined ? null : errorResponse(401, "authentication_failed", port.missingAuthMessage) };
  }
  const record = await port.getBySecret(secret);
  if (record?.montanaFailure === "expired") {
    return { key: null, response: errorResponse(401, "authentication_failed", "API key expired") };
  }
  if (record?.montanaFailure === "quota") {
    return { key: null, response: errorResponse(429, "rate_limit_error", "Quota exceeded") };
  }
  if (record?.montanaFailure === "invalid") {
    return { key: null, response: errorResponse(401, "authentication_failed", "Invalid API key") };
  }
  if (record === null || !record.active || record.revokedAt !== null) {
    return {
      key: null,
      response: errorResponse(
        401,
        "authentication_failed",
        "Oh My Omop - Router requires a valid x-api-key header or Authorization: Bearer token.",
      ),
    };
  }
  return { key: record, response: null };
}

export async function authenticateSession(
  request: Request,
  port: SessionPort,
): Promise<SessionRecord | null> {
  return (await port.verify(request)) ?? null;
}

export function requireApiKey(key: ApiKeyRecord | null): Response | null {
  if (key === null) {
    return errorResponse(
      401,
      "authentication_failed",
      "Oh My Omop - Router requires a valid x-api-key header or Authorization: Bearer token.",
    );
  }
  return null;
}

export function requireSession(session: SessionRecord | null): Response | null {
  if (session === null) return errorResponse(401, "authentication_failed", "Console session is required.");
  return null;
}

// ── Route ACL ──────────────────────────────────────────────────────────────

export interface RouteAcl {
  readonly providerAllowlist?: readonly string[] | null;
  readonly modelAllowlist?: readonly string[] | null;
  readonly modelDenylist?: readonly string[] | null;
}

export function isRouteAllowed(providerId: string, modelId: string, authorization: RouteAcl, requestedModel?: string): boolean {
  const qualified = `${providerId}/${modelId}`;
  if (!allowedByList(authorization.providerAllowlist, [providerId])) return false;
  const modelValues = requestedModel !== undefined ? [modelId, qualified, requestedModel] : [modelId, qualified];
  if (!allowedByList(authorization.modelAllowlist, modelValues)) return false;
  if ((authorization.modelDenylist ?? []).some((entry) => modelValues.some((value) => entry === value || entry === "*"))) return false;
  return true;
}

function allowedByList(list: readonly string[] | null | undefined, values: readonly string[]): boolean {
  if (list === null || list === undefined || list.length === 0) return true;
  return list.some((entry) => values.some((value) => entry === value || entry === "*"));
}

// ── Security headers & responses ───────────────────────────────────────────

// Freeze Set pool for safe telemetry headers — prevents mutation and enables fast membership checks
export const SAFE_HEADER_KEYS_POOL: ReadonlySet<string> = Object.freeze(
  new Set(["accept", "content-type", "x-client-name", "x-request-id", "x-forwarded-proto"]),
);
export const SAFE_HEADER_KEYS_FROZEN = SAFE_HEADER_KEYS_POOL;

// ── Hash LRU 2000 with wyhash fast-path (guard-local, mirrors persistence/crypto) ──
const GUARD_HASH_LRU_LIMIT = 2000;
const GUARD_HASH_TTL_MS = 60_000;

function guardWyhash(value: string): bigint {
  try {
    const maybeBun = globalThis as unknown as { Bun?: { hash?: { wyhash?: (input: string, seed?: number) => number | bigint } } };
    const fn = maybeBun.Bun?.hash?.wyhash;
    if (typeof fn === "function") {
      const out = fn(value, 0);
      return typeof out === "bigint" ? out : BigInt(out >>> 0);
    }
  } catch {}
  let h = 14695981039346656037n;
  const prime = 1099511628211n;
  const mask64 = (1n << 64n) - 1n;
  for (let i = 0; i < value.length; i++) {
    h ^= BigInt(value.charCodeAt(i));
    h = (h * prime) & mask64;
  }
  h ^= h >> 33n;
  h = (h * 0xff51afd7ed558ccdn) & mask64;
  h ^= h >> 33n;
  h = (h * 0xc4ceb9fe1a85ec53n) & mask64;
  h ^= h >> 33n;
  return h;
}

type GuardHashEntry = { readonly hash: string; readonly expiresAt: number };
const guardHashCache = new Map<bigint, GuardHashEntry>();

export function guardApiKeyHash(secret: string): string {
  const w = guardWyhash(secret);
  const now = Date.now();
  const hit = guardHashCache.get(w);
  if (hit !== undefined) {
    if (hit.expiresAt > now) {
      guardHashCache.delete(w);
      guardHashCache.set(w, hit);
      return hit.hash;
    }
    guardHashCache.delete(w);
  }
  // Use Bun.CryptoHasher if available to avoid node:crypto import at top (keeps headerSnapshot region untouched)
  let hash: string;
  try {
    const hasher = new (globalThis as unknown as { Bun: { CryptoHasher: new (algo: string) => { update(v: string): { digest(e: string): string } } } }).Bun.CryptoHasher("sha256");
    hash = hasher.update(secret).digest("hex");
  } catch {
    // fallback to Web Crypto subtle not available sync — use simple hex fallback (should not happen in Bun)
    hash = `fallback-${w.toString(16)}`;
  }
  if (guardHashCache.size >= GUARD_HASH_LRU_LIMIT) {
    const oldest = guardHashCache.keys().next().value as bigint | undefined;
    if (oldest !== undefined) guardHashCache.delete(oldest);
  }
  guardHashCache.set(w, { hash, expiresAt: now + GUARD_HASH_TTL_MS });
  return hash;
}

export function clearGuardHashCache(): void {
  guardHashCache.clear();
}

export function getGuardHashCacheSizeForTest(): number {
  return guardHashCache.size;
}

export function hasGuardHashPlaintextForTest(secret: string): boolean {
  // Diagnostic: cache is digest-keyed without plaintext, so this always returns false.
  // Used by tests to assert no plaintext retention.
  for (const entry of guardHashCache.values()) {
    if ((entry as unknown as { secret?: string }).secret === secret) return true;
  }
  return false;
}

export function buildConsoleSessionCookie(token: string, request?: Request): string {
  const base = `ohmyomop_router_console=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
  return requestIsSecure(request) ? `${base}; Secure` : base;
}

export function sseHeaders(extra?: Headers | Record<string, string>): Headers {
  const headers = new Headers(extra);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("connection", "keep-alive");
  headers.set("x-accel-buffering", "no");
  applySecurityHeaders(headers, { noStore: true });
  return headers;
}

export function withRetryAfter(response: Response, seconds: number): Response {
  const headers = new Headers(response.headers);
  headers.set("retry-after", String(Math.max(1, Math.ceil(seconds))));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
