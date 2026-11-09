import type { UpstreamFailureTrace } from "../types/error-types.js";

/**
 * Reusable protobuf framing helpers for Cursor / Devin.
 * Extracts trailer code and preserves raw message without synthesising a
 * provider code. Provider-specific auth/endpoints remain in adapters.
 */
export function parseProtobufTrailer(
  headers: Headers,
  body: Uint8Array | string,
  providerId: string,
): UpstreamFailureTrace {
  const trailerCode = headers.get("grpc-status") ?? headers.get("x-grpc-status") ?? null;
  const rawMessage = typeof body === "string" ? body.slice(0, 4096) : new TextDecoder().decode(body.slice(0, 4096));
  return {
    providerId,
    transport: "protobuf",
    statusCode: 200,
    providerCode: trailerCode,
    providerType: trailerCode,
    requestId: headers.get("x-request-id") ?? headers.get("grpc-request-id") ?? null,
    retryAfterMs: null,
    rawMessage,
    bodyTruncated: (typeof body === "string" ? body.length : body.byteLength) > 4096,
  };
}

export function isProtobufTrailerError(headers: Headers): boolean {
  const code = headers.get("grpc-status");
  return code !== null && code !== "0";
}
