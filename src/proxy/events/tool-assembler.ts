import type { StreamEvent } from "../types/stream.js";
import type { TranslationDiagnostic } from "../types/telemetry.js";
import { createInternalFailure } from "../errors.js";

export interface ToolCallFragment {
  readonly sourceKey: string;
  readonly sourceId?: string;
  readonly name?: string;
  readonly argumentDelta?: string;
  readonly reasoningSignature?: string;
  readonly done?: boolean;
}

export interface ToolCallAssemblerOptions {
  readonly maxActiveCalls: number;
  readonly maxArgumentBytes: number;
  readonly sanitizeName?: (name: string) => string;
  readonly recordDiagnostic?: (diagnostic: TranslationDiagnostic) => void;
}

interface PendingCall {
  sourceKey: string;
  occurrence: number;
  canonicalId: string;
  name: string | null;
  bufferedDeltas: string[];
  bufferedBytes: number;
  accumulatedArgs: string;
  reasoningSignature?: string;
  started: boolean;
  finished: boolean;
}

function sanitizeId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === "") return "";
  // keep A-Za-z0-9_- else _
  return trimmed.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function sanitizeSourceKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed === "") return "unknown";
  return trimmed.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 160;
}

function isValidJson(text: string): boolean {
  if (text.trim() === "") return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    // also consider multiple values? we treat as invalid
    return false;
  }
}

function hasTrailingGarbage(text: string): boolean {
  let index = 0;
  while (index < text.length && isWhitespaceCode(text.charCodeAt(index))) index++;
  if (index >= text.length) return false;
  const end = findJsonValueEnd(text, index);
  if (end === -1) return false;
  let tail = end;
  while (tail < text.length && isWhitespaceCode(text.charCodeAt(tail))) tail++;
  return tail < text.length;
}

function findJsonValueEnd(text: string, start: number): number {
  if (start >= text.length) return -1;
  const first = text[start]!;
  if (first === "\"") return scanJsonString(text, start);
  if (first === "{") return scanJsonComposite(text, start, "}");
  if (first === "[") return scanJsonComposite(text, start, "]");
  if (first === "t") return text.startsWith("true", start) ? start + 4 : -1;
  if (first === "f") return text.startsWith("false", start) ? start + 5 : -1;
  if (first === "n") return text.startsWith("null", start) ? start + 4 : -1;
  if (first === "-" || (first >= "0" && first <= "9")) {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(start));
    return match === null ? -1 : start + match[0].length;
  }
  return -1;
}

function scanJsonString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 92) {
      index += 2;
      continue;
    }
    if (code === 34) return index + 1;
    index += 1;
  }
  return -1;
}

function scanJsonComposite(text: string, start: number, closing: "}" | "]"): number {
  const stack: Array<"}" | "]"> = [closing];
  let index = start + 1;
  let inString = false;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (code === 92) {
        index += 2;
        continue;
      }
      if (code === 34) inString = false;
      index += 1;
      continue;
    }
    if (code === 34) {
      inString = true;
      index += 1;
      continue;
    }
    if (code === 123) {
      stack.push("}");
      index += 1;
      continue;
    }
    if (code === 91) {
      stack.push("]");
      index += 1;
      continue;
    }
    if (code === 125 || code === 93) {
      const expected = stack.pop();
      if (expected === undefined || expected.charCodeAt(0) !== code) return -1;
      if (stack.length === 0) return index + 1;
    }
    index += 1;
  }
  return -1;
}

/**
 * Occurrence-aware bounded assembler for incremental tool calls.
 * Shared by OpenAI/Anthropic/Gemini stream mappers.
 */
export class ToolCallAssembler {
  private readonly maxActiveCalls: number;
  private readonly maxArgumentBytes: number;
  private readonly sanitizeName?: (name: string) => string;
  private readonly recordDiagnostic?: (diagnostic: TranslationDiagnostic) => void;
  private readonly pending = new Map<string, PendingCall>(); // key: sourceKey:occurrence
  private readonly sourceKeyOccurrence = new Map<string, number>();
  private readonly canonicalIds = new Set<string>();
  private aggregateBytes = 0;

  constructor(options: ToolCallAssemblerOptions) {
    this.maxActiveCalls = options.maxActiveCalls;
    this.maxArgumentBytes = options.maxArgumentBytes;
    this.sanitizeName = options.sanitizeName;
    this.recordDiagnostic = options.recordDiagnostic;
  }

  private nextOccurrence(sourceKey: string): number {
    const cur = this.sourceKeyOccurrence.get(sourceKey) ?? 0;
    const nxt = cur + 1;
    this.sourceKeyOccurrence.set(sourceKey, nxt);
    return nxt;
  }

  private canonicalFor(sourceId: string | undefined, sourceKey: string, occurrence: number): string {
    const sanitizedKey = sanitizeSourceKey(sourceKey);
    if (sourceId !== undefined && sourceId.trim() !== "") {
      const base = sanitizeId(sourceId);
      if (base !== "") {
        let candidate = base;
        let suffix = 1;
        while (this.canonicalIds.has(candidate)) {
          suffix += 1;
          candidate = `${base}_${suffix}`;
        }
        this.canonicalIds.add(candidate);
        return candidate;
      }
    }
    // generate from sourceKey + occurrence
    const base = `call_${sanitizedKey}_${occurrence}`;
    let candidate = base;
    let suffix = 1;
    while (this.canonicalIds.has(candidate)) {
      suffix += 1;
      candidate = `${base}_${suffix}`;
    }
    this.canonicalIds.add(candidate);
    return candidate;
  }

  private getOrCreatePending(sourceKey: string, sourceOccurrenceHint?: number): PendingCall | null {
    // find active pending for this sourceKey that is not finished, or create new occurrence
    // we need to find the latest active pending for this sourceKey
    for (const pending of this.pending.values()) {
      if (pending.sourceKey === sourceKey && !pending.finished) {
        return pending;
      }
    }
    return null;
  }

  push(fragment: ToolCallFragment): readonly StreamEvent[] {
    const sourceKey = fragment.sourceKey;
    if (!sourceKey) {
      throw createInternalFailure({ kind: "provider_protocol_error", safeMessage: "tool fragment missing sourceKey", statusCode: 502, retryable: false, routeScope: "provider" });
    }

    let pending = this.getOrCreatePending(sourceKey);

    if (pending === null) {
      if (this.pending.size >= this.maxActiveCalls) {
        throw createInternalFailure({ kind: "invalid_request", safeMessage: "too many concurrent tool calls", statusCode: 413, retryable: false, routeScope: null });
      }
      const occurrence = this.nextOccurrence(sourceKey);
      const canonicalId = this.canonicalFor(fragment.sourceId, sourceKey, occurrence);
      const sanitizedName = fragment.name !== undefined ? this.sanitize(fragment.name) : null;
      pending = {
        sourceKey,
        occurrence,
        canonicalId,
        name: sanitizedName && sanitizedName.trim() !== "" ? sanitizedName : null,
        bufferedDeltas: [],
        bufferedBytes: 0,
        accumulatedArgs: "",
        reasoningSignature: fragment.reasoningSignature,
        started: false,
        finished: false,
      };
      this.pending.set(`${sourceKey}:${occurrence}`, pending);
    } else {
      // update name if provided and not yet set
      if (fragment.name !== undefined && fragment.name.trim() !== "" && pending.name === null) {
        pending.name = this.sanitize(fragment.name);
      }
      if (fragment.reasoningSignature !== undefined && pending.reasoningSignature === undefined) {
        pending.reasoningSignature = fragment.reasoningSignature;
      }
      // if fragment provides sourceId and pending was generated without ID, we could update canonical? But we already generated; keep as is for determinism
    }

    const events: StreamEvent[] = [];

    // handle argument delta
    if (fragment.argumentDelta !== undefined && fragment.argumentDelta.length > 0) {
      const deltaBytes = Buffer.byteLength(fragment.argumentDelta, "utf8");
      const newPerCall = pending.bufferedBytes + deltaBytes;
      const newAggregate = this.aggregateBytes + deltaBytes;
      if (newPerCall > this.maxArgumentBytes) {
        throw createInternalFailure({ kind: "invalid_request", safeMessage: "tool argument too large", statusCode: 413, retryable: false, routeScope: null });
      }
      if (newAggregate > 512 * 1024) {
        throw createInternalFailure({ kind: "invalid_request", safeMessage: "aggregate tool arguments too large", statusCode: 413, retryable: false, routeScope: null });
      }
      pending.accumulatedArgs += fragment.argumentDelta;
      // if not yet started (no name), buffer
      if (pending.name === null || pending.name.trim() === "") {
        pending.bufferedDeltas.push(fragment.argumentDelta);
        pending.bufferedBytes = newPerCall;
        this.aggregateBytes = newAggregate;
        // do not emit yet
      } else {
        // if started, emit buffered first if any
        if (!pending.started) {
          // first emission: start
          events.push({
            type: "tool_call_start",
            callId: pending.canonicalId,
            name: pending.name,
            ...(pending.reasoningSignature !== undefined ? { reasoningSignature: pending.reasoningSignature } : {}),
          } as StreamEvent);
          pending.started = true;
          // flush buffered deltas
          for (const buffered of pending.bufferedDeltas) {
            events.push({ type: "tool_call_delta", callId: pending.canonicalId, delta: buffered } as StreamEvent);
          }
          pending.bufferedDeltas = [];
        }
        events.push({ type: "tool_call_delta", callId: pending.canonicalId, delta: fragment.argumentDelta } as StreamEvent);
        pending.bufferedBytes = newPerCall;
        this.aggregateBytes = newAggregate;
      }
    } else if (fragment.name !== undefined && fragment.name.trim() !== "" && !pending.started && pending.name !== null) {
      // name arrived without delta, but we have buffered deltas to flush
      if (pending.bufferedDeltas.length > 0) {
        events.push({
          type: "tool_call_start",
          callId: pending.canonicalId,
          name: pending.name,
          ...(pending.reasoningSignature !== undefined ? { reasoningSignature: pending.reasoningSignature } : {}),
        } as StreamEvent);
        pending.started = true;
        for (const buffered of pending.bufferedDeltas) {
          events.push({ type: "tool_call_delta", callId: pending.canonicalId, delta: buffered } as StreamEvent);
        }
        pending.bufferedDeltas = [];
      } else {
        // if name arrived and no buffered deltas, start immediately (even if no args yet)
        // we emit start now to satisfy occurrence ordering; if later deltas arrive they'll be emitted
        // But to avoid emitting empty tool calls with no args, we could wait for first delta or done. However spec says buffer until name, then emit start followed by buffered deltas. If no deltas yet, we can emit start now.
        events.push({
          type: "tool_call_start",
          callId: pending.canonicalId,
          name: pending.name,
          ...(pending.reasoningSignature !== undefined ? { reasoningSignature: pending.reasoningSignature } : {}),
        } as StreamEvent);
        pending.started = true;
      }
    }

    if (fragment.done === true) {
      events.push(...this.finish(sourceKey));
    }

    return events;
  }

  finish(sourceKey: string): readonly StreamEvent[] {
    const pending = this.getOrCreatePending(sourceKey);
    if (pending === null) {
      // no active pending, maybe already finished; return empty
      return [];
    }
    if (pending.finished) return [];

    if (pending.name === null || pending.name.trim() === "") {
      throw createInternalFailure({ kind: "provider_protocol_error", safeMessage: "tool call finished without name", statusCode: 502, retryable: false, routeScope: "provider" });
    }

    const events: StreamEvent[] = [];

    if (!pending.started) {
      // emit start before finish if never started
      events.push({
        type: "tool_call_start",
        callId: pending.canonicalId,
        name: pending.name,
        ...(pending.reasoningSignature !== undefined ? { reasoningSignature: pending.reasoningSignature } : {}),
      } as StreamEvent);
      for (const buffered of pending.bufferedDeltas) {
        events.push({ type: "tool_call_delta", callId: pending.canonicalId, delta: buffered } as StreamEvent);
      }
      pending.bufferedDeltas = [];
      pending.started = true;
    } else if (pending.bufferedDeltas.length > 0) {
      // flush any remaining buffered (should not happen if started, but just in case)
      for (const buffered of pending.bufferedDeltas) {
        events.push({ type: "tool_call_delta", callId: pending.canonicalId, delta: buffered } as StreamEvent);
      }
      pending.bufferedDeltas = [];
    }

    const invalidJson = !isValidJson(pending.accumulatedArgs) || hasTrailingGarbage(pending.accumulatedArgs);
    if (invalidJson) {
      this.recordDiagnostic?.({
        stage: "policy",
        sourceFormat: "tool_call",
        targetSurface: "tool_call",
        fieldCategory: "arguments",
        action: "adapted",
        reason: "invalid_json",
      });
    }

    events.push({ type: "tool_call_end", callId: pending.canonicalId } as StreamEvent);
    pending.finished = true;
    this.pending.delete(`${sourceKey}:${pending.occurrence}`);
    // release aggregate bytes? keep aggregate as is for accounting? But after finish, we should subtract its bytes from aggregate? Actually aggregate is for pending only, so after finish we can subtract
    this.aggregateBytes = Math.max(0, this.aggregateBytes - pending.bufferedBytes);

    return events;
  }

  finishAll(): readonly StreamEvent[] {
    const events: StreamEvent[] = [];
    const keys = [...this.pending.keys()];
    for (const key of keys) {
      const pending = this.pending.get(key);
      if (pending) {
        const sourceKey = pending.sourceKey;
        try {
          events.push(...this.finish(sourceKey));
        } catch {
          // if finish throws due to missing name, propagate
          throw arguments[0];
        }
      }
    }
    return events;
  }

  private sanitize(name: string): string {
    if (this.sanitizeName) return this.sanitizeName(name);
    return name.trim();
  }
}
