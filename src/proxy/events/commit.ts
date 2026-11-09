import { applicationError } from "../errors.js";
import { isRecord, MAX_TOOL_ARGUMENT_LENGTH } from "../validation.js";
import type { ContentPart, NormalizedMessage } from "../types/content.js";
import type { ExtendedStreamEvent, StopReason, StreamEvent } from "../types/stream.js";
import type { ProviderUsage } from "../types/telemetry.js";
import type { Surface } from "../types/surface.js";
import type { PresentedProxyResponse, ProviderOutput } from "../types/request.js";
import type { InternalFailure, PublicErrorBody } from "../types/error-types.js";
import { ProtocolCodecError } from "../errors.js";

type InternalStreamEvent = ExtendedStreamEvent;

// ── commit / terminal classification ────────────────────────────────────────
export function isCommitEvent(ev: InternalStreamEvent): boolean {
  switch (ev.type) {
    case "text_delta":
    case "thinking_delta":
    case "tool_call_start":
    case "tool_call_delta":
    case "tool_call_end":
    case "native_block_start":
    case "native_block_delta":
    case "native_block_stop":
    case "server_tool_result":
    case "context_item":
    case "compaction_start":
    case "compaction_delta":
    case "compaction_stop":
      return true;
    case "message_stop":
      return true;
    case "message_start":
    case "usage":
      return false;
    default:
      return false;
  }
}

export function classifyTerminal(reason: StopReason): { status: "completed" | "incomplete" | "failed"; retryable: boolean } {
  if (reason === "error") return { status: "failed", retryable: false };
  // length/content_filter are incomplete but not error; downstream may treat as terminal non-retryable
  return { status: reason === "length" || reason === "content_filter" ? "incomplete" : "completed", retryable: false };
}

/** True when upstream error must NOT retry because visible commit already happened. */
export function shouldRetryAfterCommit(committed: boolean, error: { retryable?: boolean }): boolean {
  if (committed) return false;
  return error.retryable === true;
}

// exactly-once gate
export function createCommitGate(): { onEvent(ev: InternalStreamEvent): boolean; committed(): boolean } {
  let committed = false;
  return {
    onEvent(ev: InternalStreamEvent): boolean {
      if (!committed && isCommitEvent(ev)) committed = true;
      return committed;
    },
    committed(): boolean {
      return committed;
    },
  };
}

// exactly-once abort/release signal
export function createReleaseGate(release: () => Promise<void>): { release(): Promise<void>; released(): boolean } {
  let done = false;
  let promise: Promise<void> | null = null;
  return {
    released(): boolean {
      return done;
    },
    release(): Promise<void> {
      if (done) return promise ?? Promise.resolve();
      done = true;
      promise = (async () => {
        await release();
      })();
      return promise;
    },
  };
}

export function wrapWithRelease<T>(events: AsyncIterable<T>, release: () => Promise<void>, onError?: (e: unknown) => void): AsyncIterable<T> {
  const gate = createReleaseGate(release);
  let source: AsyncIterator<T> | null = null;
  const get = (): AsyncIterator<T> => {
    source ??= events[Symbol.asyncIterator]();
    return source;
  };
  let finished = false;
  const finish = async (hasPrimaryError: boolean): Promise<void> => {
    if (finished) return;
    finished = true;
    try {
      await gate.release();
    } catch (e) {
      if (hasPrimaryError) onError?.(e);
      else throw e;
    }
  };
  const iterator: AsyncIterator<T> & AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return iterator;
    },
    async next(): Promise<IteratorResult<T>> {
      if (finished) return { done: true, value: undefined };
      let failed = false;
      try {
        const r = await get().next();
        if (r.done) await finish(false);
        return r;
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        if (failed) await finish(true);
      }
    },
    async return(value?: unknown): Promise<IteratorResult<T>> {
      let failed = false;
      try {
        const r: IteratorResult<T> =
          source?.return === undefined ? { done: true, value } : await source.return(value);
        await finish(false);
        return r;
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        if (failed) await finish(true);
      }
    },
    async throw(error?: unknown): Promise<IteratorResult<T>> {
      let failed = false;
      try {
        if (source?.throw === undefined) {
          await finish(false);
          throw error;
        }
        const r = await source.throw(error);
        if (r.done) await finish(false);
        return r;
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        if (failed) await finish(true);
      }
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

/** Retry a provider call while respecting normalized retry hints and aborts. */
export async function recoverCall(options: RecoverCallOptions): Promise<ProviderOutput> {
  let lastError: unknown = null;
  for (let index = 0; index < options.maxAttempts; index += 1) {
    if (options.signal.aborted) {
      throw {
        statusCode: null,
        kind: "client_aborted",
        retryable: false,
        routeScope: null,
        source: "client_aborted",
        safeMessage: "Request aborted by client",
        retryAt: null,
      } as unknown as InternalFailure;
    }
    try {
      return await options.attempt(index);
    } catch (error) {
      lastError = error;
      const mapped = options.mapError ? options.mapError(error) : error as InternalFailure;
      if (options.onFailure) await options.onFailure(mapped, index);
      if (mapped.retryable !== true) throw mapped;
      const shouldRetry = options.shouldRetry ? options.shouldRetry(mapped) : mapped.retryable;
      if (!shouldRetry || index === options.maxAttempts - 1) throw mapped;
      const retryAt = mapped.retryAt === null ? Number.NaN : Date.parse(mapped.retryAt);
      const delay = Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
      if (delay > 0 && delay < 30_000) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          options.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }, { once: true });
        }).catch(() => {});
      }
    }
  }
  throw lastError ?? new Error("recoverCall exhausted");
}

/** Formats a normalized provider error as a public proxy response. */
export function writeErrorResponse(error: InternalFailure, requestId: string): PresentedProxyResponse {
  const status = typeof error.statusCode === "number" && Number.isFinite(error.statusCode)
    ? error.statusCode
    : 502;
  const body: PublicErrorBody = {
    error: {
      type: error.kind ?? "provider_error",
      code: error.upstream?.providerCode ?? error.failureCode ?? null,
      message: error.safeMessage ?? "Upstream provider request failed.",
    },
    request_id: requestId,
  };
  return {
    status,
    headers: new Headers({ "content-type": "application/json", "x-request-id": requestId }),
    body: { mode: "json", value: body },
  };
}

/** Formats a successful provider output as a public proxy response. */
export function writeResponse(output: ProviderOutput, requestId: string): PresentedProxyResponse {
  if (output.mode === "stream") {
    return {
      status: 200,
      headers: new Headers({
        "content-type": "text/event-stream",
        "x-request-id": requestId,
        "cache-control": "no-cache",
      }),
      body: { mode: "stream", events: output.events },
    };
  }
  return {
    status: 200,
    headers: new Headers({ "content-type": "application/json", "x-request-id": requestId }),
    body: { mode: "json", value: output.body },
  };
}

/** Retry policy used by {@link recoverCall}. */
export interface RecoverCallOptions {
  readonly attempt: (index: number) => Promise<ProviderOutput>;
  readonly maxAttempts: number;
  readonly signal: AbortSignal;
  readonly cleanup?: { add?(fn: () => void | Promise<void>): void; run?(): Promise<void> };
  readonly mapError?: (error: unknown) => InternalFailure;
  readonly onFailure?: (error: InternalFailure, index: number) => Promise<void> | void;
  readonly shouldRetry?: (error: InternalFailure) => boolean;
}

