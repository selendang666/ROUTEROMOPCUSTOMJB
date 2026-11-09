// transport/network — merged from upstream/guard/{ssrf,headers,redirect} + upstream/fetch/proxy + network selection
import { isIpLiteral, isPrivateUseName, isUnsafeIp, normalizeHostname } from "../media-guard.js";
import { UpstreamError } from "./errors.js";
import { markOverhead } from "../../runtime/overhead.js";
import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { NetworkSelection } from "../types/request.js";
import { RelayCircuitBreaker } from "./relay-circuit.js";

// SSRF guard — extracted from fetch.ts verbatim

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

/** Hostnames that are always blocked regardless of DNS resolution. */
const BLOCKED_HOSTNAMES: Record<string, true> = { localhost: true, "0.0.0.0": true };

/** Cloud-metadata and synonym hostnames that must never be reachable. */
const BLOCKED_METADATA_HOSTNAMES: Record<string, true> = { "metadata.google.internal": true, "instance-data": true };

/** Protocols accepted by the generic guard; proxy pools may be socks5. */
const DEFAULT_ALLOWED_PROTOCOLS: Record<string, true> = { "http:": true, "https:": true, "socks5:": true };

const DNS_CACHE_TTL_MS = Math.min(
  300_000,
  Math.max(1_000, Number(Bun.env.OHMYOMOP_ROUTER_DNS_CACHE_TTL_MS ?? 60_000) || 60_000),
);

const MAX_DNS_CACHE_ENTRIES = 1_024;

interface DnsCacheEntry {
  readonly records: readonly ResolvedAddress[];
  readonly expiresAt: number;
}

const dnsCache = new Map<string, DnsCacheEntry>();
const dnsInFlight = new Map<string, Promise<readonly ResolvedAddress[]>>();

async function resolvePublicHostname(hostname: string): Promise<readonly ResolvedAddress[]> {
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached !== undefined && cached.expiresAt > now) return cached.records;
  if (cached !== undefined) dnsCache.delete(hostname);
  const active = dnsInFlight.get(hostname);
  if (active !== undefined) return active;
  let lookupPromise: Promise<readonly ResolvedAddress[]>;
  try {
    lookupPromise = Bun.dns.lookup(hostname, { family: 0 }) as Promise<readonly ResolvedAddress[]>;
  } catch {
    dnsInFlight.delete(hostname);
    throw new UpstreamError({ kind: "network_unavailable", message: `DNS lookup failed for ${hostname}`, statusCode: 502, routeScope: "provider" });
  }
  const pending = lookupPromise
    .then((records) => {
      if (dnsCache.size >= MAX_DNS_CACHE_ENTRIES) {
        const oldest = dnsCache.keys().next().value;
        if (typeof oldest === "string") dnsCache.delete(oldest);
      }
      dnsCache.set(hostname, { records, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
      return records;
    })
    .finally(() => dnsInFlight.delete(hostname));
  dnsInFlight.set(hostname, pending);
  return pending;
}

/** Bounds on input before parsing. */
export const MAX_SSRF_URL_LENGTH = 4_096;

export interface SsrfUrlOptions {
  readonly label?: string;
  readonly allowedProtocols?: Readonly<Record<string, true>>;
}

/** A single address produced by a resolver. */
export interface ResolvedAddress {
  readonly address: string;
}

export class SsrfGuardError extends Error {
  readonly reason: "invalid_url" | "unsupported_protocol" | "blocked_host" | "blocked_ip";

  constructor(reason: "invalid_url" | "unsupported_protocol" | "blocked_host" | "blocked_ip", message: string) {
    super(message);
    this.name = "SsrfGuardError";
    this.reason = reason;
  }
}

/**
 * Checks a resolved IP address string against the blocked ranges. The domain
 * matcher treats unparseable input as unsafe, so only real IP literals are
 * run through it.
 */
export function isBlockedIp(address: string): boolean {
  if (address === "::1") return true;
  if (!isIpLiteral(address)) return true;
  return isUnsafeIp(address);
}

function isBlockedHostname(hostname: string): boolean {
  if (BLOCKED_HOSTNAMES[hostname] === true || BLOCKED_METADATA_HOSTNAMES[hostname] === true) return true;
  return isPrivateUseName(hostname);
}

/**
 * Validates that a URL string points at a public, routable address without
 * doing network I/O. Throws a typed SsrfGuardError with a clean message;
 * returns the parsed URL for reuse.
 */
export function assertPublicUrl(raw: string, options: SsrfUrlOptions = {}): URL {
  const label = options.label ?? "URL";
  if (raw.length === 0) throw new SsrfGuardError("invalid_url", `Invalid ${label}: no URL provided`);
  if (raw.length > MAX_SSRF_URL_LENGTH) throw new SsrfGuardError("invalid_url", `Invalid ${label}: URL exceeds ${MAX_SSRF_URL_LENGTH} characters`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfGuardError("invalid_url", `Invalid ${label}: malformed URL`);
  }
  const allowed = options.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS;
  if (allowed[url.protocol] !== true) {
    throw new SsrfGuardError("unsupported_protocol", `Invalid ${label}: protocol "${url.protocol}" not allowed`);
  }
  const hostname = normalizeHostname(url.hostname);
  if (hostname === null) throw new SsrfGuardError("invalid_url", `Invalid ${label}: no usable host`);
  if (isBlockedHostname(hostname)) {
    throw new SsrfGuardError("blocked_host", `Invalid ${label}: host "${url.hostname}" is blocked (private/loopback/internal)`);
  }
  if (isIpLiteral(hostname) && isUnsafeIp(hostname)) {
    throw new SsrfGuardError("blocked_ip", `Blocked private IP address: "${url.hostname}"`);
  }
  return url;
}

/**
 * Validates a URL immediately before dispatch, checking every DNS-resolved
 * target to prevent rebinding after configuration-time validation. The
 * resolver is injectable for tests; by default it is Bun's DNS lookup.
 */
export async function assertPublicUrlAtDispatch(
  raw: string,
  options: SsrfUrlOptions & { readonly lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]> } = {},
): Promise<URL> {
  const url = assertPublicUrl(raw, options);
  const hostname = normalizeHostname(url.hostname);
  if (hostname === null) throw new SsrfGuardError("invalid_url", "Invalid URL: no usable host");
  if (isIpLiteral(hostname)) return url;

  const stop = markOverhead("upstream.dns", { cached: options.lookup === undefined && dnsCache.has(hostname) });
  let records: readonly ResolvedAddress[];
  try {
    records = options.lookup === undefined
      ? await resolvePublicHostname(hostname)
      : await options.lookup(hostname);
  } finally {
    stop();
  }
  if (!Array.isArray(records) || records.length === 0) throw new SsrfGuardError("invalid_url", `Invalid ${options.label ?? "URL"}: hostname did not resolve`);
  for (const record of records) {
    let addr = "";
    const unknownRecord: unknown = record;
    if (unknownRecord !== null && typeof unknownRecord === "object" && "address" in unknownRecord) {
      const candidate = unknownRecord.address;
      if (typeof candidate === "string") addr = candidate.trim();
    }
    if (addr.length === 0 || isBlockedIp(addr)) {
      dnsCache.delete(hostname);
      let rawDisplay = addr;
      if (rawDisplay.length === 0) {
        if (unknownRecord !== null && typeof unknownRecord === "object" && "address" in unknownRecord) {
          const rawCandidate = unknownRecord.address;
          rawDisplay = typeof rawCandidate === "string" ? rawCandidate : String(rawCandidate ?? "");
        } else {
          rawDisplay = String(addr);
        }
      }
      throw new SsrfGuardError("blocked_ip", `Blocked private IP address "${url.hostname}": "${rawDisplay}"`);
    }
  }
  return url;
}

// Header allowlist — extracted from fetch.ts verbatim (single source of truth)
/** Headers that must never be forwarded from operator-supplied input. */
export const BLOCKED_HEADERS: Record<string, true> = {
  host: true,
  authorization: true,
  "proxy-authorization": true,
  "proxy-authenticate": true,
  "x-api-key": true,
  cookie: true,
  "set-cookie": true,
  "keep-alive": true,
  te: true,
  trailer: true,
  upgrade: true,
  forwarded: true,
  via: true,
  "x-forwarded-for": true,
  "x-forwarded-host": true,
  "x-forwarded-proto": true,
  "x-real-ip": true,
  origin: true,
  referer: true,
  "content-length": true,
  "transfer-encoding": true,
  connection: true,
};

export type BuildHeadersInput =
  | Record<string, string | undefined>
  | Headers
  | { readonly headers?: Record<string, string | undefined> | Headers | null };

function isHeadersLike(value: unknown): value is Headers {
  return typeof Headers !== "undefined" && value instanceof Headers;
}

function hasHeadersProperty(value: object): value is { readonly headers?: Record<string, string | undefined> | Headers | null } {
  return "headers" in value;
}

function extractHeaderEntries(input: BuildHeadersInput): Array<[string, string]> {
  if (isHeadersLike(input)) {
    const out: Array<[string, string]> = [];
    input.forEach((v, k) => out.push([k, v]));
    return out;
  }
  if (input !== null && typeof input === "object" && hasHeadersProperty(input)) {
    const wrapped = input.headers;
    if (wrapped === null || wrapped === undefined) return [];
    if (isHeadersLike(wrapped)) {
      const out: Array<[string, string]> = [];
      wrapped.forEach((v, k) => out.push([k, v]));
      return out;
    }
    const entries = Object.entries(wrapped);
    return entries.filter((entry): entry is [string, string] => typeof entry[1] === "string");
  }
  if (isHeadersLike(input)) return [];
  const entries = Object.entries(input as Record<string, string | undefined>);
  return entries.filter((entry): entry is [string, string] => typeof entry[1] === "string");
}

/**
 * Builds a sanitized header map from operator-supplied input.
 * - Normalizes keys to lowercase
 * - Drops blocked headers and `proxy-*` prefix
 * - Rejects CRLF injection in name or value
 * - Drops empty names
 */
export function buildHeaders(input: BuildHeadersInput): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of extractHeaderEntries(input)) {
    const name = rawName.trim();
    if (name.length === 0) continue;
    const lower = name.toLowerCase();
    if (BLOCKED_HEADERS[lower] === true || lower.startsWith("proxy-")) continue;
    if (/[\r\n]/.test(name) || /[\r\n]/.test(rawValue)) continue;
    headers[lower] = rawValue;
  }
  return headers;
}

// Redirect policy — extracted from fetch.ts verbatim
// Redirect policy
// ---------------------------------------------------------------------------

export const MAX_REDIRECTS = 5;

export type RedirectHopValidator = (url: string) => Promise<void> | void;

export interface RedirectFollowOptions {
  /** Performs the actual network step for a single validated hop. Defaults to global `fetch`. */
  readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  /** Hard cap on followed redirects; bounded to [0, MAX_REDIRECTS]. */
  readonly maxRedirects?: number;
  /** Called with each hop URL immediately before it is fetched. */
  readonly validator?: RedirectHopValidator;
}

export class RedirectPolicyError extends Error {
  readonly kind: "too_many_redirects" | "bad_redirect_target";

  constructor(kind: "too_many_redirects" | "bad_redirect_target", message: string) {
    super(message);
    this.name = "RedirectPolicyError";
    this.kind = kind;
  }
}

const SENSITIVE_REDIRECT_HEADERS: Record<string, true> = {
  authorization: true,
  "x-api-key": true,
  "proxy-authorization": true,
  "proxy-authenticate": true,
  cookie: true,
  "set-cookie": true,
  "x-forwarded-for": true,
  "x-forwarded-host": true,
  "x-forwarded-proto": true,
  "x-real-ip": true,
};

/**
 * Resolves a raw `location` header value against the current hop. Only
 * http/https targets are allowed; anything else (javascript:, data:, …) is
 * refused with a typed error instead of being fetched.
 */
export function resolveRedirectTarget(base: string, location: string): string {
  let next: URL;
  try {
    next = new URL(location, base);
  } catch {
    throw new RedirectPolicyError("bad_redirect_target", "Redirect target is not a valid URL");
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw new RedirectPolicyError("bad_redirect_target", `Redirect target uses unsupported protocol "${next.protocol}"`);
  }
  return next.toString();
}

/**
 * Follows redirects manually with `redirect: "manual"`, validating every hop
 * and refusing to grow the chain past the bound. Returns the final
 * non-redirect response (or the first response without a `location` header).
 */
export async function fetchWithRedirectPolicy(target: string, init: RequestInit, options: RedirectFollowOptions = {}): Promise<Response> {
  const { fetcher = fetch, validator } = options;
  const requested = options.maxRedirects ?? MAX_REDIRECTS;
  const maxRedirects = Number.isFinite(requested) ? Math.max(0, Math.min(MAX_REDIRECTS, Math.floor(requested))) : MAX_REDIRECTS;

  let current = target;
  let currentInit: RequestInit = { ...init };
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (validator !== undefined) await validator(current);
    const response = await fetcher(current, { ...currentInit, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    const next = resolveRedirectTarget(current, location);
    let crossOrigin = false;
    try {
      crossOrigin = new URL(current).origin !== new URL(next).origin;
    } catch {
      crossOrigin = true;
    }
    if (crossOrigin) {
      const headers = new Headers(currentInit.headers ?? {});
      for (const key of [...headers.keys()]) {
        if (SENSITIVE_REDIRECT_HEADERS[key.toLowerCase()] === true) headers.delete(key);
      }
      // Strip body across origins to avoid leaking credentials in payload
      const nextInit: RequestInit = { ...currentInit, headers };
      if (nextInit.body !== undefined) {
        delete (nextInit as Record<string, unknown>).body;
        // Remove content headers that no longer apply
        headers.delete("content-type");
        headers.delete("content-length");
        headers.delete("content-encoding");
        // For 303 or POST with cross-origin, browsers downgrade to GET
        const method = typeof nextInit.method === "string" ? nextInit.method.toUpperCase() : "GET";
        if (response.status === 303 || (response.status === 301 || response.status === 302) && method === "POST") {
          nextInit.method = "GET";
        }
      }
      nextInit.headers = headers;
      currentInit = nextInit;
    }
    current = next;
  }
  throw new RedirectPolicyError("too_many_redirects", "Too many redirects while following server-side fetch");
}

// Proxy fetchers (socks-proxy-agent@10) — extracted from fetch.ts verbatim

// ---------------------------------------------------------------------------

/** Cache SocksProxyAgent per URL — avoids re-parsing URL + rebuilding connection pool per request. */
const socksAgentCache = new Map<string, SocksProxyAgent>();

const MAX_SOCKS_AGENTS = 128;

function socksAgentFor(agentUrl: string): SocksProxyAgent {
  let agent = socksAgentCache.get(agentUrl);
  if (agent === undefined) {
    if (socksAgentCache.size >= MAX_SOCKS_AGENTS) {
      const oldest = socksAgentCache.keys().next().value;
      if (typeof oldest === "string") {
        socksAgentCache.get(oldest)?.destroy();
        socksAgentCache.delete(oldest);
      }
    }
    agent = new SocksProxyAgent(agentUrl, {
      keepAlive: true,
      keepAliveMsecs: 10_000,
      maxSockets: 256,
      maxFreeSockets: 64,
      timeout: 30_000,
    });
    socksAgentCache.set(agentUrl, agent);
  }
  return agent;
}

export interface ProxyTarget {
  readonly url: string;
  readonly isRelay?: boolean;
  readonly relaySecret?: string | null;
}

export type ProxyFetcher = (url: string, init: RequestInit) => Promise<Response>;

function isRelayHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return normalized.endsWith(".vercel.app") || normalized.endsWith(".workers.dev") || normalized.endsWith(".netlify.app");
}

function proxyUrlOf(proxy: ProxyTarget): string {
  const parsed = new URL(proxy.url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "socks5:") {
    throw new UpstreamError({ kind: "provider_protocol_error", message: `Unsupported outbound proxy protocol: ${parsed.protocol}`, statusCode: 502, routeScope: "provider" });
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeBody(body: RequestInit["body"]): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new UpstreamError({ kind: "invalid_request", message: `Unsupported request body type for proxied dispatch: ${Object.prototype.toString.call(body)}`, statusCode: 400, routeScope: null });
}

export function headersToObject(headers: RequestInit["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(headers ?? {}).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function socks5Fetcher(proxy: ProxyTarget): ProxyFetcher {
  const agentUrl = proxyUrlOf(proxy);
  return async (url, init) => {
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const transport = isHttps ? https : http;
    const req = transport.request(
      {
        agent: socksAgentFor(agentUrl),
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET",
        headers: headersToObject(init.headers),
      },
      (response) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            for (const entry of value) responseHeaders.append(key, entry);
          } else if (value !== undefined) {
            responseHeaders.set(key, value);
          }
        }
        resolve(new Response(Readable.toWeb(response as never) as ReadableStream<Uint8Array>, { status: response.statusCode ?? 502, headers: responseHeaders }));
      },
    );
    req.on("error", reject);
    const signal = init.signal;
    const abort = () => req.destroy(new UpstreamError({ kind: "client_aborted", message: "aborted", statusCode: null }));
    if (signal) {
      if (signal.aborted) {
        abort();
        return promise;
      }
      signal.addEventListener("abort", abort, { once: true });
      req.once("close", () => signal.removeEventListener("abort", abort));
    }
    const body = normalizeBody(init.body);
    if (body === undefined) req.end();
    else req.end(body);
    return promise;
  };
}

function relayFetcher(proxy: ProxyTarget): ProxyFetcher {
  const relayUrl = proxyUrlOf(proxy);
  return async (url, init) => {
    const target = new URL(url);
    const headers = new Headers(init.headers ?? {});
    headers.delete("host");
    headers.set("x-relay-target", target.origin);
    headers.set("x-relay-path", `${target.pathname}${target.search}`);
    headers.set("x-upstream-path", `${target.pathname}${target.search}`);
    if (typeof proxy.relaySecret === "string" && proxy.relaySecret.length > 0) headers.set("x-relay-secret", proxy.relaySecret);
    const relay = new URL(relayUrl);
    if (relay.username) {
      const credentials = `${decodeURIComponent(relay.username)}:${decodeURIComponent(relay.password)}`;
      headers.set("x-relay-auth", `Basic ${Buffer.from(credentials).toString("base64")}`);
      relay.username = "";
      relay.password = "";
    }
    return fetch(relay.toString(), { ...init, headers });
  };
}

function httpProxyFetcher(proxy: ProxyTarget): ProxyFetcher {
  const proxyUrl = proxyUrlOf(proxy);
  return async (url, init) => {
    return fetch(url, { ...init, proxy: proxyUrl } as RequestInit & { proxy: string });
  };
}

export function buildProxyFetcher(proxy: ProxyTarget): ProxyFetcher {
  const parsed = new URL(proxy.url);
  if (proxy.isRelay || isRelayHost(parsed.hostname)) return relayFetcher(proxy);
  return parsed.protocol === "socks5:" ? socks5Fetcher(proxy) : httpProxyFetcher(proxy);
}

function directSelection(proxyId: string | null): NetworkSelection { return { proxyId, url: null, isRelay: false, release: async () => {} }; }
function proxySelection(proxyId: string, url: string, isRelay: boolean, relaySecret?: string | null): NetworkSelection { return { proxyId, url, isRelay, ...(relaySecret === undefined ? {} : { relaySecret }), release: async () => {} }; }

export function validatePublicUrl(raw: string, label = "URL"): string | null {
  try {
    // config-time only — not dispatch; use assertPublicUrlAtDispatch for outbound fetches
    assertPublicUrl(raw, { label });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Required export for assignment: assertSafeUrl (sync, config-time only) + async alias
// Use assertSafeUrlAtDispatch for dispatch-time DNS rebinding check
export function assertSafeUrl(raw: string, options: SsrfUrlOptions = {}): URL {
  return assertPublicUrl(raw, options);
}

export async function assertSafeUrlAtDispatch(
  raw: string,
  options: SsrfUrlOptions & { readonly lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]> } = {},
): Promise<URL> {
  return assertPublicUrlAtDispatch(raw, options);
}

export function fetchWithSsrfGuard(
  url: string,
  init: RequestInit,
  options: RedirectFollowOptions = {},
): Promise<Response> {
  const validator: RedirectHopValidator = (target) => {
    return assertPublicUrlAtDispatch(target, { label: "redirect target" }).then(() => {});
  };
  return fetchWithRedirectPolicy(url, init, { fetcher: options.fetcher, maxRedirects: options.maxRedirects, validator });
}

export const BLOCKED_CUSTOM_HEADERS: Record<string, true> = BLOCKED_HEADERS;

export interface UpstreamFetcherOptions {
  readonly proxy?: ProxyTarget | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly headers?: Record<string, string | undefined>;
}

/**
 * Creates a fetcher bound to the given proxy/signal/timeout/redirect policy.
 * Direct (no proxy) fetches follow redirects manually so every hop is
 * re-validated through the SSRF guard; proxied fetches tunnel through the
 * SOCKS5/HTTP relay but still follow the same redirect policy with
 * per-hop SSRF validation and cross-origin credential stripping.
 */
export function createUpstreamFetcher(options: UpstreamFetcherOptions = {}): ProxyFetcher {
  const { proxy, signal, timeoutMs, maxRedirects, headers } = options;

  const proxyFetcher = proxy ? buildProxyFetcher(proxy) : null;

  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const mergedHeaders = headers ? { ...buildHeaders(headers), ...headersToObject(init.headers) } : init.headers;
    // Sanitize any caller-supplied headers through the allowlist only when we
    // own them (options.headers). Init.headers from providers are trusted
    // provider-constructed values; still strip CR LF to be safe.
    let safeHeaders: Record<string, string> | undefined;
    if (mergedHeaders !== undefined) {
      const raw = headersToObject(mergedHeaders);
      safeHeaders = {};
      for (const [k, v] of Object.entries(raw)) {
        if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) continue;
        safeHeaders[k] = v;
      }
    }

    const fetcherInit: RequestInit = { ...init, ...(safeHeaders ? { headers: safeHeaders } : {}) };

    // If caller provided a signal, combine with timeout
    let effectiveSignal = signal ?? fetcherInit.signal ?? undefined;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      effectiveSignal = effectiveSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([effectiveSignal, timeoutSignal]);
      fetcherInit.signal = effectiveSignal;
    } else if (effectiveSignal) {
      fetcherInit.signal = effectiveSignal;
    }

    let firstHop = true;
    const validator: RedirectHopValidator = (target) => {
      if (firstHop) {
        firstHop = false;
        return;
      }
      return assertPublicUrlAtDispatch(target, { label: "upstream redirect target" }).then(() => {});
    };
    if (proxyFetcher !== null) {
      return fetchWithRedirectPolicy(url, fetcherInit, {
        fetcher: proxyFetcher,
        maxRedirects,
        validator,
      });
    }
    // Direct path: manual redirect with SSRF validation on every hop after the first.
    // The initial URL is assumed to be validated by the caller (custom provider) or
    // is a trusted hardcoded constant (built-in providers).
    return fetchWithRedirectPolicy(url, fetcherInit, {
      maxRedirects,
      validator,
    });
  };
}

export interface NetworkSelectorInput {
  readonly providerId: string;
  readonly affinityKey: string;
  readonly sticky?: boolean;
  readonly preferDirect?: boolean;
  /** Select one route-plan proxy instead of making an independent pool choice. */
  readonly preferredProxyId?: string | null;
}

export interface NetworkSelectorResult {
  readonly proxyId: string | null;
  readonly selection: NetworkSelection & { release?: () => Promise<void> };
}

export interface NetworkSelectorProxyEntry {
  readonly id: string;
  readonly url: string;
  readonly isRelay?: boolean;
  readonly relaySecret?: string | null;
  readonly healthy?: boolean;
  readonly priority?: number;
  readonly weight?: number;
}

export interface NetworkSelectorOptions {
  readonly proxies?: readonly NetworkSelectorProxyEntry[];
  readonly getProxies?: () => readonly NetworkSelectorProxyEntry[] | Promise<readonly NetworkSelectorProxyEntry[]>;
  readonly circuit?: RelayCircuitBreaker;
}

export class NetworkSelector {
  private readonly getProxiesFn: () => Promise<readonly NetworkSelectorProxyEntry[]>;
  private readonly circuit: RelayCircuitBreaker | undefined;
  private readonly affinity = new Map<string, string>();
  private roundRobin = 0;

  constructor(options: NetworkSelectorOptions = {}) {
    this.circuit = options.circuit;
    if (options.getProxies !== undefined) {
      const fn = options.getProxies;
      this.getProxiesFn = async () => {
        const result = await fn();
        return Array.isArray(result) ? result : [];
      };
    } else if (options.proxies !== undefined) {
      const snapshot = options.proxies;
      this.getProxiesFn = async () => snapshot;
    } else {
      this.getProxiesFn = async () => [];
    }
  }

  async select(input: NetworkSelectorInput): Promise<NetworkSelectorResult | null> {
    if (input.preferDirect === true) {
      return { proxyId: null, selection: directSelection(null) };
    }
    const all = await this.getProxiesFn();
    const eligible = all.filter((p) => p.healthy !== false && typeof p.url === "string" && p.url.length > 0);
    const relays = eligible.filter((proxy) => proxy.isRelay === true);
    const circuit = this.circuit;
    const available = circuit === undefined
      ? eligible
      : eligible.filter((proxy) => proxy.isRelay !== true || circuit.isAvailable(proxy.id));
    const allRelaysOpen = relays.length > 0 && circuit !== undefined && relays.every((proxy) => !circuit.isAvailable(proxy.id));
    if (input.preferredProxyId !== undefined) {
      if (input.preferredProxyId === null) {
        return { proxyId: null, selection: directSelection(null) };
      }
      const preferred = available.find((proxy) => proxy.id === input.preferredProxyId);
      if (preferred === undefined) return null;
      if (this.circuit !== undefined && !this.circuit.tryAcquire(preferred.id)) return null;
      return {
        proxyId: preferred.id,
        selection: proxySelection(preferred.id, preferred.url, Boolean(preferred.isRelay), preferred.relaySecret),
      };
    }
    if (available.length === 0) {
      return allRelaysOpen ? null : { proxyId: null, selection: directSelection(null) };
    }
    const sorted = [...available].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    if (input.sticky === true) {
      const pinnedId = this.affinity.get(input.affinityKey);
      if (pinnedId !== undefined) {
        const pinned = sorted.find((p) => p.id === pinnedId);
        if (pinned !== undefined && (this.circuit === undefined || this.circuit.tryAcquire(pinned.id))) {
          return { proxyId: pinned.id, selection: proxySelection(pinned.id, pinned.url, Boolean(pinned.isRelay), pinned.relaySecret) };
        }
      }
    }
    const hasWeights = sorted.some((p) => typeof p.weight === "number" && p.weight !== 100);
    const computedWeights = sorted.map((p) => (typeof p.weight === "number" && Number.isFinite(p.weight) ? Math.max(1, Math.min(10, Math.floor(p.weight / 20) || 1)) : 1));
    const totalWeight = computedWeights.reduce((a, b) => a + b, 0);
    let chosen: NetworkSelectorProxyEntry | undefined;
    if (hasWeights) {
      let r = this.roundRobin % totalWeight;
      for (let i = 0; i < sorted.length; i++) {
        r -= computedWeights[i]!;
        if (r < 0) { chosen = sorted[i]; break; }
      }
      if (chosen === undefined) chosen = sorted[0];
    } else {
      chosen = sorted[this.roundRobin % sorted.length];
    }
    if (chosen !== undefined && this.circuit !== undefined && !this.circuit.tryAcquire(chosen.id)) {
      chosen = sorted.find((proxy) => proxy.id !== chosen?.id && (proxy.isRelay !== true || this.circuit?.tryAcquire(proxy.id) === true));
    }
    if (chosen === undefined) return allRelaysOpen || available.every((proxy) => proxy.isRelay === true) ? null : { proxyId: null, selection: directSelection(null) };
    this.roundRobin = (this.roundRobin + 1) >>> 0;
    if (input.sticky === true) {
      this.affinity.set(input.affinityKey, chosen.id);
      if (this.affinity.size > 1024) {
        const oldest = this.affinity.keys().next().value as string | undefined;
        if (oldest !== undefined) this.affinity.delete(oldest);
      }
    }
    return { proxyId: chosen.id, selection: proxySelection(chosen.id, chosen.url, Boolean(chosen.isRelay), chosen.relaySecret) };
  }
}
