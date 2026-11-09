import { UpstreamError, parseUpstreamFailure } from "../proxy/transport/errors.js";
import type { ProviderCaps } from "../proxy/types/provider.js";
import type { ProviderRequest } from "../proxy/types/request.js";

/**
 * Asserts the adapter supports the requested surface before any network
 * lease is acquired. Mirrors the repeated capability check across all
 * API-key and OAuth adapters.
 */
export function assertProviderSurface(input: ProviderRequest, providerId: string, caps: ProviderCaps): void {
  const surface = input.target.surface;
  if (!caps.surfaces.includes(surface as typeof caps.surfaces[number])) {
    throw new UpstreamError({
      kind: "capability_unsupported",
      message: `Provider "${providerId}" does not support surface "${surface}"`,
      statusCode: 400,
      routeScope: null,
    });
  }
}

/**
 * Requires a non-empty credential for providers that need one.
 */
export function requireCredential(credential: string | null | undefined, providerId: string): asserts credential is string {
  if (credential === null || credential === undefined || credential.length === 0) {
    throw new UpstreamError({
      kind: "credential_unavailable",
      message: `No credentials available for ${providerId}`,
      statusCode: 401,
      routeScope: "account",
    });
  }
}

/**
 * Requires a readable stream body; otherwise the upstream violated the
 * contract and we surface a provider_protocol_error.
 */
export function requireStreamBody(response: Response, providerId: string): ReadableStream<Uint8Array> {
  if (response.body === null) {
    throw new UpstreamError({
      kind: "provider_protocol_error",
      message: `${providerId} returned an empty stream body`,
      routeScope: "provider",
    });
  }
  return response.body;
}

/**
 * Throws a structured upstream failure preserving the raw body for capture.
 * Callers must `throw await throwUpstreamHttpFailure(...)`.
 */
export async function throwUpstreamHttpFailure(
  response: Response,
  providerId: string,
  _capture?: unknown,
): Promise<never> {
  throw await parseUpstreamFailure(response, providerId);
}

/**
 * Retries an upstream request once after stripping the compatibility-rejected
 * field. Used by OpenAI/Anthropic/Gemini adapters that support a
 * compatibility projection fallback.
 */
export async function retryCompatibilityRequest<T>(options: {
  readonly shouldRetry: (error: unknown) => boolean;
  readonly applyFallback: () => void;
  readonly execute: () => Promise<T>;
}): Promise<T> {
  try {
    return await options.execute();
  } catch (error) {
    if (!options.shouldRetry(error)) throw error;
    options.applyFallback();
    return options.execute();
  }
}
