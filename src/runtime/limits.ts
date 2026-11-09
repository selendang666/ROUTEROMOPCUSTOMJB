// Limits — process-wide memory and framing limits (env-tunable, clamped)
// Extracted from admission.ts verbatim

// ── Limits — process-wide memory and framing limits (env-tunable, clamped) ──

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(Bun.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), minimum), maximum);
}

/** Clamped process limits shared by request, stream, and in-memory state boundaries. */
export const runtimeMemoryLimits = Object.freeze({
  requestBodyBytes: boundedInteger("OHMYOMOP_ROUTER_MAX_REQUEST_BODY_BYTES", 10 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
  streamLineBytes: boundedInteger("OHMYOMOP_ROUTER_MAX_STREAM_LINE_BYTES", 4 * 1024 * 1024, 4 * 1024, 8 * 1024 * 1024),
  streamEventBytes: boundedInteger("OHMYOMOP_ROUTER_MAX_STREAM_EVENT_BYTES", 4 * 1024 * 1024, 16 * 1024, 16 * 1024 * 1024),
  streamBufferedBytes: boundedInteger("OHMYOMOP_ROUTER_MAX_STREAM_BUFFERED_BYTES", 512 * 1024, 64 * 1024, 8 * 1024 * 1024),
  streamEventCount: boundedInteger("OHMYOMOP_ROUTER_MAX_STREAM_EVENTS", 100_000, 1_000, 1_000_000),
  maxRouteTransitionRoutes: boundedInteger("OHMYOMOP_ROUTER_MAX_ROUTE_TRANSITION_ROUTES", 4_096, 16, 100_000),
  maxRouteTransitionsPerRoute: boundedInteger("OHMYOMOP_ROUTER_MAX_ROUTE_TRANSITIONS_PER_ROUTE", 512, 8, 4_096),
  maxTrackedIps: boundedInteger("OHMYOMOP_ROUTER_MAX_TRACKED_IPS", 10_000, 0, 1_000_000),
  maxTrackedKeys: boundedInteger("OHMYOMOP_ROUTER_MAX_TRACKED_KEYS", 10_000, 0, 1_000_000),
  loginMaxTrackedIps: boundedInteger("OHMYOMOP_ROUTER_LOGIN_MAX_TRACKED_IPS", 10_000, 0, 1_000_000),
  gcIntervalMs: boundedInteger("OHMYOMOP_ROUTER_GC_INTERVAL_MS", 10 * 60_000, 0, 24 * 60 * 60_000),
  rateLimitMaxRequests: boundedInteger("OHMYOMOP_ROUTER_RATE_LIMIT_MAX_REQUESTS", 100, 1, 1_000_000),
  rateLimitWindowMs: boundedInteger("OHMYOMOP_ROUTER_RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 24 * 60 * 60_000),
});
