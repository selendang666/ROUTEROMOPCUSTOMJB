/**
 * Compatibility retry — single owner for projection fallback.
 */
import type { AbortCoordinator } from "./abort.js";

export interface UpstreamError extends Error {
  readonly code?: string;
}

/**
 * Wraps upstream execution with compatibility projection retry.
 * @param args - payload/endpoint/coordinator/execute
 * @returns upstream result
 */
export async function withCompatibilityRetry<T>(args: {
  readonly payload: unknown;
  readonly endpoint: string;
  readonly headers: Headers;
  readonly coordinator: AbortCoordinator;
  readonly shouldRetry: (failure: UpstreamError) => boolean;
  readonly execute: (payload: unknown) => Promise<T>;
}): Promise<T> {
  try {
    return await args.execute(args.payload);
  } catch (error) {
    const failure = error as UpstreamError;
    if (!args.shouldRetry(failure)) throw error;
    // Strip capability_unsupported projections and retry once
    const next = removeCompatibilityProjection(args.payload);
    return await args.execute(next);
  }
}

function removeCompatibilityProjection(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const copy = { ...(payload as Record<string, unknown>) };
  delete copy["reasoning_effort"];
  delete copy["tool_choice"];
  return copy;
}
