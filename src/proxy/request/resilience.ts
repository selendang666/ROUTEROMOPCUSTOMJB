import type { InternalFailure } from "../types/error-types.js";
import type { ProviderOutput } from "../types/request.js";

// ── Hedge (merged from hedge.ts) ───────────────────────────────
export interface HedgeOptions {
  readonly candidates: readonly unknown[];
  readonly hedgeDelayMs: number;
  readonly signal: AbortSignal;
  readonly totalDeadlineMs: number;
}

export async function selectHedgeWinner(options: HedgeOptions): Promise<{ winner: unknown; loserAborted: boolean }> {
  if (options.candidates.length === 0) throw new Error("no candidates");
  if (options.candidates.length === 1 || options.hedgeDelayMs <= 0) return { winner: options.candidates[0], loserAborted: false };
  // Hedging remains disabled until executor cutover — keep sequential first-candidate selection.
  return { winner: options.candidates[0], loserAborted: false };
}

// ── Retry (merged from retry.ts) ───────────────────────────────
export interface RecoverCallOptions {
  readonly attempt: (index: number) => Promise<ProviderOutput>;
  readonly maxAttempts: number;
  readonly signal: AbortSignal;
  readonly cleanup?: { run(): Promise<void> };
  readonly mapError?: (error: unknown) => InternalFailure;
  readonly onFailure?: (error: InternalFailure, index: number) => Promise<void> | void;
}

export async function recoverCall(options: RecoverCallOptions): Promise<ProviderOutput> {
  let lastError: unknown;
  for (let i = 0; i < options.maxAttempts; i++) {
    if (options.signal.aborted) throw lastError ?? new Error("aborted");
    try {
      return await options.attempt(i);
    } catch (error) {
      lastError = error;
      const mapped = options.mapError ? options.mapError(error) : (error as InternalFailure);
      if (mapped && typeof (mapped as InternalFailure).retryable === "boolean" && !(mapped as InternalFailure).retryable) throw error;
      if (i < options.maxAttempts - 1) {
        const delayMs = (mapped as InternalFailure)?.retryAt ? Math.max(0, Date.parse((mapped as InternalFailure).retryAt!) - Date.now()) : 0;
        if (delayMs > 0 && delayMs < 30000) await new Promise((r) => setTimeout(r, Math.min(delayMs, 1000)));
      }
      await options.onFailure?.(mapped as InternalFailure, i);
      if (i === options.maxAttempts - 1) throw error;
    }
  }
  throw lastError;
}

export interface DecideRetryInput {
  readonly failure: InternalFailure;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly remainingDeadlineMs: number;
  readonly committed: boolean;
  readonly endpoints: readonly unknown[];
}

export interface RetryDecision {
  readonly shouldRetry: boolean;
  readonly delayMs?: number;
  readonly nextEndpoint?: unknown;
}

export function decideRetry(input: unknown): RetryDecision {
  if (!isDecideRetryInput(input)) return { shouldRetry: false };
  if (input.committed) return { shouldRetry: false };
  if (!input.failure.retryable) return { shouldRetry: false };
  if (input.attempt >= input.maxAttempts - 1) return { shouldRetry: false };
  if (input.remainingDeadlineMs <= 0) return { shouldRetry: false };

  const baseDelayMs = resolveRetryDelayMs(input.failure);
  const delayMs = Math.min(30_000, baseDelayMs * (2 ** Math.max(0, input.attempt)));
  if (delayMs > input.remainingDeadlineMs) return { shouldRetry: false };

  const nextEndpoint = input.endpoints[input.attempt + 1];
  return nextEndpoint === undefined ? { shouldRetry: true, delayMs } : { shouldRetry: true, delayMs, nextEndpoint };
}

function isDecideRetryInput(value: unknown): value is DecideRetryInput {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.attempt === "number"
    && typeof record.maxAttempts === "number"
    && typeof record.remainingDeadlineMs === "number"
    && typeof record.committed === "boolean"
    && Array.isArray(record.endpoints)
    && typeof record.failure === "object"
    && record.failure !== null
    && typeof (record.failure as InternalFailure).retryable === "boolean";
}

function resolveRetryDelayMs(failure: InternalFailure): number {
  const upstreamDelay = failure.upstream?.retryAfterMs;
  if (typeof upstreamDelay === "number" && Number.isFinite(upstreamDelay) && upstreamDelay > 0) return upstreamDelay;
  return 1000;
}
