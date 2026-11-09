// Compatibility helpers — extracted from translate.ts verbatim
import { isRecord } from "../validation.js";
import type { Adapter, ProviderOutput, ProviderRequest } from "../types/request.js";
import type { ApplicationErrorKind, InternalFailure } from "../types/error-types.js";
import type { CompatibilityProfile, CompatibilityRequestRule, OpenAIAdapterConfig, ProviderCaps, ProviderCatalogAdapter, ProviderMeta } from "../types/provider.js";
import type { ProviderUsage } from "../types/telemetry.js";
import type { RouteTarget } from "../types/routing.js";
import type { SseEvent, StopReason, StreamEvent, StreamMapper } from "../types/stream.js";
import type { Surface } from "../types/surface.js";
import { UpstreamError } from "../transport/errors.js";

// ---------------------------------------------------------------- HTTP execution

const RESERVED_COMPATIBILITY_HEADERS = new Set([
  "authorization",
  "content-length",
  "host",
  "transfer-encoding",
  "x-api-key",
]);

const ANTHROPIC_BETAS = new Set([
  "prompt-caching-2024-07-31",
  "extended-cache-ttl-2025-04-11",
  "interleaved-thinking-2025-05-14",
  "effort-2025-11-24",
  "user-profiles-2024-10-30",
  "structured-outputs-2025-11-13",
]);

export function applyAnthropicCompatibilityHeaders(
  headers: Record<string, string>,
  input: ProviderRequest,
  config: Pick<OpenAIAdapterConfig, "anthropic">,
  explicitCache: boolean,
): void {
  headers["anthropic-version"] = config.anthropic?.version ?? "2023-06-01";
  const betas = new Set<string>(config.anthropic?.betas ?? []);
  const usesOneHourCache = input.request.messages.some((message) =>
    message.content.some((block) => typeof block.cacheControl === "object" && block.cacheControl.ttl === "1h"),
  );
  if (explicitCache || usesOneHourCache) betas.add("prompt-caching-2024-07-31");
  if (usesOneHourCache) betas.add("extended-cache-ttl-2025-04-11");
  for (const beta of betas) {
    if (!ANTHROPIC_BETAS.has(beta)) {
      throw new UpstreamError({
        kind: "invalid_request",
        message: `Anthropic beta "${beta}" is not allowed by this build.`,
        statusCode: 400,
        routeScope: "provider",
      });
    }
  }
  if (betas.size > 0) headers["anthropic-beta"] = [...betas].sort().join(",");
  if (config.anthropic?.allowUserProfile !== true) return;
  const userProfile = input.headers?.get("anthropic-user-profile-id");
  if (userProfile !== null && userProfile !== undefined && /^[A-Za-z0-9._:-]{1,256}$/.test(userProfile)) {
    headers["anthropic-user-profile-id"] = userProfile;
  }
}

export function compatibilityUrl(baseUrl: string, path: string, profile: CompatibilityProfile | undefined): string {
  const url = new URL(path.replace(/^\//, ""), `${baseUrl.replace(/\/+$/, "")}/`);
  for (const [key, value] of Object.entries(profile?.query ?? {})) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key) || value.length > 2_048) {
      throw new UpstreamError({
        kind: "invalid_request",
        message: "Compatibility profile contains an invalid query parameter.",
        statusCode: 400,
        routeScope: "provider",
      });
    }
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function applyCompatibilityHeaders(
  destination: Record<string, string>,
  profile: CompatibilityProfile | undefined,
): void {
  for (const [rawName, value] of Object.entries(profile?.headers ?? {})) {
    const name = rawName.toLowerCase();
    if (
      !/^[a-z0-9-]{1,128}$/.test(name) ||
      RESERVED_COMPATIBILITY_HEADERS.has(name) ||
      value.length > 8_192 ||
      /[\r\n]/.test(value)
    ) {
      throw new UpstreamError({
        kind: "invalid_request",
        message: `Compatibility profile header "${rawName}" is not allowed.`,
        statusCode: 400,
        routeScope: "provider",
      });
    }
    destination[name] = value;
  }
}

export function applyCompatibilityRequestRules(
  initial: Record<string, unknown>,
  rules: readonly CompatibilityRequestRule[] | undefined,
): Record<string, unknown> {
  if (rules === undefined || rules.length === 0) return initial;
  const payload = { ...initial };
  for (const rule of rules) {
    if (!isCompatibilityField(rule.kind === "set-default" || rule.kind === "omit-field" ? rule.field : rule.from)) {
      throw new UpstreamError({
        kind: "invalid_request",
        message: "Compatibility profile contains an invalid request rule field.",
        statusCode: 400,
        routeScope: "provider",
      });
    }
    if (rule.kind === "rename-field") {
      if (!isCompatibilityField(rule.to)) throw invalidCompatibilityRule();
      if (payload[rule.from] !== undefined && payload[rule.to] === undefined) payload[rule.to] = payload[rule.from];
      delete payload[rule.from];
      continue;
    }
    if (rule.kind === "move-field") {
      if (rule.to.length === 0 || rule.to.length > 3 || rule.to.some((segment) => !isCompatibilityField(segment))) throw invalidCompatibilityRule();
      const value = payload[rule.from];
      if (value !== undefined) {
        let cursor: Record<string, unknown> = payload;
        for (const segment of rule.to.slice(0, -1)) {
          const existing = cursor[segment];
          if (existing === undefined) {
            const nested: Record<string, unknown> = {};
            cursor[segment] = nested;
            cursor = nested;
          } else if (isRecord(existing)) {
            const nested = { ...existing };
            cursor[segment] = nested;
            cursor = nested;
          } else {
            throw invalidCompatibilityRule();
          }
        }
        const finalSegment = rule.to[rule.to.length - 1];
        if (finalSegment === undefined) throw invalidCompatibilityRule();
        cursor[finalSegment] = value;
        delete payload[rule.from];
      }
      continue;
    }
    if (rule.kind === "set-default") {
      if (payload[rule.field] === undefined) payload[rule.field] = rule.value;
      continue;
    }
    delete payload[rule.field];
  }
  return payload;
}

function invalidCompatibilityRule(): UpstreamError {
  return new UpstreamError({
    kind: "invalid_request",
    message: "Compatibility profile contains an invalid request rule.",
    statusCode: 400,
    routeScope: "provider",
  });
}

function isCompatibilityField(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
}

export function compatibilityResponseMetadata(
  headers: Headers,
  body: Record<string, unknown> | undefined,
  profile: CompatibilityProfile | undefined,
): import("../types/telemetry.js").ProviderResponseMetadata | undefined {
  const selected = new Set(profile?.responseMetadata ?? []);
  if (selected.size === 0) return undefined;
  const requestId = headers.get("x-request-id") ?? headers.get("request-id");
  const systemFingerprint = typeof body?.system_fingerprint === "string" ? body.system_fingerprint : undefined;
  const serviceTier = typeof body?.service_tier === "string" ? body.service_tier : undefined;
  const model = typeof body?.model === "string" ? body.model : undefined;
  const metadata = {
    ...(selected.has("request-id") && requestId !== null ? { requestId } : {}),
    ...(selected.has("system-fingerprint") && systemFingerprint !== undefined ? { systemFingerprint } : {}),
    ...(selected.has("service-tier") && serviceTier !== undefined ? { serviceTier } : {}),
    ...(selected.has("model") && model !== undefined ? { model } : {}),
  };
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}
