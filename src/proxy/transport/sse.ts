import { isTerminalEvent } from "../types/stream.js";
import { sanitizeMessage } from "../types/error-types.js";
import type { ApplicationErrorKind } from "../types/error-types.js";
import type { RequestLimits } from "../types/content.js";
import type { SseDecodeConfig, SseEvent, StreamEvent, StreamMapper } from "../types/stream.js";
import { markOverhead } from "../../runtime/overhead.js";
import { runtimeMemoryLimits } from "../../runtime/limits.js";
import { createInternalFailure } from "../errors.js";

export const MAX_SSE_LINE = 64 * 1024;
export const MAX_SSE_EVENT = 64 * 1024;
export const MAX_SSE_BUFFERED = 512 * 1024;
export const MAX_SSE_EVENTS = 100_000;

function boundedInt(env: string, fallback: number, min: number, max: number): number {
  const raw = Number(Bun.env[env] ?? process.env[env]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.floor(raw), min), max);
}

export const STREAM_BOUNDS = Object.freeze({
  lineBytes: Math.min(runtimeMemoryLimits.streamLineBytes ?? boundedInt("OHMYOMOP_ROUTER_MAX_STREAM_LINE_BYTES", MAX_SSE_LINE, 4 * 1024, MAX_SSE_LINE), MAX_SSE_LINE),
  eventBytes: Math.min(runtimeMemoryLimits.streamEventBytes ?? boundedInt("OHMYOMOP_ROUTER_MAX_STREAM_EVENT_BYTES", MAX_SSE_EVENT, 4 * 1024, MAX_SSE_EVENT), MAX_SSE_EVENT),
  bufferedBytes: Math.min(runtimeMemoryLimits.streamBufferedBytes ?? boundedInt("OHMYOMOP_ROUTER_MAX_STREAM_BUFFERED_BYTES", MAX_SSE_BUFFERED, 64 * 1024, MAX_SSE_BUFFERED), MAX_SSE_BUFFERED),
  eventCount: Math.min(runtimeMemoryLimits.streamEventCount ?? boundedInt("OHMYOMOP_ROUTER_MAX_STREAM_EVENTS", MAX_SSE_EVENTS, 1_000, MAX_SSE_EVENTS), MAX_SSE_EVENTS),
  framesPerPush: boundedInt("OHMYOMOP_ROUTER_MAX_STREAM_FRAMES_PER_PUSH", 512, 32, 4096),
  framesPerEvent: boundedInt("OHMYOMOP_ROUTER_MAX_STREAM_FRAMES_PER_EVENT", 1024, 64, 8192),
  maxStreamBytes: boundedInt("OHMYOMOP_ROUTER_MAX_STREAM_BYTES", 10 * 1024 * 1024, 1 * 1024 * 1024, 64 * 1024 * 1024),
});

export type StreamErrorKind = ApplicationErrorKind | "stream_truncated" | "client_aborted";

export class StreamError extends Error {
  readonly kind: StreamErrorKind;
  readonly retryable: boolean;
  readonly routeScope: "account" | "proxy" | "provider" | null;

  constructor(options: {
    readonly kind: StreamErrorKind;
    readonly message: string;
    readonly retryable?: boolean;
    readonly routeScope?: "account" | "proxy" | "provider" | null;
  }) {
    super(options.message);
    this.name = "StreamError";
    this.kind = options.kind;
    this.retryable = options.retryable ?? false;
    this.routeScope = options.routeScope ?? "provider";
  }

  internalFailureFromUnknown(): {
    readonly statusCode: number | null;
    readonly kind: StreamErrorKind;
    readonly retryable: boolean;
    readonly routeScope: "account" | "proxy" | "provider" | null;
    readonly source: "upstream" | "internal" | "client";
    readonly safeMessage: string;
    readonly retryAt: string | null;
  } {
    return {
      statusCode: null,
      kind: this.kind,
      retryable: this.retryable,
      routeScope: this.routeScope,
      source: this.kind === "client_aborted" ? "client" : "upstream",
      safeMessage: sanitizeMessage(this.message),
      retryAt: null,
    };
  }
}

export type { SseEvent, StreamEvent };
export { isTerminalEvent };

interface StreamCoordinator {
  readonly signal?: AbortSignal;
  abort?(cause: "stream_limit"): void;
  causeOf?(): string;
  markBodyByteReceived?(): void;
  beginReadWatchdog?(timeoutMs?: number): void;
  endReadWatchdog?(): void;
}

export function lineLimit(_limits: RequestLimits): number {
  return STREAM_BOUNDS.lineBytes;
}

export function parseSseData(data: string): unknown {
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw createInternalFailure({ kind: "provider_protocol_error", safeMessage: "Invalid JSON in stream event", retryable: false, routeScope: null });
  }
}

// ── SSE parser (bounded, abort-aware) ───────────────────────────────────────
export async function* parseSseEvents(config: SseDecodeConfig): AsyncGenerator<SseEvent> {
  const maxLineBytes = Math.min(config.maxLineBytes ?? STREAM_BOUNDS.lineBytes, STREAM_BOUNDS.lineBytes);
  const maxEventBytes = Math.min(config.maxEventBytes ?? STREAM_BOUNDS.eventBytes, STREAM_BOUNDS.eventBytes);
  const reader = config.body.getReader();
  const coordinator = config.coordinator as StreamCoordinator | undefined;
  const utf8 = new TextDecoder("utf-8", { fatal: false });
  let pending: Uint8Array = new Uint8Array(0);
  let eventName: string | null = null;
  let eventBytes = 0;
  let eventCount = 0;
  let streamBytes = 0;
  let dataLines: string[] = [];

  const signal = config.signal;
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    void reader.cancel().catch(() => {});
  };
  const abortError = (): ReturnType<typeof createInternalFailure> => {
    const cause = coordinator?.causeOf?.();
    if (signal?.aborted || cause === "caller") {
      return createInternalFailure({ kind: "client_aborted", safeMessage: "Request aborted by caller", retryable: false, routeScope: null });
    }
    if (cause === "stream_limit") {
      return createInternalFailure({ kind: "provider_protocol_error", safeMessage: "Upstream stream exceeded the configured byte limit", routeScope: null });
    }
    if (cause === "first_body_timeout" || cause === "idle_timeout" || cause === "total_timeout") {
      return createInternalFailure({ kind: "stream_timeout", safeMessage: "Upstream stream timed out", retryable: true, routeScope: null });
    }
    return createInternalFailure({ kind: "provider_protocol_error", safeMessage: "Upstream stream aborted", retryable: false, routeScope: null });
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const coordinatorSignal = coordinator?.signal;
  if (coordinatorSignal && coordinatorSignal !== signal) {
    if (coordinatorSignal.aborted) onAbort();
    else coordinatorSignal.addEventListener("abort", onAbort, { once: true });
  }
  const readChunk = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
    if (!coordinatorSignal) return reader.read();
    if (coordinatorSignal.aborted) throw abortError();
    let removeAbortListener = (): void => {};
    const abortPromise = new Promise<never>((_, reject) => {
      const rejectOnAbort = (): void => reject(abortError());
      coordinatorSignal.addEventListener("abort", rejectOnAbort, { once: true });
      removeAbortListener = () => coordinatorSignal.removeEventListener("abort", rejectOnAbort);
    });
    try {
      return await Promise.race([reader.read(), abortPromise]);
    } finally {
      removeAbortListener();
    }
  };

  const consumeLine = (bytes: Uint8Array): SseEvent | null => {
    const lineBytes = bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 13
      ? bytes.subarray(0, bytes.byteLength - 1)
      : bytes;
    if (lineBytes.byteLength > maxLineBytes) {
      throw new StreamError({ kind: "provider_protocol_error", message: `SSE line exceeds ${maxLineBytes} bytes`, routeScope: "provider" });
    }
    if (lineBytes.byteLength === 0) {
      if (dataLines.length === 0) {
        eventName = null;
        eventBytes = 0;
        return null;
      }
      const data = dataLines.length === 1 ? (dataLines[0] as string) : dataLines.join("\n");
      dataLines = [];
      const event: SseEvent | null = data.length === 0 ? null : { event: eventName, data };
      eventName = null;
      eventBytes = 0;
      return event;
    }

    eventBytes += lineBytes.byteLength + 1;
    if (eventBytes > maxEventBytes) {
      throw new StreamError({ kind: "provider_protocol_error", message: `SSE event exceeds ${maxEventBytes} bytes`, routeScope: "provider" });
    }
    if (lineBytes[0] === 58) return null;
    const line = utf8.decode(lineBytes);
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    return null;
  };

  const acceptEvent = (event: SseEvent | null): SseEvent | null => {
    if (event === null) return null;
    eventCount += 1;
    if (eventCount > STREAM_BOUNDS.eventCount) {
      throw new StreamError({ kind: "provider_protocol_error", message: `SSE stream exceeds ${STREAM_BOUNDS.eventCount} events`, routeScope: "provider" });
    }
    return event;
  };

  try {
    while (true) {
      if (aborted) throw abortError();

      let chunk: { done: boolean; value?: Uint8Array };
      coordinator?.beginReadWatchdog?.(config.idleTimeoutMs);
      try {
        chunk = await readChunk();
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (coordinator?.signal?.aborted) throw abortError();
        throw createInternalFailure({ kind: "provider_protocol_error", safeMessage: sanitizeMessage(error), retryable: false, routeScope: null });
      } finally {
        coordinator?.endReadWatchdog?.();
      }

      if (aborted) throw abortError();
      if (chunk.done) {
        break;
      }
      const value = chunk.value;
      if (value === undefined || value.byteLength === 0) continue;
      coordinator?.markBodyByteReceived?.();
      streamBytes += value.byteLength;
      if (streamBytes > STREAM_BOUNDS.maxStreamBytes) {
        coordinator?.abort?.("stream_limit");
        try {
          await reader.cancel();
        } catch {}
        throw new StreamError({ kind: "provider_protocol_error", message: `SSE stream exceeds ${STREAM_BOUNDS.maxStreamBytes} bytes`, routeScope: "provider" });
      }
      const stopParse = eventCount < 10 ? markOverhead("stream.parse") : null;
      // Zero-copy pending handling: avoid pending+value full copy via subarray views.
      // pending is guaranteed to contain no newline; handle spanning line with minimal copy.
      if (pending.byteLength !== 0) {
        const nlIndex = value.indexOf(10);
        if (nlIndex === -1) {
          if (pending.byteLength + value.byteLength > maxLineBytes) {
            throw new StreamError({ kind: "provider_protocol_error", message: `SSE line exceeds ${maxLineBytes} bytes`, routeScope: "provider" });
          }
          const extended = new Uint8Array(pending.byteLength + value.byteLength);
          extended.set(pending, 0);
          extended.set(value, pending.byteLength);
          pending = extended;
          const bufferedBytes = pending.byteLength + eventBytes;
          if (bufferedBytes > STREAM_BOUNDS.bufferedBytes)
            throw new StreamError({ kind: "provider_protocol_error", message: `SSE buffered data exceeds ${STREAM_BOUNDS.bufferedBytes} bytes`, routeScope: "provider" });
          stopParse?.();
          continue;
        }
        const firstLineLen = pending.byteLength + nlIndex;
        if (firstLineLen > maxLineBytes) {
          throw new StreamError({ kind: "provider_protocol_error", message: `SSE line exceeds ${maxLineBytes} bytes`, routeScope: "provider" });
        }
        const firstLine = new Uint8Array(firstLineLen);
        firstLine.set(pending, 0);
        firstLine.set(value.subarray(0, nlIndex), pending.byteLength);
        const firstEvent = acceptEvent(consumeLine(firstLine));
        if (firstEvent !== null) {
          stopParse?.();
          yield firstEvent;
        }
        let lineStart = nlIndex + 1;
        for (let index = lineStart; index < value.byteLength; index += 1) {
          if (value[index] !== 10) continue;
          const event = acceptEvent(consumeLine(value.subarray(lineStart, index)));
          lineStart = index + 1;
          if (event !== null) {
            stopParse?.();
            yield event;
          }
        }
        pending = lineStart === value.byteLength ? new Uint8Array(0) : value.subarray(lineStart);
        stopParse?.();
        const bufferedBytes = pending.byteLength + eventBytes;
        if (pending.byteLength > maxLineBytes)
          throw new StreamError({ kind: "provider_protocol_error", message: `SSE line exceeds ${maxLineBytes} bytes`, routeScope: "provider" });
        if (bufferedBytes > STREAM_BOUNDS.bufferedBytes)
          throw new StreamError({ kind: "provider_protocol_error", message: `SSE buffered data exceeds ${STREAM_BOUNDS.bufferedBytes} bytes`, routeScope: "provider" });
        continue;
      }
      let lineStart = 0;
      for (let index = 0; index < value.byteLength; index += 1) {
        if (value[index] !== 10) continue;
        const event = acceptEvent(consumeLine(value.subarray(lineStart, index)));
        lineStart = index + 1;
        if (event !== null) {
          stopParse?.();
          yield event;
        }
      }
      pending = lineStart === value.byteLength ? new Uint8Array(0) : value.subarray(lineStart);
      stopParse?.();
      const bufferedBytes = pending.byteLength + eventBytes;
      if (pending.byteLength > maxLineBytes)
        throw new StreamError({ kind: "provider_protocol_error", message: `SSE line exceeds ${maxLineBytes} bytes`, routeScope: "provider" });
      if (bufferedBytes > STREAM_BOUNDS.bufferedBytes)
        throw new StreamError({ kind: "provider_protocol_error", message: `SSE buffered data exceeds ${STREAM_BOUNDS.bufferedBytes} bytes`, routeScope: "provider" });
    }

    if (pending.byteLength > maxLineBytes)
      throw new StreamError({ kind: "provider_protocol_error", message: `SSE line exceeds ${maxLineBytes} bytes`, routeScope: "provider" });
    if (pending.byteLength > 0) {
      const event = acceptEvent(consumeLine(pending));
      if (event !== null) yield event;
    }
    const finalEvent = acceptEvent(consumeLine(new Uint8Array(0)));
    if (finalEvent !== null) yield finalEvent;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    if (coordinatorSignal && coordinatorSignal !== signal) coordinatorSignal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
  }
}

// ── mapped stream (terminal guard) ──────────────────────────────────────────
export async function* mapSseStream(config: SseDecodeConfig, mapper: StreamMapper): AsyncGenerator<StreamEvent> {
  let terminal = false;
  for await (const sse of parseSseEvents(config)) {
    if (sse.data === "[DONE]") {
      const mapped = mapper(sse);
      if (mapped !== null) {
        const arr = Array.isArray(mapped) ? mapped : [mapped];
        for (const ev of arr) {
          yield ev;
          if (isTerminalEvent(ev)) terminal = true;
        }
      } else {
        // default terminal when mapper yields nothing for [DONE]
        if (!terminal) {
          yield { type: "message_stop", reason: "completed" };
          terminal = true;
        }
      }
      continue;
    }
    const mapped = mapper(sse);
    if (mapped === null) continue;
    const arr = Array.isArray(mapped) ? mapped : [mapped];
    if (arr.length > STREAM_BOUNDS.framesPerPush)
      throw createInternalFailure({ kind: "provider_protocol_error", safeMessage: `Stream mapper exceeds ${STREAM_BOUNDS.framesPerPush} frames per push`, routeScope: null });
    for (const ev of arr) {
      yield ev;
      if (isTerminalEvent(ev)) terminal = true;
    }
  }
  if (!terminal) {
    throw createInternalFailure({ kind: "stream_truncated", safeMessage: "Upstream stream ended before a terminal event", retryable: true, routeScope: null });
  }
}
