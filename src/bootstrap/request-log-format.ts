/**
 * Console Logs write-layer formatting — pure helpers, no privacy branching.
 * `renderTraceLine` builds the flat human-readable `msg` (never contains a client IP —
 * a flat string cannot be re-rendered under a changing privacy setting, so the raw
 * value must not be baked into it). `buildContext` returns the full structured event
 * verbatim (including the raw IP) for `context_json`, which read-time services mask
 * before returning to the wire.
 */
import type { ProxyRequestLogEvent } from "../proxy/request/prepare.js";

/** Console log level for a lifecycle event: error/warn/info/debug by severity. */
export function levelFor(event: ProxyRequestLogEvent["event"]): "error" | "warn" | "info" | "debug" {
  if (event === "failed") return "error";
  if (event === "aborted" || event === "switch") return "warn";
  if (event === "complete") return "info";
  return "debug";
}

/**
 * Fixed-order, IP-free trace line for the flat `msg` column. Nullish fields are
 * skipped. Final 240-char truncation is applied downstream by the telemetry
 * pipeline's `sanitizeMessage`; this function does not truncate.
 */
export function renderTraceLine(event: ProxyRequestLogEvent): string {
  const isAborted = event.event === "aborted";
  const tokenParts = [
    event.inputTokens !== null ? `in=${event.inputTokens}` : null,
    event.outputTokens !== null ? `out=${event.outputTokens}` : null,
    event.cachedTokens !== null ? `cache=${event.cachedTokens}` : null,
    event.cacheWriteTokens !== null ? `cachew=${event.cacheWriteTokens}` : null,
    event.reasoningTokens !== null ? `think=${event.reasoningTokens}` : null,
  ].filter((part): part is string => part !== null);
  const tokens = [
    event.event,
    event.requestId.slice(0, 8),
    `${event.providerId ?? "unknown"}/${event.model ?? "unknown"}`,
    event.accountId !== null ? `acc=${event.accountId}` : null,
    event.proxyId !== null ? `proxy=${event.proxyId}` : null,
    isAborted ? "status=499" : event.status !== null ? `status=${event.status}` : null,
    isAborted ? "err=client_aborted" : event.errorKind !== null ? `err=${event.errorKind}` : null,
    event.switch !== undefined ? `switch=${event.switch.fromCandidateId}\u2192${event.switch.toCandidateId ?? "none"}(${event.switch.reason})` : null,
    tokenParts.length > 0 ? tokenParts.join(" ") : null,
    `client=${event.clientName}(${event.clientSource})`,
    `${event.durationMs}ms`,
  ];
  return tokens.filter((token): token is string => token !== null).join(" | ");
}

/** Structured verbatim context for `context_json` — raw truth at storage layer; no masking. */
export function buildContext(event: ProxyRequestLogEvent): Readonly<Record<string, unknown>> {
  return { ...event };
}

export function renderMontanaLog(event: ProxyRequestLogEvent): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    step: event.event,
    client_key_label: event.clientName,
    model: event.model,
    relay: event.proxyId,
    status: event.status,
    latency_ms: Math.round(event.durationMs),
    error: event.errorKind,
  });
}
