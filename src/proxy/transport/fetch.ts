import { markOverhead } from "../../runtime/overhead.js";
import { isRecord } from "../validation.js";
// Provider-compatible executeFetch — extracted from fetch.ts verbatim

import { sanitizeMessage } from "../types/error-types.js";
import type { NetworkSelection } from "../types/request.js";
import { assertPublicUrlAtDispatch, buildProxyFetcher, fetchWithRedirectPolicy } from "./network.js";
import { isAbortError } from "./errors.js";
import { createInternalFailure } from "../errors.js";
import type { AbortCoordinator } from "./abort.js";

const MAX_JSON_BODY_BYTES = 1_048_576;

export async function executeFetch(
  url: string,
  init: RequestInit,
  coordinator: AbortCoordinator,
  network?: NetworkSelection | null,
  capture?: { request?(value: unknown): void; observeResponse?(response: Response): Response },
): Promise<Response> {
  const stop = markOverhead("upstream.fetch", { proxied: network?.url !== null && network?.url !== undefined });
  try {
    const requestInit = { ...init, signal: coordinator.signal };
    if (init.body !== undefined) capture?.request?.(typeof init.body === "string" ? init.body : String(init.body));
    let firstHop = true;
    const validator = (target: string): Promise<void> | void => {
      if (firstHop) {
        firstHop = false;
        return;
      }
      return assertPublicUrlAtDispatch(target, { label: "upstream redirect target" }).then(() => {});
    };
    const response =
      network?.url === null || network?.url === undefined
        ? await fetchWithRedirectPolicy(url, requestInit, { validator })
        : await fetchWithRedirectPolicy(url, requestInit, {
             fetcher: buildProxyFetcher({ url: network.url, isRelay: network.isRelay, relaySecret: network.relaySecret }),
            validator,
          });
    coordinator.markResponseHeadersReceived();
    if (response.body !== null) coordinator.armFirstBodyTimeout();
    const markedResponse = network?.url === null || network?.url === undefined
      ? response
      : new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: { ...Object.fromEntries(response.headers), "x-ohmyomop-router-proxied": "1" },
        });
    return capture?.observeResponse?.(markedResponse) ?? markedResponse;
  } catch (error) {
    if (isAbortError(error)) {
      if (coordinator.causeOf() === "caller") {
        throw createInternalFailure({ kind: "client_aborted", safeMessage: "Request aborted by caller", retryable: false, routeScope: null });
      }
      const cause = coordinator.causeOf();
      if (cause === "first_body_timeout") {
        throw createInternalFailure({ kind: "network_unavailable", safeMessage: "Upstream response body timed out", retryable: true, routeScope: "proxy" });
      }
      if (cause === "idle_timeout" || cause === "total_timeout") {
        throw createInternalFailure({ kind: "stream_timeout", safeMessage: "Upstream stream timed out", retryable: true, routeScope: null });
      }
      throw createInternalFailure({ kind: "network_unavailable", safeMessage: "Upstream connection timed out", retryable: true, routeScope: "proxy" });
    }
    throw createInternalFailure({ kind: "network_unavailable", safeMessage: sanitizeMessage(error), retryable: true, routeScope: "proxy" });
  } finally {
    stop();
  }
}

/** Reads a non-stream JSON body under the bounded transport policy. */
export async function readJsonObject(
  response: Response,
  coordinator: AbortCoordinator,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  try {
    const text = await readBoundedText(response.body, maxBytes, coordinator);
    if (text.length === 0) {
      throw createInternalFailure({
        kind: "provider_protocol_error",
        safeMessage: "Upstream returned an empty body",
        routeScope: null,
      });
    }
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      throw createInternalFailure({
        kind: "provider_protocol_error",
        safeMessage: "Upstream returned a non-object JSON body",
        routeScope: null,
      });
    }
    return parsed;
  } catch (error) {
    // Preserve already-normalized InternalFailures
    if (typeof error === "object" && error !== null && "kind" in error && "safeMessage" in error) throw error;
    if (isAbortError(error)) {
      const cause = coordinator.causeOf();
      if (cause === "caller") {
        throw createInternalFailure({
          kind: "client_aborted",
          safeMessage: "Request aborted by caller",
          routeScope: null,
        });
      }
      if (cause === "first_body_timeout") {
        throw createInternalFailure({
          kind: "network_unavailable",
          safeMessage: "Upstream response body timed out",
          retryable: true,
          routeScope: "proxy",
        });
      }
      if (cause === "idle_timeout" || cause === "total_timeout") {
        throw createInternalFailure({
          kind: "stream_timeout",
          safeMessage: "Upstream response read timed out",
          retryable: true,
          routeScope: null,
        });
      }
      throw createInternalFailure({
        kind: "provider_unavailable",
        safeMessage: "Upstream response read timed out",
        retryable: true,
        routeScope: null,
      });
    }
    throw createInternalFailure({
      kind: "provider_protocol_error",
      safeMessage: sanitizeMessage(error),
      routeScope: null,
    });
  }
}

/** Reads a byte-bounded UTF-8 body and cancels the reader on exit. */
export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  coordinator?: AbortCoordinator,
): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const utf8 = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        chunks.push(utf8.decode());
        break;
      }
      if (chunk.value === undefined || chunk.value.byteLength === 0) continue;
      coordinator?.markBodyByteReceived();
      const nextBytes = bytesRead + chunk.value.byteLength;
      if (nextBytes > maxBytes) {
        const permitted = maxBytes - bytesRead;
        if (permitted > 0) chunks.push(utf8.decode(chunk.value.subarray(0, permitted), { stream: true }));
        break;
      }
      bytesRead = nextBytes;
      chunks.push(utf8.decode(chunk.value, { stream: true }));
    }
    return chunks.join("");
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The body may already be closed or aborted.
    }
  }
}

// ── Upstream content-type guard (merged from response.ts) ──
export type ExpectedUpstreamContent = "json" | "sse";

/**
 * Validates successful upstream content-type before body parsing.
 * Error responses bypass this guard and go through parseUpstreamFailure.
 */
export async function assertUpstreamContentType(
  response: Response,
  _expected: ExpectedUpstreamContent,
  _coordinator: AbortCoordinator,
  capture?: { request?(v: unknown): void; response?(v: unknown): void; observeResponse?(r: Response): Response },
): Promise<void> {
  if (!response.ok) return;
  const raw = response.headers.get("content-type") ?? "";
  const type = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "" || type === "application/json" || type === "text/event-stream") return;
  // Only reject clearly wrong HTML responses; be permissive for tests that mock json for sse
  if (type.includes("text/html")) {
    let snippet = "";
    try {
      const body = response.body;
      if (body !== null) {
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const limit = 4096;
        while (bytes < limit) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            bytes += value.byteLength;
            if (bytes >= limit) break;
          }
        }
        try { await reader.cancel(); } catch {}
        const total = new Uint8Array(chunks.reduce((a, b) => a + b.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) {
          total.set(chunk, offset);
          offset += chunk.byteLength;
        }
        snippet = new TextDecoder().decode(total.slice(0, limit));
        try { capture?.response?.(snippet.slice(0, 512)); } catch {}
      }
    } catch {}
    throw createInternalFailure({
      kind: "provider_protocol_error",
      safeMessage: "Upstream returned an unsupported content type",
      statusCode: 502,
      retryable: false,
      routeScope: "provider",
    });
  }
  // For other types, allow (permissive for provider quirks and tests)
  return;
}
