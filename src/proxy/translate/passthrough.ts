import type { ProxyRequest } from "../types/request.js";
import type { Surface } from "../types/surface.js";
import { applyProviderQuirkPolicy, applyRequiredProviderHeaders } from "../policy/projection.js";
import type { ProviderQuirkPolicy } from "../types/provider.js";
import { isRecord } from "../validation.js";

export interface NativePassthroughContext {
  readonly client: { readonly passthrough?: string; readonly format?: string };
  readonly providerAllowsNative: boolean;
  readonly source: Surface;
  readonly target: Surface;
}

export function isNativePassthroughEligible(context: NativePassthroughContext): boolean {
  return context.providerAllowsNative && context.client.passthrough !== "never" && context.source === context.target;
}

export function preserveWirePayload(payload: Record<string, unknown>, request: ProxyRequest, targetSurface: Surface, canonicalFields: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = { ...payload };
  const allowed = new Set<string>([...canonicalFields, "model", "stream", "prompt_cache_key", "headers"]);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) delete result[key];
  }
  result.model = request.model;
  result.stream = request.stream;
  result.prompt_cache_key = request.cacheKey;

  const headers = normalizeHeaders(result.headers);
  stripSensitiveHeaders(headers);
  const policy = extractQuirkPolicy(request.nativeMetadata);
  const projected = applyProviderQuirkPolicy(result, policy);
  projected.headers = headersToRecord(applyRequiredProviderHeaders(headers, policy));
  return projected;
}

export function decideNativePassthrough(_args: {
  client: { passthrough?: string; format?: string };
  request: ProxyRequest;
  target: { surface: Surface };
  providerPolicy?: { nativePassthrough?: boolean };
  semanticChanged: boolean;
  globallyDisabled: boolean;
}): { decision: "native" | "canonical"; diagnostics?: unknown } {
  if (_args.globallyDisabled) return { decision: "canonical" };
  if (_args.semanticChanged) return { decision: "canonical" };
  if (!_args.providerPolicy?.nativePassthrough) return { decision: "canonical" };
  if (_args.client.passthrough === "never") return { decision: "canonical" };
  return { decision: "native" };
}

function extractQuirkPolicy(value: Readonly<Record<string, unknown>> | undefined): ProviderQuirkPolicy | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = isRecord(value.quirks) ? value.quirks : value;
  if (!isRecord(candidate)) return undefined;
  if ("droppedFields" in candidate || "clampedFields" in candidate || "requiredHeaders" in candidate) return candidate as ProviderQuirkPolicy;
  return undefined;
}

function normalizeHeaders(value: unknown): Headers {
  if (value instanceof Headers) return new Headers(value);
  const headers = new Headers();
  if (!isRecord(value)) return headers;
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") continue;
    headers.set(name, entry);
  }
  return headers;
}

function stripSensitiveHeaders(headers: Headers): void {
  for (const name of Array.from(headers.keys())) {
    const lower = name.toLowerCase();
    if (
      lower === "authorization" ||
      lower === "host" ||
      lower === "proxy-authorization" ||
      lower === "proxy-authenticate" ||
      lower === "proxy-connection" ||
      lower === "connection" ||
      lower === "keep-alive" ||
      lower === "te" ||
      lower === "trailer" ||
      lower === "transfer-encoding" ||
      lower === "upgrade" ||
      lower === "forwarded" ||
      lower === "x-forwarded-for" ||
      lower === "x-forwarded-host" ||
      lower === "x-forwarded-proto" ||
      lower === "x-forwarded-port" ||
      lower === "x-real-ip" ||
      lower === "cookie" ||
      lower === "set-cookie" ||
      lower.startsWith("proxy-")
    ) {
      headers.delete(name);
    }
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, value] of headers.entries()) record[name] = value;
  return record;
}
